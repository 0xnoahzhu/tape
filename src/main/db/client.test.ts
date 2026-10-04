import { mkdtempSync, openSync, readdirSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, Execution } from '@shared/types';
import { createSqliteClient, type DbTransport, type SqliteClient } from './client';
import { serve, type ServerOptions } from './server';
import { openStore, type SqliteStore } from './sqlite';

const bar = (time: number, close = 100): Bar => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 10 });
const exec = (execId: string, time: number): Execution => ({
  execId,
  orderId: 1,
  key: 'AAPL',
  contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
  side: 'BUY',
  shares: 1,
  price: 1,
  time,
});

/** Client and server in one thread, connected by a MessageChannel (the app uses a Worker). */
function connect(file: string, opts: Partial<ServerOptions> = {}) {
  const { port1, port2 } = new MessageChannel();
  const logs: string[] = [];
  let failure: (err: Error) => void = () => undefined;
  const transport: DbTransport = {
    post: (req, transfer) => (transfer ? port1.postMessage(req, transfer) : port1.postMessage(req)),
    listen(onMessage, onFailure) {
      port1.on('message', onMessage);
      failure = onFailure;
    },
    terminate: async () => port1.close(),
  };
  serve(port2, { file, log: (m) => logs.push(m), ...opts });
  const db = createSqliteClient(transport, (m) => logs.push(m));
  return { db, logs, fail: (err: Error) => failure(err), close: () => (port1.close(), port2.close()) };
}

/** Opens the store and counts top-level transactions, checkpoints and maintenance runs. */
function observedOpen() {
  const stats = { transactions: 0, checkpoints: 0, maintenance: 0 };
  const open = (file: string, o?: { reset?: boolean }): SqliteStore => {
    const store = openStore(file, o);
    const { transaction, checkpoint, maintenance } = store;
    let depth = 0;
    return Object.assign(store, {
      transaction<T>(fn: () => T): T {
        if (depth++ === 0) stats.transactions++;
        try {
          return transaction(fn);
        } finally {
          depth--;
        }
      },
      checkpoint() {
        stats.checkpoints++;
        checkpoint();
      },
      maintenance(now: number) {
        stats.maintenance++;
        return maintenance(now);
      },
    });
  };
  return { stats, open };
}

describe('database client <-> worker protocol', () => {
  let dir: string;
  let file: string;
  let db: SqliteClient | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tape-dbc-'));
    file = join(dir, 'tape.db');
  });
  afterEach(async () => {
    await db?.close();
    db = null;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips every operation', async () => {
    const c = connect(file);
    db = c.db;
    await db.ready;
    expect(db.kind).toBe('sqlite');
    await db.bars.put('AAPL|1D', [bar(300), bar(100), bar(200)]);
    expect(await db.bars.get('AAPL|1D')).toEqual([bar(100), bar(200), bar(300)]);
    expect(await db.bars.get('AAPL|1D', 200)).toEqual([bar(200), bar(300)]);
    expect(await db.bars.last('AAPL|1D')).toBe(300);
    expect(await db.bars.last('none')).toBeUndefined();
    await db.kv.set('contract', '1', { symbol: 'AAPL', strikes: [1, 2] });
    const got = await db.kv.get<{ symbol: string }>('contract', '1');
    expect(got?.value).toEqual({ symbol: 'AAPL', strikes: [1, 2] });
    expect(got?.updatedAt).toBeGreaterThan(0);
    await db.kv.delete('contract', '1');
    expect(await db.kv.get('contract', '1')).toBeUndefined();
    await db.executions.put([exec('a.01', 1000), exec('b.01', 2000)]);
    expect((await db.executions.since(1500)).map((e) => e.execId)).toEqual(['b.01']);
    expect(await db.executions.since(0)).toEqual([exec('b.01', 2000), exec('a.01', 1000)]);
    await db.nav.append([{ t: 2, netLiq: 20 }, { t: 1, netLiq: 10 }]);
    expect(await db.nav.all()).toEqual([{ t: 1, netLiq: 10 }, { t: 2, netLiq: 20 }]);
    await db.nav.replace([{ t: 3, netLiq: 30 }]);
    expect(await db.nav.all()).toEqual([{ t: 3, netLiq: 30 }]);
    expect(c.logs).toEqual([]);
  });

  it('commits writes that arrive together in one transaction', async () => {
    const { stats, open } = observedOpen();
    db = connect(file, { open }).db;
    await db.ready;
    const writes = Array.from({ length: 200 }, (_, i) => db!.kv.set('ns', String(i), i));
    writes.push(db.nav.append([{ t: 1, netLiq: 1 }]), db.bars.put('X|1D', [bar(1)]));
    await Promise.all(writes);
    expect(stats.transactions).toBe(1);
    expect((await db.kv.get('ns', '199'))?.value).toBe(199);
  });

  it('reads see the writes sent before them', async () => {
    db = connect(file).db;
    void db.bars.put('AAPL|1D', [bar(100)]);
    void db.nav.append([{ t: 5, netLiq: 5 }]);
    expect(await db.bars.get('AAPL|1D')).toEqual([bar(100)]);
    expect(await db.nav.all()).toEqual([{ t: 5, netLiq: 5 }]);
  });

  it('logs failed writes and resolves them; failed reads reject', async () => {
    const c = connect(file);
    db = c.db;
    await expect(db.bars.put(null as never, [bar(1)])).resolves.toBeUndefined();
    expect(c.logs.some((l) => /bars\.put failed/.test(l))).toBe(true);
    await db.bars.put('X|1D', [bar(1)]);
    await expect(db.bars.get('X|1D', {} as never)).rejects.toThrow(/bound/);
    // A failed write does not take the other writes of its batch down.
    void db.bars.put(null as never, [bar(1)]);
    await db.nav.append([{ t: 7, netLiq: 7 }]);
    expect(await db.nav.all()).toEqual([{ t: 7, netLiq: 7 }]);
  });

  it('falls back to memory when SQLite cannot open the file, replaying pending calls', async () => {
    const c = connect(join(dir, 'missing', 'tape.db'));
    db = c.db;
    const put = db.bars.put('AAPL|1D', [bar(1)]);
    const read = db.bars.get('AAPL|1D');
    await expect(put).resolves.toBeUndefined();
    expect(await read).toEqual([bar(1)]);
    expect(db.kind).toBe('memory');
    await db.nav.append([{ t: 1, netLiq: 1 }]);
    expect(await db.nav.all()).toEqual([{ t: 1, netLiq: 1 }]);
    expect(c.logs.filter((l) => /SQLite unavailable/.test(l))).toHaveLength(1);
  });

  it('falls back to memory when the worker dies', async () => {
    const c = connect(file);
    db = c.db;
    await db.ready;
    await db.kv.set('a', 'b', 1);
    const pending = db.nav.append([{ t: 1, netLiq: 1 }]);
    c.fail(new Error('database worker exited with code 1'));
    c.fail(new Error('again'));
    await expect(pending).resolves.toBeUndefined();
    expect(db.kind).toBe('memory');
    expect(await db.nav.all()).toEqual([{ t: 1, netLiq: 1 }]);
    expect(c.logs.filter((l) => /SQLite unavailable/.test(l))).toHaveLength(1);
    c.close();
  });

  it('close() commits pending writes; later calls neither fail nor reach the file', async () => {
    db = connect(file).db;
    for (let i = 0; i < 50; i++) void db.nav.append([{ t: i, netLiq: i + 1 }]);
    void db.executions.put([exec('x.01', 1)]);
    await db.close();
    await expect(db.nav.append([{ t: 999, netLiq: 1 }])).resolves.toBeUndefined();
    // Closing checkpointed the WAL into the main file (and SQLite removed it).
    expect(readdirSync(dir).filter((f) => f.endsWith('-wal'))).toEqual([]);
    const store = openStore(file);
    expect(store.navAll().length / 2).toBe(50);
    expect(JSON.parse(store.executionsSince(0))).toHaveLength(1);
    store.close();
    db = null;
  });

  it('when idle: checkpoints after writes, maintains at most daily, never while busy', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { stats, open } = observedOpen();
    db = connect(file, { open }).db;
    await db.ready;
    await db.kv.set('ns', 'k', 1);

    // Busy: requests keep arriving more often than the idle threshold.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(3_000);
      await db.kv.get('ns', 'k');
    }
    expect(stats.maintenance + stats.checkpoints).toBe(0);

    // Idle: maintenance first (never ran in this file), then the WAL checkpoint.
    vi.advanceTimersByTime(6_000);
    expect(stats.maintenance).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(stats.checkpoints).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(stats.checkpoints).toBe(1); // nothing written since

    await db.kv.set('ns', 'k', 2);
    vi.advanceTimersByTime(6_000);
    expect(stats.checkpoints).toBe(2);

    // Next maintenance one day after the last one.
    vi.advanceTimersByTime(3_600_000);
    expect(stats.maintenance).toBe(1);
    vi.setSystemTime(Date.now() + 86_400_000);
    vi.advanceTimersByTime(1_000);
    expect(stats.maintenance).toBe(2);
  });

  it('a long write batch does not count as idle time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { stats, open } = observedOpen();
    const slowOpen = (f: string, o?: { reset?: boolean }) => {
      const store = open(f, o);
      const { barsPut } = store;
      // The batch takes 10 s of (fake) wall time.
      return Object.assign(store, { barsPut: (...a: Parameters<typeof barsPut>) => (vi.setSystemTime(Date.now() + 10_000), barsPut(...a)) });
    };
    db = connect(file, { open: slowOpen }).db;
    await db.ready;
    await db.bars.put('AAPL|1m', [bar(1)]);
    vi.advanceTimersByTime(1_000);
    expect(stats.maintenance).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(stats.maintenance).toBe(1);
  });

  it('recreates a database whose pages are corrupt', async () => {
    const store = openStore(file);
    for (let s = 0; s < 20; s++) store.barsPut(`S${s}|1D`, Array.from({ length: 300 }, (_, i) => bar(i * 86_400)), null);
    store.close();
    // Overwrite a stretch of pages in the middle of the file (the header stays intact).
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.alloc(4096 * 8, 0xa5), 0, 4096 * 8, 4096 * 4);
    closeSync(fd);

    const c = connect(file);
    db = c.db;
    const bars = await Promise.all(Array.from({ length: 20 }, (_, s) => db!.bars.get(`S${s}|1D`)));
    expect(bars.some((b) => b.length === 0)).toBe(true);
    expect(db.kind).toBe('sqlite');
    expect(readdirSync(dir).some((f) => /^tape\.db\.corrupt-\d+$/.test(f))).toBe(true);
    // The new file works.
    await db.bars.put('S0|1D', [bar(1)]);
    expect(await db.bars.get('S0|1D')).toEqual([bar(1)]);
  });
});
