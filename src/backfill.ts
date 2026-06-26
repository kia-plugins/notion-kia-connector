import type { ConnectorHost } from '@kiagent/connector-sdk';
import type { NotionClient } from './client';
import type { NotionUserDirectory } from './users';
import { upsertPage } from './page-builder';
import { NotionApiError } from './client';
import type { NotionCursor, NotionPage, SearchResult } from './types';

export interface NotionSyncArgs {
  ctx: ConnectorHost;
  client: NotionClient;
  users: NotionUserDirectory;
  accountId: bigint;
  workspace: string;
}

export interface NotionBackfillArgs extends NotionSyncArgs {
  signal: AbortSignal;
  onProgress: (done: number, total: number | null) => void;
}

const newer = (
  a: string | undefined,
  b: string | undefined,
): string | undefined => (!a ? b : !b ? a : a > b ? a : b);

export async function runNotionBackfill(a: NotionBackfillArgs): Promise<void> {
  await a.ctx.saveSyncState({ status: 'backfilling', backfill_done_count: 0 });

  let maxEdited: string | undefined;
  let done = 0;
  const databases: string[] = [];

  const ingest = async (p: NotionPage) => {
    if (a.signal.aborted) throw new Error('notion backfill stopped');
    try {
      await upsertPage(a, p);
    } catch (e) {
      // One unreadable page (e.g. a block-children fetch that survived the
      // client's retries) must not abort the whole walk. Auth errors still
      // propagate — every subsequent call would fail the same way.
      if (e instanceof NotionApiError && e.code === 401) throw e;
      console.warn(
        `[notion] backfill: page ${p.id} skipped: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    maxEdited = newer(maxEdited, p.last_edited_time);
    done += 1;
    a.onProgress(done, null);
  };

  // 1) Enumerate every accessible page; remember databases for the row sweep.
  for await (const results of a.client.paginate<SearchResult>('/search', {
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  })) {
    for (const r of results) {
      if (a.signal.aborted) throw new Error('notion backfill stopped');
      if (r.object === 'database') databases.push(r.id);
      else if (r.object === 'page' && !r.in_trash && !r.archived)
        await ingest(r as unknown as NotionPage);
    }
  }

  // 2) Belt-and-suspenders: query each database's rows (search index lags).
  for (const dbId of databases) {
    try {
      for await (const rows of a.client.paginate<NotionPage>(
        `/databases/${dbId}/query`,
        {},
      )) {
        for (const row of rows) {
          if (!row.in_trash && !row.archived) await ingest(row);
        }
      }
    } catch (e) {
      if (e instanceof NotionApiError && e.code === 401) throw e;
      console.warn(
        `[notion] backfill: database ${dbId} query failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const cursor: NotionCursor = {
    // Floor at epoch when the workspace had zero pages so the cursor is always
    // present — otherwise JSON.stringify drops an undefined last_edited and the
    // delta throws "no cursor" forever. Epoch means "first delta re-scans
    // everything", which is the correct behaviour once pages get shared.
    last_edited: maxEdited ?? new Date(0).toISOString(),
    last_reconcile_at: new Date().toISOString(),
  };
  await a.ctx.saveSyncState({
    status: 'live',
    cursor_json: cursor as unknown as Record<string, unknown>,
    backfill_done_count: done,
    last_sync_at: new Date(),
  });
}
