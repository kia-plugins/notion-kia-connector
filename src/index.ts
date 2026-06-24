import type {
  Account,
  Connector,
  ConnectorInstance,
  ConnectorHost,
} from '@alpha-cent/connector-sdk';
import { loadTokenBlob } from './safe-storage-blob';
import { decodeNotionTokenFromStorage } from './token';
import { NotionClient } from './client';
import { NotionUserDirectory } from './users';
import { runNotionBackfill } from './backfill';
import { runNotionDelta } from './delta';
import { submitNotion } from './submit';

export const connector: Connector = {
  id: 'notion',
  displayName: 'Notion',
  capabilities: {
    multiAccount: true,
    requiresAuth: true,
    supportsBackfill: true,
    supportsDelta: true,
    supportsRealtime: false,
  },
  getAccountSchema: () => ({
    type: 'object',
    required: ['token'],
    properties: {
      token: {
        type: 'string',
        title: 'Notion internal integration secret (ntn_…)',
      },
    },
  }),
  validateAccount: (input) => {
    const i = input as Partial<{ token: string }>;
    if (!i?.token || !/^(ntn_|secret_)/.test(i.token))
      return {
        ok: false,
        error:
          'a Notion internal integration secret (ntn_… or secret_…) is required',
      };
    return { ok: true };
  },
  createInstance,
};

async function createInstance(
  account: Account,
  ctx: ConnectorHost,
): Promise<ConnectorInstance> {
  const token = decodeNotionTokenFromStorage(
    loadTokenBlob(account.credentials_blob_path!),
    ctx.safeStorage,
  );
  const client = new NotionClient({ getToken: () => token.access_token });
  const users = new NotionUserDirectory(client);
  const abort = new AbortController();
  const common = {
    ctx,
    client,
    users,
    accountId: account.id,
    workspace: token.workspace_name,
  };

  return {
    async startBackfill(progress) {
      await runNotionBackfill({
        ...common,
        signal: abort.signal,
        onProgress: (done, total) => progress.update(done, total),
      });
    },
    async pollDelta() {
      await runNotionDelta(common);
    },
    requestStop() {
      abort.abort();
    },
    async shutdown() {},
    buildSourceUrl(sourceId) {
      return `https://www.notion.so/${sourceId.replace(/-/g, '')}`;
    },
  };
}

// Only the manifest-referenced submit hook is exported: the loader rejects
// "orphan" hooks (declared but unreferenced), and the input-fields `notion-token`
// validation is resolved renderer-side, not as a backend hook.
export const hooks = {
  'notion-submit': submitNotion,
};

export default { connector, hooks };
module.exports = { connector, hooks };
