# Notion connector for alpha-cent / KIAgent

Indexes your Notion workspace into your local KIAgent digital memory: every page
and database row you share with the integration becomes a searchable document,
kept current by an incremental edit-since poll with a daily deletion reconcile.

Self-contained, out-of-process plugin — pure Node + `fetch`, no runtime npm
dependencies, no OAuth redirect. Authentication is a pasted **Notion internal
integration secret** (`ntn_…`), encrypted at rest with the host's safeStorage.

## Host API

Requires alpha-cent host API `^2.0.0`.

## Install

This connector is published to the official `kia-plugins` marketplace. In
KIAgent:

1. Open **Add a source → Browse the marketplace** (or the Marketplace screen).
2. Find **Notion** under the official store and click **Install**.
3. Review the requested permissions (`db:read`, `db:write`, `net`, `secrets`)
   and confirm.

Then add an account:

1. Create a Notion integration at <https://notion.so/my-integrations> and copy
   its **Internal Integration Secret**.
2. In Notion, open each page/database → ••• → **Connections** → add the
   integration so it can read them.
3. Paste the secret into the connector's setup field.

### Install from a release tarball (Tier 2)

You can also install directly from a published GitHub release: paste the
release's `.tgz` URL and its integrity hash into KIAgent's "Install from URL"
dialog.

## What it indexes

- One `notion_page` document per shared page and per database row.
- Block content rendered to Markdown (headings, lists, to-dos, quotes, code,
  tables, equations, media links). `child_page` / `child_database` blocks are
  separate documents, never inlined.
- Database-row properties rendered as a key/value preamble.
- Metadata: workspace, parent, URL, created/edited times, author.

Backfill walks every accessible page (and each database's rows); delta polls the
edit-since stream with a 1-minute overlap; once per 24h a reconcile archives docs
whose pages were trashed.

## Trust model

This plugin runs in a forked Node process with the permissions you grant at
install time. It is not sandboxed at the OS level — install only connectors from
authors you trust. The source is here for audit.

## Build from source

```bash
npm install
npm run typecheck
npm test
npm run build        # → dist/index.js (self-contained CJS bundle)
npm run pack         # build + npm pack → notion-kia-connector-<version>.tgz
```

## Releasing a new version

1. Bump `version` in **both** `package.json` and `manifest.json` (must match).
2. `npm install` (if deps changed) → `npm test` → `npm run pack`.
3. Compute the integrity hash:
   ```bash
   openssl dgst -sha512 -binary notion-kia-connector-<version>.tgz \
     | { printf 'sha512-'; base64; }
   ```
4. Publish the GitHub release with the tarball as an asset:
   ```bash
   gh release create v<version> notion-kia-connector-<version>.tgz \
     --title "v<version>" --notes "Integrity: sha512-…"
   ```
5. Update the Tier-2 URL + integrity in this README, commit, and push.

## License

MIT — see [LICENSE](./LICENSE).
