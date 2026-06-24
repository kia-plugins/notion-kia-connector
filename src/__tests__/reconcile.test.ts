import { runNotionReconcile } from '../reconcile';
import { NotionUserDirectory } from '../users';
import { captureHost, fakeClient } from './mocks';
import { openTestDb } from './harness';
import type { SearchResult } from '../types';

describe('runNotionReconcile', () => {
  it('archives docs whose pages are gone, scoped to the workspace', async () => {
    const db = openTestDb();
    const insert = (sourceId: string, workspace: string) =>
      db.run(
        `INSERT INTO documents (source, source_id, type, metadata, source_url)
           VALUES ('notion', ?, 'notion_page', ?, 'u')`,
        [sourceId, JSON.stringify({ workspace })],
      );
    await insert('live1', 'Acme'); // still present → keep
    await insert('gone1', 'Acme'); // missing → archive
    await insert('other1', 'Other'); // different workspace → out of scope

    const goneRow = (
      await db.all(`SELECT id FROM documents WHERE source_id='gone1'`)
    )[0];
    const goneId = goneRow.id as bigint;

    const h = captureHost({ db });
    const client = fakeClient({
      // Only live1 comes back from /search → gone1 is considered deleted.
      search: [[{ object: 'page', id: 'live1' } as SearchResult]],
    });
    const users = new NotionUserDirectory(client);

    await runNotionReconcile({
      ctx: h.ctx,
      client,
      users,
      accountId: 1n,
      workspace: 'Acme',
    });

    expect(h.archived).toEqual([{ id: goneId, reason: 'notion-reconcile' }]);
    await db.close();
  });
});
