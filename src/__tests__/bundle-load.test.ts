/**
 * Smoke test for the bundled dist/index.js — v1 had this (`git show
 * 3f12688:src/__tests__/bundle-load.test.ts`) but it was dropped with no v2
 * replacement, leaving the CJS/ESM interop in src/index.ts (`export default
 * mod; module.exports = mod;`) untested against actual esbuild output —
 * exactly what silently breaks on an esbuild upgrade (this branch bumped
 * esbuild 0.23→0.24).
 */
import { join } from 'node:path';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the notion source', async () => {
    const root = join(__dirname, '..', '..');
    await bundleLoadSmoke({ root, selfId: 'notion', sourceIds: ['notion'] });
  }, 30_000);
});
