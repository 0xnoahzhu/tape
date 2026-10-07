// Retention of tape.db: schema v2 (series.last_access, bar_count), access batching, eviction of
// unused series, the size cap, chunked maintenance and clearing the market data cache; the later
// migrations (v3 retention classes, v4 NAV per account).

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractKey, stock } from '@shared/contract';
import type { Bar } from '@shared/types';
import { CONTRACT_NS } from '../market/contracts';
import { COVERAGE_NS } from '../market/history';
import { historySpec, seriesKey } from '../market/historyParams';
import { SECDEF_NS } from '../market/options';
import { unpackBars, unpackNav } from './client';
import { configure, migrate, SCHEMA_VERSION, schemaVersion } from './schema';
import { MEMORY_MARKET_DATA_NS } from './memory';
import { LIVE, LIVE_ROWS, PAPER, PAPER_ROWS, USER_ROWS } from './navCases';
import type { BarRetention } from './types';
import {
  ACCESS_WRITE_MS,
  CACHE_CAP_TARGET_PERCENT,
  CAP_RECENT_DAYS,
  COVERAGE_KV_NS,
  DELETE_CHUNK,
  headKeyOf,
  MARKET_DATA_NS,
  nextVacuumPages,
  openStore,
  SQL,
  VACUUM_PAGES_MAX,
  VACUUM_PAGES_START,
  VACUUM_STEP_MS,
  type MaintenanceStep,
  type SqliteStore,
} from './sqlite';

const DAY = 86_400;
const DAY_MS = DAY * 1000;
const T0 = Date.UTC(2026, 9, 4, 16); // unix ms
const t0 = T0 / 1000;
const bar = (time: number, close = 100): Bar => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 10 });
/** n bars `step` seconds apart, ending before `end`. */
const barsBefore = (end: number, n: number, step: number) => Array.from({ length: n }, (_, i) => bar(end - (n - i) * step));
const AAPL_D = 'STK:AAPL|1 day|TRADES|1';
const AAPL_W = 'STK:AAPL|1 week|TRADES|1';
const MSFT_D = 'STK:MSFT|1 day|TRADES|1';
const AAPL_HEAD = 'head|STK:AAPL|TRADES|1';
const MSFT_HEAD = 'head|STK:MSFT|TRADES|1';

const pragma = (db: DatabaseSync, name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0]);
const dataBytes = (db: DatabaseSync) => (pragma(db, 'page_count') - pragma(db, 'freelist_count')) * pragma(db, 'page_size');
const seriesKeys = (s: SqliteStore) => (s.db.prepare('SELECT key FROM series ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key);
const seriesRow = (s: SqliteStore, key: string) =>
  s.db.prepare('SELECT last_access, bar_count FROM series WHERE key = ?').get(key) as { last_access: number; bar_count: number } | undefined;
const countBars = (s: SqliteStore) => (s.db.prepare('SELECT count(*) AS n FROM bars').get() as { n: number }).n;
const plan = (db: DatabaseSync, sql: string) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

/** Runs maintenance to the end; returns the evicted series in the order they were reported. */
function maintain(store: SqliteStore, now: number, capBytes?: number): string[] {
  const evicted: string[] = [];
  for (const step of store.maintenance(now, capBytes ? { capBytes } : {})) if (step) evicted.push(...step);
  return evicted;
}

describe('tape.db retention', () => {
  let dir: string;
  let file: string;
  let clock: number;
  let store: SqliteStore;
  const open = () => openStore(file, { now: () => clock });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tape-ret-'));
    file = join(dir, 'tape.db');
    clock = T0;
    store = open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a v1 file: every series counts as used now and gets its bar count', () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'tape-ret-'));
    file = join(dir, 'tape.db');
    // A file written by the previous version (schema v1).
    const v1 = new DatabaseSync(file);
    configure(v1);
    migrate(v1, 1);
    expect(schemaVersion(v1)).toBe(1);
    v1.exec(`
      INSERT INTO series (id, key, intraday) VALUES (1, '${AAPL_D}', 0), (2, 'STK:AAPL|1 min|TRADES|1', 1), (3, 'EMPTY|1 day', 0);
      INSERT INTO bars (series_id, time, o, h, l, c, v) VALUES (1, 86400, 1, 2, 0, 1, 10), (1, 172800, 1, 2, 0, 2, 10), (2, 60, 1, 1, 1, 1, 1);
      INSERT INTO kv (ns, key, value, updated_at) VALUES ('coverage', '${AAPL_D}', '{"ranges":[[86400,172801]]}', 1000);
      INSERT INTO executions (exec_id, time, json) VALUES ('e.1', 1000, '{"execId":"e.1"}');
      INSERT INTO nav (t, net_liq) VALUES (1000, 5);
    `);
    v1.close();

    const before = Date.now();
    store = open();
    const after = Date.now();
    expect(store.recovered).toBeUndefined();
    expect(schemaVersion(store.db)).toBe(SCHEMA_VERSION);
    const rows = store.db.prepare('SELECT key, last_access, bar_count FROM series ORDER BY id').all() as Array<{ key: string; last_access: number; bar_count: number }>;
    expect(rows.map((r) => [r.key, r.bar_count])).toEqual([
      [AAPL_D, 2],
      ['STK:AAPL|1 min|TRADES|1', 1],
      ['EMPTY|1 day', 0],
    ]);
    // SQLite's clock, whole seconds.
    for (const r of rows) {
      expect(r.last_access).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(r.last_access).toBeLessThanOrEqual(after);
    }
    expect(unpackBars(store.barsGet(AAPL_D, null)).map((b) => b.close)).toEqual([1, 2]);
    expect(store.kvGet('coverage', AAPL_D)?.json).toBe('{"ranges":[[86400,172801]]}');
    expect(store.stats()).toMatchObject({ series: 3, bars: 3, executions: 1 });
    expect(unpackNav(store.navAll())).toEqual([{ t: 1000, netLiq: 5 }]);
    expect(store.navGet('DU1').length).toBe(0); // no account (v4) until one claims it
    expect(store.db.prepare('SELECT key, retention FROM series ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { key: AAPL_D, retention: 'daily' },
      { key: 'STK:AAPL|1 min|TRADES|1', retention: 'minutes' },
      { key: 'EMPTY|1 day', retention: 'daily' },
    ]);
  });

  it('migrates the intraday flag (v2) to retention classes by the bar size in the key (v3), keeping every bar and dropping coverage the longer classes cannot trust', () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'tape-ret-'));
    file = join(dir, 'tape.db');
    const v2 = new DatabaseSync(file);
    configure(v2);
    migrate(v2, 2);
    const keys: Array<[string, number]> = [
      ['STK:AAPL|1 secs|TRADES|0', 1],
      ['STK:AAPL|30 secs|TRADES|0', 1],
      ['STK:AAPL|1 min|TRADES|0', 1],
      ['STK:AAPL|30 mins|TRADES|0', 1],
      ['STK:AAPL|1 hour|TRADES|0', 1],
      ['STK:AAPL|4 hours|TRADES|0', 1],
      ['STK:AAPL|1 day|TRADES|1', 0],
      ['OPT:AAPL:20261120:260:C|1 day|TRADES|1', 0],
    ];
    keys.forEach(([key, intraday], i) => v2.prepare('INSERT INTO series (id, key, intraday, bar_count) VALUES (?, ?, ?, 1)').run(i + 1, key, intraday));
    keys.forEach((_, i) => v2.prepare('INSERT INTO bars (series_id, time, o, h, l, c, v) VALUES (?, 60, 1, 1, 1, 1, 1)').run(i + 1));
    // Coverage written by the old service (clipped to 29 days when written, while its maintenance
    // went on deleting bars past 30 days): the series that now stay longer have theirs dropped.
    const kv = v2.prepare("INSERT INTO kv (ns, key, value, updated_at) VALUES ('coverage', ?, '{\"ranges\":[[1,2]]}', 1)");
    for (const [key] of keys) kv.run(key);
    kv.run('head|STK:AAPL|TRADES|0');
    v2.close();
    store = open();
    expect(schemaVersion(store.db)).toBe(SCHEMA_VERSION);
    expect(store.db.prepare("SELECT key FROM kv WHERE ns = 'coverage' ORDER BY key").all().map((r) => (r as { key: string }).key)).toEqual(
      [
        'OPT:AAPL:20261120:260:C|1 day|TRADES|1',
        'STK:AAPL|1 day|TRADES|1',
        'STK:AAPL|1 min|TRADES|0',
        'STK:AAPL|1 secs|TRADES|0',
        'STK:AAPL|30 secs|TRADES|0',
        'head|STK:AAPL|TRADES|0',
      ].sort(),
    );
    expect(store.db.prepare('SELECT retention FROM series ORDER BY id').all().map((r) => (r as { retention: string }).retention)).toEqual([
      'seconds',
      'seconds',
      'minutes',
      'hours',
      'hours',
      'hours',
      'daily',
      'daily',
    ]);
    expect(store.stats()).toMatchObject({ series: keys.length, bars: keys.length });
    // The old column is gone.
    expect(store.db.prepare("SELECT count(*) AS n FROM pragma_table_info('series') WHERE name = 'intraday'").get()).toEqual({ n: 0 });
  });

  it("migrates v3 to v4: the NAV rows keep their values without an account (the paper and live accounts' samples, mixed), shown by no account until claimed", () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'tape-ret-'));
    file = join(dir, 'tape.db');
    const v3 = new DatabaseSync(file);
    configure(v3);
    migrate(v3, 3);
    const insert = v3.prepare('INSERT INTO nav (t, net_liq) VALUES (?, ?)');
    for (const p of USER_ROWS) insert.run(p.t, p.netLiq);
    v3.close();

    store = open();
    expect(store.recovered).toBeUndefined();
    expect(schemaVersion(store.db)).toBe(4);
    expect((store.db.prepare('PRAGMA index_list(nav)').all() as Array<{ name: string }>).map((i) => i.name)).toContain('nav_account_t');
    expect(store.db.prepare('SELECT count(*) AS n FROM nav WHERE account IS NULL').get()).toEqual({ n: USER_ROWS.length });
    expect(unpackNav(store.navAll())).toEqual(USER_ROWS);
    expect(store.navGet(PAPER).length).toBe(0);
    expect(store.navLastAccount()).toBeNull();
    // The paper account's first sample takes its rows; the live account's three wait for it.
    const sample = { t: Date.UTC(2026, 9, 7, 14), netLiq: 1_051_800 };
    store.navAppend(PAPER, [sample]);
    expect(unpackNav(store.navGet(PAPER))).toEqual([...PAPER_ROWS, sample]);
    expect(unpackNav(store.navGet(LIVE))).toEqual([]);
    store.navAppend(LIVE, [{ t: sample.t + 60_000, netLiq: 31_040 }]);
    expect(unpackNav(store.navGet(LIVE))).toEqual([...LIVE_ROWS, { t: sample.t + 60_000, netLiq: 31_040 }]);
  });

  it('keeps the bar count exact through overlapping puts, retention and eviction', () => {
    store.barsPut(AAPL_D, barsBefore(t0, 10, DAY), null);
    store.barsPut(AAPL_D, [...barsBefore(t0, 3, DAY), bar(t0), bar(t0), bar(NaN)], null); // 1 new, 3 replaced, a duplicate, an invalid time
    store.barsPut('X|1 min|TRADES|1', barsBefore(t0, 100, 60), 'minutes');
    store.barsPut('X|1 min|TRADES|1', barsBefore(t0 - 40 * DAY, 50, 60), 'minutes'); // past the intraday retention
    expect(store.stats().bars).toBe(countBars(store));
    expect(store.stats().bars).toBe(161);
    expect(seriesRow(store, AAPL_D)?.bar_count).toBe(11);
    maintain(store, T0);
    expect(store.stats().bars).toBe(countBars(store));
    expect(seriesRow(store, 'X|1 min|TRADES|1')?.bar_count).toBe(100);
  });

  it('notes reads in memory and writes last_access at most hourly per series, in one transaction', () => {
    store.barsPut(AAPL_D, [bar(DAY)], null);
    store.barsPut(MSFT_D, [bar(DAY)], null);
    store.barsPut(AAPL_W, [bar(DAY)], null);
    expect(seriesRow(store, AAPL_D)?.last_access).toBe(T0); // a new series counts as used
    const exec = vi.spyOn(store.db, 'exec');
    const begins = () => exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE').length;

    // Within the hour: reads write nothing, now or at the next flush.
    clock = T0 + ACCESS_WRITE_MS - 1;
    for (let i = 0; i < 20; i++) store.barsGet(AAPL_D, null);
    expect(begins()).toBe(0);
    expect(store.flushAccess()).toBe(false);

    // After an hour: reads are still only noted; one flush writes both series in one transaction.
    clock = T0 + ACCESS_WRITE_MS + 5;
    for (let i = 0; i < 20; i++) store.barsGet(AAPL_D, null), store.barsGet(MSFT_D, null);
    expect(begins()).toBe(0);
    expect(store.flushAccess()).toBe(true);
    expect(begins()).toBe(1);
    expect(seriesRow(store, AAPL_D)?.last_access).toBe(T0 + ACCESS_WRITE_MS + 5);
    expect(seriesRow(store, MSFT_D)?.last_access).toBe(T0 + ACCESS_WRITE_MS + 5);
    expect(seriesRow(store, AAPL_W)?.last_access).toBe(T0);
    expect(store.flushAccess()).toBe(false);

    // Written again only an hour after the last write; close() writes what is pending.
    clock += ACCESS_WRITE_MS / 2;
    store.barsGet(AAPL_D, null);
    expect(store.flushAccess()).toBe(false);
    clock += ACCESS_WRITE_MS / 2;
    store.barsGet(AAPL_D, null);
    exec.mockRestore();
    store.close();
    store = open();
    expect(seriesRow(store, AAPL_D)?.last_access).toBe(clock);
    expect(store.stats().oldestAccess).toBe(T0);
  });

  it('evicts series unused for 90 days with their coverage, and a head timestamp with its last series', () => {
    clock = T0 - 100 * DAY_MS;
    store.barsPut(AAPL_D, barsBefore(t0 - 100 * DAY, 300, DAY), 'daily');
    store.barsPut(AAPL_W, barsBefore(t0 - 100 * DAY, 100, 7 * DAY), 'daily');
    store.barsPut(MSFT_D, barsBefore(t0 - 100 * DAY, 300, DAY), 'daily');
    for (const k of [AAPL_D, AAPL_W, MSFT_D, AAPL_HEAD, MSFT_HEAD]) store.kvSet('coverage', k, '{}', T0);
    store.kvSet('contract', 'AAPL', '{}', T0);
    // AAPL weekly was opened 10 days ago.
    clock = T0 - 10 * DAY_MS;
    store.barsGet(AAPL_W, null);
    store.close(); // writes the access
    store = open();

    clock = T0;
    expect(maintain(store, T0).sort()).toEqual([AAPL_D, MSFT_D]);
    expect(seriesKeys(store)).toEqual([AAPL_W]);
    expect(store.barsGet(AAPL_D, null).length).toBe(0);
    expect(store.barsGet(AAPL_W, null).length / 6).toBe(100);
    expect(store.kvGet('coverage', AAPL_D)).toBeNull();
    expect(store.kvGet('coverage', MSFT_D)).toBeNull();
    expect(store.kvGet('coverage', MSFT_HEAD)).toBeNull();
    // Still used by the weekly series of the same contract.
    expect(store.kvGet('coverage', AAPL_HEAD)).not.toBeNull();
    expect(store.kvGet('coverage', AAPL_W)).not.toBeNull();
    expect(store.kvGet('contract', 'AAPL')).not.toBeNull();
    expect(store.stats()).toMatchObject({ series: 1, bars: 100, oldestAccess: T0 }); // read just now
    // An evicted series is stored again from scratch.
    store.barsPut(AAPL_D, [bar(t0 - DAY)], 'daily');
    expect(seriesRow(store, AAPL_D)).toEqual({ last_access: T0, bar_count: 1 });
  });

  it('over the size cap: evicts series unused for a week first (seconds, then minutes and hours, then daily), then the least recently used, until under 80% of the cap', () => {
    const n = 20_000;
    // Six series of the same size, opened at different times.
    const put = (key: string, hoursAgo: number, retention: BarRetention) => {
      clock = T0 - hoursAgo * 3_600_000;
      store.barsPut(key, barsBefore(t0 - DAY, n, retention === 'daily' ? DAY : retention === 'seconds' ? 1 : 60), retention);
      store.kvSet('coverage', key, '{}', clock);
    };
    expect(CAP_RECENT_DAYS).toBe(7);
    put('I1|1 min|TRADES|1', 8 * 24, 'minutes');
    put('D1|1 day|TRADES|1', 30 * 24, 'daily');
    put('S1|1 secs|TRADES|0', 7.5 * 24, 'seconds');
    put('D2|1 day|TRADES|1', 10 * 24, 'daily');
    put('I2|1 min|TRADES|1', 3, 'minutes');
    put('D3|1 day|TRADES|1', 2, 'daily');
    // The intraday chart on screen was read a minute ago.
    clock = T0 - 60_000;
    store.barsGet('I2|1 min|TRADES|1', null);
    store.checkpoint();
    clock = T0;
    const total = dataBytes(store.db);
    const fileBefore = statSync(file).size;

    // Data must fall below 80% of 55% of the total: four of the six series go, the ones not
    // used for a week (seconds, then minutes, then daily least recently used first).
    const cap = Math.round(total * 0.55);
    expect(maintain(store, T0, cap)).toEqual(['S1|1 secs|TRADES|0', 'I1|1 min|TRADES|1', 'D1|1 day|TRADES|1', 'D2|1 day|TRADES|1']);
    expect(seriesKeys(store)).toEqual(['D3|1 day|TRADES|1', 'I2|1 min|TRADES|1']);
    expect(dataBytes(store.db)).toBeLessThanOrEqual((cap * CACHE_CAP_TARGET_PERCENT) / 100);
    expect(store.kvGet('coverage', 'D1|1 day|TRADES|1')).toBeNull();
    expect(store.kvGet('coverage', 'D3|1 day|TRADES|1')).not.toBeNull();
    // The freed pages went back to the file system and the WAL was truncated.
    expect(statSync(file).size).toBeLessThan(fileBefore * 0.5);
    expect(statSync(`${file}-wal`).size).toBe(0);
    expect(store.stats()).toMatchObject({ series: 2, bars: 2 * n });

    // Under the cap nothing more goes.
    expect(maintain(store, T0, cap)).toEqual([]);
    expect(seriesKeys(store)).toHaveLength(2);
    // A smaller cap reaches the recently used series, least recently used first: the chart on
    // screen stays.
    expect(maintain(store, T0, Math.round(dataBytes(store.db) * 0.9))).toEqual(['D3|1 day|TRADES|1']);
    expect(seriesKeys(store)).toEqual(['I2|1 min|TRADES|1']);
  });

  it('maintenance deletes at most DELETE_CHUNK rows per step, in transactions the queue can get between', () => {
    // 12,000 intraday bars past retention, an unused daily series of 12,000 bars, 6,000 expired kv entries.
    store.barsPut('OLD|1 min|TRADES|1', barsBefore(t0 - 40 * DAY, 12_000, 60), 'minutes');
    store.barsPut('NEW|1 min|TRADES|1', barsBefore(t0, 100, 60), 'minutes');
    clock = T0 - 120 * DAY_MS;
    store.barsPut(AAPL_D, barsBefore(t0, 12_000, DAY), 'daily');
    store.transaction(() => {
      for (let i = 0; i < 6_000; i++) store.kvSet('contract', `c${i}`, '{}', T0 - 200 * DAY_MS);
    });
    clock = T0;
    store.db.exec(`
      CREATE TEMP TABLE deleted (n INTEGER NOT NULL);
      INSERT INTO deleted VALUES (0);
      CREATE TEMP TRIGGER bars_deleted AFTER DELETE ON main.bars BEGIN UPDATE deleted SET n = n + 1; END;
      CREATE TEMP TRIGGER kv_deleted AFTER DELETE ON main.kv BEGIN UPDATE deleted SET n = n + 1; END;
      CREATE TEMP TRIGGER series_deleted AFTER DELETE ON main.series BEGIN UPDATE deleted SET n = n + 1; END;
    `);
    const exec = vi.spyOn(store.db, 'exec');
    const deleted = () => (store.db.prepare('SELECT n FROM deleted').get() as { n: number }).n;
    const perStep: number[] = [];
    const transactionsPerStep: number[] = [];
    const steps = store.maintenance(T0);
    for (let r = steps.next(); ; r = steps.next()) {
      perStep.push(deleted());
      transactionsPerStep.push(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE').length);
      exec.mockClear();
      store.db.exec('UPDATE deleted SET n = 0');
      if (r.done) break;
    }
    exec.mockRestore();
    expect(Math.max(...perStep)).toBeLessThanOrEqual(DELETE_CHUNK);
    expect(Math.max(...transactionsPerStep.slice(0, -1))).toBe(1);
    // Everything expected went: 12,000 + 12,000 bars, 2 series (the emptied intraday one, the unused one), 6,000 kv.
    expect(perStep.reduce((a, b) => a + b, 0)).toBe(12_000 + 12_000 + 2 + 6_000);
    expect(seriesKeys(store)).toEqual(['NEW|1 min|TRADES|1']);
    expect(perStep.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3 + 3 + 2);
  });

  it('leaves a series that is used again while it is being evicted', () => {
    clock = T0 - 100 * DAY_MS;
    store.barsPut(AAPL_D, barsBefore(t0, 3 * DELETE_CHUNK, DAY), 'daily');
    store.kvSet('coverage', AAPL_D, '{}', T0);
    clock = T0;
    const steps = store.maintenance(T0);
    let step: IteratorResult<MaintenanceStep> | undefined;
    do step = steps.next();
    while (!step.done && !step.value);
    // Reported with its first chunk: the coverage is gone already.
    expect(step.value).toEqual([AAPL_D]);
    expect(store.kvGet('coverage', AAPL_D)).toBeNull();
    // A chart reads it: the eviction stops there.
    clock += 1;
    const left = store.barsGet(AAPL_D, null).length / 6;
    expect(left).toBe(2 * DELETE_CHUNK);
    while (!steps.next().done);
    expect(seriesKeys(store)).toEqual([AAPL_D]);
    expect(store.barsGet(AAPL_D, null).length / 6).toBe(left);
    expect(seriesRow(store, AAPL_D)?.bar_count).toBe(left);
  });

  it('clearing the market data keeps executions, the NAV history and other kv, and shrinks the file', () => {
    for (let s = 0; s < 20; s++) store.barsPut(`S${s}|1 day|TRADES|1`, barsBefore(t0, 2_000, DAY), 'daily');
    for (const ns of MARKET_DATA_NS) store.kvSet(ns, 'k', '{}', T0);
    store.kvSet('other', 'k', '{}', T0);
    store.executionsPut([{ execId: 'e.1', time: 1, json: '{"execId":"e.1"}' }]);
    store.navAppend('DU1', [{ t: 1, netLiq: 1 }]);
    store.checkpoint();
    const before = store.stats();
    expect(before).toMatchObject({ series: 20, bars: 40_000, executions: 1, oldestAccess: T0 });

    store.clearMarketData();
    expect(store.stats()).toMatchObject({ series: 0, bars: 0, executions: 1 });
    // The space comes back in vacuum steps (the worker serves requests between them).
    expect(pragma(store.db, 'freelist_count')).toBeGreaterThan(0);
    for (const step of store.vacuum()) expect(step).toBeUndefined();
    expect(pragma(store.db, 'freelist_count')).toBe(0);
    store.checkpoint();
    const after = store.stats();
    expect(after).toEqual({ bytes: after.bytes, series: 0, bars: 0, executions: 1 });
    expect(after.bytes).toBeLessThan(before.bytes / 4);
    for (const ns of MARKET_DATA_NS) expect(store.kvGet(ns, 'k')).toBeNull();
    expect(store.kvGet('other', 'k')).not.toBeNull();
    expect(JSON.parse(store.executionsSince(0))).toEqual([{ execId: 'e.1' }]);
    expect(unpackNav(store.navAll())).toEqual([{ t: 1, netLiq: 1 }]);

    // The recreated table is the same (clustered, no scans); series are stored again.
    expect((store.db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'bars'").get() as { sql: string }).sql).toMatch(/WITHOUT ROWID/);
    expect(plan(store.db, SQL.barsRange)).toMatch(/SEARCH bars USING PRIMARY KEY/);
    store.barsPut('S0|1 day|TRADES|1', [bar(DAY)], 'daily');
    expect(unpackBars(store.barsGet('S0|1 day|TRADES|1', null))).toEqual([bar(DAY)]);
    expect(store.stats()).toMatchObject({ series: 1, bars: 1 });
  });

  it('vacuum steps size themselves to take about VACUUM_STEP_MS', () => {
    for (let s = 0; s < 50; s++) store.barsPut(`S${s}|1 day|TRADES|1`, barsBefore(t0, 10_000, DAY), 'daily');
    store.clearMarketData();
    const free = pragma(store.db, 'freelist_count');
    // A disk where 64 pages take a millisecond.
    vi.useFakeTimers({ toFake: ['performance'] });
    const exec = store.db.exec.bind(store.db);
    const pages: number[] = [];
    vi.spyOn(store.db, 'exec').mockImplementation((sql: string) => {
      const n = Number(/incremental_vacuum\((\d+)\)/.exec(sql)?.[1]);
      if (n) {
        pages.push(n);
        vi.advanceTimersByTime(Math.ceil(n / 64));
      }
      return exec(sql);
    });
    try {
      for (const step of store.vacuum()) void step;
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
    expect(pages[0]).toBe(VACUUM_PAGES_START);
    // 256 pages took 4 ms: 320 pages take the 5 ms aimed at.
    expect(new Set(pages.slice(1))).toEqual(new Set([64 * VACUUM_STEP_MS]));
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(free);
    expect(pragma(store.db, 'freelist_count')).toBe(0);
  });

  it('the next vacuum step follows the measured time, at most doubling', () => {
    expect(nextVacuumPages(256, VACUUM_STEP_MS)).toBe(256);
    // Slow (a WAL checkpoint, a slow disk): fewer at once.
    expect(nextVacuumPages(256, 40)).toBe(32);
    expect(nextVacuumPages(256, 1_000)).toBe(32);
    // Fast: at most twice as many, up to the maximum.
    expect(nextVacuumPages(256, 1)).toBe(512);
    expect(nextVacuumPages(256, 0)).toBe(512);
    expect(nextVacuumPages(VACUUM_PAGES_MAX, 0.1)).toBe(VACUUM_PAGES_MAX);
  });

  it('new statements seek indexes', () => {
    expect(plan(store.db, SQL.barsCount)).toMatch(/SEARCH bars USING PRIMARY KEY \(series_id=\? AND time>\? AND time<\?\)/);
    expect(plan(store.db, SQL.kvExpire)).toMatch(/SEARCH kv USING PRIMARY KEY \(ns=\? AND key=\?\)/);
    expect(plan(store.db, SQL.kvExpire)).toMatch(/SEARCH kv USING PRIMARY KEY \(ns=\?\)/);
    expect(plan(store.db, SQL.seriesByPrefix)).toMatch(/SEARCH series USING (COVERING )?INDEX sqlite_autoindex_series_1 \(key>\? AND key<\?\)/);
  });
});

describe('conventions shared with the market services', () => {
  it('kv namespaces are the ones the services write', () => {
    expect(COVERAGE_KV_NS).toBe(COVERAGE_NS);
    expect(MARKET_DATA_NS).toEqual([COVERAGE_NS, CONTRACT_NS, SECDEF_NS]);
    expect(MEMORY_MARKET_DATA_NS).toEqual(MARKET_DATA_NS);
  });

  it('the head timestamp key of a series is the one history.ts writes', () => {
    for (const req of [
      { contract: stock('AAPL'), timeframe: '1D' as const },
      { contract: stock('AAPL'), timeframe: '5m' as const, outsideRth: true },
      { contract: { symbol: 'EUR', secType: 'CASH' as const, exchange: 'IDEALPRO', currency: 'USD' }, timeframe: '1h' as const },
    ]) {
      const spec = historySpec(req);
      const ckey = contractKey(req.contract);
      expect(headKeyOf(seriesKey(spec, ckey))).toBe(`head|${ckey}|${spec.whatToShow}|${spec.useRTH}`);
    }
    expect(headKeyOf('AAPL|1D')).toBeNull();
  });
});
