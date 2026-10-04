// Send queue: rate window and spreading, lanes and aging, elision of unsent pairs, pacing rules at
// write time, error-100 backoff, stats (deterministic, with a fake clock; one block runs the real
// system clock under vi fake timers).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from './__fixtures__/fakeClock.ts';
import { OUT_MSG_ID } from './messageIds.ts';
import type { Pace } from './pacing.ts';
import {
  AGING_MS,
  BACKOFF_MS,
  BURST,
  DEFAULT_MAX_PER_SECOND,
  Lane,
  laneOf,
  pairingOf,
  SendQueue,
  systemClock,
  type Pairing,
  type QueueStats,
  type SendQueueOptions,
} from './sendQueue.ts';

function setup(max?: number, options: Partial<SendQueueOptions<number>> = {}) {
  const clock = new FakeClock();
  const written: Array<[number, number]> = [];
  const stats: QueueStats[] = [];
  const queue = new SendQueue<number>({
    maxPerSecond: max,
    write: (item) => (written.push([item, clock.t]), true),
    clock,
    onStats: (s) => stats.push(s),
    ...options,
  });
  const items = () => written.map(([i]) => i);
  return { clock, written, items, stats, queue };
}

/** At most `max` writes in any `windowMs` window. */
function expectWindow(written: Array<[number, number]>, max: number, windowMs = 1000): void {
  for (let k = 0; k + max < written.length; k++) expect(written[k + max][1] - written[k][1]).toBeGreaterThanOrEqual(windowMs);
}

/** Write times of the given items. */
const timesOf = (written: Array<[number, number]>, items: number[]): number[] => written.filter(([i]) => items.includes(i)).map(([, t]) => t);

const open = (key: string): Pairing => ({ key, cancel: false });
const cancel = (key: string): Pairing => ({ key, cancel: true });
const pace = (key: string, max: number, windowMs: number, weight = 1): Pace[] => [{ key, max, windowMs, weight }];

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('SendQueue rate window', () => {
  it('defaults to 45 per second, headroom under IB’s 50: a burst of 10 at once, then one write per 22 ms', () => {
    expect(DEFAULT_MAX_PER_SECOND).toBe(45);
    expect(BURST).toBe(10);
    const { queue, written, clock } = setup();
    for (let i = 0; i < 50; i++) queue.push(i);
    expect(written).toHaveLength(10);
    expect(queue.queued).toBe(40);
    expect(queue.stats().maxPerSecond).toBe(45);
    clock.advance(21);
    expect(written).toHaveLength(10);
    clock.advance(1);
    expect(written).toHaveLength(11);
    clock.advance(999 - 22);
    expect(written).toHaveLength(45); // 35 spread writes by t=770; the window is full until the burst leaves it
    clock.advance(1);
    expect(written).toHaveLength(46);
    clock.advance(1000);
    expect(written).toHaveLength(50);
    expectWindow(written, 45);
  });

  it('writes synchronously while under the burst', () => {
    const { queue, written } = setup();
    queue.push(1);
    expect(written).toEqual([[1, 0]]);
    for (let i = 1; i < BURST; i++) queue.push(1 + i);
    expect(written).toHaveLength(BURST);
    expect(written.every(([, t]) => t === 0)).toBe(true);
  });

  it('the burst is available again after a quiet second', () => {
    const { clock, written, queue } = setup();
    for (let i = 0; i < 30; i++) queue.push(i);
    clock.advance(5000);
    for (let i = 0; i < BURST; i++) queue.push(100 + i);
    expect(timesOf(written, Array.from({ length: BURST }, (_, i) => 100 + i))).toEqual(new Array(BURST).fill(5000));
  });

  it('honours a configured limit and never exceeds it in any 1000 ms window, never drops or reorders', () => {
    const { clock, written, items, queue } = setup(50);
    for (let i = 0; i < 175; i++) queue.push(i);
    expect(written).toHaveLength(BURST);
    expect(queue.queued).toBe(175 - BURST);
    clock.advance(5000);
    expect(items()).toEqual(Array.from({ length: 175 }, (_, i) => i));
    expectWindow(written, 50);
    expect(clock.pending).toBe(0);
  });

  it('spreads writes so that a late read on IB’s side (80 ms) still sees at most 50 in a second', () => {
    // random bursts in random lanes: idle stretches and saturation
    for (const [seed, maxGap, maxBurst] of [
      [7, 1500, 60],
      [11, 300, 80],
    ]) {
      const next = random(seed);
      const { clock, written, queue } = setup(undefined, { onStats: undefined });
      let n = 0;
      for (let t = 0; t < 30_000; t += Math.floor(next() ** 2 * maxGap)) {
        clock.advance(t - clock.t);
        const count = Math.floor(next() ** 3 * maxBurst);
        for (let i = 0; i < count; i++) queue.push(n++, Math.floor(next() * 3) as Lane);
      }
      clock.advance(600_000);
      expect(written).toHaveLength(n);
      expect(new Set(written.map(([i]) => i)).size).toBe(n);
      expectWindow(written, 45);
      expectWindow(written, 50, 1080);
    }
  });

  it('spreads a backlog with one timer per write, never a busy loop', () => {
    const { clock, written, queue } = setup(undefined, { onStats: undefined });
    for (let i = 0; i < 100; i++) queue.push(i);
    clock.advance(10_000);
    expect(written).toHaveLength(100);
    expect(clock.scheduled).toBeLessThanOrEqual(100 - BURST);
  });

  it('spreads a steady stream: 10 per 100 ms stays within the window', () => {
    const { clock, written, queue } = setup();
    for (let step = 0; step < 50; step++) {
      for (let i = 0; i < 10; i++) queue.push(step * 10 + i);
      clock.advance(100);
    }
    clock.advance(10_000);
    expect(written).toHaveLength(500);
    expectWindow(written, 45);
  });

  it('counts writes made outside the queue (handshake)', () => {
    const { clock, items, queue } = setup(3);
    queue.record();
    queue.record();
    queue.push(1);
    queue.push(2);
    expect(items()).toEqual([1]);
    expect(queue.stats().sentLastSecond).toBe(3);
    clock.advance(1000);
    expect(items()).toEqual([1, 2]);
  });

  it('stamps a write after it returns, so slow writes cannot squeeze the window', () => {
    const clock = new FakeClock();
    const written: Array<[number, number]> = [];
    // every write takes 30 ms
    const queue = new SendQueue<number>({ maxPerSecond: 2, clock, write: (i) => (written.push([i, clock.t]), (clock.t += 30), true) });
    for (let i = 0; i < 4; i++) queue.push(i);
    clock.advance(5000);
    expect(written[2][1] - written[0][1]).toBeGreaterThanOrEqual(1000 + 30);
    expect(written[3][1] - written[1][1]).toBeGreaterThanOrEqual(1000);
  });

  it('drains promptly: the next write happens exactly when the oldest one leaves the window', () => {
    const { clock, written, queue } = setup(2);
    queue.push(1);
    clock.advance(300);
    queue.push(2);
    queue.push(3);
    queue.push(4);
    clock.advance(5000);
    expect(written).toEqual([
      [1, 0],
      [2, 300],
      [3, 1000],
      [4, 1300],
    ]);
  });

  it('waits on one timer, not a loop: one wake-up per freed window', () => {
    const { clock, written, queue } = setup(5, { onStats: undefined });
    for (let i = 0; i < 25; i++) queue.push(i);
    expect(clock.pending).toBe(1);
    clock.advance(10_000);
    expect(written).toHaveLength(25);
    expect(clock.scheduled).toBe(4);
  });

  it('keeps FIFO order for items pushed from inside a write', () => {
    const clock = new FakeClock();
    const written: number[] = [];
    const queue: SendQueue<number> = new SendQueue<number>({
      clock,
      write: (i) => {
        written.push(i);
        if (i === 1) queue.push(99);
        return true;
      },
    });
    queue.push(1);
    queue.push(2);
    expect(written).toEqual([1, 99, 2]);
  });

  it('clear() drops the queue and the pending timer', () => {
    const { clock, items, queue } = setup(1);
    queue.push(1);
    queue.push(2);
    expect(clock.pending).toBe(2); // the drain timer and the stats report
    queue.clear();
    clock.advance(5000);
    expect(items()).toEqual([1]);
    expect(clock.pending).toBe(0);
  });

  it('does not count writes that did not happen', () => {
    const clock = new FakeClock();
    let connected = false;
    const written: number[] = [];
    const queue = new SendQueue<number>({ maxPerSecond: 1, clock, write: (i) => connected && (written.push(i), true) });
    queue.push(1); // socket gone: not written, not counted
    connected = true;
    queue.push(2);
    expect(written).toEqual([2]);
  });
});

describe('SendQueue lanes', () => {
  it('classifies messages: orders, control / account, market data', () => {
    const M = OUT_MSG_ID;
    for (const id of [M.PLACE_ORDER, M.CANCEL_ORDER, M.REQ_GLOBAL_CANCEL, M.REQ_IDS, M.EXERCISE_OPTIONS]) expect(laneOf(id)).toBe(Lane.Order);
    for (const id of [
      M.START_API,
      M.REQ_CURRENT_TIME,
      M.REQ_MARKET_DATA_TYPE,
      M.REQ_ACCOUNT_DATA,
      M.REQ_ACCOUNT_SUMMARY,
      M.CANCEL_ACCOUNT_SUMMARY,
      M.REQ_POSITIONS,
      M.CANCEL_POSITIONS,
      M.REQ_PNL,
      M.CANCEL_PNL,
      M.REQ_PNL_SINGLE,
      M.CANCEL_PNL_SINGLE,
      M.REQ_OPEN_ORDERS,
      M.REQ_ALL_OPEN_ORDERS,
      M.REQ_COMPLETED_ORDERS,
      M.REQ_EXECUTIONS,
      M.REQ_MANAGED_ACCTS,
      M.REQ_CONTRACT_DATA,
      M.REQ_SEC_DEF_OPT_PARAMS,
    ])
      expect(laneOf(id)).toBe(Lane.Control);
    for (const id of [
      M.REQ_MKT_DATA,
      M.CANCEL_MKT_DATA,
      M.REQ_MKT_DEPTH,
      M.CANCEL_MKT_DEPTH,
      M.REQ_HISTORICAL_DATA,
      M.CANCEL_HISTORICAL_DATA,
      M.REQ_HEAD_TIMESTAMP,
      M.CANCEL_HEAD_TIMESTAMP,
      M.REQ_MATCHING_SYMBOLS,
    ])
      expect(laneOf(id)).toBe(Lane.MarketData);
  });

  it('puts every pairable request in the same lane as its cancel', () => {
    for (let id = 1; id <= 110; id++) {
      const p = pairingOf(id, 7);
      if (!p?.cancel) continue;
      const requestId = Number(p.key.split(':')[0]);
      expect(laneOf(requestId)).toBe(laneOf(id));
      expect(pairingOf(requestId, 7)).toEqual({ key: p.key, cancel: false });
    }
  });

  it('writes waiting frames by lane (orders, control, market data), FIFO within a lane', () => {
    const { clock, items, queue } = setup();
    for (let i = 0; i < BURST; i++) queue.push(100 + i); // written at once; the rest is spread
    queue.push(21, Lane.MarketData);
    queue.push(11, Lane.Control);
    queue.push(22, Lane.MarketData);
    queue.push(1, Lane.Order);
    queue.push(12, Lane.Control);
    queue.push(2, Lane.Order);
    expect(queue.stats().queued).toEqual({ order: 2, control: 2, marketData: 2 });
    clock.advance(1000);
    expect(items().slice(BURST)).toEqual([1, 2, 11, 12, 21, 22]);
  });

  it(`market data cannot starve: after ${AGING_MS} ms it goes ahead of younger control frames`, () => {
    const { clock, items, written, queue } = setup(undefined, { onStats: undefined });
    for (let i = 0; i < 45; i++) queue.push(i, Lane.Control);
    queue.push(1000, Lane.MarketData);
    // control traffic at the limit for 5 s
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 45; i++) queue.push(100 + s * 45 + i, Lane.Control);
      clock.advance(1000);
    }
    expect(timesOf(written, [1000])).toEqual([AGING_MS]);
    expect(items().indexOf(1000)).toBe(45); // after the older control frames, before the younger ones
  });

  it('orders still go ahead of market data that has aged', () => {
    const { clock, items, queue } = setup(1);
    queue.push(0); // fills the window
    queue.push(20, Lane.MarketData);
    clock.advance(999);
    queue.push(10, Lane.Control);
    queue.push(1, Lane.Order);
    clock.advance(10_000);
    expect(items()).toEqual([0, 1, 20, 10]);
  });

  it('an order arriving while market data waits goes out next', () => {
    const { clock, items, queue } = setup(2);
    for (let i = 0; i < 6; i++) queue.push(20 + i, Lane.MarketData);
    clock.advance(1000);
    queue.push(1, Lane.Order);
    clock.advance(1000);
    expect(items()).toEqual([20, 21, 22, 23, 1, 24]);
  });

  it('cork() batches pushes so a flush goes out by lane', () => {
    const { items, queue } = setup();
    queue.cork();
    queue.push(21, Lane.MarketData);
    queue.push(11, Lane.Control);
    queue.push(1, Lane.Order);
    expect(items()).toEqual([]);
    queue.uncork();
    expect(items()).toEqual([1, 11, 21]);
  });
});

describe('SendQueue elision of unsent pairs', () => {
  it('drops a request and its cancel when the request is still queued, and counts the pair', () => {
    const { clock, items, queue } = setup(1);
    queue.push(0);
    queue.push(1, Lane.MarketData, open('1:5'));
    queue.push(2, Lane.MarketData, open('1:6'));
    queue.push(3, Lane.MarketData, cancel('1:5'));
    expect(queue.queued).toBe(1);
    expect(queue.stats().elidedPairs).toBe(1);
    clock.advance(10_000);
    expect(items()).toEqual([0, 2]);
  });

  it('queues the cancel when its request is already on the wire', () => {
    const { clock, items, queue } = setup(1);
    queue.push(1, Lane.MarketData, open('1:5'));
    queue.push(2, Lane.MarketData, cancel('1:5'));
    clock.advance(1000);
    expect(items()).toEqual([1, 2]);
    expect(queue.stats().elidedPairs).toBe(0);
  });

  it('elides inside a corked batch (held requests flushed on connect)', () => {
    const { items, queue } = setup();
    queue.cork();
    queue.push(1, Lane.MarketData, open('20:9'));
    queue.push(2, Lane.Control);
    queue.push(3, Lane.MarketData, cancel('20:9'));
    queue.uncork();
    expect(items()).toEqual([2]);
    expect(queue.stats().elidedPairs).toBe(1);
  });

  it('a resubscription after a sent request: the second request and second cancel go, the first cancel stays', () => {
    const { clock, items, queue } = setup(1);
    queue.push(1, Lane.MarketData, open('1:5')); // sent
    queue.push(2, Lane.MarketData, cancel('1:5')); // queued
    queue.push(3, Lane.MarketData, open('1:5')); // queued
    queue.push(4, Lane.MarketData, cancel('1:5')); // elides 3
    clock.advance(10_000);
    expect(items()).toEqual([1, 2]);
  });

  it('never elides when two unsent requests share the id (ambiguous)', () => {
    const { clock, items, queue } = setup(1);
    queue.push(0);
    queue.push(1, Lane.MarketData, open('1:5'));
    queue.push(2, Lane.MarketData, open('1:5'));
    queue.push(3, Lane.MarketData, cancel('1:5'));
    clock.advance(10_000);
    expect(items()).toEqual([0, 1, 2, 3]);
    expect(queue.stats().elidedPairs).toBe(0);
  });

  it('sends the cancel when a request of its key is already on the wire (two requests shared the id)', () => {
    const { clock, items, queue } = setup(1);
    queue.push(0);
    queue.push(1, Lane.MarketData, open('1:5'));
    queue.push(2, Lane.MarketData, open('1:5'));
    clock.advance(1000); // 1 goes out
    queue.push(3, Lane.MarketData, cancel('1:5'));
    clock.advance(10_000);
    expect(items()).toEqual([0, 1, 2, 3]);
    expect(queue.stats().elidedPairs).toBe(0);
  });

  it('sends the cancel when the id is requested again while the first request is on the wire', () => {
    const { clock, items, queue } = setup(1);
    queue.push(1, Lane.MarketData, open('1:5')); // sent
    queue.push(2, Lane.MarketData, open('1:5')); // queued
    queue.push(3, Lane.MarketData, cancel('1:5'));
    clock.advance(10_000);
    expect(items()).toEqual([1, 2, 3]);
    expect(queue.stats().elidedPairs).toBe(0);
  });

  it('elides again once the cancel of the sent request went out', () => {
    const { clock, items, queue } = setup(1);
    queue.push(1, Lane.MarketData, open('1:5'));
    clock.advance(1000);
    queue.push(2, Lane.MarketData, cancel('1:5'));
    clock.advance(1000); // both on the wire
    queue.push(0); // fills the window
    queue.push(3, Lane.MarketData, open('1:5'));
    queue.push(4, Lane.MarketData, cancel('1:5'));
    clock.advance(10_000);
    expect(items()).toEqual([1, 2, 0]);
    expect(queue.stats().elidedPairs).toBe(1);
  });

  it('forgets the subscriptions of a closed connection (clear)', () => {
    const { clock, items, queue } = setup(1);
    queue.push(1, Lane.MarketData, open('1:5')); // sent on the old connection
    queue.clear();
    clock.advance(1000);
    queue.push(0);
    queue.push(2, Lane.MarketData, open('1:5'));
    queue.push(3, Lane.MarketData, cancel('1:5'));
    clock.advance(10_000);
    expect(items()).toEqual([1, 0]);
  });

  it('never elides order messages or across lanes', () => {
    const { clock, items, queue } = setup(1);
    queue.push(0);
    queue.push(1, Lane.Order, open('3:11'));
    queue.push(2, Lane.Order, cancel('3:11'));
    queue.push(3, Lane.Control, open('62:9'));
    queue.push(4, Lane.MarketData, cancel('62:9'));
    clock.advance(10_000);
    expect(items()).toEqual([0, 1, 2, 3, 4]);
    expect(pairingOf(OUT_MSG_ID.PLACE_ORDER, 11)).toBeUndefined();
    expect(pairingOf(OUT_MSG_ID.CANCEL_ORDER, 11)).toBeUndefined();
  });

  it('pairs the cancels named by IB with their requests', () => {
    const M = OUT_MSG_ID;
    const pairs = [
      [M.REQ_MKT_DATA, M.CANCEL_MKT_DATA],
      [M.REQ_MKT_DEPTH, M.CANCEL_MKT_DEPTH],
      [M.REQ_HISTORICAL_DATA, M.CANCEL_HISTORICAL_DATA],
      [M.REQ_HEAD_TIMESTAMP, M.CANCEL_HEAD_TIMESTAMP],
      [M.REQ_PNL_SINGLE, M.CANCEL_PNL_SINGLE],
      [M.REQ_PNL, M.CANCEL_PNL],
      [M.REQ_ACCOUNT_SUMMARY, M.CANCEL_ACCOUNT_SUMMARY],
    ];
    for (const [req, can] of pairs) {
      expect(pairingOf(req, 42)).toEqual({ key: `${req}:42`, cancel: false });
      expect(pairingOf(can, 42)).toEqual({ key: `${req}:42`, cancel: true });
    }
    expect(pairingOf(M.REQ_MKT_DATA, undefined)).toBeUndefined();
    expect(pairingOf(M.REQ_POSITIONS, 1)).toBeUndefined();
  });
});

describe('SendQueue pacing rules (checked when a frame is written)', () => {
  const SEARCH = pace('symbols', 1, 1000);

  it('keeps symbol searches 1 s apart on the wire even when both waited behind a backlog', () => {
    const { clock, written, queue } = setup(undefined, { onStats: undefined });
    for (let i = 0; i < 105; i++) queue.push(i, Lane.Control);
    queue.push(1001, Lane.MarketData, undefined, SEARCH);
    clock.advance(1000);
    queue.push(1002, Lane.MarketData, undefined, SEARCH); // 1 s after the first call
    clock.advance(10_000);
    const [a, b] = timesOf(written, [1001, 1002]);
    expect(a).toBeGreaterThan(2000); // behind the older control frames
    expect(b - a).toBe(1000);
    expect(written).toHaveLength(107);
  });

  it('historical data: 5 requests delayed by a backlog and a 6th called 2 s after them stay within 5 per 2 s', () => {
    const HIST = pace('hist:AAPL', 5, 2000);
    const { clock, written, queue } = setup(undefined, { onStats: undefined });
    for (let i = 0; i < 60; i++) queue.push(i, Lane.Control); // e.g. P&L per position on connect
    for (let i = 0; i < 5; i++) queue.push(100 + i, Lane.MarketData, open(`20:${i}`), HIST);
    clock.advance(2000);
    queue.push(105, Lane.MarketData, open('20:5'), HIST); // a pacer counting calls would let it go now
    clock.advance(10_000);
    const t = timesOf(written, [100, 101, 102, 103, 104, 105]);
    expect(t[0]).toBeGreaterThan(1000);
    expect(t[5] - t[0]).toBe(2000);
  });

  it('a frame held by its rule does not hold up the frames behind it', () => {
    const { clock, items, queue } = setup();
    queue.push(1, Lane.MarketData, undefined, SEARCH);
    queue.push(2, Lane.MarketData, undefined, SEARCH); // held for 1 s
    queue.push(3, Lane.MarketData);
    queue.push(4, Lane.Control);
    expect(items()).toEqual([1, 3, 4]);
    expect(queue.stats().queued.marketData).toBe(1);
    clock.advance(999);
    expect(items()).toEqual([1, 3, 4]);
    clock.advance(1);
    expect(items()).toEqual([1, 3, 4, 2]);
    expect(clock.pending).toBe(0);
  });

  it('a held request keeps the frames of its subscription behind it (a cancel never overtakes it)', () => {
    const SAME = pace('hist=AAPL 1 day', 1, 15_000);
    const { clock, items, queue } = setup();
    queue.push(1, Lane.MarketData, open('20:1'), SAME);
    queue.push(2, Lane.MarketData, open('20:2'), SAME); // identical request: held 15 s
    queue.push(3, Lane.MarketData, open('20:2'), SAME); // the id again: the cancel cannot be elided
    queue.push(4, Lane.MarketData, cancel('20:2'));
    queue.push(5, Lane.MarketData);
    expect(items()).toEqual([1, 5]);
    clock.advance(15_000);
    expect(items()).toEqual([1, 5, 2]);
    clock.advance(15_000);
    expect(items()).toEqual([1, 5, 2, 3, 4]);
  });

  it('elides a held request with its cancel', () => {
    const { clock, items, queue } = setup(undefined, { onStats: undefined });
    queue.push(1, Lane.MarketData, undefined, SEARCH);
    queue.push(2, Lane.MarketData, open('81:2'), SEARCH);
    queue.push(3, Lane.MarketData, cancel('81:2'));
    expect(queue.queued).toBe(0);
    clock.advance(5000);
    expect(items()).toEqual([1]);
    expect(clock.pending).toBe(0);
  });

  it('counts a frame `weight` times', () => {
    const DOUBLE = pace('bidAsk', 4, 2000, 2);
    const { clock, written, queue } = setup();
    for (let i = 0; i < 3; i++) queue.push(i, Lane.MarketData, undefined, DOUBLE);
    expect(written).toHaveLength(2);
    clock.advance(2000);
    expect(timesOf(written, [2])).toEqual([2000]);
  });

  it('a new frame does not wait for the wake-up of a held one', () => {
    const SLOW = pace('slow', 1, 60_000);
    const { clock, items, queue } = setup(undefined, { onStats: undefined });
    queue.push(1, Lane.MarketData, undefined, SLOW);
    queue.push(2, Lane.MarketData, undefined, SLOW); // held for a minute
    clock.advance(10);
    queue.push(3, Lane.Control);
    expect(items()).toEqual([1, 3]);
    expect(clock.pending).toBe(1);
    clock.advance(60_000);
    expect(items()).toEqual([1, 3, 2]);
  });

  it('a held frame still counts against the rate limit when it goes', () => {
    const { clock, written, queue } = setup(2);
    queue.push(1, Lane.MarketData, undefined, SEARCH);
    queue.push(2, Lane.MarketData, undefined, SEARCH);
    clock.advance(500);
    queue.push(3);
    queue.push(4); // the window (2 per second) is full until t=1000
    clock.advance(10_000);
    expect(written).toEqual([
      [1, 0],
      [3, 500],
      [2, 1000],
      [4, 1500],
    ]);
  });
});

describe('SendQueue backoff (error 100)', () => {
  it('halves the limit for 10 s, then restores it', () => {
    const { clock, written, queue } = setup(undefined, { onStats: undefined });
    expect(queue.backoff()).toBe(true);
    expect(BACKOFF_MS).toBe(10_000);
    expect(queue.stats().maxPerSecond).toBe(22);
    for (let i = 0; i < 60; i++) queue.push(i);
    clock.advance(1000);
    expect(written).toHaveLength(22 + 1); // 22 in the first second, one more as the burst leaves
    clock.advance(BACKOFF_MS - 1000);
    expect(written).toHaveLength(60);
    expectWindow(written, 22);
    expect(written[BURST + 1][1] - written[BURST][1]).toBe(45); // spread at 1000 / 22 ms
    expect(queue.stats().maxPerSecond).toBe(45);
    expect(queue.stats().backoffUntil).toBe(0);
    for (let i = 0; i < 45; i++) queue.push(100 + i);
    clock.advance(1000);
    expect(written).toHaveLength(105);
  });

  it('errors during a backoff extend it without halving again (never below half the limit)', () => {
    const { clock, queue } = setup();
    expect(queue.backoff()).toBe(true);
    for (let i = 0; i < 6; i++) {
      clock.advance(i === 0 ? 200 : 1000);
      expect(queue.backoff()).toBe(false);
      expect(queue.stats().maxPerSecond).toBe(22);
    }
    clock.advance(BACKOFF_MS - 1);
    expect(queue.stats().maxPerSecond).toBe(22);
    clock.advance(1);
    expect(queue.stats().maxPerSecond).toBe(45);
    expect(queue.backoff()).toBe(true); // a new backoff
  });

  it('reports the end of the backoff as an epoch time', () => {
    const { clock, queue } = setup();
    queue.backoff();
    clock.advance(4000);
    const until = queue.stats().backoffUntil;
    expect(until - Date.now()).toBeGreaterThan(5900);
    expect(until - Date.now()).toBeLessThanOrEqual(6000);
  });

  it('drains at full rate as soon as the backoff ends, without waiting for the halved window', () => {
    const { clock, written, queue } = setup();
    queue.backoff();
    clock.advance(BACKOFF_MS - 100);
    for (let i = 0; i < 40; i++) queue.push(i); // the burst, then 45 ms apart until the backoff ends
    clock.advance(1100);
    expect(written.map(([, t]) => t - (BACKOFF_MS - 100)).slice(BURST - 1, BURST + 3)).toEqual([0, 45, 90, 112]);
    expect(written).toHaveLength(40);
    expect(written[39][1]).toBe(BACKOFF_MS + 12 + 27 * 22); // 22 ms apart from then on
    expectWindow(written, 45);
  });

  it('a halved window that is full lets the next write go when the backoff ends', () => {
    const { clock, written, queue } = setup(5);
    queue.backoff(); // 2 per second
    clock.advance(BACKOFF_MS - 100);
    for (let i = 0; i < 6; i++) queue.push(i);
    expect(written).toHaveLength(2);
    clock.advance(100);
    expect(written).toHaveLength(5);
    expect(written[2][1]).toBe(BACKOFF_MS);
  });

  it('keeps the window and the backoff across clear() (a reconnect)', () => {
    const { queue } = setup();
    queue.backoff();
    for (let i = 0; i < 30; i++) queue.push(i);
    queue.clear();
    const stats = queue.stats();
    expect([stats.maxPerSecond, stats.sentLastSecond, stats.queued.control]).toEqual([22, BURST, 0]);
  });
});

describe('SendQueue stats', () => {
  it('reports nothing while frames go out at once', () => {
    const { clock, stats, queue } = setup();
    for (let i = 0; i < BURST; i++) queue.push(i);
    clock.advance(5000);
    expect(stats).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it('reports at most once per second while frames wait, then once when drained', () => {
    const { clock, stats, queue } = setup(10);
    for (let i = 0; i < 40; i++) queue.push(i, i % 2 ? Lane.MarketData : Lane.Control);
    clock.advance(0);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({ queued: { order: 0, control: 15, marketData: 15 }, sentLastSecond: 10, elidedPairs: 0, backoffUntil: 0, maxPerSecond: 10 });
    clock.advance(999);
    expect(stats).toHaveLength(1);
    clock.advance(1);
    expect(stats).toHaveLength(2);
    clock.advance(10_000);
    expect(stats.map((s) => s.queued.control + s.queued.marketData)).toEqual([30, 20, 10, 0]);
    expect(clock.pending).toBe(0);
  });

  it('keeps the one-second spacing when a new burst follows a report', () => {
    const { clock, stats, queue } = setup(1);
    queue.push(1);
    queue.push(2);
    clock.advance(0); // report 1 at t=0
    clock.advance(1000); // 2 written; report 2 (drained) at t=1000
    queue.push(3);
    queue.push(4); // waits; next report not before t=2000
    clock.advance(999);
    expect(stats).toHaveLength(2);
    clock.advance(1);
    expect(stats).toHaveLength(3);
  });

  it('a throwing stats listener does not stop the queue', () => {
    const thrown: unknown[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb: () => void) => {
      try {
        cb();
      } catch (err) {
        thrown.push(err);
      }
    });
    const { clock, written, queue } = setup(1, {
      onStats: () => {
        throw new Error('listener failed');
      },
    });
    queue.push(1);
    queue.push(2);
    clock.advance(5000);
    spy.mockRestore();
    expect(written).toHaveLength(2);
    expect(thrown.length).toBeGreaterThan(0);
  });
});

describe('SendQueue with the system clock (vi fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses unref’d timers, a monotonic clock, and spreads writes on them', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const written: number[] = [];
    const queue = new SendQueue<number>({ write: (i) => (written.push(i), true) });
    for (let i = 0; i < 50; i++) queue.push(i);
    expect(written).toHaveLength(BURST);
    // a wall-clock jump (NTP, DST, user) changes nothing: the queue runs on performance.now()
    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(21);
    expect(written).toHaveLength(BURST);
    vi.advanceTimersByTime(1);
    expect(written).toHaveLength(BURST + 1);
    vi.advanceTimersByTime(2000);
    expect(written).toHaveLength(50);
  });

  it('never keeps the process alive', () => {
    const handle = systemClock.setTimeout(() => undefined, 60_000) as ReturnType<typeof setTimeout>;
    expect(handle.hasRef()).toBe(false);
    systemClock.clearTimeout(handle);
  });
});
