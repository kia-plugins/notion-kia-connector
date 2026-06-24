import { upsertPage } from '../page-builder';
import { NotionUserDirectory } from '../users';
import { captureHost, fakeClient, makePage } from './mocks';
import type { BlockNode } from '../types';

const text = (s: string): BlockNode =>
  ({ object: 'block', id: 'x', type: 'paragraph', paragraph: { rich_text: [{ plain_text: s }] } }) as BlockNode;

describe('upsertPage', () => {
  it('writes a notion_page document with rendered body + metadata', async () => {
    const h = captureHost();
    const client = fakeClient({ blocks: { page1: [text('hello world')] } });
    const users = new NotionUserDirectory(client);
    const page = makePage('page1', { title: 'My Page' });

    const docId = await upsertPage(
      { ctx: h.ctx, client, users, accountId: 1n, workspace: 'Acme' },
      page,
    );

    expect(docId).toBe(1n);
    expect(h.docs).toHaveLength(1);
    const doc = h.docs[0];
    expect(doc.source).toBe('notion');
    expect(doc.source_id).toBe('page1');
    expect(doc.type).toBe('notion_page');
    expect(doc.title).toBe('My Page');
    expect(doc.markdown).toBe('hello world');
    expect(doc.metadata).toMatchObject({ workspace: 'Acme', parent_type: 'page_id' });
    expect(doc.source_url).toBe('https://www.notion.so/page1');
    expect(doc.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to a heading when the page has no body', async () => {
    const h = captureHost();
    const client = fakeClient({ blocks: {} });
    const users = new NotionUserDirectory(client);
    const page = makePage('empty', { title: 'Bare' });

    await upsertPage(
      { ctx: h.ctx, client, users, accountId: 1n, workspace: 'Acme' },
      page,
    );
    expect(h.docs[0].markdown).toBe('# Bare');
  });

  it('renders database-row properties as a preamble', async () => {
    const h = captureHost();
    const client = fakeClient({ blocks: {} });
    const users = new NotionUserDirectory(client);
    const row = makePage('row1', {
      parent: { type: 'database_id', database_id: 'db1' },
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Widget' }] },
        Status: { type: 'status', status: { name: 'Done' } },
      },
    });

    await upsertPage(
      { ctx: h.ctx, client, users, accountId: 1n, workspace: 'Acme' },
      row,
    );
    expect(h.docs[0].markdown).toContain('**Status:** Done');
    expect(h.docs[0].title).toBe('Widget');
  });
});
