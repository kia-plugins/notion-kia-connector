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
import { NotionClient, type NotionClientDeps } from './client';
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
  /** Notion pagination cursor mid-backfill — crash-safe resume point. */
  nextCursor?: string;
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

/**
 * Ascending, hand-paged (NOT via `client.paginate`), resumable backfill: each
 * search page yields its own batch carrying Notion's own `next_cursor`, so a
 * crash mid-page resumes AT that page — upserts are idempotent by
 * externalId, so re-ingesting it is harmless. When Notion reports no more
 * pages, flips to a final `live` batch (v1's zero-page floor trick — delta
 * must never see a null cursor).
 */
async function* backfill(
  client: NotionClient,
  session: Session,
  cursor: NotionCursor | null,
): AsyncGenerator<Batch<NotionCursor, NotionItem>> {
  let startCursor = cursor?.nextCursor;
  let maxEdited: string | null = cursor?.lastEditedTime ?? null;

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
      items.push(await toItem(client, result));
      if (maxEdited === null || result.last_edited_time > maxEdited) {
        maxEdited = result.last_edited_time;
      }
    }

    const next = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    yield {
      phase: 'backfill',
      items,
      cursor: { lastEditedTime: maxEdited, nextCursor: next },
    };

    if (!page.has_more) {
      yield {
        phase: 'live',
        items: [],
        cursor: { lastEditedTime: maxEdited ?? new Date(0).toISOString() },
      };
      return;
    }
    startCursor = next;
  }
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
      items.push(await toItem(client, page));
      if (page.last_edited_time > ingestedMax) ingestedMax = page.last_edited_time;
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
      if (cursor === null || cursor.lastEditedTime === null || cursor.nextCursor) {
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
    },
  };
}
