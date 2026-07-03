/**
 * v2 port of v1 `src/page-builder.ts` (see `git show main:src/page-builder.ts`
 * in this repo), plus v1's `fetchBlockTree` (previously in `client.ts`'s
 * caller, `page-builder.ts`). Deltas: no `ConnectorHost`/`upsertDocument`
 * wiring (Task 13 owns turning this into a Source pull), no author
 * resolution (v1 resolved `created_by` via a user directory — dropped along
 * with the mention/user-directory delta in render.ts); `people` properties
 * render whatever names are present in the payload, no directory lookups.
 */
import type { NotionClient } from './client';
import type { NotionBlock } from './notion-types';
import { renderBlocks } from './render';
import type { NotionItem } from './source';

/** child_page / child_database are separate documents — never recurse into them. */
const RECURSE_EXCLUDED = new Set(['child_page', 'child_database']);

/** Recursively fetch a block's children (and grandchildren, ...) via
 *  `/blocks/{id}/children`, never recursing into child_page/child_database
 *  (those are separate documents). */
export async function fetchBlockTree(
  client: NotionClient,
  blockId: string,
): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  for await (const blocks of client.paginateGet<NotionBlock>(
    `/blocks/${blockId}/children`,
  )) {
    for (const b of blocks) {
      if (b.has_children && !RECURSE_EXCLUDED.has(b.type)) {
        b.children = await fetchBlockTree(client, b.id);
      }
      out.push(b);
    }
  }
  return out;
}

/** v1's title-property extraction: the first `title`-typed property with
 *  non-empty text, or null if the page has none. */
export function pageTitle(page: NotionItem['page']): string | null {
  for (const prop of Object.values(page.properties ?? {})) {
    const p = prop as { type?: string; title?: Array<{ plain_text: string }> };
    if (p?.type === 'title') {
      const text = (p.title ?? [])
        .map((r) => r.plain_text)
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return null;
}

function propValue(prop: Record<string, unknown>): string {
  switch (prop.type as string | undefined) {
    case 'rich_text':
      return (
        (prop.rich_text as Array<{ plain_text: string }> | undefined) ?? []
      )
        .map((r) => r.plain_text)
        .join('');
    case 'select':
      return (prop.select as { name?: string } | null | undefined)?.name ?? '';
    case 'status':
      return (prop.status as { name?: string } | null | undefined)?.name ?? '';
    case 'multi_select':
      return (
        (prop.multi_select as Array<{ name?: string }> | undefined) ?? []
      )
        .map((s) => s.name)
        .filter(Boolean)
        .join(', ');
    case 'date': {
      const d = prop.date as
        | { start?: string; end?: string | null }
        | null
        | undefined;
      return [d?.start, d?.end].filter(Boolean).join(' → ');
    }
    case 'number': {
      const n = prop.number as number | null | undefined;
      return n == null ? '' : String(n);
    }
    case 'checkbox':
      return prop.checkbox ? '✓' : '✗';
    case 'url':
      return (prop.url as string | null | undefined) ?? '';
    case 'email':
      return (prop.email as string | null | undefined) ?? '';
    case 'phone_number':
      return (prop.phone_number as string | null | undefined) ?? '';
    case 'people':
      return (
        (prop.people as Array<{ id?: string; name?: string }> | undefined) ??
        []
      )
        .map((p) => p.name ?? p.id ?? '')
        .filter(Boolean)
        .join(', ');
    default:
      return '';
  }
}

/** Database-row properties (excluding the title) → a key/value preamble. */
function renderProperties(page: NotionItem['page']): string {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(page.properties ?? {})) {
    const p = prop as Record<string, unknown>;
    if (p?.type === 'title') continue;
    const v = propValue(p);
    if (v) lines.push(`**${name}:** ${v}`);
  }
  return lines.join('\n');
}

/** Preamble (database rows only) + rendered body, falling back to a bare
 *  `# Title` heading when there's neither. */
export function buildMarkdown(
  page: NotionItem['page'],
  blocks: NotionBlock[],
): string {
  const body = renderBlocks(blocks);
  const preamble =
    page.parent?.type === 'database_id' ? renderProperties(page) : '';
  const combined = [preamble, body].filter(Boolean).join('\n\n');
  if (combined) return combined;
  return `# ${pageTitle(page) ?? 'Untitled'}`;
}
