// Persistent caches of the main process. Hot data (quotes, books, orders) never goes through
// here; these stores keep what would otherwise have to be requested from IB again
// (bars, contract definitions, option chain parameters) and what IB does not keep for the API
// (executions older than today, the NAV history).
//
// All methods are async: the SQLite implementation runs in a worker thread so database work
// never blocks the socket / IPC event loop. Writes never reject (persistence is best-effort and
// failures are logged); reads reject when the database reports an error.
//
// Retention, so tape.db cannot grow without bound (applied by the SQLite worker about two minutes
// after startup and then every six hours, in small steps that yield to requests; the constants
// are in sqlite.ts):
// - intraday bars older than INTRADAY_RETENTION_DAYS (30) are deleted (a series left empty goes too);
// - a series (bars, coverage, head timestamp) not read or written for SERIES_UNUSED_DAYS (90) is
//   evicted; reads touch a series at most once an hour (series.last_access);
// - above CACHE_CAP_BYTES (512 MB, tape.db plus its WAL) series are evicted until the data is
//   below CACHE_CAP_TARGET_PERCENT (80%) of the cap: first those not used for CAP_RECENT_DAYS (7),
//   intraday before daily and longer, then the recently used ones; least recently used first;
// - kv entries not rewritten for 180 days are deleted (contract details, option chains,
//   coverage documents, head timestamps);
// - executions are never deleted (the trade journal is the user's record); the NAV history is
//   compacted to one point per day after 10 days by ib/navHistory.ts.
// Then free pages are returned to the file system (incremental vacuum), the WAL is truncated and
// the planner statistics refreshed. Evicted series are reported through onEvicted, so the
// history service drops what it keeps in memory about them and refetches them cleanly.

import type { Bar, CacheStats, Execution, NavPoint } from '@shared/types';

/**
 * Intraday bars older than this many days are dropped by maintenance; daily and longer bars are kept.
 * (Used by both bundles: a small integer the bundler inlines, so no chunk is shared, see worker.ts.)
 */
export const INTRADAY_RETENTION_DAYS = 30;

/** Series evicted by maintenance (their keys), or 'all' when the market data cache is cleared. */
export type EvictedSeries = readonly string[] | 'all';

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
  /** Size on disk and what the cache holds. */
  stats(): Promise<CacheStats>;
  /**
   * Deletes the market data caches (bars, series and the kv namespaces of coverage / head
   * timestamps, contract details and option chains) and returns the space to the file system
   * (the SQLite worker serves other requests meanwhile), resolving once it is back. Executions
   * and the NAV history are kept. Listeners hear 'all' before it runs. Rejects on database errors.
   */
  clearMarketData(): Promise<void>;
  /**
   * Series removed with their coverage: by maintenance (after the fact) or by clearMarketData
   * ('all', before it runs). Returns the unsubscribe function.
   */
  onEvicted(listener: (evicted: EvictedSeries) => void): () => void;
  close(): Promise<void>;
}
