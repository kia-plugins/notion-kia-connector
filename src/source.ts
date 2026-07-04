/**
 * Notion v2 source: connect via the engine's password-prompt vault, ascending
 * hand-paged/resumable backfill, descending floor-break delta, full-listing
 * reconcile, and a pure toDocument. See `.superpowers/sdd/task-13-brief.md`
 * (kiagent-core) for the full spec this implements.
 *
 * Delta is deliberately DESCENDING (v1's proven shape, `git show
 * main:src/delta.ts`) even though spec §6 says "ascending" — that wording
 * governs backfill only; Task 14 updates the spec text.
 */
import type { AuthChannel, Batch, HostFor, Session, Source } from './kiagent-contracts';
import { NotionApiError, NotionClient, type NotionClientDeps } from './client';
import type { NotionSearchResult } from './notion-types';
import { buildMarkdown, fetchBlockTree, pageTitle } from './pages';

/** Notion rounds `last_edited_time` to the minute — v1's OVERLAP_MS. Every
 *  delta pull re-scans the trailing minute so an edit landing right at the
 *  rounding boundary is never silently missed. */
const OVERLAP_MS = 60_000;
/** Delta yields ingested pages in small commit-sized slices so a crash
 *  mid-delta only ever loses (and idempotently re-does) a bounded amount of
 *  work, never the whole tick. */
const DELTA_SLICE_SIZE = 20;

export interface NotionCursor {
  /** High-water mark: newest last_edited_time fully ingested (ISO-8601). */
  lastEditedTime: string | null;
  /** Notion pagination cursor mid page-search — crash-safe resume point.
   *  Its presence (with no `phase`) is also how pre-2.1.0 mid-backfill
   *  cursors resume: they re-enter the page phase and then proceed through
   *  the new database phases. */
  nextCursor?: string;
  /** Which post-page backfill phase this cursor resumes. Absent on page-phase
   *  and delta cursors (both pre- and post-2.1.0 shapes). */
  phase?: 'dblist' | 'dbsweep';
  /** Search cursor mid database-discovery (`phase: 'dblist'`). */
  dbListCursor?: string;
  /** Databases discovered but not yet fully row-swept (current one first). */
  dbQueue?: string[];
  /** Row-pagination cursor inside dbQueue[0] (`phase: 'dbsweep'`). */
  dbCursor?: string;
}

export interface NotionItem {
  page: NotionSearchResult;
  markdown: string;
}

async function requireToken(session: Session): Promise<string> {
  const creds = await session.credentials();
  const token = creds?.password;
  if (!token) throw new Error('no Notion credentials — reconnect the account');
  return token;
}

interface SearchEnvelope {
  results?: NotionSearchResult[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function toItem(client: NotionClient, page: NotionSearchResult): Promise<NotionItem> {
  const blocks = await fetchBlockTree(client, page.id);
  return { page, markdown: buildMarkdown(page, blocks) };
}

const isAuthError = (e: unknown): boolean =>
  e instanceof NotionApiError && e.httpStatus === 401;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Ascending, hand-paged (NOT via `client.paginate`), resumable backfill in
 * three phases, each yielding a crash-safe cursor per Notion page (upserts
 * are idempotent by externalId, so re-ingesting a resumed page is harmless):
 *
 *  1. pages — every search-visible page (`filter: page`, ascending).
 *  2. dblist — discover every database (`filter: database`).
 *  3. dbsweep — query each database's rows directly. v1's belt-and-suspenders
 *     (`git show v1.0.0:src/backfill.ts`): the search index lags/misses
 *     database rows, so a database-heavy workspace backfilled from search
 *     alone silently loses most of its documents.
 *
 * When all three finish, flips to a final `live` batch (v1's zero-page floor
 * trick — delta must never see a null cursor).
 */
async function* backfill(
  client: NotionClient,
  session: Session,
  cursor: NotionCursor | null,
): AsyncGenerator<Batch<NotionCursor, NotionItem>> {
  let maxEdited: string | null = cursor?.lastEditedTime ?? null;
  // Rows ingested THIS run (search often returns some db rows; the sweep
  // re-lists them) — skip re-fetching their block trees. Deliberately not
  // persisted: a crash-resume re-ingests at most a page's worth, idempotently.
  const seen = new Set<string>();

  const ingest = async (
    result: NotionSearchResult,
    items: NotionItem[],
    what: string,
  ): Promise<void> => {
    try {
      items.push(await toItem(client, result));
      seen.add(result.id);
      if (maxEdited === null || result.last_edited_time > maxEdited) {
        maxEdited = result.last_edited_time;
      }
    } catch (e) {
      // v1 parity: one unreadable page must not abort the whole walk — skip
      // it (without advancing the high-water mark) and keep going. Auth
      // errors still propagate: every later call would fail identically.
      if (isAuthError(e)) throw e;
      session.log('warn', `notion backfill: ${what} ${result.id} skipped: ${errText(e)}`);
    }
  };

  // Phase 1: pages.
  if (!cursor?.phase) {
    let startCursor = cursor?.nextCursor;
    for (;;) {
      if (session.signal.aborted) return;
      const page = await client.request<SearchEnvelope>('POST', '/search', {
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'ascending', timestamp: 'last_edited_time' },
        page_size: 100,
        start_cursor: startCursor,
      });

      const items: NotionItem[] = [];
      for (const result of page.results ?? []) {
        if (session.signal.aborted) return;
        if (result.archived || result.in_trash) continue;
        await ingest(result, items, 'page');
      }

      if (!page.has_more) {
        yield { phase: 'backfill', items, cursor: { lastEditedTime: maxEdited, phase: 'dblist' } };
        break;
      }
      const next = page.next_cursor ?? undefined;
      yield { phase: 'backfill', items, cursor: { lastEditedTime: maxEdited, nextCursor: next } };
      startCursor = next;
    }
  }

  // Phase 2: discover databases.
  const dbQueue: string[] = [...(cursor?.phase ? (cursor.dbQueue ?? []) : [])];
  if (cursor?.phase !== 'dbsweep') {
    let dbListCursor = cursor?.phase === 'dblist' ? cursor.dbListCursor : undefined;
    for (;;) {
      if (session.signal.aborted) return;
      const page = await client.request<SearchEnvelope>('POST', '/search', {
        filter: { property: 'object', value: 'database' },
        sort: { direction: 'ascending', timestamp: 'last_edited_time' },
        page_size: 100,
        start_cursor: dbListCursor,
      });
      for (const result of page.results ?? []) {
        if (!result.archived && !result.in_trash) dbQueue.push(result.id);
      }
      if (!page.has_more) {
        yield {
          phase: 'backfill',
          items: [],
          cursor: { lastEditedTime: maxEdited, phase: 'dbsweep', dbQueue: [...dbQueue] },
        };
        break;
      }
      dbListCursor = page.next_cursor ?? undefined;
      yield {
        phase: 'backfill',
        items: [],
        cursor: { lastEditedTime: maxEdited, phase: 'dblist', dbListCursor, dbQueue: [...dbQueue] },
      };
    }
  }

  // Phase 3: sweep each database's rows.
  let dbCursor = cursor?.phase === 'dbsweep' ? cursor.dbCursor : undefined;
  while (dbQueue.length > 0) {
    const dbId = dbQueue[0];
    try {
      for (;;) {
        if (session.signal.aborted) return;
        const page = await client.request<SearchEnvelope>('POST', `/databases/${dbId}/query`, {
          page_size: 100,
          ...(dbCursor ? { start_cursor: dbCursor } : {}),
        });
        const items: NotionItem[] = [];
        for (const row of page.results ?? []) {
          if (session.signal.aborted) return;
          if (row.object !== 'page' || row.archived || row.in_trash || seen.has(row.id)) continue;
          await ingest(row, items, 'row');
        }
        if (!page.has_more) {
          dbQueue.shift();
          dbCursor = undefined;
          yield {
            phase: 'backfill',
            items,
            cursor: { lastEditedTime: maxEdited, phase: 'dbsweep', dbQueue: [...dbQueue] },
          };
          break;
        }
        dbCursor = page.next_cursor ?? undefined;
        yield {
          phase: 'backfill',
          items,
          cursor: { lastEditedTime: maxEdited, phase: 'dbsweep', dbQueue: [...dbQueue], dbCursor },
        };
      }
    } catch (e) {
      // v1 parity: one broken/unshared database must not abort the sweep —
      // pop it (the yielded cursor makes that durable) and move on.
      if (isAuthError(e)) throw e;
      session.log('warn', `notion backfill: database ${dbId} query failed: ${errText(e)}`);
      dbQueue.shift();
      dbCursor = undefined;
      yield {
        phase: 'backfill',
        items: [],
        cursor: { lastEditedTime: maxEdited, phase: 'dbsweep', dbQueue: [...dbQueue] },
      };
    }
  }

  yield {
    phase: 'live',
    items: [],
    cursor: { lastEditedTime: maxEdited ?? new Date(0).toISOString() },
  };
}

/**
 * Descending floor-break delta — v1's proven shape (`git show
 * main:src/delta.ts`). Scans newest-first until an item's last_edited_time
 * falls at or before `floorMs`, collecting non-archived/non-trashed PAGES
 * (non-page objects and trashed/archived pages still advance the scan
 * ceiling so a burst of trash-only activity can't stall the cursor forever,
 * but are never ingested). Collected pages are then ingested oldest-first in
 * slices, each yield's cursor covering only what that slice (and the ones
 * before it) fully ingested — except the LAST slice, which may also fold in
 * the scan ceiling, since by then every real page has been ingested.
 */
async function* delta(
  client: NotionClient,
  session: Session,
  cursor: NotionCursor,
): AsyncGenerator<Batch<NotionCursor, NotionItem>> {
  const startEdited = cursor.lastEditedTime;
  if (startEdited === null) return; // unreachable given pull()'s dispatch guard

  const floorMs = Date.parse(startEdited) - OVERLAP_MS;
  let scanMax = startEdited;
  const collected: NotionSearchResult[] = [];

  // eslint-disable-next-line no-labels -- early-exit across both pagination loops (v1 delta.ts)
  outer: for await (const results of client.paginate<NotionSearchResult>('/search', {
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  })) {
    for (const r of results) {
      if (session.signal.aborted) return;
      if (Date.parse(r.last_edited_time) <= floorMs) break outer; // reached unchanged tail
      if (r.last_edited_time > scanMax) scanMax = r.last_edited_time;
      if (r.object !== 'page' || r.archived || r.in_trash) continue;
      collected.push(r);
    }
  }

  if (collected.length === 0) {
    // Trash-only/database-only window: no real page to ingest, but the scan
    // ceiling still advanced past the incoming floor — yield one empty batch
    // so the cursor advances too (v1 did this; otherwise every 30-minute
    // cadence re-scans an ever-widening window forever). If nothing was
    // scanned above the floor at all, scanMax === startEdited and there is
    // truly nothing new — return without yielding, as before.
    if (scanMax > startEdited) {
      yield { phase: 'live', items: [], cursor: { lastEditedTime: scanMax } };
    }
    return;
  }

  collected.reverse(); // oldest-first: the cursor only ever advances forward

  let ingestedMax = startEdited;
  for (let i = 0; i < collected.length; i += DELTA_SLICE_SIZE) {
    if (session.signal.aborted) return;
    const slice = collected.slice(i, i + DELTA_SLICE_SIZE);
    const items: NotionItem[] = [];
    for (const page of slice) {
      if (session.signal.aborted) return;
      try {
        items.push(await toItem(client, page));
        if (page.last_edited_time > ingestedMax) ingestedMax = page.last_edited_time;
      } catch (e) {
        // v1 parity: one bad page must not abort the tick; it does not
        // advance the cursor itself (though newer successes may pass it —
        // the same trade v1 made). Auth errors still propagate.
        if (isAuthError(e)) throw e;
        session.log('warn', `notion delta: page ${page.id} skipped: ${errText(e)}`);
      }
    }
    const isLastSlice = i + DELTA_SLICE_SIZE >= collected.length;
    const lastEditedTime = isLastSlice && scanMax > ingestedMax ? scanMax : ingestedMax;
    yield { phase: 'live', items, cursor: { lastEditedTime } };
  }
}

export function createNotionSource(
  host: HostFor<'net'>,
  // Test seam only: NotionClient's sleep/now are injectable so tests never
  // actually wait out the 3 rps throttle; production callers omit this.
  clock?: Pick<NotionClientDeps, 'sleep' | 'now'>,
): Source<NotionCursor, NotionItem> {
  return {
    descriptor: {
      id: 'notion',
      name: 'Notion',
      documentTypes: ['notion.page'],
      auth: 'password',
      cadence: { every: '30m' },
    },

    async connect(auth: AuthChannel) {
      const answers = await auth.prompt({
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', title: 'Internal Integration Secret', format: 'password' },
        },
      });
      const token = typeof answers.password === 'string' ? answers.password.trim() : '';
      if (!/^(ntn_|secret_)/.test(token)) {
        throw new Error(
          'that does not look like a Notion internal integration secret (ntn_… or secret_…)',
        );
      }
      const client = new NotionClient({ fetch: host.net.fetch, token, ...clock });
      const me = await client.request<{ name?: string; bot?: { workspace_name?: string } }>(
        'GET',
        '/users/me',
      );
      return { identifier: me.bot?.workspace_name ?? me.name ?? 'notion', config: {} };
    },

    async *pull(session: Session, cursor: NotionCursor | null) {
      const token = await requireToken(session);
      const client = new NotionClient({ fetch: host.net.fetch, token, ...clock });
      if (
        cursor === null ||
        cursor.lastEditedTime === null ||
        cursor.nextCursor ||
        cursor.phase
      ) {
        yield* backfill(client, session, cursor);
      } else {
        yield* delta(client, session, cursor);
      }
    },

    toDocument({ page, markdown }: NotionItem) {
      return {
        externalId: page.id,
        type: 'notion.page',
        title: pageTitle(page),
        markdown,
        url: page.url,
        metadata: {
          parentType: page.parent?.type,
          lastEditedTime: page.last_edited_time,
          createdTime: page.created_time,
        },
        createdAt: page.last_edited_time,
      };
    },

    async *reconcile(session: Session) {
      const token = await requireToken(session);
      const client = new NotionClient({ fetch: host.net.fetch, token, ...clock });
      for await (const results of client.paginate<NotionSearchResult>('/search', {
        filter: { property: 'object', value: 'page' },
        page_size: 100,
      })) {
        if (session.signal.aborted) return;
        yield results
          .filter((p) => !p.archived && !p.in_trash)
          .map((p) => ({ externalId: p.id, type: 'notion.page' }));
      }
      // Database rows too — the search index misses some, and backfill sweeps
      // them (phase 3), so a page-search-only live-set would archive every
      // swept-only row on the very next cycle. A database failure here
      // PROPAGATES, unlike backfill's per-db skip: the engine treats a thrown
      // reconcile as a partial listing and skips the deletion diff, whereas
      // swallowing it would hand the engine a complete-looking listing minus
      // one database's rows.
      const dbs: string[] = [];
      for await (const results of client.paginate<NotionSearchResult>('/search', {
        filter: { property: 'object', value: 'database' },
        page_size: 100,
      })) {
        if (session.signal.aborted) return;
        for (const d of results) if (!d.archived && !d.in_trash) dbs.push(d.id);
      }
      for (const dbId of dbs) {
        for await (const rows of client.paginate<NotionSearchResult>(
          `/databases/${dbId}/query`,
          { page_size: 100 },
        )) {
          if (session.signal.aborted) return;
          yield rows
            .filter((p) => p.object === 'page' && !p.archived && !p.in_trash)
            .map((p) => ({ externalId: p.id, type: 'notion.page' }));
        }
      }
    },
  };
}
