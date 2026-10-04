// Outgoing queue of the TWS client: priority lanes, elision of unsent request / cancel pairs,
// IB's per-request pacing, and a sliding-window rate limit that spreads bursts and backs off
// when IB reports error 100.
//
// Lanes: 0 = order traffic, 1 = control / account, 2 = market data. Orders always go first;
// then control before market data, FIFO within a lane, except that a market data frame that
// has waited AGING_MS goes ahead of younger control frames (it cannot starve). A request and
// its cancel share a lane, so they stay ordered.
//
// While the last second holds fewer than BURST writes a frame is written synchronously; beyond
// that writes are spread evenly (one per 1000 / limit ms), so a late read on IB's side cannot
// put two bursts into one of its seconds. Frames with pacing rules (pacing.ts: symbol search,
// historical data) are checked when they are written, the moment IB counts them; one whose
// rule is full is passed over by the frames behind it, except frames of its subscription.

import { OUT_MSG_ID } from './messageIds.ts';
import { PaceWindows, type Pace } from './pacing.ts';

/** IB's limit is 50 messages per second; 45 leaves headroom for network jitter. */
export const DEFAULT_MAX_PER_SECOND = 45;
/** How long the halved limit applies after the last error 100. */
export const BACKOFF_MS = 10_000;
/** Writes within the last second that may go out at once; beyond, writes are spread evenly. */
export const BURST = 10;
/** A market data frame that waited this long goes ahead of younger control frames. */
export const AGING_MS = 1000;
const WINDOW_MS = 1000;
const STATS_INTERVAL_MS = 1000;

export const Lane = { Order: 0, Control: 1, MarketData: 2 } as const;
export type Lane = (typeof Lane)[keyof typeof Lane];
const LANE_COUNT = 3;

const M = OUT_MSG_ID;
const ORDER_MSGS = [M.PLACE_ORDER, M.CANCEL_ORDER, M.REQ_GLOBAL_CANCEL, M.REQ_IDS, M.EXERCISE_OPTIONS];
const MARKET_DATA_MSGS = [
  M.REQ_MKT_DATA,
  M.CANCEL_MKT_DATA,
  M.REQ_MKT_DEPTH,
  M.CANCEL_MKT_DEPTH,
  M.REQ_HISTORICAL_DATA,
  M.CANCEL_HISTORICAL_DATA,
  M.REQ_HEAD_TIMESTAMP,
  M.CANCEL_HEAD_TIMESTAMP,
  M.REQ_MATCHING_SYMBOLS,
  M.REQ_REAL_TIME_BARS,
  M.CANCEL_REAL_TIME_BARS,
  M.REQ_TICK_BY_TICK_DATA,
  M.CANCEL_TICK_BY_TICK_DATA,
  M.REQ_HISTORICAL_TICKS,
  M.REQ_HISTOGRAM_DATA,
  M.CANCEL_HISTOGRAM_DATA,
];
const LANE_OF = new Map<number, Lane>([...ORDER_MSGS.map((id) => [id, Lane.Order] as const), ...MARKET_DATA_MSGS.map((id) => [id, Lane.MarketData] as const)]);

/** Lane of an outgoing message id; everything that is neither orders nor market data is control. */
export function laneOf(msgId: number): Lane {
  return LANE_OF.get(msgId) ?? Lane.Control;
}

/** Cancel message id -> the request it cancels (both carry the same request id). Never orders. */
const REQUEST_OF_CANCEL = new Map<number, number>([
  [M.CANCEL_MKT_DATA, M.REQ_MKT_DATA],
  [M.CANCEL_MKT_DEPTH, M.REQ_MKT_DEPTH],
  [M.CANCEL_HISTORICAL_DATA, M.REQ_HISTORICAL_DATA],
  [M.CANCEL_HEAD_TIMESTAMP, M.REQ_HEAD_TIMESTAMP],
  [M.CANCEL_ACCOUNT_SUMMARY, M.REQ_ACCOUNT_SUMMARY],
  [M.CANCEL_PNL, M.REQ_PNL],
  [M.CANCEL_PNL_SINGLE, M.REQ_PNL_SINGLE],
]);
const PAIRED_REQUESTS: ReadonlySet<number> = new Set(REQUEST_OF_CANCEL.values());

/** A frame that opens (or cancels) the subscription `key`. */
export interface Pairing {
  key: string;
  cancel: boolean;
}

/** Pairing of a frame with message id `msgId` for request id `reqId` (undefined: not pairable). */
export function pairingOf(msgId: number, reqId: number | undefined): Pairing | undefined {
  if (reqId === undefined) return undefined;
  const request = REQUEST_OF_CANCEL.get(msgId);
  if (request !== undefined) return { key: `${request}:${reqId}`, cancel: true };
  return PAIRED_REQUESTS.has(msgId) ? { key: `${msgId}:${reqId}`, cancel: false } : undefined;
}

export interface QueueStats {
  /** Frames waiting for the rate limit or their pacing rule, per lane. */
  queued: { order: number; control: number; marketData: number };
  /** Frames written in the last second (the handshake included). */
  sentLastSecond: number;
  /** Request / cancel pairs dropped before reaching the wire. */
  elidedPairs: number;
  /** Epoch ms when the error-100 backoff ends; 0 when the full rate applies. */
  backoffUntil: number;
  /** Current limit in messages per second (halved during a backoff). */
  maxPerSecond: number;
}

/** Time source of the queue (injectable for tests). */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Monotonic clock (immune to system clock changes); its timers never keep the process alive. */
export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SendQueueOptions<T> {
  /** Writes one item; false when it could not be written (then it is not counted). */
  write: (item: T) => boolean;
  /** Default DEFAULT_MAX_PER_SECOND. */
  maxPerSecond?: number;
  clock?: Clock;
  /** Called at most once per second while items wait, and once more after they drained. */
  onStats?: (stats: QueueStats) => void;
}

interface Entry<T> {
  item: T;
  lane: Lane;
  pairing: Pairing | undefined;
  paces: readonly Pace[] | undefined;
  /** Push order and time (aging). */
  seq: number;
  at: number;
  /** Elided, or written ahead of the entries before it (discarded when it reaches the head). */
  done: boolean;
}

/** Minimal FIFO with O(1) shift and indexed reads from the head. */
class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  /** The i-th item from the head. */
  at(i: number): T {
    return this.items[this.head + i];
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head++] = undefined as T;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }
}

/**
 * Hands items to `write` so that at most `maxPerSecond` writes happen in any 1000 ms window,
 * spread evenly past the first BURST. Items are never dropped except unsent request / cancel
 * pairs. A write is time-stamped after it returned, so the gap between the k-th and the
 * (k+max)-th write is at least one second however long writes take.
 */
export class SendQueue<T> {
  private readonly lanes: Array<Fifo<Entry<T>>> = Array.from({ length: LANE_COUNT }, () => new Fifo());
  /** Items per lane that will be written (done entries excluded). */
  private readonly live = new Array<number>(LANE_COUNT).fill(0);
  /**
   * Open subscriptions by key, in the order IB will see the frames: the unsent request a cancel
   * may elide, or null when one is on the wire or several were requested (a cancel must go).
   * A cancel closes the key. Keys of requests that end without a cancel (one-shot historical
   * data) stay until the queue is cleared on disconnect.
   */
  private readonly open = new Map<string, Entry<T> | null>();
  private readonly paced = new PaceWindows();
  /** Stamps of the writes in the current window (oldest first). */
  private readonly stamps: number[] = [];
  private readonly max: number;
  private readonly write: (item: T) => boolean;
  private readonly clock: Clock;
  private readonly onStats: ((stats: QueueStats) => void) | undefined;
  private timer: unknown = null;
  private timerAt = Infinity;
  private pumping = false;
  private corks = 0;
  private seq = 0;
  private elided = 0;
  private backoffUntil = -Infinity;
  /** Shortest wait of the paced frames the last next() passed over (Infinity: none). */
  private heldMs = Infinity;
  private statsTimer: unknown = null;
  private lastStatsAt = -Infinity;

  constructor(options: SendQueueOptions<T>) {
    this.max = Math.max(1, Math.floor(options.maxPerSecond ?? DEFAULT_MAX_PER_SECOND));
    this.write = options.write;
    this.clock = options.clock ?? systemClock;
    this.onStats = options.onStats;
  }

  /** Items waiting for the limit or their pacing rule. */
  get queued(): number {
    return this.live[0] + this.live[1] + this.live[2];
  }

  /** Counts a write made outside the queue (handshake, START_API). */
  record(): void {
    this.stamps.push(this.clock.now());
  }

  /**
   * Queues an item; it is written synchronously when the limit and its pacing rules allow. A
   * cancel whose request is still unsent removes that request instead and is not queued itself.
   */
  push(item: T, lane: Lane = Lane.Control, pairing?: Pairing, paces?: readonly Pace[]): void {
    if (pairing?.cancel && this.elide(pairing.key, lane)) return;
    const entry: Entry<T> = { item, lane, pairing, paces, seq: this.seq++, at: this.clock.now(), done: false };
    if (pairing && !pairing.cancel) this.open.set(pairing.key, this.open.has(pairing.key) ? null : entry);
    this.lanes[lane].push(entry);
    this.live[lane]++;
    this.kick();
    this.watchStats();
  }

  /** Holds writes until the matching uncork() (pushes in between are prioritized and elided as a batch). */
  cork(): void {
    this.corks++;
  }

  uncork(): void {
    if (this.corks > 0 && --this.corks === 0) this.kick();
  }

  /**
   * IB reported error 100 (message rate exceeded): half the limit until BACKOFF_MS after the
   * last such error. Returns true when a backoff starts (errors during one only extend it).
   */
  backoff(): boolean {
    const now = this.clock.now();
    const starts = now >= this.backoffUntil;
    this.backoffUntil = now + BACKOFF_MS;
    return starts;
  }

  stats(): QueueStats {
    const now = this.clock.now();
    this.prune(now);
    return {
      queued: { order: this.live[Lane.Order], control: this.live[Lane.Control], marketData: this.live[Lane.MarketData] },
      sentLastSecond: this.stamps.length,
      elidedPairs: this.elided,
      backoffUntil: now < this.backoffUntil ? Date.now() + Math.ceil(this.backoffUntil - now) : 0,
      maxPerSecond: this.limit(now),
    };
  }

  /** Drops the queued items (the connection is gone). Window, pacing, backoff and counters are kept. */
  clear(): void {
    this.cancelTimer();
    for (const lane of this.lanes) lane.clear();
    this.live.fill(0);
    this.open.clear();
  }

  // ---------------------------------------------------------------------------

  /**
   * A cancel closes its key. When the key's only open request is still unsent (same lane,
   * never orders) both are dropped; false when the cancel has to be sent.
   */
  private elide(key: string, lane: Lane): boolean {
    const request = this.open.get(key);
    this.open.delete(key);
    if (!request || request.lane !== lane || lane === Lane.Order) return false;
    request.done = true;
    this.live[lane]--;
    this.elided++;
    return true;
  }

  private kick(): void {
    if (this.pumping || this.corks > 0) return;
    if (this.timer !== null) {
      // a pending wake-up stands unless the rate allows a write before it (it waits for a paced frame)
      const now = this.clock.now();
      if (this.timerAt <= now + this.waitMs(now)) return;
    }
    this.pump();
  }

  private pump(): void {
    this.cancelTimer();
    this.pumping = true;
    try {
      while (this.corks === 0 && this.queued > 0) {
        const now = this.clock.now();
        const wait = this.waitMs(now);
        if (wait > 0) return this.wakeIn(wait);
        const entry = this.next(now);
        if (!entry) return this.wakeIn(this.heldMs); // everything waiting is held by its pacing rule
        this.take(entry);
        if (!this.write(entry.item)) continue;
        const at = this.clock.now();
        this.stamps.push(at);
        if (entry.paces) this.paced.record(entry.paces, at);
      }
      if (this.queued === 0) for (const lane of this.lanes) lane.clear(); // only done entries are left
    } finally {
      this.pumping = false;
    }
  }

  /** The entry to write now: orders, then control, then market data (unless it has aged). */
  private next(now: number): Entry<T> | undefined {
    this.heldMs = Infinity;
    const order = this.candidate(this.lanes[Lane.Order], now);
    if (order) return order;
    const control = this.candidate(this.lanes[Lane.Control], now);
    const data = this.candidate(this.lanes[Lane.MarketData], now);
    if (control && data && data.seq < control.seq && now - data.at >= AGING_MS) return data;
    return control ?? data;
  }

  /**
   * First entry of a lane that may be written now. Paced entries whose rule is full are passed
   * over (their wait goes to heldMs), and so is anything of their subscription behind them.
   */
  private candidate(lane: Fifo<Entry<T>>, now: number): Entry<T> | undefined {
    while (lane.length > 0 && lane.at(0).done) lane.shift();
    let held: Set<string> | undefined;
    for (let i = 0; i < lane.length; i++) {
      const entry = lane.at(i);
      if (entry.done || (entry.pairing && held?.has(entry.pairing.key))) continue;
      const wait = entry.paces ? this.paced.waitMs(entry.paces, now) : 0;
      if (wait === 0) return entry;
      this.heldMs = Math.min(this.heldMs, wait);
      if (entry.pairing) (held ??= new Set()).add(entry.pairing.key);
    }
    return undefined;
  }

  /** The entry leaves the queue; a request on the wire can no longer be elided. */
  private take(entry: Entry<T>): void {
    entry.done = true;
    this.live[entry.lane]--;
    const key = entry.pairing?.key;
    if (key !== undefined && this.open.get(key) === entry) this.open.set(key, null);
  }

  private wakeIn(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.timerAt = this.clock.now() + ms;
    this.timer = this.clock.setTimeout(() => this.pump(), ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  private limit(now: number): number {
    return now < this.backoffUntil ? Math.max(1, Math.floor(this.max / 2)) : this.max;
  }

  private prune(now: number): void {
    while (this.stamps.length && now - this.stamps[0] >= WINDOW_MS) this.stamps.shift();
  }

  /** Milliseconds until the rate limit allows the next write (0: now). */
  private waitMs(now: number): number {
    this.prune(now);
    let until = this.allowedAt(this.limit(now));
    // during a backoff, the full limit applies from its end
    if (now < this.backoffUntil) until = Math.min(until, Math.max(this.backoffUntil, this.allowedAt(this.max)));
    return until > now ? Math.max(1, Math.ceil(until - now)) : 0;
  }

  /** Earliest time of the next write under `max` writes per second (the window is pruned). */
  private allowedAt(max: number): number {
    const n = this.stamps.length;
    let at = -Infinity;
    // the oldest n - max + 1 writes must leave the window
    if (n >= max) at = this.stamps[n - max] + WINDOW_MS;
    // past the burst, one write per 1000 / max ms
    if (n >= BURST) at = Math.max(at, this.stamps[n - 1] + Math.floor(WINDOW_MS / max));
    return at;
  }

  /** Schedules a stats report while items wait (at most one per STATS_INTERVAL_MS). */
  private watchStats(): void {
    if (!this.onStats || this.statsTimer !== null || this.queued === 0) return;
    const delay = Math.max(0, this.lastStatsAt + STATS_INTERVAL_MS - this.clock.now());
    this.statsTimer = this.clock.setTimeout(() => this.reportStats(), delay);
  }

  private reportStats(): void {
    this.statsTimer = null;
    this.lastStatsAt = this.clock.now();
    const stats = this.stats();
    // keep reporting while items wait; the report that finds the queue empty is the last one
    if (this.queued > 0) this.statsTimer = this.clock.setTimeout(() => this.reportStats(), STATS_INTERVAL_MS);
    try {
      this.onStats?.(stats);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}
