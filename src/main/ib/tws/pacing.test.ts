// IB's per-request pacing rules: which frames they apply to, their keys (read from encoded
// frames), and the sliding windows the send queue checks at write time.

import { describe, expect, it } from 'vitest';
import * as encoder from './encoder.ts';
import { PaceWindows, pacesOf, type Pace } from './pacing.ts';
import type { Contract } from './types.ts';

const SV = 193;
const aapl: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' };

/** Pacing rules of a reqHistoricalData frame. */
function hist(over: { reqId?: number; contract?: Contract; end?: string; duration?: string; bar?: string; what?: string; rth?: number; format?: number; live?: boolean } = {}): readonly Pace[] {
  const tokens = encoder.reqHistoricalData(
    SV,
    over.reqId ?? 1,
    over.contract ?? aapl,
    over.end ?? '',
    over.duration ?? '2 D',
    over.bar ?? '1 hour',
    over.what ?? 'TRADES',
    over.rth ?? 1,
    over.format ?? 2,
    over.live ?? false,
  );
  return pacesOf(tokens)!;
}

const keys = (paces: readonly Pace[]): string[] => paces.map((p) => p.key);

describe('pacesOf', () => {
  it('symbol search: one per second', () => {
    expect(pacesOf(encoder.reqMatchingSymbols(SV, 7, 'AA'))).toEqual([{ key: 'symbols', max: 1, windowMs: 1000, weight: 1 }]);
  });

  it('historical data: identical within 15 s, 5 per contract / exchange / tick type in 2 s, 60 in 10 min', () => {
    expect(hist().map(({ max, windowMs, weight }) => [max, windowMs, weight])).toEqual([
      [1, 15_000, 1],
      [5, 2000, 1],
      [60, 600_000, 1],
    ]);
    expect(hist()[2].key).toBe('hist');
  });

  it('identical requests: the request id, date format and keepUpToDate do not matter, the query does', () => {
    const base = hist()[0].key;
    expect(hist({ reqId: 99, format: 1, live: true })[0].key).toBe(base);
    for (const over of [{ end: '20261002 16:00:00 US/Eastern' }, { duration: '5 D' }, { bar: '1 day' }, { what: 'MIDPOINT' }, { rth: 0 }, { contract: { ...aapl, conId: 1 } }])
      expect(hist(over)[0].key).not.toBe(base);
  });

  it('same contract, exchange and tick type: any query of it counts', () => {
    const base = hist()[1].key;
    expect(hist({ reqId: 2, duration: '10 Y', bar: '1 week', rth: 0 })[1].key).toBe(base);
    expect(hist({ contract: { ...aapl, exchange: 'ISLAND' } })[1].key).not.toBe(base);
    expect(hist({ what: 'BID' })[1].key).not.toBe(base);
    expect(hist({ contract: { ...aapl, conId: 272093, symbol: 'MSFT' } })[1].key).not.toBe(base);
  });

  it('BID_ASK counts twice towards the per-contract and the 10-minute rules', () => {
    expect(hist({ what: 'BID_ASK' }).map((p) => p.weight)).toEqual([1, 2, 2]);
  });

  it('no rules for other messages', () => {
    expect(pacesOf(encoder.reqMktData(SV, 1, aapl, '', false, false))).toBeUndefined();
    expect(pacesOf(encoder.cancelHistoricalData(SV, 1))).toBeUndefined();
    expect(pacesOf(encoder.reqContractDetails(SV, 1, aapl))).toBeUndefined();
    expect(keys(hist())).toHaveLength(3);
  });
});

describe('PaceWindows', () => {
  const rule = (max: number, windowMs: number, weight = 1): Pace => ({ key: 'k', max, windowMs, weight });

  it('allows up to `max` writes per window, then waits until the oldest leaves it', () => {
    const w = new PaceWindows();
    const r = [rule(2, 1000)];
    expect(w.waitMs(r, 0)).toBe(0);
    w.record(r, 0);
    w.record(r, 300);
    expect(w.waitMs(r, 400)).toBe(600);
    expect(w.waitMs(r, 1000)).toBe(0);
  });

  it('waits for the strictest of several rules', () => {
    const w = new PaceWindows();
    const r: Pace[] = [rule(5, 2000), { key: 'other', max: 1, windowMs: 15_000, weight: 1 }];
    w.record(r, 0);
    expect(w.waitMs(r, 100)).toBe(14_900);
    expect(w.waitMs([rule(5, 2000)], 100)).toBe(0);
  });

  it('a frame of weight 2 needs two free places', () => {
    const w = new PaceWindows();
    const r = [rule(3, 1000, 2)];
    w.record(r, 0);
    expect(w.waitMs(r, 10)).toBe(990);
    expect(w.waitMs([rule(3, 1000)], 10)).toBe(0);
  });

  it('forgets windows without writes inside them', () => {
    const w = new PaceWindows();
    for (let i = 0; i < 100; i++) w.record([{ key: `id${i}`, max: 1, windowMs: 15_000, weight: 1 }], i * 1000);
    expect(w.size).toBeLessThanOrEqual(16);
  });
});
