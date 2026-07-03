/**
 * v1 has no client.test.ts (client.ts was untested there — see `git ls-tree
 * main src/__tests__/`); this suite is new for the v2 port, per the task
 * brief's Step 3. Fetch is fully scripted (no real network), and `sleep` is
 * recorded rather than awaited for real — a fake, test-driven `now()` clock
 * advances only when `sleep` is invoked, so throttle/backoff math is exact
 * and the suite runs instantly.
 */
import { NotionApiError, NotionClient, type NetFetch } from '../client';

function jsonResponse(
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
) {
  return {
    status,
    statusText: '',
    headers,
    body: new TextEncoder().encode(JSON.stringify(json)),
  };
}

function makeClient(fetchFn: NetFetch, token = 'secret-token') {
  const sleeps: number[] = [];
  let clock = 1_000_000; // arbitrary starting point >> MIN_INTERVAL_MS
  const client = new NotionClient({
    fetch: fetchFn,
    token,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms; // model sleep as elapsed time for throttle math
    },
    now: () => clock,
  });
  return { client, sleeps };
}

describe('NotionClient', () => {
  it('sends the bearer token, notion-version header, and hits the v1 base URL', async () => {
    const fetchFn = jest.fn(async (_url: string, _init?: unknown) =>
      jsonResponse(200, { ok: true }),
    );
    const { client } = makeClient(fetchFn, 'tok-abc');

    const result = await client.request('GET', '/users/me');

    expect(result).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.notion.com/v1/users/me');
    expect(init.headers.authorization).toBe('Bearer tok-abc');
    expect(init.headers['notion-version']).toBe('2022-06-28');
  });

  it('throttles consecutive requests to >= 334ms apart (3 rps)', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(200, {}));
    const { client, sleeps } = makeClient(fetchFn);

    await client.request('GET', '/users/me');
    await client.request('GET', '/users/me');

    expect(sleeps).toEqual([334]);
  });

  it('retries a 429 honoring retry-after, then returns the successful result', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call === 1)
        return jsonResponse(429, { code: 'rate_limited' }, { 'retry-after': '2' });
      return jsonResponse(200, { done: true });
    });
    const { client, sleeps } = makeClient(fetchFn);

    const result = await client.request('GET', '/search');

    expect(sleeps).toEqual([2000]);
    expect(result).toEqual({ done: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('clamps a retry-after above 60s down to 60000ms', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, {}, { 'retry-after': '999' });
      return jsonResponse(200, {});
    });
    const { client, sleeps } = makeClient(fetchFn);

    await client.request('GET', '/search');

    expect(sleeps).toEqual([60000]);
  });

  it('defaults to 5000ms when retry-after is missing', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, {});
      return jsonResponse(200, {});
    });
    const { client, sleeps } = makeClient(fetchFn);

    await client.request('GET', '/search');

    expect(sleeps).toEqual([5000]);
  });

  it('gives up after 5 rate-limit retries', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(429, {}, { 'retry-after': '1' }));
    const { client, sleeps } = makeClient(fetchFn);

    await expect(client.request('GET', '/search')).rejects.toThrow(/429/);
    expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('backs off 1000/2000/4000/8000ms on repeated 500s, then throws', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(500, {}));
    const { client, sleeps } = makeClient(fetchFn);

    await expect(client.request('GET', '/search')).rejects.toThrow(/500/);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('throws NotionApiError with httpStatus 401 and no retry', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(401, { code: 'unauthorized', message: 'API token is invalid.' }),
    );
    const { client } = makeClient(fetchFn);

    let error: unknown;
    try {
      await client.request('GET', '/users/me');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).httpStatus).toBe(401);
    expect((error as NotionApiError).notionCode).toBe('unauthorized');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('paginate follows next_cursor to exhaustion via POST start_cursor', async () => {
    const pages = [
      { results: ['a', 'b'], has_more: true, next_cursor: 'cursor-2' },
      { results: ['c'], has_more: true, next_cursor: 'cursor-3' },
      { results: ['d'], has_more: false, next_cursor: null },
    ];
    let call = 0;
    const seenCursors: Array<string | undefined> = [];
    const fetchFn = jest.fn(async (_url: string, init?: unknown) => {
      const { body } = init as { body: string };
      seenCursors.push((JSON.parse(body) as { start_cursor?: string }).start_cursor);
      const page = pages[call];
      call += 1;
      return jsonResponse(200, page);
    });
    const { client } = makeClient(fetchFn);

    const collected: string[] = [];
    for await (const batch of client.paginate<string>('/databases/db1/query', {
      filter: {},
    })) {
      collected.push(...batch);
    }

    expect(collected).toEqual(['a', 'b', 'c', 'd']);
    expect(seenCursors).toEqual([undefined, 'cursor-2', 'cursor-3']);
  });

  it('paginateGet builds the ?start_cursor=&page_size=100 query string', async () => {
    const pages = [
      { results: ['x'], has_more: true, next_cursor: 'next-1' },
      { results: ['y'], has_more: false, next_cursor: null },
    ];
    let call = 0;
    const seenUrls: string[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      seenUrls.push(url);
      const page = pages[call];
      call += 1;
      return jsonResponse(200, page);
    });
    const { client } = makeClient(fetchFn);

    const collected: string[] = [];
    for await (const batch of client.paginateGet<string>('/blocks/page1/children')) {
      collected.push(...batch);
    }

    expect(collected).toEqual(['x', 'y']);
    expect(seenUrls).toEqual([
      'https://api.notion.com/v1/blocks/page1/children?page_size=100',
      'https://api.notion.com/v1/blocks/page1/children?start_cursor=next-1&page_size=100',
    ]);
  });
});
