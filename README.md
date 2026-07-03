# Notion connector for KIAgent

Indexes your Notion workspace into your local KIAgent digital memory: pages and
database rows you share with the integration become searchable documents,
kept in sync automatically.

## Install

Install **Notion** from the KIAgent marketplace (Settings → Extensions →
Marketplace → Notion → Install). KIAgent will prompt for the one grant this
connector needs — `net`, so it can talk to `api.notion.com` — before it
activates.

## Connect your workspace

1. Go to <https://notion.so/my-integrations> and create a new **internal
   integration** (or reuse one you already have). Give it read access to
   content and comments; it does not need to update or insert content.
2. Copy the integration's **Internal Integration Secret** (starts with `ntn_`
   for newer integrations, or `secret_` for older ones).
3. In KIAgent, add a Notion account and paste the secret in when prompted.
   The connector verifies it against Notion's `/users/me` before saving it
   and shows your workspace's name as the account identifier.
4. In Notion, open every page or database you want indexed → **•••** →
   **Connections** → add the integration. Notion only shares what you
   explicitly connect — the integration (and KIAgent) sees nothing else.

## What gets indexed

- Every page and database row the integration has been connected to,
  converted to Markdown (headings, lists, to-dos, quotes, code, tables,
  callouts, embeds, and nested blocks all carry over; database rows get a
  properties preamble ahead of their body).
- The title, the page's own Notion URL (for jumping back to the source), and
  metadata (parent type, created/last-edited timestamps).
- Trashed and archived pages are skipped, and are archived out of the local
  index once no longer listed upstream.

Nothing else leaves Notion: no comments, no user directory, no workspace
settings.

## Sync behavior

- **Backfill:** on first connect, the connector walks every accessible page
  oldest-edited-first, resuming exactly where it left off if interrupted.
- **Live sync:** once backfill completes, it re-checks Notion every
  **30 minutes**, pulling only what changed since the last successful sync.
- **Reconcile:** a full listing runs alongside sync to catch pages that were
  deleted or unshared upstream, archiving the corresponding local documents.

## Privacy

Your Notion content is fetched directly from Notion's API and written
straight into your local KIAgent index. The connector has no server of its
own and no analytics: the only network traffic it makes is between
`api.notion.com` and your machine, over the platform's `net` capability —
nothing is sent anywhere else.

## Build from source

```bash
npm install
npm test
npm run typecheck
npm run build        # → dist/index.js (self-contained CJS bundle)
npm pack              # → notion-kia-connector-<version>.tgz
```

## License

MIT — see [LICENSE](./LICENSE).
