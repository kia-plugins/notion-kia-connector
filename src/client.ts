/**
 * v2 port of v1 `src/client.ts` (see `git show main:src/client.ts` in this
 * repo). Preserved verbatim: API base, notion-version header, the 3-rps
 * throttle, 429 handling (retry-after clamp, ≤5 retries), transient
 * network/5xx exponential backoff (1s × 2^n, ≤4 retries), NotionApiError with
 * 401 pass-through, and both paginators.
 *
 * Deltas from v1:
 *  1. All I/O goes through `deps.fetch` — the host's `net.fetch` surface —
 *     NEVER the global fetch. v1 called `fetchFn ?? fetch` directly against a
 *     Web Response; here the host resolves to a plain object (status /
 *     statusText / headers (lowercase keys) / body: Uint8Array), so responses
 *     are parsed manually (JSON.parse(new TextDecoder().decode(body))) and
 *     there is no `.ok` — computed from `status`.
 *  2. Token is a constructor dep (one client instance per pull — see Task 13),
 *     sent as `authorization: Bearer ${token}` — v1 read it via getToken().
 *  3. `sleep`/`now` are injectable (default: real timer / Date.now) so tests
 *     never actually wait — v1 had the same seam (sleepFn/nowFn).
 *  4. Dropped: users directory, safeStorage/token-blob code, `db` access —
 *     v2's client is fetch-only.
 */

export type NetFetch = (url: string, init?: unknown) => Promise<unknown>;

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
/** Notion's published average limit is ~3 requests/second. */
export const REQUESTS_PER_SECOND = 3;
const MIN_INTERVAL_MS = Math.ceil(1000 / REQUESTS_PER_SECOND);
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = 1_000; // 1s, 2s, 4s, 8s
const MAX_RATE_LIMIT_RETRIES = 5;

/** The host `net.fetch` surface resolves to this shape — header keys are
 *  lowercase (built via Object.fromEntries(res.headers.entries())). */
interface HostResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface NotionPageEnvelope<T> {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** code=401 makes the scheduler's isAuthError() flag the account needs_reauth. */
export class NotionApiError extends Error {
  constructor(
    public notionCode: string,
    public httpStatus: number,
    message: string,
  ) {
    super(`notion ${notionCode}: ${message}`);
    this.name = 'NotionApiError';
  }
}

export interface NotionClientDeps {
  fetch: NetFetch;
  token: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class NotionClient {
  requestCount = 0;

  private lastCallAt = 0;

  private readonly fetchFn: NetFetch;

  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly now: () => number;

  constructor(private readonly deps: NotionClientDeps) {
    this.fetchFn = deps.fetch;
    this.sleepFn =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleepFn(wait);
    this.lastCallAt = this.now();
    this.requestCount += 1;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST',
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    let transient = 0;
    let rateLimited = 0;
    for (;;) {
      await this.throttle();
      let res: HostResponse;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = (await this.fetchFn(`${NOTION_API_BASE}${pathname}`, {
          method,
          headers: {
            authorization: `Bearer ${this.deps.token}`,
            'notion-version': NOTION_VERSION,
            'content-type': 'application/json',
          },
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        })) as HostResponse;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(
            `notion ${pathname}: network error after ${transient + 1} attempts: ${msg}`,
          );
        transient += 1;
        // eslint-disable-next-line no-await-in-loop
        await this.sleepFn(TRANSIENT_BACKOFF_MS * 2 ** (transient - 1));
        continue;
      }
      if (res.status === 429) {
        if (rateLimited >= MAX_RATE_LIMIT_RETRIES)
          throw new Error(
            `notion ${pathname}: HTTP 429 after ${rateLimited + 1} attempts`,
          );
        rateLimited += 1;
        // retry-after may be missing or non-numeric; both must not collapse
        // to a 0ms busy-retry. Default to 5s, floor 1s, cap 60s.
        const raw = Number(res.headers['retry-after']);
        const after = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 60) : 5;
        // eslint-disable-next-line no-await-in-loop
        await this.sleepFn(after * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(
            `notion ${pathname}: HTTP ${res.status} after ${transient + 1} attempts`,
          );
        transient += 1;
        // eslint-disable-next-line no-await-in-loop
        await this.sleepFn(TRANSIENT_BACKOFF_MS * 2 ** (transient - 1));
        continue;
      }
      const json = JSON.parse(new TextDecoder().decode(res.body)) as T & {
        code?: string;
        message?: string;
      };
      const ok = res.status >= 200 && res.status < 300;
      if (!ok)
        throw new NotionApiError(
          json.code ?? 'unknown_error',
          res.status,
          json.message ?? `HTTP ${res.status}`,
        );
      return json;
    }
  }

  /** Iterate a POST cursor-paginated endpoint (search, databases/{id}/query),
   *  yielding each page's `results` array. */
  async *paginate<T>(
    pathname: string,
    body: Record<string, unknown>,
  ): AsyncGenerator<T[]> {
    let cursor: string | undefined;
    do {
      const page = await this.request<NotionPageEnvelope<T>>('POST', pathname, {
        ...body,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      yield page.results ?? [];
      cursor = page.has_more ? page.next_cursor || undefined : undefined;
    } while (cursor);
  }

  /** GET cursor-paginated endpoint (blocks/{id}/children) — cursor is a query param. */
  async *paginateGet<T>(pathname: string): AsyncGenerator<T[]> {
    let cursor: string | undefined;
    do {
      const q = cursor
        ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100`
        : '?page_size=100';
      const page = await this.request<NotionPageEnvelope<T>>(
        'GET',
        `${pathname}${q}`,
      );
      yield page.results ?? [];
      cursor = page.has_more ? page.next_cursor || undefined : undefined;
    } while (cursor);
  }
}
