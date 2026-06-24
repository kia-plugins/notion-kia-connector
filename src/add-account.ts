import { NOTION_API_BASE, NOTION_VERSION } from './client';
import type { NotionToken } from './types';

export type ValidateNotionResult =
  | { ok: true; token: NotionToken }
  | { ok: false; error: string; message: string };

interface NotionMe {
  object?: string;
  id?: string;
  type?: string;
  bot?: { workspace_name?: string };
}

export async function validateNotionToken(
  raw: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ValidateNotionResult> {
  const token = raw.trim();
  if (!/^(ntn_|secret_)/.test(token)) {
    return {
      ok: false,
      error: 'invalid-token-format',
      message:
        'Expected a Notion internal integration secret (starts with ntn_ or secret_).',
    };
  }
  let res: Awaited<ReturnType<typeof fetchFn>>;
  try {
    res = await fetchFn(`${NOTION_API_BASE}/users/me`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': NOTION_VERSION,
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: 'network-failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: 'auth-failed',
      message: `Notion rejected the token (HTTP ${res.status}). Make sure you pasted the integration's Internal Integration Secret.`,
    };
  }
  const me = (await res.json()) as NotionMe;
  if (!me.id) {
    return {
      ok: false,
      error: 'auth-failed',
      message: 'Notion returned no bot identity for this token.',
    };
  }
  return {
    ok: true,
    token: {
      access_token: token,
      bot_id: me.id,
      workspace_name: me.bot?.workspace_name ?? 'Notion',
    },
  };
}
