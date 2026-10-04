// Persistent caches of the main process. Hot data (quotes, books, orders) never goes through
// here; these stores keep what would otherwise have to be requested from IB again
// (bars, contract definitions, option chain parameters) and what IB does not keep for the API
// (executions older than today, the NAV history).
//
// All methods are async: the SQLite implementation runs in a worker thread so database work
// never blocks the socket / IPC event loop. Writes never reject (persistence is best-effort and
// failures are logged); reads reject when the database reports an error.
//
// Retention (applied by the SQLite implementation when idle, at most daily): intraday bars older
// than 30 days and kv entries not rewritten for 180 days are dropped. Executions and NAV are kept.

import type { Bar, Execution, NavPoint } from '@shared/types';

/** Intraday bars older than this many days are dropped by maintenance; daily and longer bars are kept. */
export const INTRADAY_RETENTION_DAYS = 30;

/** Bars per series; a series key identifies contract + bar size + whatToShow + useRTH. */
export interface BarCache {
  /**
   * Bars of a series in ascending time order, optionally from `fromTime` (unix seconds, inclusive)
   * and before `toTime` (exclusive).
   */
  get(series: string, fromTime?: number, toTime?: number): Promise<Bar[]>;
  /**
   * Inserts or replaces bars (matched by time). `intraday` selects the 30-day retention; when
   * omitted it is inferred from the key ("…|5m|…", "1 min") and the bar spacing.
   */
  put(series: string, bars: Bar[], opts?: { intraday?: boolean }): Promise<void>;
  /** Time of the newest stored bar, or undefined. */
  last(series: string): Promise<number | undefined>;
}

/** Small JSON documents with a timestamp, grouped by namespace (e.g. 'contract', 'secdef'). */
export interface KeyValueCache {
  get<T>(ns: string, key: string): Promise<{ value: T; updatedAt: number } | undefined>;
  set<T>(ns: string, key: string, value: T): Promise<void>;
  delete(ns: string, key: string): Promise<void>;
}

export interface ExecutionJournal {
  /** Inserts or replaces executions (matched by execId). */
  put(executions: Execution[]): Promise<void>;
  /** Executions with time >= `since` (unix ms), newest first. */
  since(since: number): Promise<Execution[]>;
}

export interface NavLog {
  append(points: NavPoint[]): Promise<void>;
  /** All points, ascending. */
  all(): Promise<NavPoint[]>;
  /** Replaces the whole history (used by compaction). */
  replace(points: NavPoint[]): Promise<void>;
}

export interface Database {
  readonly bars: BarCache;
  readonly kv: KeyValueCache;
  readonly executions: ExecutionJournal;
  readonly nav: NavLog;
  /** 'sqlite' when persistent, 'memory' when the database could not be opened. */
  readonly kind: 'sqlite' | 'memory';
  close(): Promise<void>;
}
