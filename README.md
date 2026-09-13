# atomeditor.io

Static site for the Atom Editor revival, hosted on GitHub Pages.

- **Homepage** — `index.html`, reuse of the atom.tmiland.com atom.io-design homage.
- **Blog** — `blog/`, static posts under their own section of the main page.
- **Registry** — `api/`, a static, atom.io-compatible package registry for `apm`.
  - `GET /api/packages`        — full package index (JSON)
  - `GET /api/packages/<name>` — full metadata + versions
  - `GET /api/packages/featured`
  - `GET /api/themes`, `GET /api/themes/featured`
  - `.html` files contain raw JSON; apm parses bodies, content-type is irrelevant.
- **Generator** — `generator/generate-registry.js` (Node ≥ 18, zero deps) pulls the
  `atom-community` catalog, resolves each repo's `package.json` (branch + tag tarballs
  via GitHub codeload), and rewrites `api/`.

## Regenerate

```sh
GH_TOKEN=$GH_TOKEN node generator/generate-registry.js
```

Run by GitHub Actions on every push and weekly (`.github/workflows/pages.yml`).

## Deploy

`main` → build (regenerate registry) → deploy to GitHub Pages. Custom domain:
`atomeditor.io`, DNS via Namecheap (apex 4× A `185.199.108.153/.109/.110/.111`, `www`
CNAME `atomeditor.github.io`).