import crypto from 'node:crypto';
import type { ConnectorHost, DocumentId } from '@alpha-cent/connector-sdk';
import type { NotionClient } from './client';
import type { NotionUserDirectory } from './users';
import { renderBlocks } from './render';
import type { BlockNode, NotionPage, NotionProperty } from './types';

export interface NotionPageArgs {
  ctx: ConnectorHost;
  client: NotionClient;
  users: NotionUserDirectory;
  accountId: bigint;
  workspace: string;
}

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s).digest('hex');

/** child_page / child_database are separate documents — never recurse into them. */
const RECURSE_EXCLUDED = new Set(['child_page', 'child_database']);

export async function fetchBlockTree(
  client: NotionClient,
  blockId: string,
): Promise<BlockNode[]> {
  const out: BlockNode[] = [];
  for await (const blocks of client.paginateGet<BlockNode>(
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

export function pageTitle(p: NotionPage): string {
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop.type === 'title') {
      const text = (prop.title ?? [])
        .map((r) => r.plain_text)
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return 'Untitled';
}

function propValue(prop: NotionProperty): string {
  switch (prop.type) {
    case 'rich_text':
      return (prop.rich_text ?? []).map((r) => r.plain_text).join('');
    case 'select':
      return prop.select?.name ?? '';
    case 'status':
      return prop.status?.name ?? '';
    case 'multi_select':
      return (prop.multi_select ?? [])
        .map((s) => s.name)
        .filter(Boolean)
        .join(', ');
    case 'date':
      return [prop.date?.start, prop.date?.end].filter(Boolean).join(' → ');
    case 'number':
      return prop.number == null ? '' : String(prop.number);
    case 'checkbox':
      return prop.checkbox ? '✓' : '✗';
    case 'url':
      return prop.url ?? '';
    case 'email':
      return prop.email ?? '';
    case 'phone_number':
      return prop.phone_number ?? '';
    case 'people':
      return (prop.people ?? [])
        .map((p) => p.name ?? p.id ?? '')
        .filter(Boolean)
        .join(', ');
    default:
      return '';
  }
}

/** Database-row properties (excluding the title) → a key/value preamble. */
export function renderProperties(p: NotionPage): string {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(p.properties ?? {})) {
    if (prop.type === 'title') continue;
    const v = propValue(prop);
    if (v) lines.push(`**${name}:** ${v}`);
  }
  return lines.join('\n');
}

export async function upsertPage(
  args: NotionPageArgs,
  p: NotionPage,
): Promise<DocumentId> {
  const tree = await fetchBlockTree(args.client, p.id);
  const body = renderBlocks(tree, args.users.resolve);
  const preamble = p.parent.type === 'database_id' ? renderProperties(p) : '';
  const title = pageTitle(p);
  const markdown =
    [preamble, body].filter(Boolean).join('\n\n') || `# ${title}`;
  const author = p.created_by?.id
    ? await args.users.resolveOrFetch(p.created_by.id)
    : undefined;
  return args.ctx.upsertDocument({
    source: 'notion',
    source_id: p.id,
    type: 'notion_page',
    title,
    markdown,
    metadata: {
      workspace: args.workspace,
      parent_type: p.parent.type,
      parent_database_id: p.parent.database_id ?? null,
      parent_page_id: p.parent.page_id ?? null,
      url: p.url,
      created_time: p.created_time,
      last_edited_time: p.last_edited_time,
      author: author ?? null,
    },
    source_url: p.url,
    content_hash: sha256(`${title}\n${markdown}`),
    from_address: author?.toLowerCase(),
    created_at: new Date(p.created_time),
  });
}
