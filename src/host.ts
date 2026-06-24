import type { ConnectorHost } from '@alpha-cent/connector-sdk';

/** Minimal async DB surface the connector calls on ctx.db (cast from unknown).
 *  Mirrors the app's AppDb shape the host injects into the forked process. */
export type Db = {
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
};

export type Host = ConnectorHost;
