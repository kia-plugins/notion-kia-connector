/** Decoded blob persisted (encrypted) at accounts.credentials_blob_path. */
export interface NotionToken {
  access_token: string;
  /** Bot user id from GET /v1/users/me — stable per integration-in-workspace. */
  bot_id: string;
  workspace_name: string;
}

/** Shape persisted in sync_state.cursor_json for source='notion'. */
export interface NotionCursor {
  /** Newest last_edited_time ingested so far (ISO 8601). */
  last_edited?: string;
  /** ISO timestamp of the last deletion reconcile pass. */
  last_reconcile_at?: string;
}

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

export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  has_children?: boolean;
  // The per-type payload lives under block[block.type]; typed loosely on purpose.
  [key: string]: unknown;
}

/** A block plus its recursively-fetched children (child_page/child_database excluded). */
export type BlockNode = NotionBlock & { children?: BlockNode[] };

export interface NotionParent {
  type: 'database_id' | 'page_id' | 'workspace' | 'block_id';
  database_id?: string;
  page_id?: string;
}

export interface NotionPage {
  object: 'page';
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  archived?: boolean;
  in_trash?: boolean;
  parent: NotionParent;
  created_by?: { id?: string };
  properties: Record<string, NotionProperty>;
}

export interface NotionProperty {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
  status?: { name?: string } | null;
  date?: { start?: string; end?: string | null } | null;
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  people?: Array<{ id?: string; name?: string }>;
  [key: string]: unknown;
}

/** A `search` / `databases.query` result is a page or a database. */
export interface SearchResult {
  object: 'page' | 'database';
  id: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
}
