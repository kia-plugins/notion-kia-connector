/**
 * Smoke test for the bundled dist/index.js — v1 had this (`git show
 * 3f12688:src/__tests__/bundle-load.test.ts`) but it was dropped with no v2
 * replacement, leaving the CJS/ESM interop in src/index.ts (`export default
 * mod; module.exports = mod;`) untested against actual esbuild output —
 * exactly what silently breaks on an esbuild upgrade (this branch bumped
 * esbuild 0.23→0.24).
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { HostFor } from '../kiagent-contracts';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the notion source', async () => {
    const root = join(__dirname, '..', '..');
    execSync('npm run build', { cwd: root });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(root, 'dist', 'index.js'));
    const entry = mod.default ?? mod;
    expect(typeof entry.activate).toBe('function');

    const host: HostFor<'net'> = {
      self: { id: 'notion', dataDir: '/tmp' },
      log: () => {},
      net: {
        fetch: async () => {
          throw new Error('unused in this smoke test');
        },
      },
    };
    const result = await entry.activate(host);

    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0]?.descriptor.id).toBe('notion');
  }, 30_000);
});
