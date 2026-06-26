import type { SafeStorageLike } from '@kiagent/connector-sdk';
import {
  decodeJsonFromStorage,
  encodeJsonForStorage,
} from './safe-storage-blob';
import type { NotionToken } from './types';

export function encodeNotionTokenForStorage(
  t: NotionToken,
  ss: SafeStorageLike,
): Buffer {
  return encodeJsonForStorage(t, ss);
}

export function decodeNotionTokenFromStorage(
  blob: Buffer,
  ss: SafeStorageLike,
): NotionToken {
  return decodeJsonFromStorage<NotionToken>(blob, ss);
}
