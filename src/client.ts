import { setTimeout as nodeSleep } from 'node:timers/promises';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';
/** Notion's published average limit is ~3 requests/second. */
export const REQUESTS_PER_SECOND = 3;
const MIN_INTERVAL_MS = Math.ceil(1000 / REQUESTS_PER_SECOND);
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = 1_000; // 1s, 2s, 4s, 8s
const MAX_RATE_LIMIT_RETRIES = 5;

/** code=401 makes the scheduler's isAuthError() flag the account needs_reauth. */
export class NotionApiError extends Error {
  readonly code?: number;

  constructor(
    readonly notionCode: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(`notion ${notionCode}: ${message}`);
    this.name = 'NotionApiError';
    if (httpStatus === 401) this.code = 401;
  }
}

export interface NotionClientDeps {
  getToken: () => string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

interface NotionPageEnvelope<T> {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export class NotionClient {
  requestCount = 0;

  private lastCallAt = 0;

  private readonly fetchFn: typeof fetch;

  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly now: () => number;

  constructor(private readonly deps: NotionClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepFn = deps.sleepFn ?? (async (ms) => void (await nodeSleep(ms)));
    this.now = deps.nowFn ?? Date.now;
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
    body?: Record<string, unknown>,
  ): Promise<T> {
    let transient = 0;
    let rateLimited = 0;
    for (;;) {
      await this.throttle();
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await this.fetchFn(`${NOTION_API_BASE}${pathname}`, {
          method,
          headers: {
            authorization: `Bearer ${this.deps.getToken()}`,
            'notion-version': NOTION_VERSION,
            'content-type': 'application/json',
          },
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        });
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
        // Retry-After may be missing or a non-numeric HTTP-date; both must not
        // collapse to a 0ms busy-retry. Default to 5s, floor 1s, cap 60s.
        const raw = Number(res.headers.get('retry-after'));
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
      // eslint-disable-next-line no-await-in-loop
      const json = (await res.json()) as T & {
        code?: string;
        message?: string;
      };
      if (!res.ok)
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
