#!/usr/bin/env node
'use strict';
// Generate a static, atom.io-compatible package registry for apm.
// Sources: the atom-community catalog on GitHub; tarballs stream from
// GitHub codeload ("pulled from repos on gh").
//
// Output layout (served by GitHub Pages for https://atomeditor.io/api/...):
//   api/packages/index.html    GET /api/packages              (browse/search index, light records)
//   api/packages/<name>.json   GET /api/packages/<name>       (full metadata + versions)
//   api/packages/featured.html GET /api/packages/featured
//   api/themes/index.html      GET /api/themes
//   api/themes/featured.html   GET /api/themes/featured
//   api/_meta.json             counts + generated_at
// .html files contain raw JSON (content-type mismatch is harmless; bodies are
// parsed as JSON by apm/request). .nojekyll keeps Pages from rewriting paths.

const fs = require('fs');
const path = require('path');

const ORGS = (process.env.REGISTRY_ORGS || 'atomeditor-io,tmiland-lab,atom-community').split(',').map(s => s.trim()).filter(Boolean);
const EXTRA = (process.env.EXTRA_REPOS || [
  'atom-minimap/minimap',
  'file-icons/atom',
  'steelbrain/linter',
  'steelbrain/linter-ui-default',
  'shd101wyy/markdown-preview-enhanced',
  'smashwilson/merge-conflicts',
  'TypeStrong/atom-typescript',
  'arcticicestudio/nord-atom-ui',
  'arcticicestudio/nord-atom-syntax'
]).join(',');
const EXTRA_REPOS = EXTRA.split(',').map(s => s.trim()).filter(Boolean);
// Infra/meta repos that ship a package.json but are not installable packages.
const NAME_DENY = /^(atom|atom-community\.github\.io|atom-editor|semantic-release[^/]*|dlvr[^/]*)$|\.github\.io$/i;
// Build-dep/config/infra noise that shipped a package.json but isn't a real
// installable Atom package. Hidden from the browse indices (per-package files
// still resolve so apm can install if someone pinned one).
const JUNK_NAMES = new Set([
  'definitely-typed','mathjax','react-tools','electron-quick-start',
  'jasmine-json','jasmine-node','jasmine-reporters','jasmine-tagged','jasmine-waits-for-callback',
  'generator-atom-npm','grunt-coffeelint','neon-cli','slackin','spamtoberfest','opencode',
  'babel-preset-atomic','babel-plugin-add-module-exports','babel-plugin-transform-not-strict',
  'eslint-config-atomic','prettier-config-atomic','terser-config-atomic','rollup-plugin-atomic',
  'atomcommunity-pipelines','telemetry-github','debugger-test','organization-sync','atom-bugs',
  'github-releases','flight-manual.atom.io','atom-slick','space-pencil','squeegpg','town-crier',
  'television','tello','joanna','roaster','notebook','pr-changelog','spawn-as-admin','whats-my-line',
  'project-ring','scroll-searcher','scrollbar-style','atom-diff','line-length-index','line-top-index',
  'nslog','text-transforms','mistaken-pull-closer','reactionary','revert-buffer','require-snapshot',
  'timecop','loophole','mixto'
]);
// Names that keep their original owner URL even if the basename collides with
// a (non-fork) repo in atomeditor-io (e.g. our `atom` editor vs file-icons/atom).
const NO_FORK_RENAME = new Set(['atom']);
const PER_PAGE = 100;
const OUT_DIR = path.join(__dirname, '..', 'api');
const ORG_NAME = 'atomeditor-io';
const OUR_FORKS = new Set(); // basenames of atomeditor-io fork repos (set by main())
const TOKEN = process.env.GH_TOKEN || '';
const AUTH = TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'atomeditor-registry' } } : { headers: { 'User-Agent': 'atomeditor-registry' } };

async function listOrgRepos(org) {
  const repos = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetch(url, AUTH);
    if (res.status === 403) {
      console.error(`rate-limited at page ${page}`);
      break;
    }
    if (!res.ok) {
      console.error(`org list failed: ${res.status} ${url}`);
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const r of batch) {
      repos.push({
        org,
        name: r.name,
        branch: r.default_branch || 'master',
        stars: r.stargazers_count || 0,
        description: r.description || null,
        archived: !!r.archived,
        fork: !!r.fork
      });
    }
    console.error(`listed ${org} page ${page} (${repos.length} total)`);
    if (batch.length < PER_PAGE) break;
  }
  return repos;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, AUTH);
    if (res.status !== 200) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  }
}

async function headStatus(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', ...AUTH });
    return res.status;
  } catch (e) {
    return 0;
  }
}

async function resolveTarball(meta) {
  // Prefer a matching tag tarball (exact semver, then v-prefixed), else the default branch tarball.
  const ver = meta.version || '0.0.0';
  const candidates = [
    [`refs/tags/${ver}`, ver],
    [`refs/tags/v${ver}`, ver],
    [`refs/heads/${meta.branch}`, ver]
  ];
  for (const [ref, verLabel] of candidates) {
    const url = `https://codeload.github.com/${meta.org}/${meta.name}/tar.gz/${ref}`;
    const code = await headStatus(url);
    if (code === 200) return { version: verLabel, tarball: url };
  }
  return { version: ver, tarball: null };
}

async function resolveBranch(meta) {
  for (const branch of ['master', 'main']) {
    const res = await fetch(`https://raw.githubusercontent.com/${meta.org}/${meta.name}/${branch}/package.json`, AUTH);
    if (res.status === 200) return branch;
  }
  return meta.branch;
}

async function buildPackage(meta) {
  if (!meta.branch) meta.branch = await resolveBranch(meta) || 'master';
  const rawBase = `https://raw.githubusercontent.com/${meta.org}/${meta.name}/${meta.branch}`;
  const pkg = await fetchJson(`${rawBase}/package.json`);
  if (!pkg || typeof pkg !== 'object') return null;

  const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : meta.name;
  if (name.startsWith('@') || /\/|\\/.test(name)) return null;
  if (NAME_DENY.test(name)) return null;
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  const isTheme =
    keywords.some(k => /theme/i.test(k)) ||
    /-(ui|syntax|theme)$/i.test(name) ||
    (/theme/i.test(name));
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  let repositoryUrl = (pkg.repository && (pkg.repository.url || pkg.repository)) || `https://github.com/${meta.org}/${meta.name}`;
  repositoryUrl = String(repositoryUrl).replace(/^git\+/, '');
  // If we mirror this repo under atomeditor-io, link there instead of the upstream owner.
  // Prefer matching by repo basename; fall back to the package name for forks whose
  // upstream renamed/re-homed the repo (e.g. space-pen -> space-pen-plus, atom-buildium -> buildium).
  const baseName = path.basename(repositoryUrl).replace(/\.git$/, '');
  const forkName =
    OUR_FORKS.has(baseName) && !NO_FORK_RENAME.has(baseName)
      ? baseName
      : OUR_FORKS.has(name) && !NO_FORK_RENAME.has(name)
      ? name
      : null;
  const forkBase = forkName !== null;
  if (forkBase) repositoryUrl = `https://github.com/${ORG_NAME}/${forkName}`;
  const urlBase = forkBase
    ? `https://github.com/${ORG_NAME}/${forkName}`
    : `https://github.com/${meta.org}/${meta.name}`;

  const { version: tarballVersion, tarball } = await resolveTarball({ ...meta, version });
  const verKey = tarballVersion || version;
  const engines = (pkg.engines && (pkg.engines.atom || pkg.engines['atom'])) ? { atom: pkg.engines.atom || pkg.engines['atom'] } : null;
  const versionEntry = {
    url: urlBase,
    tarball_url: tarball,
    dist: { tarball },
    ...(engines ? { engines } : {})
  };

  return {
    name,
    version: tarballVersion || version,
    description: pkg.description || meta.description || '',
    website: urlBase,
    repository: { type: 'git', url: repositoryUrl },
    stars: meta.stars,
    downloads: 0,
    stargazers_count: meta.stars,
    readme: null,
    metadata: {
      name,
      version: tarballVersion || version,
      description: pkg.description || meta.description || '',
      repository: { type: 'git', url: repositoryUrl },
      website: urlBase,
      theme: isTheme,
      ...(engines ? { engines } : {})
    },
    releases: {
      latest: { version: tarballVersion || version, tarball_url: tarball, url: `${tarball || ''}` },
      stable: { version: tarballVersion || version, tarball_url: tarball, url: `${tarball || ''}` }
    },
    theme: isTheme,
    archived: meta.archived,
    versions: {
      [verKey]: versionEntry
    }
  };
}

function lightRecord(p) {
  return {
    name: p.name,
    version: p.version,
    description: p.description,
    repository: p.repository.url,
    stars: p.stars,
    theme: p.theme
  };
}

async function main() {
  const repos = (await Promise.all(ORGS.map(listOrgRepos))).flat();
  for (const r of repos) {
    if (r.org === ORG_NAME && r.fork) OUR_FORKS.add(r.name);
  }
  console.error(`our forks: ${OUR_FORKS.size}`);
  const byName = new Map();
  for (const r of repos) {
    const key = r.org + '/' + r.name;
    const existing = byName.get(key);
    if (!existing) byName.set(key, { org: r.org, name: r.name, ...r });
  }
  for (const e of EXTRA_REPOS) {
    const [org, name] = e.split('/');
    if (!byName.has(`${org}/${name}`)) byName.set(`${org}/${name}`, { org, name, branch: null, stars: 0, description: null, archived: false, fork: false });
  }
  const unique = [...byName.values()];
  console.error(`catalog: ${unique.length} repos`);
  const packages = [];
  const BATCH = 24;
  let ok = 0;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(r => buildPackage(r)));
    for (const p of results) {
      if (p) {
        packages.push(p);
        ok++;
      }
    }
    console.error(`processed ${Math.min(i + BATCH, unique.length)}/${unique.length} (${ok} packages)`);
  }
  const byPkgName = new Map();
  for (const p of packages) {
    if (!byPkgName.has(p.name) || p.stars > byPkgName.get(p.name).stars) byPkgName.set(p.name, p);
  }
  const finalPkgs = [...byPkgName.values()];
  finalPkgs.sort((a, b) => b.stars - a.stars);

  const listedPkgs = finalPkgs.filter(p => !JUNK_NAMES.has(p.name));
  const hidden = finalPkgs.length - listedPkgs.length;
  console.error(`hidden junk: ${hidden}`);

  fs.mkdirSync(path.join(OUT_DIR, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'themes'), { recursive: true });

  const writeJsonHtml = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data));
  };

  for (const p of listedPkgs) {
    try {
      // apm requests /api/packages/<name> extensionless; Pages won't map <name>.json
      // to it, so the canonical file is extensionless (a .json twin is a bonus).
      writeJsonHtml(path.join(OUT_DIR, 'packages', p.name), p);
    } catch (e) {
      console.error(`skip write for ${p.name}: ${e.code}`);
    }
  }

  // Index files carry FULL records so apm's search can fetch the whole list
  // once and filter locally (the static site can't answer arbitrary ?q=).
  // /api/packages carries packages AND themes (as atom.io's search did); the
  // /api/themes index stays theme-only for browsing; featured stays split.
  const themeRecords = listedPkgs.filter(p => p.theme);
  const themeIndex = themeRecords;

  writeJsonHtml(path.join(OUT_DIR, 'packages', 'index.html'), listedPkgs);
  writeJsonHtml(path.join(OUT_DIR, 'themes', 'index.html'), themeIndex);
  // featured needs FULL pack objects (apm renderer filters on pack.releases.latest)
  writeJsonHtml(path.join(OUT_DIR, 'packages', 'featured'), listedPkgs.filter(p => !p.theme).slice(0, 60));
  writeJsonHtml(path.join(OUT_DIR, 'themes', 'featured'), themeRecords.slice(0, 30));

  const meta = {
    source: ORGS.map(o => `https://github.com/${o}`),
    generated_at: new Date().toISOString(),
    counts: { repos: unique.length, packages: listedPkgs.length, themes: themeRecords.length }
  };
  writeJsonHtml(path.join(OUT_DIR, '_meta.json'), meta);

  console.log(`registry written to ${OUT_DIR}: ${listedPkgs.length} packages, ${themeRecords.length} themes`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});