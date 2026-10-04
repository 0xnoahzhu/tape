// Database worker loop: request / response over a message port. Writes that arrive together are
// committed in one transaction (one WAL append instead of one per call; a burst longer than
// BATCH_MS is split); a read first commits the writes queued before it. When the port has been
// quiet for a while the worker checkpoints the WAL and, at most daily, runs retention,
// incremental vacuum and optimize in small steps.

import type { MessagePort, Transferable } from 'node:worker_threads';
import type { DbMessage, DbOp, DbRequest, DbWorkerData } from './protocol';
import { SCHEMA_VERSION } from './schema';
import { isCorruption, openStore, type SqliteStore } from './sqlite';

const WRITE_OPS: ReadonlySet<DbOp> = new Set<DbOp>(['bars.put', 'kv.set', 'kv.delete', 'executions.put', 'nav.append', 'nav.replace']);
const DAY_MS = 86_400_000;
/** Quiet time before idle work (checkpoint, maintenance) starts. */
export const IDLE_MS = 5_000;
const IDLE_CHECK_MS = 1_000;
/** Longest write transaction before it is committed and the rest of the queue waits a turn. */
const BATCH_MS = 50;
/** Longest maintenance slice before the worker looks at its queue again. */
const SLICE_MS = 20;

export interface ServerOptions extends DbWorkerData {
  idleMs?: number;
  log?: (message: string, err?: unknown) => void;
  /** Opens the store (tests wrap it to observe transactions and checkpoints). */
  open?: typeof openStore;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function serve(port: MessagePort, opts: ServerOptions): void {
  const idleMs = opts.idleMs ?? IDLE_MS;
  const log = opts.log ?? ((message, err) => console.warn(`[db] ${message}`, ...(err === undefined ? [] : [err])));
  const open = opts.open ?? openStore;
  const post = (msg: DbMessage, transfer?: Transferable[]) => (transfer ? port.postMessage(msg, transfer) : port.postMessage(msg));

  let store: SqliteStore;
  try {
    store = open(opts.file);
  } catch (err) {
    post({ type: 'unavailable', message: errorText(err) });
    return;
  }
  post({ type: 'ready', file: store.file, schemaVersion: SCHEMA_VERSION, ...(store.recovered ? { recovered: store.recovered } : {}) });

  const queue: DbRequest[] = [];
  let flushScheduled = false;
  let lastActivity = Date.now();
  let dirty = false;
  let closed = false;
  let maintenance: Generator<void, void, void> | null = null;
  let nextMaintenanceAt = store.maintainedAt() + DAY_MS;
  const timer = setInterval(onIdleCheck, IDLE_CHECK_MS);
  // The main side went away without closing: stop idle work (the file stays consistent).
  port.on('close', () => {
    closed = true;
    clearInterval(timer);
  });

  port.on('message', (req: DbRequest) => {
    lastActivity = Date.now();
    if (closed) return post({ id: req.id, ok: false, message: 'Database is closed' });
    if (WRITE_OPS.has(req.op)) {
      queue.push(req);
      return scheduleFlush();
    }
    flushWrites();
    if (req.op === 'close') return close(req);
    try {
      const value = run(() => read(req));
      post({ id: req.id, ok: true, value }, value instanceof Float64Array ? [value.buffer as ArrayBuffer] : undefined);
    } catch (err) {
      post({ id: req.id, ok: false, message: errorText(err) });
    }
    lastActivity = Date.now();
  });

  /** Runs `fn`; on corruption the file is moved aside, a new database is created and `fn` retried once. */
  function run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (!isCorruption(err)) throw err;
      recover(err);
      return fn();
    }
  }

  function recover(cause: unknown): void {
    log('database corrupted; moving it aside and starting a new one', cause);
    maintenance = null;
    try {
      store.db.close();
    } catch {
      // already unusable
    }
    try {
      store = open(store.file, { reset: true });
    } catch (err) {
      // The client serves everything from memory from now on.
      closed = true;
      clearInterval(timer);
      post({ type: 'unavailable', message: errorText(err) });
      throw err;
    }
  }

  /** Commits queued writes: all of them (before a read or close), or one bounded batch. */
  function flushWrites(all = true): void {
    flushScheduled = false;
    while (queue.length) {
      commitBatch();
      if (!all) break;
    }
    if (queue.length) scheduleFlush();
    // Idle time counts from the end of the work: a long batch is not quiet time.
    lastActivity = Date.now();
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => flushWrites(false));
  }

  /**
   * One transaction over the queue's head, closed after BATCH_MS: a huge burst becomes several
   * commits that fit the page cache (no spilling) and leave room for reads in between.
   */
  function commitBatch(): void {
    const started = performance.now();
    const results: Array<string | null> = [];
    let taken = 0;
    try {
      run(() => {
        taken = results.length = 0;
        store.transaction(() => {
          while (taken < queue.length && (taken === 0 || performance.now() - started < BATCH_MS)) {
            const req = queue[taken++];
            try {
              store.transaction(() => write(req));
              results.push(null);
            } catch (err) {
              if (isCorruption(err)) throw err;
              results.push(errorText(err));
            }
          }
        });
      });
      dirty = true;
    } catch (err) {
      // The transaction itself failed (disk full, I/O error): none of its writes were kept.
      taken = Math.max(taken, 1);
      results.length = 0;
      for (let i = 0; i < taken; i++) results.push(errorText(err));
    }
    queue.splice(0, taken).forEach((req, i) => {
      const message = results[i];
      post(message == null ? { id: req.id, ok: true, value: undefined } : { id: req.id, ok: false, message });
    });
  }

  function write(req: DbRequest): void {
    const a = req.args as never[];
    switch (req.op) {
      case 'bars.put':
        return store.barsPut(a[0], a[1], a[2]);
      case 'kv.set':
        return store.kvSet(a[0], a[1], a[2], a[3]);
      case 'kv.delete':
        return store.kvDelete(a[0], a[1]);
      case 'executions.put':
        return store.executionsPut(a[0]);
      case 'nav.append':
        return store.navAppend(a[0]);
      case 'nav.replace':
        return store.navReplace(a[0]);
      default:
        throw new Error(`Unknown write ${req.op}`);
    }
  }

  function read(req: DbRequest): unknown {
    const a = req.args as never[];
    switch (req.op) {
      case 'bars.get':
        return store.barsGet(a[0], a[1]);
      case 'bars.last':
        return store.barsLast(a[0]);
      case 'kv.get':
        return store.kvGet(a[0], a[1]);
      case 'executions.since':
        return store.executionsSince(a[0]);
      case 'nav.all':
        return store.navAll();
      case 'maintain': {
        const steps = store.maintenance(Date.now());
        while (!steps.next().done);
        maintenance = null;
        nextMaintenanceAt = Date.now() + DAY_MS;
        store.checkpoint();
        return undefined;
      }
      default:
        throw new Error(`Unknown request ${req.op}`);
    }
  }

  const isIdle = () => Date.now() - lastActivity >= idleMs;

  function onIdleCheck(): void {
    if (closed || !isIdle()) return;
    if (!maintenance && Date.now() >= nextMaintenanceAt) maintenance = store.maintenance(Date.now());
    if (maintenance) return maintainSlice();
    if (!dirty) return;
    try {
      run(() => store.checkpoint());
      dirty = false;
    } catch (err) {
      log('checkpoint failed', err);
    }
  }

  /** Runs maintenance for up to SLICE_MS, then yields; stops as soon as a request arrives. */
  function maintainSlice(): void {
    const started = performance.now();
    while (maintenance && !closed && isIdle()) {
      if (performance.now() - started > SLICE_MS) return void setImmediate(maintainSlice);
      try {
        if (!maintenance.next().done) continue;
      } catch (err) {
        log('maintenance failed', err);
        if (isCorruption(err)) {
          try {
            recover(err);
          } catch {
            return;
          }
        }
      }
      maintenance = null;
      nextMaintenanceAt = Date.now() + DAY_MS;
      dirty = true;
    }
  }

  function close(req: DbRequest): void {
    closed = true;
    clearInterval(timer);
    let message: string | null = null;
    try {
      store.close();
    } catch (err) {
      message = errorText(err);
    }
    post(message == null ? { id: req.id, ok: true, value: undefined } : { id: req.id, ok: false, message });
    if (opts.closed) {
      Atomics.store(opts.closed, 0, 1);
      Atomics.notify(opts.closed, 0);
    }
  }
}
