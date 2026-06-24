import { connector } from '../index';
import { validateNotionToken } from '../add-account';

describe('connector descriptor', () => {
  it('has the expected id and capabilities', () => {
    expect(connector.id).toBe('notion');
    expect(connector.capabilities).toMatchObject({
      multiAccount: true,
      requiresAuth: true,
      supportsBackfill: true,
      supportsDelta: true,
      supportsRealtime: false,
    });
  });

  it('getAccountSchema requires a token', () => {
    const schema = connector.getAccountSchema() as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['token']);
    expect(schema.properties).toHaveProperty('token');
  });

  it('validateAccount rejects non-secret tokens and accepts ntn_/secret_', () => {
    expect(connector.validateAccount({ token: 'nope' }).ok).toBe(false);
    expect(connector.validateAccount({}).ok).toBe(false);
    expect(connector.validateAccount({ token: 'ntn_abc' }).ok).toBe(true);
    expect(connector.validateAccount({ token: 'secret_abc' }).ok).toBe(true);
  });
});

describe('validateNotionToken', () => {
  it('rejects a wrong-format token without calling the network', async () => {
    const fetchFn = jest.fn();
    const r = await validateNotionToken('xoxp-not-notion', fetchFn as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid-token-format');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns the bot identity on a 200 from /users/me', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot_1', bot: { workspace_name: 'Acme' } }),
    }));
    const r = await validateNotionToken('ntn_secret', fetchFn as never);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.token).toEqual({
        access_token: 'ntn_secret',
        bot_id: 'bot_1',
        workspace_name: 'Acme',
      });
  });

  it('maps a non-200 to auth-failed', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    const r = await validateNotionToken('ntn_bad', fetchFn as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('auth-failed');
  });
});
