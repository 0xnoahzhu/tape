// SQLite operations of the database worker (synchronous; they run on the worker thread).
// Unit tests use them in-process on temporary files.
//
// Retention (see types.ts for the policy) runs as a generator of small steps: a step is at most
// one transaction deleting at most DELETE_CHUNK rows, or one incremental_vacuum sized to take
// about VACUUM_STEP_MS, and the worker looks at its queue between slices of steps (server.ts),
// so maintenance never holds up a request for long. A series is evicted oldest bars first; its
// coverage and head timestamp go with the first chunk, so a reader in between finds no coverage
// in the database (the history service drops its in-memory copy when the eviction is announced)
// instead of trusting a half-deleted series.

import { existsSync, renameSync, statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Bar, CacheStats, NavPoint } from '@shared/types';
import type { ExecutionRow } from './protocol';
import { configure, migrate, NewerSchemaError } from './schema';
import { HOURS_RETENTION_DAYS, INTRADAY_RETENTION_DAYS, SECONDS_RETENTION_DAYS, type BarRetention } from './types';

export { HOURS_RETENTION_DAYS, INTRADAY_RETENTION_DAYS, SECONDS_RETENTION_DAYS };

/** Days of bars each retention class keeps (daily and longer: all of them). */
export const RETENTION_DAYS: Readonly<Record<Exclude<BarRetention, 'daily'>, number>> = {
  seconds: SECONDS_RETENTION_DAYS,
  minutes: INTRADAY_RETENTION_DAYS,
  hours: HOURS_RETENTION_DAYS,
};
const RETENTIONS: ReadonlySet<string> = new Set<BarRetention>(['seconds', 'minutes', 'hours', 'daily']);
/** A series nobody read or wrote for this many days is evicted. */
export const SERIES_UNUSED_DAYS = 90;
/** Size cap of tape.db plus its WAL (512 MB). */
export const CACHE_CAP_BYTES = 512 * 1024 * 1024;
/** Above the cap, series are evicted until the data takes at most this share of it (percent). */
export const CACHE_CAP_TARGET_PERCENT = 80;
/**
 * Above the cap, series read or written within this many days (a chart on screen, the charts of
 * the last trading days) go last; older ones go first: seconds, then minutes and hours, then
 * daily and longer.
 */
export const CAP_RECENT_DAYS = 7;
/** kv holds caches: entries not rewritten for this many days are dropped ('*' = any namespace). */
export const KV_TTL_DAYS: Readonly<Record<string, number>> = { '*': 180 };
/**
 * kv namespace of the bar series' bookkeeping (market/history.ts → COVERAGE_NS): coverage
 * documents keyed by series, head timestamps keyed "head|<contract>|<whatToShow>|<useRTH>".
 */
export const COVERAGE_KV_NS = 'coverage';
/**
 * kv namespaces of cached market data, deleted by clearMarketData: coverage and head timestamps,
 * contract details (market/contracts.ts → CONTRACT_NS), option chain parameters
 * (market/options.ts → SECDEF_NS). memory.ts keeps the same list.
 */
export const MARKET_DATA_NS: readonly string[] = [COVERAGE_KV_NS, 'contract', 'secdef'];
/** Namespace for the database's own bookkeeping (exempt from the TTL). */
const META_NS = '__tape';
const DAY_MS = 86_400_000;
/** Most rows one maintenance transaction deletes, so maintenance yields to requests between chunks. */
export const DELETE_CHUNK = 5_000;
/** A series' last_access is written at most this often (reads only touch it in memory before). */
export const ACCESS_WRITE_MS = 3_600_000;
/**
 * Time an incremental_vacuum step aims at. What a page costs varies a lot (pages moved or only
 * truncated, WAL checkpoints), so the page count of the next step follows the measured time.
 */
export const VACUUM_STEP_MS = 5;
/** Pages (4 KiB) of the first incremental_vacuum step of a run, and the bounds of later ones. */
export const VACUUM_PAGES_START = 256;
const VACUUM_PAGES_MIN = 32;
export const VACUUM_PAGES_MAX = 2_048;
const BAR_FIELDS = 6;
/** Later than any bar time: "all bars" for the chunked deletes. */
const END_OF_TIME = Number.MAX_SAFE_INTEGER;
/** PRAGMA auto_vacuum value of a file whose free pages incremental_vacuum can release. */
const AUTO_VACUUM_INCREMENTAL = 2;

const SQLITE_ERROR = 1;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** Statements whose query plans the tests check (no full scans on large tables). */
export const SQL = {
  barsRange: 'SELECT time, o, h, l, c, v FROM bars WHERE series_id = ? AND time >= ? ORDER BY time',
  barsBetween: 'SELECT time, o, h, l, c, v FROM bars WHERE series_id = ? AND time >= ? AND time < ? ORDER BY time',
  barsLast: 'SELECT max(time) AS t FROM bars WHERE series_id = ?',
  barsPut: 'INSERT OR REPLACE INTO bars (series_id, time, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)',
  /** Bars of a series in [from, to]: counted around a put to keep series.bar_count exact. */
  barsCount: 'SELECT count(*) AS n FROM bars WHERE series_id = ? AND time >= ? AND time <= ?',
  barsExpire: 'DELETE FROM bars WHERE series_id = ? AND time <= ?',
  barsExpireBound: 'SELECT time FROM bars WHERE series_id = ? AND time < ? ORDER BY time LIMIT 1 OFFSET ?',
  executionsSince: 'SELECT json FROM executions WHERE time >= ? ORDER BY time DESC',
  kvGet: 'SELECT value, updated_at FROM kv WHERE ns = ? AND key = ?',
  kvExpire: 'DELETE FROM kv WHERE ns = ? AND key IN (SELECT key FROM kv WHERE ns = ? AND updated_at < ? LIMIT ?)',
  /** Series keys starting with a contract key (the series sharing a head timestamp). */
  seriesByPrefix: 'SELECT id, key FROM series WHERE key >= ? AND key < ?',
  /** Eviction order above the size cap (the parameter: last_access from which a series counts as recently used). */
  capOrder:
    "SELECT id, key FROM series ORDER BY CASE WHEN last_access >= ? THEN 3 WHEN retention = 'seconds' THEN 0 WHEN retention = 'daily' THEN 2 ELSE 1 END, last_access, id",
} as const;

/** What a maintenance step reports: the keys of series it evicted (their coverage is gone). */
export type MaintenanceStep = readonly string[] | void;

export interface MaintenanceOptions {
  /** Size cap of the database plus its WAL (default CACHE_CAP_BYTES). */
  capBytes?: number;
}

export interface SqliteStore {
  readonly db: DatabaseSync;
  readonly file: string;
  /** Path the previous (unreadable) file was moved to when the database was recreated. */
  readonly recovered?: string;
  /** Runs `fn` in a transaction (a savepoint when nested). */
  transaction<T>(fn: () => T): T;
  /** Packed [time, o, h, l, c, v] * n, ascending; `toTime` is exclusive. */
  barsGet(series: string, fromTime: number | null, toTime?: number | null): Float64Array;
  /**
   * Bars as objects, or packed [time, o, h, l, c, v] * n (what the worker receives).
   * `retention` sets the series' class; null: a new series' class is inferred from its key and
   * bar spacing (inferRetention), an existing series keeps its class.
   */
  barsPut(series: string, bars: readonly Bar[] | Float64Array, retention: BarRetention | null): void;
  barsLast(series: string): number | null;
  kvGet(ns: string, key: string): { json: string; updatedAt: number } | null;
  kvSet(ns: string, key: string, json: string, updatedAt: number): void;
  kvDelete(ns: string, key: string): void;
  executionsPut(rows: readonly ExecutionRow[]): void;
  /** JSON array text, newest first. */
  executionsSince(since: number): string;
  navAppend(points: readonly NavPoint[]): void;
  /** Packed [t, netLiq] * n, ascending. */
  navAll(): Float64Array;
  navReplace(points: readonly NavPoint[]): void;
  /**
   * Writes the series accesses noted since the last flush (at most one per series per
   * ACCESS_WRITE_MS) in one transaction. Returns whether anything was written.
   */
  flushAccess(): boolean;
  /** Size on disk and contents. */
  stats(): CacheStats;
  /**
   * Deletes bars, series and the market data kv namespaces (dropping the bars table: about 0.1 s
   * for millions of rows). The freed pages stay in the file until vacuum() returns them.
   */
  clearMarketData(): void;
  /**
   * Returns free pages to the file system in steps of about VACUUM_STEP_MS (incremental
   * auto-vacuum files only; on others it ends at once and free pages are reused instead).
   */
  vacuum(): Generator<MaintenanceStep, void, void>;
  /** Unix ms of the last completed maintenance (0 = never). */
  maintainedAt(): number;
  /**
   * Retention, size cap, incremental vacuum, WAL truncation and optimize, one bounded step per
   * iteration; a step that evicted series yields their keys.
   */
  maintenance(now: number, opts?: MaintenanceOptions): Generator<MaintenanceStep, void, void>;
  /** Moves WAL content into the database file and truncates the WAL. */
  checkpoint(): void;
  close(): void;
}

export interface OpenOptions {
  /** Move the current file aside first (corruption found at runtime). */
  reset?: boolean;
  /** Clock of the access tracking (tests). */
  now?: () => number;
}

/**
 * Pages of the next incremental_vacuum step after one of `pages` took `ms`: scaled towards
 * VACUUM_STEP_MS, at most twice as many as before (a fast step may have been luck).
 */
export function nextVacuumPages(pages: number, ms: number): number {
  const scaled = ms > 0 ? Math.round((pages * VACUUM_STEP_MS) / ms) : pages * 2;
  return Math.max(VACUUM_PAGES_MIN, Math.min(VACUUM_PAGES_MAX, pages * 2, scaled));
}

/** SQLite primary result code of an error thrown by node:sqlite, if any. */
export function sqliteCode(err: unknown): number | undefined {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code & 0xff : undefined;
}

export function isCorruption(err: unknown): boolean {
  const code = sqliteCode(err);
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB;
}

/**
 * The head timestamp key of a series key "<contract>|<bar size>|<whatToShow>|<useRTH>"
 * ("head|<contract>|<whatToShow>|<useRTH>", as market/history.ts writes it); null for other keys.
 */
export function headKeyOf(series: string): string | null {
  const parts = series.split('|');
  return parts.length < 4 ? null : ['head', ...parts.slice(0, -3), ...parts.slice(-2)].join('|');
}

/**
 * Opens (creating or migrating) the database. An unreadable file — corrupt, not a database, or
 * with a schema that does not migrate — is moved aside as `<file>.corrupt-<ts>` and recreated.
 * `reset` moves the current file aside unconditionally (corruption found at runtime).
 * Throws when SQLite cannot be used at all (the caller falls back to memory).
 */
export function openStore(file: string, opts: OpenOptions = {}): SqliteStore {
  const now = opts.now ?? Date.now;
  let recovered = opts.reset ? moveAside(file) : undefined;
  try {
    return createStore(openConnection(file), file, recovered, now);
  } catch (err) {
    if (recovered || !isRecoverable(err) || !existsSync(file)) throw err;
    recovered = moveAside(file);
    return createStore(openConnection(file), file, recovered, now);
  }
}

class MigrationError extends Error {}

function openConnection(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    configure(db);
    try {
      migrate(db);
    } catch (err) {
      if (err instanceof NewerSchemaError || sqliteCode(err) !== SQLITE_ERROR) throw err;
      throw new MigrationError(`tape.db schema could not be migrated: ${(err as Error).message}`, { cause: err });
    }
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // already closed
    }
    throw err;
  }
}

const isRecoverable = (err: unknown) => isCorruption(err) || err instanceof MigrationError;

/** Renames the database and its WAL / shared-memory files; returns the new database path. */
function moveAside(file: string): string | undefined {
  const target = `${file}.corrupt-${Date.now()}`;
  let moved = false;
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(file + suffix)) continue;
    renameSync(file + suffix, target + suffix);
    moved = true;
  }
  return moved ? target : undefined;
}

/** Size of a file, 0 when it does not exist. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Retention class of a series from the bar size in its key ("1 secs", "5 mins", "1 hour"; also
 * timeframe keys like "…|5m|…") or, failing that, the bar spacing (below 12 hours: minutes).
 */
export function inferRetention(key: string, times: ArrayLike<number>): BarRetention {
  if (/(^|\|)\d+s(\||$)|\b\d+ secs?\b/.test(key)) return 'seconds';
  if (/(^|\|)\d+h(\||$)|\b\d+ hours?\b/.test(key)) return 'hours';
  // 30-minute bars are kept like hours (db/types.ts).
  const mins = /(?:^|\|)(\d+)m(?:\||$)|\b(\d+) mins?\b/.exec(key);
  if (mins) return Number(mins[1] ?? mins[2]) >= 30 ? 'hours' : 'minutes';
  for (let i = 1; i < times.length; i++) {
    const gap = Math.abs(times[i] - times[i - 1]);
    if (gap > 0 && gap < 12 * 3600) return 'minutes';
  }
  return 'daily';
}

/** Packs bar objects like the client does, so both inputs share one insert loop. */
function packBars(bars: readonly Bar[]): Float64Array {
  const out = new Float64Array(bars.length * BAR_FIELDS);
  for (let i = 0, j = 0; i < bars.length; i++, j += BAR_FIELDS) {
    const b = bars[i];
    out[j] = b?.time;
    out[j + 1] = b?.open;
    out[j + 2] = b?.high;
    out[j + 3] = b?.low;
    out[j + 4] = b?.close;
    out[j + 5] = b?.volume;
  }
  return out;
}

/** Finite number or NULL (node:sqlite cannot bind undefined; NaN would be stored as NULL anyway). */
const real = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

interface SeriesRow {
  id: number;
  retention: BarRetention;
  /** last_access as stored, or as it will be by the next flushAccess. */
  access: number;
}

function createStore(db: DatabaseSync, file: string, recovered: string | undefined, now: () => number): SqliteStore {
  const statements = new Map<string, StatementSync>();
  const arrayStatements = new Map<string, StatementSync>();
  /** Series key -> row (series rows are never renamed; evicted ones are removed). */
  const seriesCache = new Map<string, SeriesRow>();
  /** last_access values to write (series id -> unix ms), batched by flushAccess. */
  const pendingAccess = new Map<number, number>();
  /** Last read or write of each series in this session (id -> accessSeq): eviction stops for a series in use again. */
  const usedAt = new Map<number, number>();
  /** Counts reads and writes of series (a clock that never ties). */
  let accessSeq = 0;
  let depth = 0;

  const sql = (text: string): StatementSync => {
    let s = statements.get(text);
    if (!s) statements.set(text, (s = db.prepare(text)));
    return s;
  };
  /** Statements returning rows as arrays: no per-row key objects for bulk reads. */
  const arrays = (text: string): StatementSync => {
    let s = arrayStatements.get(text);
    if (!s) {
      s = db.prepare(text);
      s.setReturnArrays(true);
      arrayStatements.set(text, s);
    }
    return s;
  };
  /** A numeric PRAGMA's current value. */
  const pragma = (name: string): number => Number(Object.values(sql(`PRAGMA ${name}`).get() ?? {})[0]);
  /** Bytes the data takes in the file (free pages excluded). */
  const dataBytes = () => (pragma('page_count') - pragma('freelist_count')) * pragma('page_size');
  const walBytes = () => fileSize(`${file}-wal`);

  function transaction<T>(fn: () => T): T {
    const savepoint = `sp${depth}`;
    db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    depth++;
    try {
      const result = fn();
      depth--;
      db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      depth--;
      try {
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // SQLite already rolled back (e.g. after an I/O error)
      }
      throw err;
    }
  }

  function seriesOf(key: string): SeriesRow | undefined {
    let s = seriesCache.get(key);
    if (s) return s;
    const row = sql('SELECT id, retention, last_access FROM series WHERE key = ?').get(key) as { id: number; retention: BarRetention; last_access: number } | undefined;
    if (!row) return undefined;
    seriesCache.set(key, (s = { id: row.id, retention: row.retention, access: row.last_access }));
    return s;
  }

  /** The series row, inserted with `retention` (or `infer()`), or updated to `retention` when given and different. */
  function ensureSeries(key: string, retention: BarRetention | null, infer: () => BarRetention): SeriesRow {
    const known = seriesOf(key);
    if (known && (retention === null || known.retention === retention)) return known;
    const row = sql(
      'INSERT INTO series (key, retention, last_access) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET retention = excluded.retention RETURNING id, retention, last_access',
    ).get(key, retention ?? infer(), Math.round(now())) as { id: number; retention: BarRetention; last_access: number };
    const s = { id: row.id, retention: row.retention, access: row.last_access };
    seriesCache.set(key, s);
    return s;
  }

  /** Notes a read or write of a series; its last_access is written by the next flushAccess, at most hourly. */
  function touch(s: SeriesRow): void {
    const t = now();
    usedAt.set(s.id, ++accessSeq);
    if (t - s.access < ACCESS_WRITE_MS) return;
    s.access = t;
    pendingAccess.set(s.id, t);
  }

  /** Whether the series was read or written after `seq` (an earlier accessSeq). */
  const usedSince = (id: number, seq: number) => (usedAt.get(id) ?? 0) > seq;

  function flushAccess(): boolean {
    if (!pendingAccess.size) return false;
    const list = [...pendingAccess];
    pendingAccess.clear();
    transaction(() => {
      const update = sql('UPDATE series SET last_access = max(last_access, ?) WHERE id = ?');
      for (const [id, t] of list) update.run(Math.round(t), id);
    });
    return true;
  }

  function kvGet(ns: string, key: string): { json: string; updatedAt: number } | null {
    const row = sql(SQL.kvGet).get(ns, key) as { value: string; updated_at: number } | undefined;
    return row ? { json: row.value, updatedAt: row.updated_at } : null;
  }

  function kvDelete(ns: string, key: string): void {
    sql('DELETE FROM kv WHERE ns = ? AND key = ?').run(ns, key);
  }

  function navInsert(points: readonly NavPoint[]): void {
    const insert = sql('INSERT OR REPLACE INTO nav (t, net_liq) VALUES (?, ?)');
    for (const p of points) {
      if (Number.isFinite(p?.t) && Number.isFinite(p?.netLiq)) insert.run(Math.round(p.t), p.netLiq);
    }
  }

  /** Deletes up to DELETE_CHUNK of the series' oldest bars before `before`; true when more may be left. */
  function deleteChunk(id: number, before: number): boolean {
    const bound = sql(SQL.barsExpireBound).get(id, before, DELETE_CHUNK - 1) as { time: number } | undefined;
    const deleted = Number(sql(SQL.barsExpire).run(id, bound ? bound.time : before - 1).changes);
    if (deleted) sql('UPDATE series SET bar_count = max(0, bar_count - ?) WHERE id = ?').run(deleted, id);
    return !!bound;
  }

  /**
   * Deletes the coverage document of a series (kv 'coverage', keyed by the series) and, when no
   * other series shares it, the head timestamp of its contract + whatToShow + useRTH.
   */
  function dropSeriesKv(key: string, id: number): void {
    kvDelete(COVERAGE_KV_NS, key);
    const head = headKeyOf(key);
    if (!head) return;
    const contract = key.split('|').slice(0, -3).join('|');
    // Every key starting with "<contract>|" sorts below "<contract>}" ('}' follows '|').
    const siblings = sql(SQL.seriesByPrefix).all(`${contract}|`, `${contract}}`) as Array<{ id: number; key: string }>;
    if (!siblings.some((s) => s.id !== id && headKeyOf(s.key) === head)) kvDelete(COVERAGE_KV_NS, head);
  }

  function forgetSeries(key: string, id: number): void {
    seriesCache.delete(key);
    pendingAccess.delete(id);
    usedAt.delete(id);
  }

  /**
   * Evicts a series: its kv entries go with the first chunk of bars (reported then), the rest of
   * its bars chunk by chunk, the series row with the last one. A series that is read or written
   * again meanwhile is left alone (its coverage is gone, so its bars are fetched again).
   */
  function* evictSeries(id: number, key: string): Generator<MaintenanceStep, void, void> {
    const since = accessSeq;
    for (let first = true; ; first = false) {
      if (!first && usedSince(id, since)) return;
      const more = transaction(() => {
        if (first) dropSeriesKv(key, id);
        if (deleteChunk(id, END_OF_TIME)) return true;
        sql('DELETE FROM series WHERE id = ?').run(id);
        return false;
      });
      if (!more) forgetSeries(key, id);
      yield first ? [key] : undefined;
      if (!more) return;
    }
  }

  function* maintenance(nowMs: number, opts: MaintenanceOptions = {}): Generator<MaintenanceStep, void, void> {
    const started = accessSeq;
    // Accesses noted in memory decide what is unused or least recently used.
    flushAccess();

    // 1. Bars past their class's retention (seconds, minutes, hours), in chunks per series;
    //    series left empty go.
    const nowSec = Math.floor(nowMs / 1000);
    const intraday = sql("SELECT id, retention FROM series WHERE retention != 'daily'").all() as Array<{ id: number; retention: BarRetention }>;
    for (const { id, retention } of intraday) {
      const days = RETENTION_DAYS[retention as Exclude<BarRetention, 'daily'>] ?? INTRADAY_RETENTION_DAYS;
      const cutoff = nowSec - days * 86_400;
      while (transaction(() => deleteChunk(id, cutoff))) yield;
      yield;
    }
    const emptied = sql("SELECT id, key FROM series WHERE retention != 'daily' AND NOT EXISTS (SELECT 1 FROM bars WHERE series_id = series.id)").all() as Array<{
      id: number;
      key: string;
    }>;
    for (const s of emptied) if (!usedSince(s.id, started)) yield* evictSeries(s.id, s.key);

    // 2. Series nobody read or wrote for SERIES_UNUSED_DAYS.
    const unused = sql('SELECT id, key FROM series WHERE last_access < ? ORDER BY last_access, id').all(nowMs - SERIES_UNUSED_DAYS * DAY_MS) as Array<{
      id: number;
      key: string;
    }>;
    for (const s of unused) if (!usedSince(s.id, started)) yield* evictSeries(s.id, s.key);

    // 3. kv entries past their namespace TTL, in chunks.
    const namespaces = (sql('SELECT DISTINCT ns FROM kv').all() as Array<{ ns: string }>).map((r) => r.ns);
    for (const ns of namespaces) {
      const days = KV_TTL_DAYS[ns] ?? KV_TTL_DAYS['*'];
      if (ns === META_NS || days == null) continue;
      const before = nowMs - days * DAY_MS;
      while (transaction(() => Number(sql(SQL.kvExpire).run(ns, ns, before, DELETE_CHUNK).changes)) === DELETE_CHUNK) yield;
      yield;
    }

    // 4. Size cap, until the data is below the target share of the cap (the WAL is truncated
    //    below): first series not used for CAP_RECENT_DAYS (seconds, then minutes and hours,
    //    then daily and longer), then the recently used ones; least recently used first within
    //    each group.
    const cap = opts.capBytes ?? CACHE_CAP_BYTES;
    if (dataBytes() + walBytes() > cap) {
      const target = (cap * CACHE_CAP_TARGET_PERCENT) / 100;
      const order = sql(SQL.capOrder).all(nowMs - CAP_RECENT_DAYS * DAY_MS) as Array<{ id: number; key: string }>;
      for (const s of order) {
        if (dataBytes() <= target) break;
        if (!usedSince(s.id, started)) yield* evictSeries(s.id, s.key);
      }
    }

    // 5. Give freed pages back to the file system.
    yield* vacuum();

    // 6. Refresh planner statistics, note the run, truncate the WAL.
    db.exec('PRAGMA optimize');
    transaction(() => sql('INSERT OR REPLACE INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)').run(META_NS, 'maintainedAt', String(nowMs), nowMs));
    yield;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Only a file created with incremental auto-vacuum can return free pages (on others
   * incremental_vacuum does nothing); stops as well if a step frees nothing.
   */
  function* vacuum(): Generator<MaintenanceStep, void, void> {
    if (pragma('auto_vacuum') !== AUTO_VACUUM_INCREMENTAL) return;
    let pages = VACUUM_PAGES_START;
    for (let free = pragma('freelist_count'); free > 0; ) {
      const started = performance.now();
      db.exec(`PRAGMA incremental_vacuum(${pages})`);
      pages = nextVacuumPages(pages, performance.now() - started);
      yield;
      const left = pragma('freelist_count');
      if (left >= free) break;
      free = left;
    }
  }

  return {
    db,
    file,
    recovered,
    transaction,

    barsGet(series, fromTime, toTime) {
      const s = seriesOf(series);
      if (!s) return new Float64Array(0);
      touch(s);
      const from = fromTime ?? Number.MIN_SAFE_INTEGER;
      const rows = (toTime == null ? arrays(SQL.barsRange).all(s.id, from) : arrays(SQL.barsBetween).all(s.id, from, toTime)) as unknown as Array<Array<number | null>>;
      const out = new Float64Array(rows.length * BAR_FIELDS);
      for (let i = 0, j = 0; i < rows.length; i++) {
        const r = rows[i];
        for (let k = 0; k < BAR_FIELDS; k++, j++) out[j] = r[k] ?? NaN;
      }
      return out;
    },

    barsPut(series, bars, retention) {
      const p = bars instanceof Float64Array ? bars : packBars(bars);
      const n = Math.floor(p.length / BAR_FIELDS);
      if (!n) return;
      transaction(() => {
        const infer = () => {
          const times = new Float64Array(n);
          for (let i = 0; i < n; i++) times[i] = p[i * BAR_FIELDS];
          return inferRetention(series, times);
        };
        const s = ensureSeries(series, retention != null && RETENTIONS.has(retention) ? retention : null, infer);
        touch(s);
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = 0; j < n * BAR_FIELDS; j += BAR_FIELDS) {
          if (!Number.isFinite(p[j])) continue;
          const t = Math.trunc(p[j]);
          if (t < lo) lo = t;
          if (t > hi) hi = t;
        }
        if (lo > hi) return;
        // New rows = rows in the batch's time range after minus before (the others were replaced).
        const count = sql(SQL.barsCount);
        const before = (count.get(s.id, lo, hi) as { n: number }).n;
        const insert = sql(SQL.barsPut);
        for (let j = 0; j < n * BAR_FIELDS; j += BAR_FIELDS) {
          if (!Number.isFinite(p[j])) continue;
          insert.run(s.id, Math.trunc(p[j]), real(p[j + 1]), real(p[j + 2]), real(p[j + 3]), real(p[j + 4]), real(p[j + 5]));
        }
        const added = (count.get(s.id, lo, hi) as { n: number }).n - before;
        if (added) sql('UPDATE series SET bar_count = bar_count + ? WHERE id = ?').run(added, s.id);
      });
    },

    barsLast(series) {
      const s = seriesOf(series);
      if (!s) return null;
      const row = sql(SQL.barsLast).get(s.id) as { t: number | null } | undefined;
      return row?.t ?? null;
    },

    kvGet,

    kvSet(ns, key, json, updatedAt) {
      sql('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
        ns,
        key,
        json,
        Math.round(updatedAt),
      );
    },

    kvDelete,

    executionsPut(rows) {
      if (!rows.length) return;
      transaction(() => {
        const insert = sql('INSERT OR REPLACE INTO executions (exec_id, time, json) VALUES (?, ?, ?)');
        for (const r of rows) {
          if (r?.execId && Number.isFinite(r.time) && typeof r.json === 'string') insert.run(r.execId, Math.round(r.time), r.json);
        }
      });
    },

    executionsSince(since) {
      const rows = arrays(SQL.executionsSince).all(since) as unknown as Array<[string]>;
      let out = '[';
      for (let i = 0; i < rows.length; i++) out += (i ? ',' : '') + rows[i][0];
      return out + ']';
    },

    navAppend(points) {
      if (points.length) transaction(() => navInsert(points));
    },

    navAll() {
      const rows = arrays('SELECT t, net_liq FROM nav ORDER BY t').all() as unknown as Array<[number, number]>;
      const out = new Float64Array(rows.length * 2);
      for (let i = 0; i < rows.length; i++) {
        out[i * 2] = rows[i][0];
        out[i * 2 + 1] = rows[i][1];
      }
      return out;
    },

    navReplace(points) {
      transaction(() => {
        db.exec('DELETE FROM nav');
        navInsert(points);
      });
    },

    flushAccess,

    stats() {
      flushAccess();
      const s = sql('SELECT count(*) AS series, coalesce(sum(bar_count), 0) AS bars, min(last_access) AS oldest FROM series').get() as {
        series: number;
        bars: number;
        oldest: number | null;
      };
      const executions = (sql('SELECT count(*) AS n FROM executions').get() as { n: number }).n;
      const bytes = fileSize(file) + walBytes() || pragma('page_count') * pragma('page_size');
      return { bytes, series: s.series, bars: s.bars, executions, ...(s.oldest != null ? { oldestAccess: s.oldest } : {}) };
    },

    clearMarketData() {
      const ddl = (sql("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'bars'").get() as { sql: string }).sql;
      transaction(() => {
        // Dropping the table frees its pages at once; deleting millions of rows one by one
        // would hold the worker for seconds.
        db.exec('DROP TABLE bars');
        db.exec(ddl);
        db.exec('DELETE FROM series');
        for (const ns of MARKET_DATA_NS) sql('DELETE FROM kv WHERE ns = ?').run(ns);
      });
      seriesCache.clear();
      pendingAccess.clear();
      usedAt.clear();
    },

    vacuum,

    maintainedAt: () => kvGet(META_NS, 'maintainedAt')?.updatedAt ?? 0,

    maintenance,

    checkpoint() {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },

    close() {
      if (!db.isOpen) return;
      try {
        flushAccess();
        db.exec('PRAGMA optimize');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    },
  };
}
