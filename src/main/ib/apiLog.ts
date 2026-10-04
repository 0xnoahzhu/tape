// API log: every frame sent to / received from TWS or IB Gateway (API log page, export, daily
// log files).
//
// Recording runs inside the socket handler for every tick, so a frame is stored raw in a fixed
// ring of the newest 20,000 slots (time, direction, server version, message id, frame text):
// a few array stores, no objects. Names and fields are decoded only when entries are read
// (getEntries, export, live batches) and the decoded entry then replaces the text in its slot. Live
// `apiLog` batches (250 ms) are built only while a view streams them. When enabled, every frame
// is also appended to a daily file (api-YYYYMMDD.log) by the batched writer of apiLogFiles.ts.
//
// Streaming contract (renderer: hooks/useApiLogStream.ts): a view first turns streaming on, then
// loads the recorded entries with getEntries(); batches carry every frame recorded after the
// stream started, so they may overlap the loaded entries and the renderer drops entries whose seq
// it already holds. Each batch also carries the current day's log file path. Renderers stream
// through createLogViewers(): one vote per renderer, withdrawn when it reloads or closes.

import { readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { EventName, type OrderState } from './tws';
import type { ApiLogEntry } from '@shared/types';
import type { ApiLog, MainContext } from '../context';
import { createLogFileWriter, expiredLogFiles, logFileName } from './apiLogFiles';
import {
  DEFAULT_SERVER_VERSION,
  decodeFrame,
  decodeFrameText,
  formatLogLine,
  frameLogLine,
  frameTokens,
  messageName,
  type DecodeOptions,
  type DecodedFrame,
  type Direction,
  type Fields,
} from './messageSchema';

/**
 * Whether live `apiLog` events flow while no view streams them. Off: a log nobody watches is
 * never decoded or sent, only recorded (and written to the file); the views showing it call
 * setApiLogStreaming(true) / (false).
 */
export const STREAM_BY_DEFAULT = false;

export const RING_SIZE = 20_000;
const PUSH_MS = 250;
/** Estimated file line size: the frame text plus time, direction, name and field names. */
const lineBytes = (raw: RawFrame): number => (typeof raw === 'string' ? raw.length * 2 + 40 : 80);

// Slot kinds
const FRAME = 0;
/** First frame received on a connection: server version and connection time. */
const SERVER_VERSION = 1;
/** Synthetic entry from note(); stored decoded. */
const NOTE = 2;

/**
 * A frame as recorded: its text (tokens joined by NUL, see frameTokens) or, for the "API\0"
 * handshake whose text is only the version range, its tokens.
 */
type RawFrame = string | readonly unknown[];

/**
 * Time of the current task: frames handled in one task (one socket read, one burst of requests)
 * share a timestamp, since Date.now() costs more than recording a frame.
 */
let taskTime = 0;
let taskTimeValid = false;
const expireTaskTime = () => {
  taskTimeValid = false;
};

function now(): number {
  if (!taskTimeValid) {
    taskTime = Date.now();
    taskTimeValid = true;
    queueMicrotask(expireTaskTime);
  }
  return taskTime;
}

/** Parses the message id at the start of a frame's text (-1 when there is none). */
function leadingId(text: string): number {
  let n = 0;
  let i = 0;
  for (; i < text.length && i < 6; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) break;
    n = n * 10 + c - 48;
  }
  return i ? n : -1;
}

/**
 * The newest `size` frames, as parallel arrays so that recording allocates nothing.
 * Frame `seq` (1, 2, 3, …) lives in slot (seq - 1) % size.
 */
export class FrameRing {
  readonly size: number;
  /** Seq of the newest frame (0 before the first). */
  last = 0;
  private readonly times: Float64Array;
  /** Bit 0: received; bits 1+: kind. */
  private readonly flags: Uint8Array;
  private readonly version: Uint16Array;
  private readonly msgIds: Int32Array;
  /** Frame text; released ('') once the slot's entry is cached (the entry holds it as `raw`). */
  private readonly raw: RawFrame[];
  private readonly cache: Array<ApiLogEntry | null>;
  /** Fields added to frames not decoded yet (order state), by seq; appended when decoded. */
  private readonly extra = new Map<number, Fields>();

  constructor(size = RING_SIZE) {
    this.size = size;
    this.times = new Float64Array(size);
    this.flags = new Uint8Array(size);
    this.version = new Uint16Array(size);
    this.msgIds = new Int32Array(size);
    this.raw = new Array<RawFrame>(size).fill('');
    this.cache = new Array<ApiLogEntry | null>(size).fill(null);
  }

  /** Oldest seq still held. */
  get first(): number {
    return this.last < this.size ? 1 : this.last - this.size + 1;
  }

  /** Records a frame; returns its seq. */
  push(t: number, dir: Direction, kind: number, serverVersion: number, msgId: number, raw: RawFrame): number {
    const i = this.last % this.size;
    this.times[i] = t;
    this.flags[i] = (dir === 'in' ? 1 : 0) | (kind << 1);
    this.version[i] = serverVersion;
    this.msgIds[i] = msgId;
    this.raw[i] = raw;
    this.cache[i] = null;
    return ++this.last;
  }

  has(seq: number): boolean {
    return seq >= this.first && seq <= this.last && seq > 0;
  }

  time(seq: number): number {
    return this.times[(seq - 1) % this.size];
  }

  msgId(seq: number): number {
    return this.msgIds[(seq - 1) % this.size];
  }

  isFrame(seq: number, dir: Direction): boolean {
    return this.flags[(seq - 1) % this.size] === (dir === 'in' ? 1 : 0);
  }

  /** The decoded entry of a held `seq`; `keep` caches it in the slot for later reads. */
  entry(seq: number, keep: boolean): ApiLogEntry {
    const i = (seq - 1) % this.size;
    const cached = this.cache[i];
    if (cached) return cached;
    const e = this.decode(i, seq);
    if (keep) {
      this.cache[i] = e;
      this.raw[i] = '';
      if (this.extra.size) this.extra.delete(seq);
    }
    return e;
  }

  /** Stores an entry built elsewhere (notes). */
  keep(seq: number, entry: ApiLogEntry): void {
    const i = (seq - 1) % this.size;
    this.cache[i] = entry;
    this.raw[i] = '';
  }

  /** Adds fields to a held frame without decoding it: to its cached entry, or once it is decoded. */
  annotate(seq: number, fields: Fields): void {
    const cached = this.cache[(seq - 1) % this.size];
    if (cached) {
      cached.fields.push(...fields);
      return;
    }
    // Seqs are added in order: first drop those the ring no longer holds.
    for (const old of this.extra.keys()) {
      if (old >= this.first) break;
      this.extra.delete(old);
    }
    this.extra.set(seq, [...(this.extra.get(seq) ?? []), ...fields]);
  }

  /** Decoded entries from..to (inclusive, held seqs), cached. */
  entries(from: number, to: number): ApiLogEntry[] {
    const out: ApiLogEntry[] = [];
    for (let seq = from; seq <= to; seq++) out.push(this.entry(seq, true));
    return out;
  }

  /**
   * The log file line of a held `seq`. Without `keep`, a frame not decoded yet is formatted
   * straight from its text, without building (or caching) its entry; only the rare annotated
   * frames are decoded.
   */
  line(seq: number, keep: boolean): string {
    const i = (seq - 1) % this.size;
    const raw = this.raw[i];
    const annotated = this.extra.size !== 0 && this.extra.has(seq);
    if (keep || this.cache[i] || typeof raw !== 'string' || annotated) return formatLogLine(this.entry(seq, keep));
    try {
      return frameLogLine(this.times[i], this.dir(i), raw, this.decodeOptions(i));
    } catch {
      return formatLogLine(this.decode(i, seq)); // listed as undecoded
    }
  }

  private dir(i: number): Direction {
    return this.flags[i] & 1 ? 'in' : 'out';
  }

  private decodeOptions(i: number): DecodeOptions {
    return { serverVersion: this.version[i], firstReceived: this.flags[i] >> 1 === SERVER_VERSION };
  }

  private decode(i: number, seq: number): ApiLogEntry {
    const dir = this.dir(i);
    const raw = this.raw[i];
    const t = this.times[i];
    let d: DecodedFrame;
    try {
      d = typeof raw === 'string' ? decodeFrameText(dir, raw, this.decodeOptions(i)) : decodeFrame(dir, raw, this.decodeOptions(i));
    } catch (err) {
      // Never let a decoding problem hide the frame; keep it raw.
      const tokens = typeof raw === 'string' ? frameTokens(dir, raw) : raw;
      d = { msgId: '?', name: 'undecoded', fields: [['error', String(err)]], bytes: 0, err: true, raw: tokens.join('␀') };
    }
    const extra = this.extra.size ? this.extra.get(seq) : undefined;
    const fields = extra ? d.fields.concat(extra) : d.fields;
    // Same keys and order as before the ring: seq, t, dir, then the decoded frame.
    return d.reqId === undefined
      ? { seq, t, dir, msgId: d.msgId, name: d.name, fields, bytes: d.bytes, err: d.err, raw: d.raw }
      : { seq, t, dir, msgId: d.msgId, name: d.name, reqId: d.reqId, fields, bytes: d.bytes, err: d.err, raw: d.raw };
  }
}

export interface ApiLogOptions {
  /** Overrides STREAM_BY_DEFAULT (tests, benchmark). */
  streamByDefault?: boolean;
}

/** The API log folder. Development profiles (TAPE_USER_DATA) keep their logs next to their data. */
export function apiLogDir(): string {
  return process.env.TAPE_USER_DATA ? join(app.getPath('userData'), 'logs') : app.getPath('logs');
}

export function createApiLog(ctx: MainContext, options: ApiLogOptions = {}): ApiLog {
  const ring = new FrameRing();
  /** First seq shown (clear() moves it past every recorded frame). */
  let shownFrom = 1;

  const streamByDefault = options.streamByDefault ?? STREAM_BY_DEFAULT;
  /** Views that called setStreaming(true) and not yet (false). */
  let viewers = 0;
  let live = streamByDefault;
  /** Newest seq sent in a live batch. */
  let pushed = 0;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Log file path of the last batch ('' = send it with the next one, even without entries). */
  let pathSent = '';

  let fileOn = false;
  /** Newest seq handed to the log file. */
  let written = 0;
  const files = createLogFileWriter({ dir: apiLogDir, collect: collectLines, maxPending: RING_SIZE / 2 });

  let serverVersion = DEFAULT_SERVER_VERSION;
  /** Set after the handshake is sent: the next received frame is the server version. */
  let expectServerVersion = false;
  /** Seq of the last received frame; decoded callbacks fired for that frame may annotate it. */
  let lastIn = 0;

  function filePath(): string {
    return join(apiLogDir(), logFileName(Date.now()));
  }

  // ---------------------------------------------------------------------------
  // Recording (hot path)

  function add(t: number, dir: Direction, kind: number, msgId: number, raw: RawFrame): number {
    const seq = ring.push(t, dir, kind, serverVersion, msgId, raw);
    if (live && !pushTimer) pushTimer = setTimeout(push, PUSH_MS);
    if (fileOn) files.pending(lineBytes(raw));
    return seq;
  }

  /** EventName.sent: the written tokens and their text (tokens joined by NUL). */
  function onSent(tokens: readonly unknown[], text?: unknown): void {
    if (tokens[0] === 'API\0') {
      expectServerVersion = true;
      add(now(), 'out', FRAME, -1, tokens.slice());
      return;
    }
    const raw = typeof text === 'string' ? text : tokens.join('\0');
    add(now(), 'out', FRAME, leadingId(raw), raw);
  }

  /** EventName.received: the frame's fields and its text (fields NUL-terminated). */
  function onReceived(tokens: readonly unknown[], text?: unknown): void {
    const raw = typeof text === 'string' ? text : tokens.join('\0') + '\0';
    if (expectServerVersion) {
      expectServerVersion = false;
      lastIn = add(now(), 'in', SERVER_VERSION, -1, raw);
      const end = raw.indexOf('\0');
      const v = Number(end < 0 ? raw : raw.slice(0, end));
      if (v > 0) serverVersion = v;
      return;
    }
    lastIn = add(now(), 'in', FRAME, leadingId(raw), raw);
  }

  /**
   * openOrder / completedOrder frames carry the order state deep inside a variable layout;
   * the library has just decoded the same frame, so its status is added to the entry (without
   * decoding the frame here, on the socket path).
   */
  function annotate(name: string, state: OrderState | undefined): void {
    if (!state || !ring.has(lastIn) || !ring.isFrame(lastIn, 'in') || messageName('in', ring.msgId(lastIn)) !== name) return;
    const fields: Fields = [];
    if (state.status) fields.push(['status', String(state.status)]);
    if (state.completedStatus) fields.push(['completedStatus', state.completedStatus]);
    if (state.warningText) fields.push(['warningText', state.warningText]);
    if (fields.length) ring.annotate(lastIn, fields);
  }

  // ---------------------------------------------------------------------------
  // Live batches and the file

  function push(): void {
    pushTimer = null;
    if (!live) return;
    const from = Math.max(pushed + 1, shownFrom, ring.first);
    pushed = ring.last;
    // The file changes at local midnight; views show the current one.
    const logFilePath = filePath();
    if (from > ring.last && logFilePath === pathSent) return;
    pathSent = logFilePath;
    ctx.emit({ type: 'apiLog', entries: from <= ring.last ? ring.entries(from, ring.last) : [], logFilePath });
  }

  function collectLines(line: (t: number, text: string) => void): void {
    const from = Math.max(written + 1, ring.first);
    const lost = from - written - 1;
    written = ring.last;
    if (lost > 0) {
      // Only one task recording over RING_SIZE / 2 frames (one socket read holds a few thousand
      // at most) can outrun the batches (see maxPending).
      const t = Date.now();
      line(t, formatLogLine({ t, dir: 'in', name: 'log overflow', fields: [['notWritten', String(lost)]] }));
    }
    // While streaming, live batches need the entries anyway: decode once and keep them.
    for (let seq = from; seq <= ring.last; seq++) line(ring.time(seq), ring.line(seq, live));
  }

  function setFileLogging(on: boolean): void {
    if (on === fileOn) return;
    fileOn = on;
    written = ring.last;
    if (!on) files.discard();
  }

  async function prune(keepDays: number): Promise<void> {
    const dir = apiLogDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // no log folder yet
    }
    for (const name of expiredLogFiles(names, keepDays)) {
      await unlink(join(dir, name)).catch((err: unknown) => console.error(`[apiLog] could not delete ${name}:`, err));
    }
  }

  // Other services exist once index.ts has created them all.
  setImmediate(() => {
    setFileLogging(ctx.store.getSettings().apiLog.writeFile);
    ctx.ib.on(EventName.sent, onSent);
    ctx.ib.on(EventName.received, onReceived);
    ctx.ib.on(EventName.openOrder, (_id: number, _c: unknown, _o: unknown, state: OrderState) => annotate('openOrder', state));
    ctx.ib.on(EventName.completedOrder, (_c: unknown, _o: unknown, state: OrderState) => annotate('completedOrder', state));
    ctx.store.onSettingsChanged((next, prev) => {
      setFileLogging(next.apiLog.writeFile);
      if (next.apiLog.keepDays !== prev.apiLog.keepDays) void prune(next.apiLog.keepDays);
    });
  });
  void app.whenReady().then(() => prune(ctx.store.getSettings().apiLog.keepDays));
  app.on('will-quit', () => files.flushSync());

  const visibleFrom = () => Math.max(shownFrom, ring.first);

  return {
    getEntries: () => ring.entries(visibleFrom(), ring.last),
    clear() {
      shownFrom = ring.last + 1;
      pushed = ring.last;
      lastIn = 0;
    },
    async exportTo(path) {
      let text = '';
      for (let seq = visibleFrom(); seq <= ring.last; seq++) text += formatLogLine(ring.entry(seq, true)) + '\n';
      await writeFile(path, text, 'utf8');
    },
    filePath,
    setStreaming(on) {
      viewers = Math.max(0, viewers + (on ? 1 : -1));
      const next = streamByDefault || viewers > 0;
      if (on) {
        // A new view gets the current file path with the next batch, even if no frame arrives.
        pathSent = '';
        if (next && !pushTimer) pushTimer = setTimeout(push, PUSH_MS);
      }
      if (next === live) return;
      live = next;
      // A view loads what was recorded so far with getEntries(); batches carry newer frames.
      pushed = ring.last;
      if (!live && pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
    },
    note(dir, name, fields, err) {
      const t = now();
      const seq = add(t, dir, NOTE, -1, '');
      ring.keep(seq, { seq, t, dir, msgId: '—', name, fields, bytes: 0, err: !!err, raw: '' });
    },
  };
}

/** The parts of Electron's WebContents that createLogViewers uses. */
export interface LogViewer {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: 'did-start-loading', listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'did-start-loading', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

/**
 * setApiLogStreaming per renderer. A renderer counts as one view however often it turns
 * streaming on, and its stream ends when it starts loading a page (a reload never sends the
 * "off" call its views would have made on unmount) or is destroyed.
 */
export function createLogViewers(log: Pick<ApiLog, 'setStreaming'>): { set(viewer: LogViewer, on: boolean): void; readonly count: number } {
  /** Streaming renderers by webContents id, with the function that ends their stream. */
  const streaming = new Map<number, () => void>();
  return {
    set(viewer, on) {
      const stop = streaming.get(viewer.id);
      if (!on) {
        stop?.();
        return;
      }
      if (stop || viewer.isDestroyed()) return;
      const end = () => {
        viewer.removeListener('did-start-loading', end);
        viewer.removeListener('destroyed', end);
        if (streaming.get(viewer.id) !== end) return;
        streaming.delete(viewer.id);
        log.setStreaming(false);
      };
      viewer.once('did-start-loading', end);
      viewer.once('destroyed', end);
      streaming.set(viewer.id, end);
      log.setStreaming(true);
    },
    get count() {
      return streaming.size;
    },
  };
}
