import { NotionApiError } from './client';
import { upsertPage } from './page-builder';
import { runNotionReconcile } from './reconcile';
import type { NotionSyncArgs } from './backfill';
import type { NotionCursor, NotionPage, SearchResult } from './types';

const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Notion rounds last_edited_time to the minute; re-scan the trailing minute. */
const OVERLAP_MS = 60_000;

export interface NotionDeltaArgs extends NotionSyncArgs {
  /** Test seam; defaults to Date.now. */
  nowFn?: () => number;
}

export async function runNotionDelta(a: NotionDeltaArgs): Promise<void> {
  const now = a.nowFn ?? Date.now;
  const state = await a.ctx.loadSyncState();
  const cursor = state?.cursor_json as unknown as NotionCursor | undefined;
  if (!cursor?.last_edited)
    throw new Error('notion delta: no cursor — backfill first');

  const floorMs = new Date(cursor.last_edited).getTime() - OVERLAP_MS;
  let maxEdited = cursor.last_edited;

  // eslint-disable-next-line no-labels -- early-exit across both pagination loops
  outer: for await (const results of a.client.paginate<SearchResult>(
    '/search',
    {
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    },
  )) {
    for (const r of results) {
      const edited = r.last_edited_time ?? '';
      if (edited && new Date(edited).getTime() <= floorMs)
        // eslint-disable-next-line no-labels
        break outer; // reached unchanged tail
      if (r.object !== 'page' || r.in_trash || r.archived) {
        // Observed but not ingested (trashed / archived / non-page). Advance the
        // cursor anyway so a burst of trash-only activity can't stall it and
        // force the same window to be re-walked on every tick. Reconcile handles
        // archiving the corresponding docs.
        if (edited && edited > maxEdited) maxEdited = edited;
        continue;
      }
      try {
        await upsertPage(a, r as unknown as NotionPage);
        // Advance only on success so a transiently-failed page is retried next
        // tick rather than silently skipped past.
        if (edited && edited > maxEdited) maxEdited = edited;
      } catch (e) {
        // One bad page must not abort the tick; auth errors still propagate.
        if (e instanceof NotionApiError && e.code === 401) throw e;
        console.warn(
          `[notion] delta: page ${r.id} skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  cursor.last_edited = maxEdited;

  // Deletion reconcile, at most once per 24h.
  const lastReconcile = cursor.last_reconcile_at
    ? new Date(cursor.last_reconcile_at).getTime()
    : 0;
  if (now() - lastReconcile >= RECONCILE_INTERVAL_MS) {
    try {
      await runNotionReconcile(a);
      cursor.last_reconcile_at = new Date(now()).toISOString();
    } catch (e) {
      if (e instanceof NotionApiError && e.code === 401) throw e;
      console.warn(
        `[notion] reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  await a.ctx.saveSyncState({
    status: 'live',
    cursor_json: cursor as unknown as Record<string, unknown>,
    last_sync_at: new Date(),
  });
}
