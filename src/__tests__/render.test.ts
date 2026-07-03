/**
 * Ported from v1 `src/__tests__/render.test.ts` (`git show
 * main:src/__tests__/render.test.ts`), adapted for the v2 delta: no
 * `resolve` callback (mentions render their `plain_text` directly), and
 * `NotionBlock` replaces `BlockNode` (see `../notion-types`). Extended with
 * coverage for every block type in the render.ts switch, per the task brief.
 */
import { renderBlocks, renderRichText } from '../render';
import type { NotionBlock } from '../notion-types';

let counter = 0;
const nextId = () => `b${counter++}`;

const block = (
  type: string,
  payload: Record<string, unknown> = {},
): NotionBlock => ({ object: 'block', id: nextId(), type, [type]: payload }) as NotionBlock;

const para = (text: string): NotionBlock =>
  block('paragraph', { rich_text: [{ plain_text: text }] });

beforeEach(() => {
  counter = 0;
});

describe('renderRichText', () => {
  it('applies code/bold/italic/strikethrough and links', () => {
    const out = renderRichText([
      { plain_text: 'b', annotations: { bold: true } },
      { plain_text: 'i', annotations: { italic: true } },
      { plain_text: 's', annotations: { strikethrough: true } },
      { plain_text: 'c', annotations: { code: true } },
      { plain_text: 'link', href: 'https://x' },
    ]);
    expect(out).toBe('**b***i*~~s~~`c`[link](https://x)');
  });

  it('renders a mention span as its plain_text, with no user resolution', () => {
    const out = renderRichText([
      {
        plain_text: 'Alice',
        type: 'mention',
        mention: { type: 'user', user: { id: 'u1' } },
      },
    ]);
    expect(out).toBe('Alice');
  });

  it('returns empty string for undefined or empty rich text', () => {
    expect(renderRichText(undefined)).toBe('');
    expect(renderRichText([])).toBe('');
  });
});

describe('renderBlocks', () => {
  it('renders headings 1/2/3', () => {
    const md = renderBlocks([
      block('heading_1', { rich_text: [{ plain_text: 'H1' }] }),
      block('heading_2', { rich_text: [{ plain_text: 'H2' }] }),
      block('heading_3', { rich_text: [{ plain_text: 'H3' }] }),
    ]);
    expect(md).toBe('# H1\n\n## H2\n\n### H3');
  });

  it('renders bulleted and numbered list items', () => {
    const md = renderBlocks([
      block('bulleted_list_item', { rich_text: [{ plain_text: 'one' }] }),
      block('numbered_list_item', { rich_text: [{ plain_text: 'two' }] }),
    ]);
    expect(md).toBe('- one\n\n1. two');
  });

  it('renders to_do checked and unchecked states', () => {
    const md = renderBlocks([
      block('to_do', { rich_text: [{ plain_text: 'done' }], checked: true }),
      block('to_do', { rich_text: [{ plain_text: 'todo' }], checked: false }),
    ]);
    expect(md).toBe('- [x] done\n\n- [ ] todo');
  });

  it('renders toggle as plain text', () => {
    const md = renderBlocks([block('toggle', { rich_text: [{ plain_text: 'more' }] })]);
    expect(md).toBe('more');
  });

  it('renders quote and callout with a blockquote prefix', () => {
    const md = renderBlocks([
      block('quote', { rich_text: [{ plain_text: 'q' }] }),
      block('callout', { rich_text: [{ plain_text: 'c' }] }),
    ]);
    expect(md).toBe('> q\n\n> c');
  });

  it('renders a fenced code block with its language', () => {
    const md = renderBlocks([
      block('code', {
        rich_text: [{ plain_text: 'const x = 1;' }],
        language: 'typescript',
      }),
    ]);
    expect(md).toBe('```typescript\nconst x = 1;\n```');
  });

  it('renders a divider', () => {
    expect(renderBlocks([block('divider')])).toBe('---');
  });

  it('renders child_page and child_database as links', () => {
    const md = renderBlocks([
      block('child_page', { title: 'Sub Page' }),
      block('child_database', { title: 'Sub DB' }),
    ]);
    expect(md).toBe('[Sub Page](child_page)\n\n[Sub DB](child_database)');
  });

  it('renders bookmark/embed/link_preview as bare URLs', () => {
    const md = renderBlocks([
      block('bookmark', { url: 'https://a' }),
      block('embed', { url: 'https://b' }),
      block('link_preview', { url: 'https://c' }),
    ]);
    expect(md).toBe('https://a\n\nhttps://b\n\nhttps://c');
  });

  it('renders media blocks as [caption](url), falling back to the type name', () => {
    const md = renderBlocks([
      block('image', {
        external: { url: 'https://img' },
        caption: [{ plain_text: 'a cat' }],
      }),
      block('file', { file: { url: 'https://file' } }),
    ]);
    expect(md).toBe('[a cat](https://img)\n\n[file](https://file)');
  });

  it('skips media blocks with no url', () => {
    expect(renderBlocks([block('pdf', {})])).toBe('');
  });

  it('renders an equation as a $$…$$ block', () => {
    const md = renderBlocks([block('equation', { expression: 'E=mc^2' })]);
    expect(md).toBe('$$E=mc^2$$');
  });

  it('renders a lone table_row via the generic switch', () => {
    const row = block('table_row', {
      cells: [[{ plain_text: 'x' }], [{ plain_text: 'y' }]],
    });
    expect(renderBlocks([row])).toBe('| x | y |');
  });

  it('skips unknown/unsupported block types', () => {
    expect(renderBlocks([block('unsupported_thing', {})])).toBe('');
  });

  it('renders a table as one contiguous GFM block', () => {
    const table = block('table');
    table.children = [
      block('table_row', { cells: [[{ plain_text: 'a' }], [{ plain_text: 'b' }]] }),
      block('table_row', { cells: [[{ plain_text: '1' }], [{ plain_text: '2' }]] }),
    ];
    const md = renderBlocks([table]);
    expect(md).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('indents children one level under a parent', () => {
    const parent = para('parent');
    parent.children = [para('child')];
    const md = renderBlocks([parent]);
    expect(md).toBe('parent\n\n  child');
  });

  it('indents nested children two levels deep', () => {
    const grandchild = para('grandchild');
    const child = para('child');
    child.children = [grandchild];
    const parent = para('parent');
    parent.children = [child];
    const md = renderBlocks([parent]);
    expect(md).toBe('parent\n\n  child\n\n    grandchild');
  });

  it('flattens depth under emit-nothing containers (column_list/column)', () => {
    const column = block('column');
    column.children = [para('inside column')];
    const columnList = block('column_list');
    columnList.children = [column];
    const md = renderBlocks([columnList]);
    expect(md).toBe('inside column');
  });
});
