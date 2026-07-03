import type { ExtensionModule } from './kiagent-contracts';
import { createNotionSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createNotionSource(host)] };
  },
} satisfies ExtensionModule<'net'>;

export default mod;
module.exports = mod;
