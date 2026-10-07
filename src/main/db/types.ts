// Persistent caches of the main process. Hot data (quotes, books, orders) never goes through
// here; these stores keep what would otherwise have to be requested from IB again (bars,
// contract definitions, option chain parameters).
//
// All methods are async: the SQLite implementation runs in a worker thread so database work
// never blocks the socket / IPC event loop. Writes never reject (persistence is best-effort and
// failures are logged); reads reject when the database reports an error.
//
// Retention, so tape.db cannot grow without bound (applied by the SQLite worker about two minutes
// after startup and then every six hours, in small steps that yield to requests; the constants
// are in sqlite.ts):
// - bars of a series with a retention class (by bar size, BarRetention) are deleted once older than
//   its days: seconds SECONDS_RETENTION_DAYS (6), minutes INTRADAY_RETENTION_DAYS (30), hours
//   HOURS_RETENTION_DAYS (400); daily and longer bars are kept (a series left empty goes too);
// - a series (bars, coverage, head timestamp) not read or written for SERIES_UNUSED_DAYS (90) is
//   evicted; reads touch a series at most once an hour (series.last_access);
// - above CACHE_CAP_BYTES (512 MB, tape.db plus its WAL) series are evicted until the data is
//   below CACHE_CAP_TARGET_PERCENT (80%) of the cap: first those not used for CAP_RECENT_DAYS (7),
//   seconds first, then minutes and hours, then daily and longer, then the recently used ones;
//   least recently used first;
// - kv entries not rewritten for 180 days are deleted (contract details, option chains,
//   coverage documents, head timestamps).
// Then free pages are returned to the file system (incremental vacuum), the WAL is truncated and
// the planner statistics refreshed. Evicted series are reported through onEvicted, so the
// history service drops what it keeps in memory about them and refetches them cleanly.

import type { Bar, CacheStats } from '@shared/types';

/**
 * How long maintenance keeps the bars of a series, by bar size: seconds (1 to 30 secs) are large
 * (57,600 one-second bars per extended session) and kept for SECONDS_RETENTION_DAYS, minutes (1 to
 * 20 mins) for INTRADAY_RETENTION_DAYS, hours (30 mins to 8 hours) for HOURS_RETENTION_DAYS so a
 * year of them stays cached (and a one-month range of 30-minute bars); daily and longer bars are
 * kept.
 */
export type BarRetention = 'seconds' | 'minutes' | 'hours' | 'daily';

/**
 * Days of bars kept per retention class. (Used by both bundles: small integers the bundler
 * inlines, so no chunk is shared, see worker.ts.) Seconds: the cache serves a day less (5 days),
 * so the newest session stays served over a weekend plus a Monday holiday until Tuesday's open
 * (about four sessions per series).
 */
export const SECONDS_RETENTION_DAYS = 6;
export const INTRADAY_RETENTION_DAYS = 30;
export const HOURS_RETENTION_DAYS = 400;

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
   * Inserts or replaces bars (matched by time). `retention` sets the series' retention class;
   * when omitted a new series' class is inferred from the key ("1 secs", "5 mins", "1 hour") and
   * the bar spacing.
   */
  put(series: string, bars: Bar[], opts?: { retention?: BarRetention }): Promise<void>;
  /** Time of the newest stored bar, or undefined. */
  last(series: string): Promise<number | undefined>;
}

/** Small JSON documents with a timestamp, grouped by namespace (e.g. 'contract', 'secdef'). */
export interface KeyValueCache {
  get<T>(ns: string, key: string): Promise<{ value: T; updatedAt: number } | undefined>;
  set<T>(ns: string, key: string, value: T): Promise<void>;
  delete(ns: string, key: string): Promise<void>;
}

export interface Database {
  readonly bars: BarCache;
  readonly kv: KeyValueCache;
  /** 'sqlite' when persistent, 'memory' when the database could not be opened. */
  readonly kind: 'sqlite' | 'memory';
  /** Size on disk and what the cache holds. */
  stats(): Promise<CacheStats>;
  /**
   * Deletes the market data caches (bars, series and the kv namespaces of coverage / head
   * timestamps, contract details and option chains) and returns the space to the file system
   * (the SQLite worker serves other requests meanwhile), resolving once it is back. Other kv
   * namespaces are kept. Listeners hear 'all' before it runs. Rejects on database errors.
   */
  clearMarketData(): Promise<void>;
  /**
   * Series removed with their coverage: by maintenance (after the fact) or by clearMarketData
   * ('all', before it runs). Returns the unsubscribe function.
   */
  onEvicted(listener: (evicted: EvictedSeries) => void): () => void;
  close(): Promise<void>;
}
