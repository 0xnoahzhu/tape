// Messages between the main process (client.ts) and the database worker (server.ts).
// Types only: the two sides are separate bundles and must not share runtime code.

import type { CacheStats, NavPoint } from '@shared/types';
import type { BarRetention } from './types';

/** A journaled execution: the JSON text is what ExecutionJournal.since returns. */
export interface ExecutionRow {
  execId: string;
  time: number;
  json: string;
}

/**
 * Operations by name: arguments and result. Bars travel both ways and NAV points back as packed
 * Float64Arrays (transferred, not copied): bars as [time, o, h, l, c, v] * n, NAV as [t, netLiq] * n.
 * Packing is done separately on each side (the bundles share no runtime code).
 */
export interface DbOps {
  'bars.get': [args: [series: string, fromTime: number | null, toTime: number | null], result: Float64Array];
  'bars.put': [args: [series: string, bars: Float64Array, retention: BarRetention | null], result: void];
  'bars.last': [args: [series: string], result: number | null];
  'kv.get': [args: [ns: string, key: string], result: { json: string; updatedAt: number } | null];
  'kv.set': [args: [ns: string, key: string, json: string, updatedAt: number], result: void];
  'kv.delete': [args: [ns: string, key: string], result: void];
  'executions.put': [args: [rows: ExecutionRow[]], result: void];
  /** JSON array text, newest first. */
  'executions.since': [args: [since: number], result: string];
  /** account null: unattributed points (the nav.json import). */
  'nav.append': [args: [account: string | null, points: NavPoint[]], result: void];
  'nav.get': [args: [account: string], result: Float64Array];
  /** Every row, unattributed ones included. */
  'nav.all': [args: [], result: Float64Array];
  'nav.lastAccount': [args: [], result: string | null];
  'nav.replace': [args: [account: string, points: NavPoint[]], result: void];
  /** Runs retention and vacuum now (tests, diagnostics). */
  maintain: [args: [], result: void];
  'cache.stats': [args: [], result: CacheStats];
  /**
   * Deletes the cached market data (not executions or NAV); answered once the freed space is
   * returned to the file system (other requests are served meanwhile).
   */
  'cache.clear': [args: [], result: void];
  /** Commits pending writes, checkpoints the WAL and closes the database. */
  close: [args: [], result: void];
}

export type DbOp = keyof DbOps;
export type DbArgs<K extends DbOp> = DbOps[K][0];
export type DbResult<K extends DbOp> = DbOps[K][1];

export interface DbRequest<K extends DbOp = DbOp> {
  id: number;
  op: K;
  args: DbArgs<K>;
}

export type DbResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

/**
 * Sent by the server: once after opening (or failing to open) the database, and whenever
 * maintenance evicted series (their bars, coverage and head timestamps are gone).
 */
export type DbStatus =
  | { type: 'ready'; file: string; schemaVersion: number; recovered?: string }
  | { type: 'unavailable'; message: string }
  | { type: 'evicted'; series: string[] };

export type DbMessage = DbResponse | DbStatus;

/** Worker options (workerData). */
export interface DbWorkerData {
  file: string;
  /** Size cap of the database plus its WAL (default sqlite.ts → CACHE_CAP_BYTES). */
  capBytes?: number;
  /** Set to 1 (and notified) once the database is closed, so the main thread can wait on quit. */
  closed?: Int32Array;
}
