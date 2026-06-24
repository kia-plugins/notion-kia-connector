import { renderBlocks, renderRichText } from '../render';
import type { BlockNode } from '../types';

const id = (() => {
  let n = 0;
  return () => `b${n++}`;
})();

const block = (type: string, payload: Record<string, unknown> = {}): BlockNode =>
  ({ object: 'block', id: id(), type, [type]: payload }) as BlockNode;

const para = (text: string): BlockNode =>
  block('paragraph', { rich_text: [{ plain_text: text }] });

describe('renderRichText', () => {
  it('applies code/bold/italic/strike and links', () => {
    const out = renderRichText(
      [
        { plain_text: 'b', annotations: { bold: true } },
        { plain_text: 'i', annotations: { italic: true } },
        { plain_text: 's', annotations: { strikethrough: true } },
        { plain_text: 'c', annotations: { code: true } },
        { plain_text: 'link', href: 'https://x' },
      ],
      (x) => x ?? '',
    );
    expect(out).toBe('**b***i*~~s~~`c`[link](https://x)');
  });

  it('resolves a user mention via the resolver', () => {
    const out = renderRichText(
      [{ plain_text: '', type: 'mention', mention: { type: 'user', user: { id: 'u1' } } }],
      (uid) => (uid === 'u1' ? 'Alice' : '?'),
    );
    expect(out).toBe('@Alice');
  });
});

describe('renderBlocks', () => {
  it('renders headings, lists and to-dos', () => {
    const md = renderBlocks(
      [
        block('heading_1', { rich_text: [{ plain_text: 'Title' }] }),
        block('bulleted_list_item', { rich_text: [{ plain_text: 'one' }] }),
        block('to_do', { rich_text: [{ plain_text: 'task' }], checked: true }),
      ],
      (x) => x ?? '',
    );
    expect(md).toBe('# Title\n\n- one\n\n- [x] task');
  });

  it('indents children one level under a parent', () => {
    const parent = para('parent');
    parent.children = [para('child')];
    const md = renderBlocks([parent], (x) => x ?? '');
    expect(md).toBe('parent\n\n  child');
  });

  it('renders a table as one contiguous GFM block', () => {
    const table = block('table');
    table.children = [
      block('table_row', { cells: [[{ plain_text: 'a' }], [{ plain_text: 'b' }]] }),
      block('table_row', { cells: [[{ plain_text: '1' }], [{ plain_text: '2' }]] }),
    ];
    const md = renderBlocks([table], (x) => x ?? '');
    expect(md).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });
});
