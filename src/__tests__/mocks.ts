import type {
  ConnectorHost,
  DocumentId,
  PendingDocument,
  SyncStateRow,
} from '@kiagent/connector-sdk';
import type { NotionClient } from '../client';
import type { BlockNode, NotionPage, SearchResult } from '../types';

/** Reversible stand-in for Electron safeStorage (tests have no keyring). */
export function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  };
}

export interface CaptureHost {
  ctx: ConnectorHost;
  docs: PendingDocument[];
  archived: Array<{ id: bigint; reason: string }>;
  box: { state: Partial<SyncStateRow> | null };
}

/** A ConnectorHost that records documents / sync-state / archive calls. */
export function captureHost(
  opts: { db?: unknown; state?: Partial<SyncStateRow> | null } = {},
): CaptureHost {
  const docs: PendingDocument[] = [];
  const archived: Array<{ id: bigint; reason: string }> = [];
  const box: { state: Partial<SyncStateRow> | null } = {
    state: opts.state ?? null,
  };
  let nextId = 1n;
  const ctx = {
    accountId: 1n,
    db: opts.db,
    dataDir: '/tmp/notion-test',
    safeStorage: fakeSafeStorage(),
    emitStreamEvent: () => {},
    async upsertDocument(doc: PendingDocument): Promise<DocumentId> {
      docs.push(doc);
      return nextId++;
    },
    async deleteDocument() {},
    async archiveDocument(id: bigint, reason: string) {
      archived.push({ id, reason });
    },
    async findBySourceId() {
      return null;
    },
    async findByContentHash() {
      return [];
    },
    async saveSyncState(s: Partial<SyncStateRow>) {
      box.state = { ...(box.state ?? {}), ...s };
    },
    async loadSyncState() {
      return box.state as SyncStateRow | null;
    },
  } as unknown as ConnectorHost;
  return { ctx, docs, archived, box };
}

export interface FakeClientRoutes {
  /** Pages of `/search` results (each inner array is one cursor page). */
  search?: SearchResult[][];
  /** `/databases/{id}/query` results, keyed by database id. */
  dbQuery?: Record<string, NotionPage[][]>;
  /** `/blocks/{id}/children` block trees, keyed by block (page) id. */
  blocks?: Record<string, BlockNode[]>;
  /** `/users/{id}` records, keyed by user id. */
  users?: Record<string, { id: string; name?: string }>;
}

/** A NotionClient stand-in that routes by pathname; no network, no throttling. */
export function fakeClient(routes: FakeClientRoutes): NotionClient {
  return {
    async *paginate<T>(pathname: string): AsyncGenerator<T[]> {
      if (pathname === '/search') {
        for (const page of routes.search ?? []) yield page as unknown as T[];
        return;
      }
      const m = pathname.match(/^\/databases\/(.+)\/query$/);
      if (m) {
        for (const page of routes.dbQuery?.[m[1]] ?? [])
          yield page as unknown as T[];
      }
    },
    async *paginateGet<T>(pathname: string): AsyncGenerator<T[]> {
      const m = pathname.match(/^\/blocks\/(.+)\/children$/);
      yield ((m && routes.blocks?.[m[1]]) ?? []) as unknown as T[];
    },
    async request<T>(_method: string, pathname: string): Promise<T> {
      const m = pathname.match(/^\/users\/(.+)$/);
      if (m) return (routes.users?.[m[1]] ?? { id: m[1] }) as unknown as T;
      return {} as T;
    },
  } as unknown as NotionClient;
}

/** Build a full Notion page object (search returns full pages, not just ids). */
export function makePage(
  id: string,
  opts: Partial<NotionPage> & { title?: string } = {},
): NotionPage {
  const { title, ...rest } = opts;
  return {
    object: 'page',
    id,
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-01-02T00:00:00.000Z',
    url: `https://www.notion.so/${id}`,
    parent: { type: 'page_id', page_id: 'root' },
    properties: title
      ? { Name: { type: 'title', title: [{ plain_text: title }] } }
      : {},
    ...rest,
  };
}
