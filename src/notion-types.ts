/**
 * Ported subset of v1 `src/types.ts` (see `git show main:src/types.ts` in this
 * repo) — only the block/rich-text shapes the renderer needs, plus a
 * search-result page shape for the page-markdown builder. v1's user/token/
 * account-store types (NotionToken, NotionCursor, NotionParent w/ users
 * lookups, etc.) are dropped — v2 has no directory/token-blob concerns here.
 * Runtime-free: types only.
 */

export interface NotionRichText {
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
  type?: string;
  mention?: { type?: string; user?: { id?: string } };
}

/** A block, optionally with its recursively-fetched children (child_page/
 *  child_database excluded — those are separate documents, never recursed
 *  into; see pages.ts's fetchBlockTree). The per-type payload lives under
 *  block[block.type]; typed loosely on purpose, mirroring v1. */
export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: unknown;
}

/** A `search` / `databases.query` result: a page or a database. Structurally
 *  matches `NotionItem['page']` in source.ts (Task 13 aligns the two so
 *  source.ts can reuse this type directly). */
export interface NotionSearchResult {
  object: string;
  id: string;
  url?: string;
  archived?: boolean;
  in_trash?: boolean;
  last_edited_time: string;
  created_time?: string;
  parent?: { type?: string };
  properties?: Record<string, unknown>;
}
