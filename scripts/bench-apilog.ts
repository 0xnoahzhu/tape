// Benchmark of the API log hot path (src/main/ib/apiLog.ts): pushes synthetic tickPrice frames
// through createApiLog with a fake context and reports the cost per frame and the heap the log
// keeps. Node built-ins only; Electron is stubbed.
//
//   node scripts/bench-apilog.ts [--frames 100000] [--chunk 100] [--rate 20000] [--runs 5]
//                                [--module <path to apiLog.ts>]
//
// Frames arrive like socket reads: `chunk` frames per task at `rate` frames per second (a manual
// clock); the log's timers run between reads at their virtual due time, file appends and
// microtasks run for real between reads.
//
// Columns (medians over the runs):
//   record    synchronous cost inside the socket handler (the EventName.received listener)
//   deferred  timer work: live batches (decode) and file batches (format); the appends
//             themselves run on libuv's thread pool and are not timed
//   retained  heap the log still holds after a full GC (ring, cached entries)
//   gc        garbage collections while frames arrive (count, pause ms)
//
// --module measures another createApiLog, e.g. an older apiLog.ts copied together with its
// messageSchema.ts and apiLogFiles.ts (relative imports resolve next to it, then in src/main/ib).
// Modules using TypeScript parameter properties need `node --experimental-transform-types`.
// An implementation without stream control always streams (its "stream off" rows stream).
//
// Baseline: the API log before the frame ring (every frame decoded into an entry in the socket
// handler, always streamed). Its sources are not kept in the repo; measured with --module on a
// copy of them, defaults, Apple M2 Pro, Node 24.14, next to the ring at the time:
//
//   stream file   record ns  deferred ns  retained MB  gc n  gc ms     ring: record  deferred  retained  gc n  gc ms
//   off    off         1447            3         15.8     6   18.1               46         2       1.2     0    0.0
//   off    on          1465         1027         15.8     9   33.5               46       732       1.2     3    1.4
//   on     off         1427            3         15.7     6   19.3               64       709      16.7     3    9.4
//   on     on          1417         1026         15.7     7   23.3               63      1069      16.8     6   19.2
//
// getEntries: baseline 0.1 ms (entries stored decoded); ring 16.2 ms first read, 0.7 ms again.

import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

const { values } = parseArgs({
  options: {
    frames: { type: 'string', default: '100000' },
    chunk: { type: 'string', default: '100' },
    rate: { type: 'string', default: '20000' },
    runs: { type: 'string', default: '5' },
    module: { type: 'string', default: 'src/main/ib/apiLog.ts' },
  },
});
const FRAMES = Number(values.frames);
const RUNS = Number(values.runs);
const CHUNK = Number(values.chunk);
const CHUNK_MS = (CHUNK / Number(values.rate)) * 1000;
const root = new URL('../', import.meta.url);
const modulePath = resolve(values.module);

// ---------------------------------------------------------------------------
// Module resolution like Vite: the @shared alias, extensionless relative imports, electron stub

const ELECTRON = 'data:text/javascript,' + encodeURIComponent('export const app = globalThis.__benchElectronApp;');
const ibDir = new URL('src/main/ib/', root).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: ELECTRON, shortCircuit: true };
    if (specifier.startsWith('@shared/')) specifier = new URL(`src/shared/${specifier.slice(8)}`, root).href;
    const candidates = [specifier, specifier + '.ts', specifier + '/index.ts'];
    // A module copied elsewhere (--module) still finds the rest of src/main/ib.
    if (specifier.startsWith('./') && context.parentURL && !context.parentURL.startsWith(ibDir)) {
      const inRepo = new URL(specifier, ibDir).href;
      candidates.push(inRepo + '.ts', inRepo + '/index.ts');
    }
    let first: unknown;
    for (const c of candidates) {
      try {
        return next(c, context);
      } catch (err) {
        first ??= err;
      }
    }
    throw first;
  },
});

// ---------------------------------------------------------------------------
// GC access without --expose-gc

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const heapUsed = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

// ---------------------------------------------------------------------------
// Manual timers: the log's batches run when drain() is called, so they can be timed apart

interface Task {
  at: number;
  order: number;
  fn: () => void;
  done: boolean;
}

const real = { setTimeout: globalThis.setTimeout, setImmediate: globalThis.setImmediate };
let clock = 0;
let order = 0;
let tasks: Task[] = [];

function schedule(fn: () => void, ms = 0): Task {
  const task: Task = { at: clock + Math.max(0, ms), order: order++, fn, done: false };
  const handle = Object.assign(task, { ref: () => handle, unref: () => handle, hasRef: () => true, refresh: () => handle });
  tasks.push(task);
  return handle;
}
const cancel = (t?: Task | null) => {
  if (t) t.done = true;
};
Object.assign(globalThis, { setTimeout: schedule, clearTimeout: cancel, setImmediate: schedule, clearImmediate: cancel });

/** Runs the tasks due by `until` (all of them by default), advancing the clock. */
function drain(until = Infinity): void {
  for (;;) {
    tasks = tasks.filter((t) => !t.done);
    tasks.sort((a, b) => a.at - b.at || a.order - b.order);
    const task = tasks[0];
    if (!task || task.at > until) break;
    tasks.shift();
    clock = Math.max(clock, task.at);
    task.done = true;
    task.fn();
  }
  if (until !== Infinity) clock = Math.max(clock, until);
}

const sleep = (ms: number) => new Promise<void>((r) => real.setTimeout(r, ms));
const nextTask = () => new Promise<void>((r) => real.setImmediate(r));

// ---------------------------------------------------------------------------
// Fake context and frames

const logRoot = mkdtempSync(join(tmpdir(), 'tape-bench-apilog-'));
const quitHandlers: Array<() => void> = [];
let logDir = '';
(globalThis as Record<string, unknown>).__benchElectronApp = {
  getPath: () => logDir,
  whenReady: () => new Promise(() => undefined),
  on: (event: string, fn: () => void) => event === 'will-quit' && quitHandlers.push(fn),
};
delete process.env.TAPE_USER_DATA;

type Listener = (...args: unknown[]) => void;
interface Log {
  getEntries(): unknown[];
  setStreaming?(on: boolean): void;
}
type CreateApiLog = (ctx: unknown, options?: { streamByDefault?: boolean }) => Log;

function fakeContext(writeFile: boolean) {
  const listeners = new Map<string, Listener>();
  const ctx = {
    emitted: 0,
    store: {
      getSettings: () => ({ apiLog: { writeFile, keepDays: 7 } }),
      onSettingsChanged: () => () => undefined,
    },
    ib: {
      on(event: string, l: Listener) {
        listeners.set(event, l);
        return () => listeners.delete(event);
      },
    },
    emit(e: { type: string; entries?: unknown[] }) {
      if (e.type === 'apiLog') ctx.emitted += e.entries?.length ?? 0;
    },
  };
  return { ctx, listeners };
}

const TICKS = ['1', '2', '4', '6', '7', '9', '66', '67', '68'];

/** tickPrice frames as the TWS client reports them: fields (a fresh copy) and the frame text. */
function makeFrames(n: number): { tokens: string[][]; texts: string[] } {
  const tokens: string[][] = new Array(n);
  const texts: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const price = (200 + (i % 997) / 100).toFixed(2);
    const fields = ['1', '6', String(1000 + (i % 100)), TICKS[i % TICKS.length], price, String(100 + (i % 50)), '0'];
    // Decoded from bytes like a socket read, so the text is a flat string.
    texts[i] = Buffer.from(fields.join('\0') + '\0', 'utf8').toString('utf8');
    tokens[i] = fields;
  }
  return { tokens, texts };
}

function countLines(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Runs

interface Result {
  recordNs: number;
  deferredNs: number;
  retainedMb: number;
  gcCount: number;
  gcMs: number;
  emitted: number;
  fileLines: number;
}

const gcEntries: Array<{ start: number; duration: number }> = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcEntries.push({ start: e.startTime, duration: e.duration });
}).observe({ entryTypes: ['gc'] });

async function run(createApiLog: CreateApiLog, n: number, stream: boolean, file: boolean): Promise<Result> {
  logDir = mkdtempSync(join(logRoot, 'run-'));
  quitHandlers.length = 0;
  const h0 = heapUsed();
  let frames: ReturnType<typeof makeFrames> | null = makeFrames(n);
  const { ctx, listeners } = fakeContext(file);
  const log = createApiLog(ctx, { streamByDefault: stream });
  drain(); // subscribes
  const received = listeners.get('received')!;
  await sleep(20); // let pending GC entries from setup arrive
  gcEntries.length = 0;

  let recordMs = 0;
  let deferredMs = 0;
  const t0 = performance.now();
  for (let c = 0; c < n; c += CHUNK) {
    const a = performance.now();
    for (let i = c, end = Math.min(n, c + CHUNK); i < end; i++) received(frames.tokens[i], frames.texts[i]);
    const b = performance.now();
    drain(clock + CHUNK_MS);
    deferredMs += performance.now() - b;
    recordMs += b - a;
    await nextTask();
  }
  const a = performance.now();
  drain();
  const t2 = performance.now();
  deferredMs += t2 - a;

  for (const fn of quitHandlers) fn(); // final file batch, synchronously
  frames = null;
  // Background appends: wait until the files stop growing.
  let fileLines = 0;
  for (let prev = -1; file && fileLines !== prev; ) {
    prev = fileLines;
    await sleep(150);
    fileLines = countLines(logDir);
  }
  await sleep(20);
  const gcs = gcEntries.filter((e) => e.start >= t0 && e.start <= t2);
  const h1 = heapUsed();
  if (!log.getEntries) throw new Error('not an ApiLog'); // keeps the log alive until here
  const result: Result = {
    recordNs: (recordMs * 1e6) / n,
    deferredNs: (deferredMs * 1e6) / n,
    retainedMb: (h1 - h0) / 1024 / 1024,
    gcCount: gcs.length,
    gcMs: gcs.reduce((s, e) => s + e.duration, 0),
    emitted: ctx.emitted,
    fileLines,
  };
  listeners.clear();
  rmSync(logDir, { recursive: true, force: true });
  return result;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (v: number, d = 0) => v.toFixed(d).padStart(9);

const { createApiLog } = (await import(pathToFileURL(modulePath).href)) as { createApiLog: CreateApiLog };

console.log(`module ${values.module}: ${FRAMES.toLocaleString('en-US')} tickPrice frames, ${CHUNK} per read, ${values.rate}/s, median of ${RUNS} runs`);
console.log('stream  file    record ns   deferred ns   total ns   retained MB   gc n   gc ms   emitted   file lines');
for (const [stream, file] of [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const) {
  await run(createApiLog, Math.min(FRAMES, 20_000), stream, file); // warm-up
  const results: Result[] = [];
  for (let r = 0; r < RUNS; r++) results.push(await run(createApiLog, FRAMES, stream, file));
  const m = (k: keyof Result) => median(results.map((x) => x[k]));
  console.log(
    `${(stream ? 'on' : 'off').padEnd(6)}  ${(file ? 'on' : 'off').padEnd(4)}  ${fmt(m('recordNs'))}  ${fmt(m('deferredNs'), 0).padStart(12)}  ${fmt(m('recordNs') + m('deferredNs')).padStart(9)}  ${fmt(m('retainedMb'), 1).padStart(12)}  ${String(m('gcCount')).padStart(5)}  ${fmt(m('gcMs'), 1).padStart(6)}  ${String(m('emitted')).padStart(8)}  ${String(m('fileLines')).padStart(11)}`,
  );
}

// Reading entries: the first read decodes the ring, later reads hit the cached slots.
{
  logDir = mkdtempSync(join(logRoot, 'read-'));
  const { ctx, listeners } = fakeContext(false);
  const log = createApiLog(ctx, { streamByDefault: false });
  drain();
  const received = listeners.get('received')!;
  const frames = makeFrames(FRAMES);
  for (let i = 0; i < FRAMES; i++) received(frames.tokens[i], frames.texts[i]);
  drain();
  const t0 = performance.now();
  const first = log.getEntries().length;
  const t1 = performance.now();
  log.getEntries();
  const t2 = performance.now();
  console.log(`getEntries (${first.toLocaleString('en-US')} entries): first ${(t1 - t0).toFixed(1)} ms, again ${(t2 - t1).toFixed(1)} ms`);
}

rmSync(logRoot, { recursive: true, force: true });
process.exit(0);
