/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('dist bundle loads standalone', () => {
  it('exports {connector,hooks} with no node_modules reachable', () => {
    const dist = path.join(__dirname, '..', '..', 'dist', 'index.js');
    expect(fs.existsSync(dist)).toBe(true); // run `npm run build` first
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-iso-'));
    fs.copyFileSync(dist, path.join(dir, 'index.js'));
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(
      probe,
      `const m = require('./index.js');
       if (!m.connector || m.connector.id !== 'notion') throw new Error('no connector');
       if (!m.hooks || typeof m.hooks['notion-submit'] !== 'function') throw new Error('no notion-submit hook');
       if (Object.keys(m.hooks).length !== 1) throw new Error('unexpected hooks: ' + Object.keys(m.hooks));
       if (m.makeByteSource !== undefined) throw new Error('notion ships no byte source');
       console.log('OK');`,
    );
    const out = execFileSync('node', [probe], { cwd: dir, encoding: 'utf8' });
    expect(out.trim()).toBe('OK');
  });
});
