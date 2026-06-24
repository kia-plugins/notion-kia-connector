import { runNotionBackfill } from '../backfill';
import { NotionUserDirectory } from '../users';
import { captureHost, fakeClient, makePage } from './mocks';
import type { NotionCursor, SearchResult } from '../types';

describe('runNotionBackfill', () => {
  it('walks pages + database rows, ingests them, and saves a live cursor', async () => {
    const h = captureHost();
    const page1 = makePage('page1', {
      title: 'Page One',
      last_edited_time: '2026-03-01T00:00:00.000Z',
    });
    const dbEntry = { object: 'database', id: 'db1' } as SearchResult;
    const row1 = makePage('row1', {
      title: 'Row',
      parent: { type: 'database_id', database_id: 'db1' },
      last_edited_time: '2026-04-01T00:00:00.000Z',
    });
    const client = fakeClient({
      search: [[page1 as unknown as SearchResult, dbEntry]],
      dbQuery: { db1: [[row1]] },
      blocks: {},
    });
    const users = new NotionUserDirectory(client);
    const progress: Array<[number, number | null]> = [];

    await runNotionBackfill({
      ctx: h.ctx,
      client,
      users,
      accountId: 1n,
      workspace: 'Acme',
      signal: new AbortController().signal,
      onProgress: (d, t) => progress.push([d, t]),
    });

    // Both the page and the database row become documents.
    expect(h.docs.map((d) => d.source_id).sort()).toEqual(['page1', 'row1']);
    expect(progress.at(-1)).toEqual([2, null]);

    const state = h.box.state!;
    expect(state.status).toBe('live');
    expect(state.backfill_done_count).toBe(2);
    const cursor = state.cursor_json as unknown as NotionCursor;
    expect(cursor.last_edited).toBe('2026-04-01T00:00:00.000Z');
    expect(cursor.last_reconcile_at).toBeTruthy();
  });

  it('floors the cursor at epoch for an empty workspace', async () => {
    const h = captureHost();
    const client = fakeClient({ search: [[]] });
    const users = new NotionUserDirectory(client);

    await runNotionBackfill({
      ctx: h.ctx,
      client,
      users,
      accountId: 1n,
      workspace: 'Acme',
      signal: new AbortController().signal,
      onProgress: () => {},
    });

    const cursor = h.box.state!.cursor_json as unknown as NotionCursor;
    expect(cursor.last_edited).toBe(new Date(0).toISOString());
    expect(h.box.state!.backfill_done_count).toBe(0);
  });

  it('aborts the walk when the signal fires', async () => {
    const h = captureHost();
    const ac = new AbortController();
    ac.abort();
    const client = fakeClient({
      search: [[makePage('p', { title: 'x' }) as unknown as SearchResult]],
    });
    const users = new NotionUserDirectory(client);

    await expect(
      runNotionBackfill({
        ctx: h.ctx,
        client,
        users,
        accountId: 1n,
        workspace: 'Acme',
        signal: ac.signal,
        onProgress: () => {},
      }),
    ).rejects.toThrow('notion backfill stopped');
  });
});
