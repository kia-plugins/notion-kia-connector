import { runNotionDelta } from '../delta';
import { NotionUserDirectory } from '../users';
import { captureHost, fakeClient, makePage } from './mocks';
import type { NotionCursor, SearchResult } from '../types';

const ISO = (s: string) => new Date(s).toISOString();

describe('runNotionDelta', () => {
  it('throws when there is no cursor (backfill must run first)', async () => {
    const h = captureHost({ state: { status: 'live' } });
    const client = fakeClient({ search: [[]] });
    const users = new NotionUserDirectory(client);
    await expect(
      runNotionDelta({ ctx: h.ctx, client, users, accountId: 1n, workspace: 'Acme' }),
    ).rejects.toThrow('no cursor');
  });

  it('ingests pages newer than the cursor and stops at the unchanged tail', async () => {
    const cursor: NotionCursor = {
      last_edited: ISO('2026-03-01T00:00:00.000Z'),
      last_reconcile_at: ISO('2026-03-01T00:00:00.000Z'),
    };
    const h = captureHost({
      state: { status: 'live', cursor_json: cursor as unknown as Record<string, unknown> },
    });
    const fresh = makePage('fresh', {
      title: 'Fresh',
      last_edited_time: ISO('2026-03-05T00:00:00.000Z'),
    });
    const old = makePage('old', {
      title: 'Old',
      last_edited_time: ISO('2026-01-01T00:00:00.000Z'),
    });
    const client = fakeClient({
      search: [[fresh as unknown as SearchResult, old as unknown as SearchResult]],
      blocks: {},
    });
    const users = new NotionUserDirectory(client);

    // nowFn 6h after last_reconcile_at → the 24h reconcile is NOT due, so this
    // stays a pure delta-ingest test (no ctx.db needed).
    await runNotionDelta({
      ctx: h.ctx,
      client,
      users,
      accountId: 1n,
      workspace: 'Acme',
      nowFn: () => new Date('2026-03-01T06:00:00.000Z').getTime(),
    });

    expect(h.docs.map((d) => d.source_id)).toEqual(['fresh']);
    const saved = h.box.state!.cursor_json as unknown as NotionCursor;
    expect(saved.last_edited).toBe(ISO('2026-03-05T00:00:00.000Z'));
    expect(h.box.state!.status).toBe('live');
  });
});
