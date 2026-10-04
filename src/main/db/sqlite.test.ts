import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { packBars, unpackBars, unpackNav } from './client';
import { configure, migrate, NewerSchemaError, SCHEMA_VERSION, schemaVersion } from './schema';
import { looksIntraday, openStore, SQL, type SqliteStore } from './sqlite';

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 4, 16); // unix ms
const bar = (time: number, close = 100): Bar => ({ time, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 });
const pragma = (db: DatabaseSync, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
const plan = (db: DatabaseSync, sql: string) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

describe('SQLite store', () => {
  let dir: string;
  let file: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tape-db-'));
    file = join(dir, 'tape.db');
    store = openStore(file);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the schema with the large-data settings', () => {
    const { db } = store;
    expect(pragma(db, 'journal_mode')).toBe('wal');
    expect(pragma(db, 'auto_vacuum')).toBe(2); // incremental
    expect(pragma(db, 'synchronous')).toBe(1); // normal
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(pragma(db, 'busy_timeout')).toBe(5000);
    expect(pragma(db, 'temp_store')).toBe(2); // memory
    expect(pragma(db, 'user_version')).toBe(1);
    expect(Number(pragma(db, 'cache_size'))).toBeLessThan(0);
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(['bars', 'executions', 'kv', 'nav', 'series']);
    expect((db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'bars'").get() as { sql: string }).sql).toMatch(/WITHOUT ROWID/);
  });

  it('reopens an existing file without migrating again', () => {
    store.barsPut('AAPL|1D', [bar(DAY)], null);
    store.close();
    store = openStore(file);
    expect(store.recovered).toBeUndefined();
    expect(unpackBars(store.barsGet('AAPL|1D', null))).toEqual([bar(DAY)]);
  });

  it('bars: ascending range reads, replace by time, last', () => {
    store.barsPut('AAPL|1D', [bar(3 * DAY, 103), bar(DAY, 101), bar(2 * DAY, 102)], null);
    store.barsPut('AAPL|1D', [bar(2 * DAY, 202)], null);
    store.barsPut('MSFT|1D', [bar(DAY, 300)], null);
    expect(unpackBars(store.barsGet('AAPL|1D', null)).map((b) => b.close)).toEqual([101, 202, 103]);
    expect(unpackBars(store.barsGet('AAPL|1D', 2 * DAY)).map((b) => b.time)).toEqual([2 * DAY, 3 * DAY]);
    expect(store.barsLast('AAPL|1D')).toBe(3 * DAY);
    expect(store.barsLast('nope')).toBeNull();
    expect(store.barsGet('nope', null).length).toBe(0);
    // Exact doubles round-trip; invalid times are skipped.
    store.barsPut('X|1D', [{ time: DAY, open: 0.1, high: 1 / 3, low: 1e-9, close: 12345.6789, volume: 0 }, { ...bar(0), time: NaN }], null);
    expect(unpackBars(store.barsGet('X|1D', null))).toEqual([{ time: DAY, open: 0.1, high: 1 / 3, low: 1e-9, close: 12345.6789, volume: 0 }]);
    // Packed input (what the worker receives) is the same data.
    store.barsPut('P|1D', packBars([bar(DAY, 7), bar(2 * DAY, 8)]), null);
    expect(unpackBars(store.barsGet('P|1D', null))).toEqual([bar(DAY, 7), bar(2 * DAY, 8)]);
  });

  it('infers intraday series from the key or the bar spacing', () => {
    expect(looksIntraday('AAPL@SMART|5m|1|TRADES', [])).toBe(true);
    expect(looksIntraday('AAPL@SMART|1h|1|TRADES', [])).toBe(true);
    expect(looksIntraday('AAPL 1 min TRADES', [])).toBe(true);
    expect(looksIntraday('AAPL@SMART|1M|1|TRADES', [])).toBe(false);
    expect(looksIntraday('AAPL@SMART|1D|1|TRADES', [DAY, 2 * DAY, 3 * DAY + 3600])).toBe(false);
    expect(looksIntraday('custom', [DAY, DAY, DAY + 300])).toBe(true);
    store.barsPut('a', [bar(DAY), bar(DAY + 60)], null);
    store.barsPut('b', [bar(DAY)], null);
    store.barsPut('b', [bar(2 * DAY)], true); // explicit flag upgrades
    const flags = store.db.prepare('SELECT key, intraday FROM series ORDER BY key').all();
    expect(flags.map((r) => ({ ...r }))).toEqual([
      { key: 'a', intraday: 1 },
      { key: 'b', intraday: 1 },
    ]);
  });

  it('kv: JSON text with a timestamp, upsert and delete', () => {
    store.kvSet('contract', '265598', '{"symbol":"AAPL"}', 1000);
    store.kvSet('contract', '265598', '{"symbol":"AAPL","v":2}', 2000);
    expect(store.kvGet('contract', '265598')).toEqual({ json: '{"symbol":"AAPL","v":2}', updatedAt: 2000 });
    store.kvDelete('contract', '265598');
    expect(store.kvGet('contract', '265598')).toBeNull();
  });

  it('executions: replace by id, newest first since a time', () => {
    const row = (execId: string, time: number, price = 1) => ({ execId, time, json: JSON.stringify({ execId, time, price }) });
    store.executionsPut([row('a.01', 1000), row('b.01', 3000), row('c.01', 2000)]);
    store.executionsPut([row('b.01', 3000, 2)]);
    expect(JSON.parse(store.executionsSince(2000))).toEqual([
      { execId: 'b.01', time: 3000, price: 2 },
      { execId: 'c.01', time: 2000, price: 1 },
    ]);
    expect(JSON.parse(store.executionsSince(5000))).toEqual([]);
  });

  it('nav: append (replacing equal timestamps), all ascending, replace', () => {
    store.navAppend([
      { t: 2000, netLiq: 2 },
      { t: 1000, netLiq: 1 },
    ]);
    store.navAppend([{ t: 2000, netLiq: 22 }]);
    expect(unpackNav(store.navAll())).toEqual([
      { t: 1000, netLiq: 1 },
      { t: 2000, netLiq: 22 },
    ]);
    store.navReplace([{ t: 5000, netLiq: 5 }]);
    expect(unpackNav(store.navAll())).toEqual([{ t: 5000, netLiq: 5 }]);
  });

  it('a failed statement inside a batch rolls back only its own savepoint', () => {
    store.transaction(() => {
      store.navAppend([{ t: 1, netLiq: 1 }]);
      expect(() => store.transaction(() => store.db.exec('INSERT INTO nav (t, net_liq) VALUES (2, NULL)'))).toThrow();
      store.navAppend([{ t: 3, netLiq: 3 }]);
    });
    expect(unpackNav(store.navAll()).map((p) => p.t)).toEqual([1, 3]);
  });

  describe('query plans (no full scans, no sorting)', () => {
    it('bar range reads seek the clustered primary key', () => {
      const p = plan(store.db, SQL.barsRange);
      expect(p).toMatch(/SEARCH bars USING PRIMARY KEY \(series_id=\? AND time>\?\)/);
      expect(p).not.toMatch(/SCAN|TEMP B-TREE/);
      expect(plan(store.db, SQL.barsLast)).toMatch(/SEARCH bars USING PRIMARY KEY \(series_id=\?\)/);
      expect(plan(store.db, SQL.barsExpire)).toMatch(/SEARCH bars USING PRIMARY KEY \(series_id=\? AND time<\?\)/);
      expect(plan(store.db, SQL.barsExpireBound)).toMatch(/SEARCH bars USING PRIMARY KEY \(series_id=\? AND time<\?\)/);
    });

    it('execution reads use the time index', () => {
      const p = plan(store.db, SQL.executionsSince);
      expect(p).toMatch(/SEARCH executions USING INDEX executions_time \(time>\?\)/);
      expect(p).not.toMatch(/SCAN|TEMP B-TREE/);
    });

    it('kv lookups and expiry use the primary key', () => {
      expect(plan(store.db, SQL.kvGet)).toMatch(/SEARCH kv USING PRIMARY KEY \(ns=\? AND key=\?\)/);
      expect(plan(store.db, SQL.kvExpire)).toMatch(/SEARCH kv USING PRIMARY KEY \(ns=\?\)/);
    });
  });

  describe('maintenance', () => {
    const run = (now: number) => {
      for (const _ of store.maintenance(now)) void _;
    };
    const nowSec = Math.floor(NOW / 1000);

    it('drops intraday bars past 30 days in chunks, keeps daily bars, vacuums', () => {
      // 40 days of 1-minute bars (8 hours a day) and 400 days of daily bars.
      const minutes: Bar[] = [];
      for (let d = 40; d >= 1; d--) for (let m = 0; m < 480; m++) minutes.push(bar(nowSec - d * DAY + m * 60));
      store.barsPut('AAPL|1m|1|TRADES', minutes, null);
      store.barsPut('OLD|5m|1|TRADES', [bar(nowSec - 60 * DAY), bar(nowSec - 60 * DAY + 300)], null);
      const days = Array.from({ length: 400 }, (_, i) => bar(nowSec - (400 - i) * DAY));
      store.barsPut('AAPL|1D|1|TRADES', days, null);

      const steps = store.maintenance(NOW);
      let n = 0;
      while (!steps.next().done) n++;
      expect(n).toBeGreaterThan(3); // 10 days * 480 bars = 4800 expired rows: chunked + later phases

      const kept = unpackBars(store.barsGet('AAPL|1m|1|TRADES', null));
      expect(kept.length).toBe(30 * 480);
      expect(kept[0].time).toBeGreaterThanOrEqual(nowSec - 30 * DAY);
      expect(store.barsGet('AAPL|1D|1|TRADES', null).length / 6).toBe(400);
      // A series without bars left is removed (and can be written again).
      expect(store.db.prepare("SELECT count(*) AS n FROM series WHERE key = 'OLD|5m|1|TRADES'").get()).toEqual({ n: 0 });
      store.barsPut('OLD|5m|1|TRADES', [bar(nowSec)], null);
      expect(store.barsLast('OLD|5m|1|TRADES')).toBe(nowSec);
      expect(pragma(store.db, 'freelist_count')).toBe(0);
      expect(store.maintainedAt()).toBe(NOW);
    });

    it('drops kv entries past the namespace TTL and keeps its own bookkeeping', () => {
      store.kvSet('contract', 'old', '1', NOW - 181 * DAY * 1000);
      store.kvSet('contract', 'fresh', '2', NOW - 10 * DAY * 1000);
      run(NOW);
      expect(store.kvGet('contract', 'old')).toBeNull();
      expect(store.kvGet('contract', 'fresh')).not.toBeNull();
      run(NOW + 365 * DAY * 1000);
      expect(store.maintainedAt()).toBe(NOW + 365 * DAY * 1000);
    });
  });
});

describe('opening damaged or foreign files', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tape-db-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('moves a file that is not a database aside and starts a new one', () => {
    const file = join(dir, 'tape.db');
    writeFileSync(file, 'definitely not an SQLite database '.repeat(200));
    const store = openStore(file);
    expect(store.recovered).toMatch(/tape\.db\.corrupt-\d+$/);
    expect(existsSync(store.recovered!)).toBe(true);
    store.navAppend([{ t: 1, netLiq: 1 }]);
    expect(store.navAll().length).toBe(2);
    store.close();
  });

  it('moves aside a database whose schema does not match', () => {
    const file = join(dir, 'tape.db');
    const other = new DatabaseSync(file);
    other.exec('CREATE TABLE bars (x); CREATE TABLE series (y)');
    other.close();
    const store = openStore(file);
    expect(store.recovered).toBeTruthy();
    expect(readdirSync(dir).some((f) => /^tape\.db\.corrupt-\d+$/.test(f))).toBe(true);
    store.close();
  });

  it('leaves a database written by a newer version alone', () => {
    const file = join(dir, 'tape.db');
    const newer = new DatabaseSync(file);
    newer.exec('PRAGMA user_version = 99; CREATE TABLE future (x)');
    newer.close();
    expect(() => openStore(file)).toThrow(NewerSchemaError);
    expect(readdirSync(dir).filter((f) => f.includes('corrupt'))).toEqual([]);
  });

  it('throws when the file cannot be created at all', () => {
    expect(() => openStore(join(dir, 'missing-dir', 'tape.db'))).toThrow();
  });
});

describe('files created elsewhere, other connections', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tape-db-'));
    file = join(dir, 'tape.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maintenance finishes on a file without incremental auto-vacuum (free pages are kept)', () => {
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE legacy (x)'); // not empty: auto_vacuum can no longer be set
    raw.close();
    const store = openStore(file);
    expect(pragma(store.db, 'auto_vacuum')).toBe(0);
    const old = Math.floor(NOW / 1000) - 60 * DAY;
    store.barsPut('AAPL|1m|1|TRADES', Array.from({ length: 20_000 }, (_, i) => bar(old + i * 60)), null);
    const steps = store.maintenance(NOW);
    let n = 0;
    while (!steps.next().done && n < 1_000) n++;
    expect(n).toBeLessThan(1_000);
    expect(store.barsGet('AAPL|1m|1|TRADES', null).length).toBe(0);
    expect(pragma(store.db, 'freelist_count')).toBeGreaterThan(0);
    expect(store.maintainedAt()).toBe(NOW);
    store.close();
  });

  it("opening waits for another connection's write transaction instead of failing", async () => {
    openStore(file).close();
    // Another process (a DB tool, a second instance) holds the write lock for 300 ms.
    const holder = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.file);
       db.exec('BEGIN IMMEDIATE');
       db.exec('INSERT INTO nav (t, net_liq) VALUES (1, 1)');
       parentPort.postMessage('locked');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { file } },
    );
    try {
      await once(holder, 'message');
      const store = openStore(file);
      expect(store.recovered).toBeUndefined();
      expect(pragma(store.db, 'auto_vacuum')).toBe(2);
      expect(Array.from(store.navAll())).toEqual([1, 1]); // waited for the commit
      store.close();
    } finally {
      await once(holder, 'exit');
    }
  });

  it('a migration made by another connection meanwhile is not applied twice', () => {
    const a = new DatabaseSync(file);
    const b = new DatabaseSync(file);
    configure(a);
    configure(b);
    // Two instances start together: b migrates after a read version 0, before a's BEGIN.
    const exec = a.exec.bind(a);
    let raced = false;
    a.exec = (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !raced) {
        raced = true;
        migrate(b);
      }
      return exec(sql);
    };
    expect(migrate(a)).toBe(SCHEMA_VERSION);
    expect(raced).toBe(true);
    expect(schemaVersion(a)).toBe(SCHEMA_VERSION);
    expect(pragma(a, 'auto_vacuum')).toBe(2);
    a.close();
    b.close();
  });
});
