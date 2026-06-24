import type { NotionClient } from './client';

interface NotionUserRecord {
  id: string;
  name?: string;
}

export class NotionUserDirectory {
  private names = new Map<string, string>();

  constructor(private readonly client: NotionClient) {}

  resolve = (id?: string): string =>
    (id && this.names.get(id)) || id || 'unknown';

  async resolveOrFetch(id: string): Promise<string> {
    const hit = this.names.get(id);
    if (hit) return hit;
    try {
      const u = await this.client.request<NotionUserRecord>(
        'GET',
        `/users/${id}`,
      );
      const name = u.name || id;
      this.names.set(id, name);
      return name;
    } catch {
      return id;
    }
  }
}
