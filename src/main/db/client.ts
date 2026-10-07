// Main-process side of the database worker: a typed async RPC (request id -> promise) that
// implements Database. When the worker cannot open SQLite or dies, pending and later calls are
// served by the in-memory database instead (logged once).
//
// Writes never reject: persistence is best-effort, a failed write is logged. Reads reject with
// the worker's error message.
//
// Evictions reach onEvicted listeners: the worker's 'evicted' messages, and 'all' when
// clearMarketData is called (synchronously, before the request is sent, so a listener that drops
// its copy of the evicted data re-reads it only after the clear).

import type { Transferable } from 'node:worker_threads';
import type { Bar } from '@shared/types';
import { createMemoryDatabase } from './memory';
import type { DbArgs, DbMessage, DbOp, DbRequest, DbResult } from './protocol';
import type { Database, EvictedSeries } from './types';

/** How long close() waits for the worker to commit and close the file. */
const CLOSE_TIMEOUT_MS = 3_000;

/** The message channel to the worker (a Worker in the app, a MessagePort in tests). */
export interface DbTransport {
  post(req: DbRequest, transfer?: Transferable[]): void;
  /** Messages, and failures: the worker failed to start, threw or exited. */
  listen(onMessage: (m: DbMessage) => void, onFailure: (err: Error) => void): void;
  terminate(): Promise<void>;
  /**
   * Blocks the calling thread until the worker has closed the database, at most `ms`.
   * Used on quit, where the process may exit before an async reply could be read.
   */
  waitClosed?(ms: number): boolean;
}

export interface SqliteClient extends Database {
  /** Settles once the worker reported that SQLite is open, or the client fell back to memory. */
  readonly ready: Promise<void>;
}

const WRITE_OPS: ReadonlySet<DbOp> = new Set<DbOp>(['bars.put', 'kv.set', 'kv.delete']);

interface Pending {
  op: DbOp;
  /** Turns the worker's reply into the method's result. */
  decode(value: unknown): unknown;
  resolve(value: unknown): void;
  reject(err: Error): void;
  /** Runs the same call against the memory database. */
  fallback(m: Database): Promise<unknown>;
}

export function createSqliteClient(transport: DbTransport, log: (message: string) => void = (m) => console.warn(m)): SqliteClient {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  /** Set when calls are served from memory (fallback or after close). */
  let memory: Database | null = null;
  let fellBack = false;
  let closing: Promise<void> | null = null;
  let writeErrors = 0;
  const evictionListeners = new Set<(evicted: EvictedSeries) => void>();
  const notifyEvicted = (evicted: EvictedSeries) => {
    for (const l of [...evictionListeners]) {
      try {
        l(evicted);
      } catch (err) {
        log(`[db] eviction listener failed: ${(err as Error).message}`);
      }
    }
  };
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  function useMemory(reason: string | null): void {
    if (memory) return;
    memory = createMemoryDatabase();
    if (reason != null) {
      fellBack = true;
      log(`[db] SQLite unavailable, caches are kept in memory: ${reason}`);
    }
    markReady();
    // Replay in request order, so writes land before the reads that followed them.
    const list = [...pending.values()];
    pending.clear();
    for (const p of list) p.fallback(memory).then(p.resolve, p.reject);
  }

  transport.listen(
    (m) => {
      if ('type' in m) {
        if (m.type === 'ready') {
          if (m.recovered) log(`[db] tape.db was unreadable and has been recreated (old file: ${m.recovered})`);
          markReady();
        } else if (m.type === 'evicted') {
          if (!memory && m.series.length) notifyEvicted(m.series);
        } else {
          useMemory(m.message);
        }
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) {
        try {
          p.resolve(p.decode(m.value));
        } catch (err) {
          p.reject(err as Error);
        }
      } else if (WRITE_OPS.has(p.op)) {
        if (writeErrors++ < 5) log(`[db] ${p.op} failed: ${m.message}`);
        p.resolve(undefined);
      } else p.reject(new Error(m.message));
    },
    (err) => {
      if (closing) return;
      useMemory(err.message);
      void transport.terminate().catch(() => undefined);
    },
  );

  function call<K extends DbOp, R>(
    op: K,
    args: DbArgs<K>,
    fallback: (m: Database) => Promise<R>,
    decode: (value: DbResult<K>) => R = (v) => v as unknown as R,
    transfer?: Transferable[],
  ): Promise<R> {
    if (memory) return fallback(memory);
    const id = nextId++;
    return new Promise<R>((resolve, reject) => {
      pending.set(id, {
        op,
        decode: decode as (value: unknown) => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
        fallback,
      });
      transport.post({ id, op, args }, transfer);
    });
  }

  return {
    get kind() {
      return fellBack ? 'memory' : 'sqlite';
    },
    ready,
    bars: {
      get: (series, fromTime, toTime) => call('bars.get', [series, fromTime ?? null, toTime ?? null], (m) => m.bars.get(series, fromTime, toTime), unpackBars),
      put: (series, bars, opts) => {
        const packed = packBars(bars);
        return call('bars.put', [series, packed, opts?.retention ?? null], (m) => m.bars.put(series, bars, opts), undefined, [packed.buffer as ArrayBuffer]);
      },
      last: (series) => call('bars.last', [series], (m) => m.bars.last(series), (t) => t ?? undefined),
    },
    kv: {
      get: <T>(ns: string, key: string) =>
        call('kv.get', [ns, key], (m) => m.kv.get<T>(ns, key), (row) => (row ? { value: JSON.parse(row.json) as T, updatedAt: row.updatedAt } : undefined)),
      set: (ns, key, value) => call('kv.set', [ns, key, JSON.stringify(value ?? null), Date.now()], (m) => m.kv.set(ns, key, value)),
      delete: (ns, key) => call('kv.delete', [ns, key], (m) => m.kv.delete(ns, key)),
    },
    stats: () => call('cache.stats', [], (m) => m.stats()),
    clearMarketData() {
      notifyEvicted('all');
      return call('cache.clear', [], (m) => m.clearMarketData());
    },
    onEvicted(listener) {
      evictionListeners.add(listener);
      return () => void evictionListeners.delete(listener);
    },
    close() {
      closing ??= (async () => {
        if (!memory) {
          const done = call('close', [], async () => undefined);
          // Quit: block until the worker committed and closed the file (the process may exit next).
          const closed = transport.waitClosed ? transport.waitClosed(CLOSE_TIMEOUT_MS) : await settlesWithin(done, CLOSE_TIMEOUT_MS);
          if (!closed) log('[db] the database worker did not close in time');
          // Late calls (e.g. a write during quit) go nowhere instead of failing.
          useMemory(null);
        }
        await transport.terminate().catch(() => undefined);
      })();
      return closing;
    },
  };
}

function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(
      () => (clearTimeout(timer), resolve(true)),
      () => (clearTimeout(timer), resolve(true)),
    );
  });
}

/** [time, o, h, l, c, v] * n; transferred to the worker instead of cloning n objects. */
export function packBars(bars: readonly Bar[]): Float64Array {
  const out = new Float64Array(bars.length * 6);
  for (let i = 0, j = 0; i < bars.length; i++, j += 6) {
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

export function unpackBars(buf: Float64Array): Bar[] {
  const n = buf.length / 6;
  const out = new Array<Bar>(n);
  for (let i = 0, j = 0; i < n; i++, j += 6) {
    out[i] = { time: buf[j], open: buf[j + 1], high: buf[j + 2], low: buf[j + 3], close: buf[j + 4], volume: buf[j + 5] };
  }
  return out;
}
