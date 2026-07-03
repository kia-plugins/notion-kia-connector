import type { AuthChannel, HostFor, Session, Source } from './kiagent-contracts';

export interface NotionCursor {
  /** High-water mark: newest last_edited_time fully ingested (ISO-8601). */
  lastEditedTime: string | null;
  /** Notion pagination cursor mid-backfill — crash-safe resume point. */
  nextCursor?: string;
}
export interface NotionItem {
  page: { id: string; url?: string; last_edited_time: string; created_time?: string;
          parent?: { type?: string }; properties?: Record<string, unknown> };
  markdown: string;
}

export function createNotionSource(host: HostFor<'net'>): Source<NotionCursor, NotionItem> {
  return {
    descriptor: {
      id: 'notion',
      name: 'Notion',
      documentTypes: ['notion.page'],
      auth: 'password',
      cadence: { every: '30m' },
    },
    async connect(_auth: AuthChannel) {
      throw new Error('not implemented yet');
    },
    // eslint-disable-next-line require-yield
    async *pull(_session: Session, _cursor: NotionCursor | null) {
      throw new Error('not implemented yet');
    },
    toDocument() {
      return null;
    },
  };
}
