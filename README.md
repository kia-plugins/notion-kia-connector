# Notion connector for KIAgent

Indexes your Notion workspace into your local KIAgent digital memory: pages and
database rows you share with the integration become searchable documents.

> **Status:** v2 rewrite in progress against KIAgent's new extension platform
> (`Source<Cursor, Item>` contract). This README is a skeleton — connect/pull
> behavior, indexing details, and the release process are filled in as the
> rewrite lands (see the repo's `v2` branch history).

## Setup

1. Create an internal integration at <https://notion.so/my-integrations> and
   copy its **Internal Integration Secret**.
2. In Notion, open each page or database you want indexed → **•••** →
   **Connections** → add the integration so it can read them.
3. In KIAgent, start adding a Notion source and paste the secret into the
   connect flow.

## Build from source

```bash
npm install
npm run typecheck
npm run build        # → dist/index.js (self-contained CJS bundle)
npm pack              # → notion-kia-connector-<version>.tgz
```

## License

MIT — see [LICENSE](./LICENSE).
