// Database worker loop: request / response over a message port. Writes that arrive together are
// committed in one transaction (one WAL append instead of one per call; a burst longer than
// BATCH_MS is split); a read first commits the writes queued before it. When the port has been
// quiet for a while the worker writes the noted series accesses, checkpoints the WAL and, about
// two minutes after startup and then every six hours, runs maintenance (retention, size cap,
// incremental vacuum, WAL truncation, optimize) in slices of small steps that stop as soon as a
// request arrives. Series that maintenance evicted are announced with an 'evicted' message
// before the worker reads its next request. Clearing the market data drops the bars at once and
// returns the freed pages in slices too, with requests served in between; the clear is
// answered when the space is back.

import type { MessagePort, Transferable } from 'node:worker_threads';
import type { DbMessage, DbOp, DbRequest, DbWorkerData } from './protocol';
import { SCHEMA_VERSION } from './schema';
import { isCorruption, openStore, type MaintenanceStep, type SqliteStore } from './sqlite';

const WRITE_OPS: ReadonlySet<DbOp> = new Set<DbOp>(['bars.put', 'kv.set', 'kv.delete', 'executions.put', 'nav.append', 'nav.replace']);
/** First maintenance after startup (once the worker is idle). */
export const MAINTENANCE_DELAY_MS = 2 * 60_000;
/** Maintenance while the app keeps running. */
export const MAINTENANCE_INTERVAL_MS = 6 * 3_600_000;
/** Quiet time before idle work (access flush, checkpoint, maintenance) starts. */
export const IDLE_MS = 5_000;
const IDLE_CHECK_MS = 1_000;
/** Longest write transaction before it is committed and the rest of the queue waits a turn. */
const BATCH_MS = 50;
/**
 * Longest maintenance slice before the worker looks at its queue again: a request waits at most
 * about this long, plus the amount a step takes longer than the one before it.
 */
export const SLICE_MS = 20;

export interface ServerOptions extends DbWorkerData {
  idleMs?: number;
  maintenanceDelayMs?: number;
  maintenanceIntervalMs?: number;
  log?: (message: string, err?: unknown) => void;
  /** Opens the store (tests wrap it to observe transactions and checkpoints). */
  open?: typeof openStore;
  /** Clock of the maintenance slices, in ms (tests). */
  now?: () => number;
}

type Steps = Generator<MaintenanceStep, void, void>;

/**
 * Runs a generator's steps in slices. A slice ends before a step that, taking as long as the
 * step before it, would end more than `sliceMs` after the slice started; its first step
 * always runs, so a slice makes progress however long steps take.
 */
export function createSlicer(now: () => number = () => performance.now(), sliceMs = SLICE_MS) {
  let lastStepMs = 0;
  return {
    /**
     * Runs steps while `go()` allows; evicted series keys are added to `evicted`. Returns
     * whether steps are left. Errors of a step propagate.
     */
    run(steps: Steps, evicted: string[], go: () => boolean): boolean {
      const started = now();
      for (let n = 0; go(); n++) {
        const at = now();
        if (n > 0 && at - started + lastStepMs > sliceMs) return true;
        const step = steps.next();
        lastStepMs = now() - at;
        if (step.value) evicted.push(...step.value);
        if (step.done) return false;
      }
      return true;
    },
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function serve(port: MessagePort, opts: ServerOptions): void {
  const idleMs = opts.idleMs ?? IDLE_MS;
  const intervalMs = opts.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS;
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
  let maintenance: Steps | null = null;
  /** Whether the next maintenance slice is scheduled already (setImmediate). */
  let sliceScheduled = false;
  /**
   * Free pages of a clear being returned; the clear requests are answered when it ends. While
   * it is set, a clearSlice is scheduled or running.
   */
  let clearing: { steps: Steps; waiting: DbRequest[] } | null = null;
  const slicer = createSlicer(opts.now);
  let nextMaintenanceAt = Date.now() + (opts.maintenanceDelayMs ?? MAINTENANCE_DELAY_MS);
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
    if (req.op === 'cache.clear') return clear(req);
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
    // The new file holds no market data: a clear in progress is done (its next slice answers it).
    if (clearing) clearing.steps = emptySteps();
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
        return store.navAppend(a[0], a[1]);
      case 'nav.replace':
        return store.navReplace(a[0], a[1]);
      default:
        throw new Error(`Unknown write ${req.op}`);
    }
  }

  function read(req: DbRequest): unknown {
    const a = req.args as never[];
    switch (req.op) {
      case 'bars.get':
        return store.barsGet(a[0], a[1], a[2] ?? null);
      case 'bars.last':
        return store.barsLast(a[0]);
      case 'kv.get':
        return store.kvGet(a[0], a[1]);
      case 'executions.since':
        return store.executionsSince(a[0]);
      case 'nav.get':
        return store.navGet(a[0]);
      case 'nav.all':
        return store.navAll();
      case 'nav.lastAccount':
        return store.navLastAccount();
      case 'maintain': {
        const steps = startMaintenance();
        const evicted: string[] = [];
        try {
          for (let step = steps.next(); !step.done; step = steps.next()) if (step.value) evicted.push(...step.value);
        } finally {
          announce(evicted);
        }
        maintenance = null;
        nextMaintenanceAt = Date.now() + intervalMs;
        store.checkpoint();
        return undefined;
      }
      case 'cache.stats':
        return store.stats();
      default:
        throw new Error(`Unknown request ${req.op}`);
    }
  }

  const isIdle = () => Date.now() - lastActivity >= idleMs;

  const startMaintenance = () => store.maintenance(Date.now(), opts.capBytes ? { capBytes: opts.capBytes } : {});

  /** Tells the main side which series are gone (before the worker reads its next request). */
  function announce(series: string[]): void {
    if (series.length) post({ type: 'evicted', series });
  }

  function onIdleCheck(): void {
    if (closed || !isIdle() || clearing) return;
    if (!maintenance && Date.now() >= nextMaintenanceAt) maintenance = startMaintenance();
    if (maintenance) return void (sliceScheduled || maintainSlice());
    try {
      if (run(() => store.flushAccess())) dirty = true;
    } catch (err) {
      log('recording series access failed', err);
    }
    if (!dirty) return;
    try {
      run(() => store.checkpoint());
      dirty = false;
    } catch (err) {
      log('checkpoint failed', err);
    }
  }

  /**
   * Runs a slice of maintenance and schedules the next one while the worker stays idle; once a
   * request arrives, the idle check resumes it.
   */
  function maintainSlice(): void {
    sliceScheduled = false;
    const evicted: string[] = [];
    try {
      if (!maintenance || closed || clearing || !isIdle()) return;
      let more = false;
      try {
        more = slicer.run(maintenance, evicted, () => !closed && isIdle());
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
      if (!more) {
        maintenance = null;
        nextMaintenanceAt = Date.now() + intervalMs;
        dirty = true;
      } else if (!closed && isIdle()) {
        sliceScheduled = true;
        setImmediate(maintainSlice);
      }
    } finally {
      announce(evicted);
    }
  }

  /**
   * Drops the market data at once (a single DROP TABLE), then returns the freed pages in slices
   * with requests served in between (a full cache frees hundreds of MB: up to about a second of
   * vacuum steps); the clear is answered when the space is back.
   */
  function clear(req: DbRequest): void {
    try {
      run(() => store.clearMarketData());
    } catch (err) {
      return post({ id: req.id, ok: false, message: errorText(err) });
    }
    // A maintenance run in progress would go on from a list of series that are gone; it is still
    // due, so the next idle check starts a new one.
    maintenance = null;
    dirty = true;
    const waiting = clearing ? clearing.waiting : [];
    waiting.push(req);
    // A clear while one is returning space starts over (the free list changed).
    if (!clearing) setImmediate(clearSlice);
    clearing = { steps: store.vacuum(), waiting };
  }

  function clearSlice(): void {
    if (!clearing) return;
    let more = false;
    try {
      more = !closed && slicer.run(clearing.steps, [], () => !closed);
    } catch (err) {
      // The data is gone already; the space comes back with the next maintenance.
      log('returning the space of the cleared cache failed', err);
      if (isCorruption(err)) {
        try {
          recover(err);
        } catch {
          // unavailable: answered below
        }
      }
    }
    if (more) return void setImmediate(clearSlice);
    finishClear();
  }

  /** Truncates the WAL and answers the clear requests. */
  function finishClear(): void {
    const done = clearing;
    clearing = null;
    if (!done) return;
    if (!closed) {
      try {
        run(() => store.checkpoint());
      } catch (err) {
        log('checkpoint failed', err);
      }
    }
    lastActivity = Date.now();
    for (const req of done.waiting) post({ id: req.id, ok: true, value: undefined });
  }

  function close(req: DbRequest): void {
    closed = true;
    clearInterval(timer);
    // A clear returning space: the data is gone, the rest of the space comes back next run.
    finishClear();
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

function* emptySteps(): Steps {}
