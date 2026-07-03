/**
 * Task 13 suite for the finished Notion v2 source: connect (password-vault
 * prompt), pull (ascending resumable backfill / descending floor-break
 * delta), reconcile, and the pure toDocument mapping.
 *
 * `host.net.fetch` is fully scripted — no real network. `scriptedFetch`
 * records every call (url/method/parsed JSON body) and pops queued
 * responses in call order; responses are JSON encoded to Uint8Array with
 * lowercase headers, matching the host's real response shape (see
 * `../client`). Block-fetch responses are minimal (empty children) — block
 * rendering is Task 12's tested territory; these tests focus on
 * cursor/batching/floor logic.
 */
import { createNotionSource, type NotionCursor, type NotionItem } from '../source';
import { NotionApiError, type NetFetch } from '../client';
import type { NotionSearchResult } from '../notion-types';
import type {
  Account,
  AuthChannel,
  Batch,
  Credentials,
  ExternalRef,
  HostFor,
  Session,
} from '../kiagent-contracts';

function jsonResponse(status: number, json: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    statusText: '',
    headers,
    body: new TextEncoder().encode(JSON.stringify(json)),
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function scriptedFetch(responses: unknown[]): { fetchFn: NetFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn: NetFetch = async (url, init) => {
    const parsed = (init ?? {}) as { method?: string; body?: string };
    calls.push({
      url,
      method: parsed.method ?? 'GET',
      body: parsed.body ? JSON.parse(parsed.body) : undefined,
    });
    const res = responses[i];
    i += 1;
    if (res === undefined) {
      throw new Error(`scriptedFetch: no response queued for call #${i} (${url})`);
    }
    return res;
  };
  return { fetchFn, calls };
}

function makeHost(fetchFn: NetFetch): HostFor<'net'> {
  return {
    self: { id: 'notion', dataDir: '/tmp' },
    log: () => {},
    net: { fetch: fetchFn },
  };
}

function makeSession(credentials: Credentials | null): Session {
  return {
    account: {} as Account,
    signal: new AbortController().signal,
    credentials: async () => credentials,
    log: () => {},
  };
}

function makeAuth(answers: Record<string, unknown>): {
  auth: AuthChannel;
  getSchema: () => unknown;
} {
  let schema: unknown;
  const auth: AuthChannel = {
    oauth: async () => ({}),
    showQr: () => {},
    prompt: async (s) => {
      schema = s;
      return answers;
    },
    status: () => {},
  };
  return { auth, getSchema: () => schema };
}

function page(
  id: string,
  lastEdited: string,
  extra: Partial<NotionSearchResult> = {},
): NotionSearchResult {
  return {
    object: 'page',
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: lastEdited,
    created_time: lastEdited,
    parent: { type: 'workspace' },
    properties: {},
    ...extra,
  };
}

const emptyBlocks = () => jsonResponse(200, { results: [], has_more: false, next_cursor: null });

// Instant clock via createNotionSource's test seam: the client's 3 rps
// throttle resolves immediately instead of really sleeping.
const instantClock = { sleep: async () => {} };

describe('connect', () => {
  it('prompts with a password field (format: password) and rejects a bad token before any fetch', async () => {
    const { fetchFn, calls } = scriptedFetch([]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const { auth, getSchema } = makeAuth({ password: 'not-a-real-token' });

    await expect(source.connect(auth)).rejects.toThrow(/does not look like a Notion/);

    const schema = getSchema() as {
      required: string[];
      properties: Record<string, { format?: string }>;
    };
    expect(schema.required).toContain('password');
    expect(schema.properties.password.format).toBe('password');
    expect(calls).toHaveLength(0);
  });

  it('accepts a valid-looking token, hits /users/me, and returns the workspace name identifier', async () => {
    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(200, { bot: { workspace_name: 'Acme Corp' } }),
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ password: '  secret_abc123  ' });

    const result = await source.connect(auth);

    expect(result.identifier).toBe('Acme Corp');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.notion.com/v1/users/me');
    expect(calls[0].method).toBe('GET');
  });

  it('falls back to the user name, then "notion", when no workspace name is present', async () => {
    const { fetchFn } = scriptedFetch([jsonResponse(200, { name: 'Solo Bot' })]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ password: 'ntn_zzz' });

    const result = await source.connect(auth);

    expect(result.identifier).toBe('Solo Bot');
  });

  it('propagates a non-2xx failure from GET /users/me (e.g. 401) to the caller', async () => {
    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(401, { code: 'unauthorized', message: 'API token is invalid.' }),
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const { auth } = makeAuth({ password: 'secret_deadbeef' });

    let error: unknown;
    try {
      await source.connect(auth);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).httpStatus).toBe(401);
    expect(calls).toHaveLength(1);
  });
});

describe('pull — backfill', () => {
  const T1 = '2024-01-01T00:00:00.000Z';
  const T2 = '2024-01-01T00:01:00.000Z';
  const T3 = '2024-01-01T00:02:00.000Z';
  const T4 = '2024-01-01T00:03:00.000Z';
  const T5 = '2024-01-01T00:04:00.000Z';

  it('hand-pages ascending, skips archived/in_trash, tracks the cursor high-water mark, then flips to live', async () => {
    const p1 = page('p1', T1);
    const p2 = page('p2', T2, { archived: true });
    const p3 = page('p3', T3);
    const p4 = page('p4', T4, { in_trash: true });
    const p5 = page('p5', T5);

    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(200, { results: [p1, p2, p3], has_more: true, next_cursor: 'cursor-2' }),
      emptyBlocks(), // p1 blocks
      emptyBlocks(), // p3 blocks
      jsonResponse(200, { results: [p4, p5], has_more: false, next_cursor: null }),
      emptyBlocks(), // p5 blocks
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession({ password: 'secret_x' });

    const batches: Array<Batch<NotionCursor, NotionItem>> = [];
    for await (const b of source.pull(session, null)) batches.push(b);

    expect(batches).toHaveLength(3);

    expect(batches[0].phase).toBe('backfill');
    expect(batches[0].items.map((i) => i.page.id)).toEqual(['p1', 'p3']);
    expect(batches[0].cursor).toEqual({ lastEditedTime: T3, nextCursor: 'cursor-2' });

    expect(batches[1].phase).toBe('backfill');
    expect(batches[1].items.map((i) => i.page.id)).toEqual(['p5']);
    expect(batches[1].cursor).toEqual({ lastEditedTime: T5, nextCursor: undefined });

    expect(batches[2]).toEqual({ phase: 'live', items: [], cursor: { lastEditedTime: T5 } });

    const searchCalls = calls.filter((c) => c.url.endsWith('/search'));
    expect(searchCalls.map((c) => (c.body as { start_cursor?: string }).start_cursor)).toEqual([
      undefined,
      'cursor-2',
    ]);
    expect(calls.filter((c) => c.url.includes('/blocks/'))).toHaveLength(3);
  });

  it('resumes a stored { lastEditedTime, nextCursor } starting AT that search cursor', async () => {
    const p9 = page('p9', T5);
    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(200, { results: [p9], has_more: false, next_cursor: null }),
      emptyBlocks(), // p9 blocks
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession({ password: 'secret_x' });

    const batches: Array<Batch<NotionCursor, NotionItem>> = [];
    for await (const b of source.pull(session, { lastEditedTime: T1, nextCursor: 'resume-here' })) {
      batches.push(b);
    }

    const searchCall = calls.find((c) => c.url.endsWith('/search'));
    expect((searchCall?.body as { start_cursor?: string }).start_cursor).toBe('resume-here');
    // one backfill batch (has_more already false) + the live flip
    expect(batches).toHaveLength(2);
    expect(batches[0].items.map((i) => i.page.id)).toEqual(['p9']);
  });
});

describe('pull — delta', () => {
  it('descends, stops at the floor (last_edited_time <= floor), ingests newer pages oldest-first, and advances the cursor to the newest ingested', async () => {
    const L0 = '2024-02-01T00:10:00.000Z'; // floor = 00:09:00.000Z
    const newA1 = page('newA1', '2024-02-01T00:15:00.000Z');
    const newA2 = page('newA2', '2024-02-01T00:12:00.000Z');
    const newB1 = page('newB1', '2024-02-01T00:11:00.000Z');
    const tailB2 = page('tailB2', '2024-02-01T00:08:00.000Z'); // at/before the floor

    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(200, { results: [newA1, newA2], has_more: true, next_cursor: 'd2' }),
      jsonResponse(200, { results: [newB1, tailB2], has_more: true, next_cursor: 'd3' }),
      emptyBlocks(), // newB1 blocks (oldest-first)
      emptyBlocks(), // newA2 blocks
      emptyBlocks(), // newA1 blocks
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession({ password: 'secret_x' });

    const batches: Array<Batch<NotionCursor, NotionItem>> = [];
    for await (const b of source.pull(session, { lastEditedTime: L0 })) batches.push(b);

    expect(batches).toHaveLength(1);
    expect(batches[0].phase).toBe('live');
    expect(batches[0].items.map((i) => i.page.id)).toEqual(['newB1', 'newA2', 'newA1']);
    expect(batches[0].cursor).toEqual({ lastEditedTime: '2024-02-01T00:15:00.000Z' });

    // Paging stopped at the floor break — the (never-requested) third page is absent.
    const searchCalls = calls.filter((c) => c.url.endsWith('/search'));
    expect(searchCalls).toHaveLength(2);
  });

  it('yields no batches when nothing is newer than the floor', async () => {
    const L0 = '2024-03-01T00:10:00.000Z';
    const old = page('old1', '2024-03-01T00:05:00.000Z');
    const { fetchFn } = scriptedFetch([
      jsonResponse(200, { results: [old], has_more: true, next_cursor: 'z2' }),
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession({ password: 'secret_x' });

    const batches: Array<Batch<NotionCursor, NotionItem>> = [];
    for await (const b of source.pull(session, { lastEditedTime: L0 })) batches.push(b);

    expect(batches).toHaveLength(0);
  });

  it('folds the scan ceiling into the (single, final) slice cursor when the newest scanned item is skipped (archived) and never ingested', async () => {
    const L0 = '2024-04-01T00:10:00.000Z'; // floor = 00:09:00.000Z
    const skippedNewest = page('skippedNewest', '2024-04-01T00:20:00.000Z', { archived: true });
    const p1 = page('p1', '2024-04-01T00:15:00.000Z');
    const p2 = page('p2', '2024-04-01T00:12:00.000Z');
    const tail = page('tail', '2024-04-01T00:08:00.000Z'); // at/before the floor — stops paging

    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(200, {
        results: [skippedNewest, p1, p2, tail],
        has_more: true,
        next_cursor: 'd2',
      }),
      emptyBlocks(), // p2 blocks (oldest-first)
      emptyBlocks(), // p1 blocks
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession({ password: 'secret_x' });

    const batches: Array<Batch<NotionCursor, NotionItem>> = [];
    for await (const b of source.pull(session, { lastEditedTime: L0 })) batches.push(b);

    expect(batches).toHaveLength(1);
    expect(batches[0].items.map((i) => i.page.id)).toEqual(['p2', 'p1']);
    // the scan ceiling (skippedNewest's time) folds into the final slice's cursor...
    expect(batches[0].cursor).toEqual({ lastEditedTime: skippedNewest.last_edited_time });
    // ...even though the skipped item itself is never ingested.
    expect(batches[0].items.some((i) => i.page.id === 'skippedNewest')).toBe(false);

    // only one search page requested — the floor break stopped paging before page 2.
    expect(calls.filter((c) => c.url.endsWith('/search'))).toHaveLength(1);
  });

  it('slices >20 collected pages into oldest-first batches whose cursors only ever cover what that slice (and earlier ones) fully ingested, folding the scan ceiling only into the final slice', async () => {
    const L0 = '2024-05-01T01:00:00.000Z'; // floor = 2024-05-01T00:59:00.000Z
    const skippedNewest = page('skippedNewest', '2024-05-01T02:00:00.000Z', { archived: true });
    // 25 real pages, descending: page1 newest .. page25 oldest (all still above the floor).
    const pages = Array.from({ length: 25 }, (_, idx) => {
      const k = idx + 1;
      const t = new Date(Date.parse(L0) + (26 - k) * 60_000).toISOString();
      return page(`page${k}`, t);
    });

    const { fetchFn, calls } = scriptedFetch([
      jsonResponse(200, {
        results: [skippedNewest, ...pages],
        has_more: false,
        next_cursor: null,
      }),
      ...Array.from({ length: 25 }, () => emptyBlocks()),
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession({ password: 'secret_x' });

    const batches: Array<Batch<NotionCursor, NotionItem>> = [];
    for await (const b of source.pull(session, { lastEditedTime: L0 })) batches.push(b);

    expect(batches).toHaveLength(2);

    // first (intermediate) batch: the 20 oldest, oldest-first (page25 .. page6).
    const expectedFirstIds = Array.from({ length: 20 }, (_, i) => `page${25 - i}`);
    expect(batches[0].items.map((i) => i.page.id)).toEqual(expectedFirstIds);
    // its cursor covers only the newest page WITHIN this slice (page6 = pages[5]) —
    // it does not jump ahead to slice 2's pages or to the global scan ceiling.
    expect(batches[0].cursor).toEqual({ lastEditedTime: pages[5].last_edited_time });
    expect(batches[0].cursor.lastEditedTime).not.toBe(skippedNewest.last_edited_time);

    // final batch: the remaining 5 newest, oldest-first (page5 .. page1).
    const expectedSecondIds = Array.from({ length: 5 }, (_, i) => `page${5 - i}`);
    expect(batches[1].items.map((i) => i.page.id)).toEqual(expectedSecondIds);
    // every real page is now ingested, so the final slice folds in the scan ceiling.
    expect(batches[1].cursor).toEqual({ lastEditedTime: skippedNewest.last_edited_time });

    // the skipped item is never ingested, across either batch.
    const allIds = [...batches[0].items, ...batches[1].items].map((i) => i.page.id);
    expect(allIds).toHaveLength(25);
    expect(allIds).not.toContain('skippedNewest');

    expect(calls.filter((c) => c.url.endsWith('/search'))).toHaveLength(1);
  });
});

describe('pull — missing credentials', () => {
  it('throws telling the user to reconnect the account, before any fetch', async () => {
    const { fetchFn, calls } = scriptedFetch([]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession(null);

    await expect(
      (async () => {
        // eslint-disable-next-line no-unused-vars
        for await (const _batch of source.pull(session, null)) {
          // drain
        }
      })(),
    ).rejects.toThrow(/reconnect the account/);
    expect(calls).toHaveLength(0);
  });
});

describe('reconcile', () => {
  it('yields externalId refs per search page, skipping archived/in_trash', async () => {
    const a = page('ra', '2024-01-01T00:00:00.000Z');
    const b = page('rb', '2024-01-01T00:00:00.000Z', { archived: true });
    const c = page('rc', '2024-01-01T00:00:00.000Z', { in_trash: true });
    const { fetchFn } = scriptedFetch([
      jsonResponse(200, { results: [a, b, c], has_more: false, next_cursor: null }),
    ]);
    const source = createNotionSource(makeHost(fetchFn), instantClock);
    const session = makeSession({ password: 'secret_x' });

    const refs: ExternalRef[] = [];
    for await (const batch of source.reconcile!(session)) refs.push(...batch);

    expect(refs).toEqual([{ externalId: 'ra', type: 'notion.page' }]);
  });
});

describe('toDocument', () => {
  it('maps fields exactly — pure, no client involved', () => {
    const source = createNotionSource(
      makeHost(async () => {
        throw new Error('toDocument must never touch the network');
      }),
    );
    const item: NotionItem = {
      page: {
        object: 'page',
        id: 'pg1',
        url: 'https://notion.so/pg1',
        last_edited_time: '2024-05-01T00:00:00.000Z',
        created_time: '2024-04-01T00:00:00.000Z',
        parent: { type: 'database_id' },
        properties: {
          Name: { type: 'title', title: [{ plain_text: 'Hello' }] },
        },
      },
      markdown: '# Hello\n\nbody',
    };

    const doc = source.toDocument(item);

    expect(doc).toEqual({
      externalId: 'pg1',
      type: 'notion.page',
      title: 'Hello',
      markdown: '# Hello\n\nbody',
      url: 'https://notion.so/pg1',
      metadata: {
        parentType: 'database_id',
        lastEditedTime: '2024-05-01T00:00:00.000Z',
        createdTime: '2024-04-01T00:00:00.000Z',
      },
      createdAt: '2024-05-01T00:00:00.000Z',
    });
  });
});
