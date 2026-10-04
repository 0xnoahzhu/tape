// SQLite operations of the database worker (synchronous; they run on the worker thread).
// Unit tests use them in-process on temporary files.

import { existsSync, renameSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Bar, NavPoint } from '@shared/types';
import type { ExecutionRow } from './protocol';
import { configure, migrate, NewerSchemaError } from './schema';

/** Intraday bars older than this are dropped by maintenance; daily and longer bars are kept. */
export const INTRADAY_RETENTION_DAYS = 30;
/** kv holds caches: entries not rewritten for this many days are dropped ('*' = any namespace). */
export const KV_TTL_DAYS: Readonly<Record<string, number>> = { '*': 180 };
/** Namespace for the database's own bookkeeping (exempt from the TTL). */
const META_NS = '__tape';
const DAY_MS = 86_400_000;
/** Rows per retention DELETE, so maintenance yields to requests between chunks. */
const DELETE_CHUNK = 5_000;
/** Pages returned to the file system per incremental_vacuum step (4 KiB pages). */
const VACUUM_PAGES = 2_048;
const BAR_FIELDS = 6;
/** PRAGMA auto_vacuum value of a file whose free pages incremental_vacuum can release. */
const AUTO_VACUUM_INCREMENTAL = 2;

const SQLITE_ERROR = 1;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** Statements whose query plans the tests check (no full scans on large tables). */
export const SQL = {
  barsRange: 'SELECT time, o, h, l, c, v FROM bars WHERE series_id = ? AND time >= ? ORDER BY time',
  barsLast: 'SELECT max(time) AS t FROM bars WHERE series_id = ?',
  barsPut: 'INSERT OR REPLACE INTO bars (series_id, time, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)',
  barsExpire: 'DELETE FROM bars WHERE series_id = ? AND time <= ?',
  barsExpireBound: 'SELECT time FROM bars WHERE series_id = ? AND time < ? ORDER BY time LIMIT 1 OFFSET ?',
  executionsSince: 'SELECT json FROM executions WHERE time >= ? ORDER BY time DESC',
  kvGet: 'SELECT value, updated_at FROM kv WHERE ns = ? AND key = ?',
  kvExpire: 'DELETE FROM kv WHERE ns = ? AND updated_at < ?',
} as const;

export interface SqliteStore {
  readonly db: DatabaseSync;
  readonly file: string;
  /** Path the previous (unreadable) file was moved to when the database was recreated. */
  readonly recovered?: string;
  /** Runs `fn` in a transaction (a savepoint when nested). */
  transaction<T>(fn: () => T): T;
  /** Packed [time, o, h, l, c, v] * n, ascending. */
  barsGet(series: string, fromTime: number | null): Float64Array;
  /**
   * Bars as objects, or packed [time, o, h, l, c, v] * n (what the worker receives).
   * `intraday` null: inferred from the series key and bar spacing.
   */
  barsPut(series: string, bars: readonly Bar[] | Float64Array, intraday: boolean | null): void;
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
  /** Unix ms of the last completed maintenance (0 = never). */
  maintainedAt(): number;
  /** Retention, incremental vacuum and optimize, one bounded step per iteration. */
  maintenance(now: number): Generator<void, void, void>;
  /** Moves WAL content into the database file and truncates the WAL. */
  checkpoint(): void;
  close(): void;
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
 * Opens (creating or migrating) the database. An unreadable file — corrupt, not a database, or
 * with a schema that does not migrate — is moved aside as `<file>.corrupt-<ts>` and recreated.
 * `reset` moves the current file aside unconditionally (corruption found at runtime).
 * Throws when SQLite cannot be used at all (the caller falls back to memory).
 */
export function openStore(file: string, opts: { reset?: boolean } = {}): SqliteStore {
  let recovered = opts.reset ? moveAside(file) : undefined;
  try {
    return createStore(openConnection(file), file, recovered);
  } catch (err) {
    if (recovered || !isRecoverable(err) || !existsSync(file)) throw err;
    recovered = moveAside(file);
    return createStore(openConnection(file), file, recovered);
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

/** A bar size below one day, from the series key ("…|5m|…", "1 min") or the bar spacing. */
export function looksIntraday(key: string, times: ArrayLike<number>): boolean {
  if (/(^|\|)\d+[smh](\||$)|\b\d+ (secs?|mins?|hours?)\b/.test(key)) return true;
  for (let i = 1; i < times.length; i++) {
    const gap = Math.abs(times[i] - times[i - 1]);
    if (gap > 0 && gap < 12 * 3600) return true;
  }
  return false;
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

function createStore(db: DatabaseSync, file: string, recovered: string | undefined): SqliteStore {
  const statements = new Map<string, StatementSync>();
  const arrayStatements = new Map<string, StatementSync>();
  /** Series key -> id / intraday flag (series rows are never renamed). */
  const seriesCache = new Map<string, { id: number; intraday: boolean }>();
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

  function seriesOf(key: string): { id: number; intraday: boolean } | undefined {
    let s = seriesCache.get(key);
    if (s) return s;
    const row = sql('SELECT id, intraday FROM series WHERE key = ?').get(key) as { id: number; intraday: number } | undefined;
    if (!row) return undefined;
    seriesCache.set(key, (s = { id: row.id, intraday: row.intraday === 1 }));
    return s;
  }

  function ensureSeries(key: string, intraday: boolean): number {
    const known = seriesOf(key);
    if (known && (known.intraday || !intraday)) return known.id;
    // Insert, or upgrade to intraday (a series never goes back to daily retention).
    const row = sql(
      'INSERT INTO series (key, intraday) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET intraday = max(intraday, excluded.intraday) RETURNING id, intraday',
    ).get(key, intraday ? 1 : 0) as { id: number; intraday: number };
    seriesCache.set(key, { id: row.id, intraday: row.intraday === 1 });
    return row.id;
  }

  function kvGet(ns: string, key: string): { json: string; updatedAt: number } | null {
    const row = sql(SQL.kvGet).get(ns, key) as { value: string; updated_at: number } | undefined;
    return row ? { json: row.value, updatedAt: row.updated_at } : null;
  }

  function navInsert(points: readonly NavPoint[]): void {
    const insert = sql('INSERT OR REPLACE INTO nav (t, net_liq) VALUES (?, ?)');
    for (const p of points) {
      if (Number.isFinite(p?.t) && Number.isFinite(p?.netLiq)) insert.run(Math.round(p.t), p.netLiq);
    }
  }

  function* maintenance(now: number): Generator<void, void, void> {
    // 1. Intraday bars past the retention window, in chunks per series.
    const cutoff = Math.floor(now / 1000) - INTRADAY_RETENTION_DAYS * 86_400;
    const intraday = sql('SELECT id FROM series WHERE intraday = 1').all() as Array<{ id: number }>;
    for (const { id } of intraday) {
      for (;;) {
        const bound = sql(SQL.barsExpireBound).get(id, cutoff, DELETE_CHUNK - 1) as { time: number } | undefined;
        transaction(() => sql(SQL.barsExpire).run(id, bound ? bound.time : cutoff - 1));
        yield;
        if (!bound) break;
      }
    }
    transaction(() => db.exec('DELETE FROM series WHERE intraday = 1 AND NOT EXISTS (SELECT 1 FROM bars WHERE series_id = series.id)'));
    seriesCache.clear();
    yield;

    // 2. kv entries past their namespace TTL.
    const namespaces = (sql('SELECT DISTINCT ns FROM kv').all() as Array<{ ns: string }>).map((r) => r.ns);
    for (const ns of namespaces) {
      const days = KV_TTL_DAYS[ns] ?? KV_TTL_DAYS['*'];
      if (ns === META_NS || days == null) continue;
      transaction(() => sql(SQL.kvExpire).run(ns, now - days * DAY_MS));
      yield;
    }

    // 3. Give freed pages back to the file system, then refresh planner statistics. Only a file
    //    created with incremental auto-vacuum can (on others incremental_vacuum does nothing and
    //    free pages are reused instead); stop as well if a step frees nothing.
    if (pragma('auto_vacuum') === AUTO_VACUUM_INCREMENTAL) {
      for (let free = pragma('freelist_count'); free > 0; ) {
        db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
        yield;
        const left = pragma('freelist_count');
        if (left >= free) break;
        free = left;
      }
    }
    db.exec('PRAGMA optimize');
    transaction(() => sql('INSERT OR REPLACE INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)').run(META_NS, 'maintainedAt', String(now), now));
  }

  return {
    db,
    file,
    recovered,
    transaction,

    barsGet(series, fromTime) {
      const s = seriesOf(series);
      if (!s) return new Float64Array(0);
      const rows = arrays(SQL.barsRange).all(s.id, fromTime ?? Number.MIN_SAFE_INTEGER) as unknown as Array<Array<number | null>>;
      const out = new Float64Array(rows.length * BAR_FIELDS);
      for (let i = 0, j = 0; i < rows.length; i++) {
        const r = rows[i];
        for (let k = 0; k < BAR_FIELDS; k++, j++) out[j] = r[k] ?? NaN;
      }
      return out;
    },

    barsPut(series, bars, intraday) {
      const p = bars instanceof Float64Array ? bars : packBars(bars);
      const n = Math.floor(p.length / BAR_FIELDS);
      if (!n) return;
      transaction(() => {
        let isIntraday = intraday;
        if (isIntraday == null) {
          const times = new Float64Array(n);
          for (let i = 0; i < n; i++) times[i] = p[i * BAR_FIELDS];
          isIntraday = looksIntraday(series, times);
        }
        const id = ensureSeries(series, isIntraday);
        const insert = sql(SQL.barsPut);
        for (let j = 0; j < n * BAR_FIELDS; j += BAR_FIELDS) {
          if (!Number.isFinite(p[j])) continue;
          insert.run(id, Math.trunc(p[j]), real(p[j + 1]), real(p[j + 2]), real(p[j + 3]), real(p[j + 4]), real(p[j + 5]));
        }
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

    kvDelete(ns, key) {
      sql('DELETE FROM kv WHERE ns = ? AND key = ?').run(ns, key);
    },

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

    maintainedAt: () => kvGet(META_NS, 'maintainedAt')?.updatedAt ?? 0,

    maintenance,

    checkpoint() {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },

    close() {
      if (!db.isOpen) return;
      try {
        db.exec('PRAGMA optimize');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    },
  };
}
