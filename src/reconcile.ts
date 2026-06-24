import type { Db } from './host';
import type { NotionSyncArgs } from './backfill';
import type { SearchResult } from './types';

/**
 * Deletion reconciliation: a trashed page silently drops out of the edit-since
 * stream, so once a day we enumerate every accessible page id (metadata only,
 * no block fetch) and archive any stored notion doc whose page is gone.
 */
export async function runNotionReconcile(a: NotionSyncArgs): Promise<void> {
  const live = new Set<string>();
  for await (const results of a.client.paginate<SearchResult>('/search', {
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  })) {
    for (const r of results)
      if (r.object === 'page' && !r.in_trash && !r.archived) live.add(r.id);
  }

  // Scope to THIS workspace's docs only. The documents table has no account_id
  // column the connector can rely on cross-version, so a multi-workspace install
  // must filter on metadata.workspace — otherwise one workspace's reconcile
  // would archive another's pages. (Was DocumentsRepository.listNotionPagesForWorkspace
  // in-tree; out-of-process we read the host's raw db surface directly.)
  const db = a.ctx.db as Db;
  const stored = await db.all(
    `SELECT id, source_id, metadata FROM documents
       WHERE source = 'notion'
         AND type = 'notion_page'
         AND json_extract(metadata, '$.workspace') = ?`,
    [a.workspace],
  );
  for (const row of stored) {
    const meta = row.metadata
      ? (JSON.parse(row.metadata as string) as { status?: string })
      : {};
    if (meta.status === 'archived') continue; // already archived — skip
    if (!live.has(row.source_id as string)) {
      await a.ctx.archiveDocument(row.id as bigint, 'notion-reconcile');
    }
  }
}
