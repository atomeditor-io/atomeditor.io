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
  'TypeStrong/atom-typescript'
]).join(',');
const EXTRA_REPOS = EXTRA.split(',').map(s => s.trim()).filter(Boolean);
const PER_PAGE = 100;
const OUT_DIR = path.join(__dirname, '..', 'api');
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
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  const isTheme =
    keywords.some(k => /theme/i.test(k)) ||
    /-(ui|syntax|theme)$/i.test(name) ||
    (/theme/i.test(name));
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  const repositoryUrl = (pkg.repository && (pkg.repository.url || pkg.repository)) || `https://github.com/${meta.org}/${meta.name}`;

  const { version: tarballVersion, tarball } = await resolveTarball({ ...meta, version });
  const verKey = tarballVersion || version;

  return {
    name,
    version: tarballVersion || version,
    description: pkg.description || meta.description || '',
    website: `https://github.com/${meta.org}/${meta.name}`,
    repository: { type: 'git', url: String(repositoryUrl).replace(/^git\+/, '') },
    stars: meta.stars,
    theme: isTheme,
    archived: meta.archived,
    versions: {
      [verKey]: {
        url: `https://github.com/${meta.org}/${meta.name}`,
        tarball_url: tarball,
        dist: { tarball }
      }
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

  fs.mkdirSync(path.join(OUT_DIR, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'themes'), { recursive: true });

  const writeJsonHtml = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data));
  };

  for (const p of finalPkgs) {
    try {
      writeJsonHtml(path.join(OUT_DIR, 'packages', `${p.name}.json`), p);
    } catch (e) {
      console.error(`skip write for ${p.name}: ${e.code}`);
    }
  }

  const themeRecords = finalPkgs.filter(p => p.theme);
  const pkgIndex = finalPkgs.filter(p => !p.theme).map(lightRecord);
  const themeIndex = themeRecords.map(lightRecord);

  writeJsonHtml(path.join(OUT_DIR, 'packages', 'index.html'), pkgIndex);
  writeJsonHtml(path.join(OUT_DIR, 'themes', 'index.html'), themeIndex);
  writeJsonHtml(path.join(OUT_DIR, 'packages', 'featured.html'), pkgIndex.slice(0, 60));
  writeJsonHtml(path.join(OUT_DIR, 'themes', 'featured.html'), themeIndex.slice(0, 30));

  const meta = {
    source: ORGS.map(o => `https://github.com/${o}`),
    generated_at: new Date().toISOString(),
    counts: { repos: unique.length, packages: finalPkgs.length, themes: themeRecords.length }
  };
  writeJsonHtml(path.join(OUT_DIR, '_meta.json'), meta);

  console.log(`registry written to ${OUT_DIR}: ${finalPkgs.length} packages, ${themeRecords.length} themes`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});