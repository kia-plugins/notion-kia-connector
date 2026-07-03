/**
 * v2 port of v1 `src/render.ts` (see `git show main:src/render.ts` in this
 * repo) — near-verbatim. ONE delta: v1's `@mention` user resolution (an
 * injected `resolve` callback) is dropped; mention spans render their
 * `plain_text` directly, so `renderRichText`/`renderBlock`/`renderBlocks` no
 * longer take a resolver argument.
 */
import type { NotionBlock, NotionRichText } from './notion-types';

export function renderRichText(rts: NotionRichText[] | undefined): string {
  if (!rts?.length) return '';
  return rts
    .map((r) => {
      let text = r.plain_text;
      const a = r.annotations ?? {};
      if (a.code) text = `\`${text}\``;
      if (a.bold) text = `**${text}**`;
      if (a.italic) text = `*${text}*`;
      if (a.strikethrough) text = `~~${text}~~`;
      if (r.href) text = `[${text}](${r.href})`;
      return text;
    })
    .join('');
}

function rtOf(block: NotionBlock): NotionRichText[] | undefined {
  const payload = block[block.type] as
    | { rich_text?: NotionRichText[] }
    | undefined;
  return payload?.rich_text;
}

/** Render one block to markdown (without its children). Returns null to skip. */
function renderBlock(block: NotionBlock): string | null {
  const t = block.type;
  const text = renderRichText(rtOf(block));
  switch (t) {
    case 'paragraph':
      return text;
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do': {
      const checked = (block.to_do as { checked?: boolean } | undefined)
        ?.checked;
      return `- [${checked ? 'x' : ' '}] ${text}`;
    }
    case 'toggle':
      return text;
    case 'quote':
      return `> ${text}`;
    case 'callout':
      return `> ${text}`;
    case 'code': {
      const lang =
        (block.code as { language?: string } | undefined)?.language ?? '';
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case 'divider':
      return '---';
    case 'child_page': {
      const title =
        (block.child_page as { title?: string } | undefined)?.title ??
        'Untitled';
      return `[${title}](child_page)`;
    }
    case 'child_database': {
      const title =
        (block.child_database as { title?: string } | undefined)?.title ??
        'Untitled';
      return `[${title}](child_database)`;
    }
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const url = (block[t] as { url?: string } | undefined)?.url;
      return url || null;
    }
    case 'image':
    case 'file':
    case 'pdf':
    case 'video': {
      const media = block[t] as
        | {
            caption?: NotionRichText[];
            external?: { url?: string };
            file?: { url?: string };
          }
        | undefined;
      const url = media?.external?.url ?? media?.file?.url ?? '';
      const caption = renderRichText(media?.caption) || t;
      return url ? `[${caption}](${url})` : null;
    }
    case 'equation': {
      const expr =
        (block.equation as { expression?: string } | undefined)?.expression ??
        text;
      return expr ? `$$${expr}$$` : null;
    }
    case 'table_row': {
      const cells = (
        (block.table_row as { cells?: NotionRichText[][] } | undefined)
          ?.cells ?? []
      ).map((c) => renderRichText(c));
      return `| ${cells.join(' | ')} |`;
    }
    // Containers with no text of their own: emit nothing, let children render.
    case 'table':
    case 'column_list':
    case 'column':
    case 'synced_block':
      return '';
    default:
      return null; // unknown/unsupported → skip
  }
}

const indent = (s: string, pad: string) =>
  s
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');

/**
 * A GFM table must be a contiguous block: rows joined by single newlines with a
 * `| --- | --- |` delimiter row after the header (first) row. The generic
 * per-block recursion (blank-line joins, depth indentation) cannot express that,
 * so the `table` block renders its own `table_row` children here.
 */
function renderTable(block: NotionBlock): string {
  const rows = (block.children ?? []).filter((c) => c.type === 'table_row');
  if (!rows.length) return '';
  const renderRow = (r: NotionBlock): string =>
    `| ${(
      (r.table_row as { cells?: NotionRichText[][] } | undefined)?.cells ?? []
    )
      .map((c) => renderRichText(c))
      .join(' | ')} |`;
  const colCount = (
    (rows[0].table_row as { cells?: NotionRichText[][] } | undefined)?.cells ??
    []
  ).length;
  const separator = `| ${Array.from({ length: Math.max(colCount, 1) }, () => '---').join(' | ')} |`;
  const lines = rows.map(renderRow);
  return [lines[0], separator, ...lines.slice(1)].join('\n');
}

export function renderBlocks(blocks: NotionBlock[], depth = 0): string {
  const out: string[] = [];
  for (const block of blocks) {
    // Tables render as one contiguous GFM block (header + delimiter + rows);
    // the generic recursion below can't, so handle + skip their children here.
    if (block.type === 'table' && block.children?.length) {
      const tableMd = renderTable(block);
      if (tableMd)
        out.push(depth > 0 ? indent(tableMd, '  '.repeat(depth)) : tableMd);
      continue;
    }

    const rendered = renderBlock(block);
    if (rendered)
      out.push(depth > 0 ? indent(rendered, '  '.repeat(depth)) : rendered);
    if (block.children?.length) {
      // A container that emits no text of its own (column_list / column /
      // synced_block → '') is "flattened": its children stay at the current
      // depth rather than being indented one level deeper.
      const childDepth = rendered === '' ? depth : depth + 1;
      const childMd = renderBlocks(block.children, childDepth);
      if (childMd) out.push(childMd);
    }
  }
  return out.join('\n\n');
}
