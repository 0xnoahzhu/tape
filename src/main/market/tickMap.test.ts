import { beforeEach, describe, expect, it } from 'vitest';
import type { Quote } from '@shared/types';
import { applyTick, lastOrMid, midPrice, parseDividends, TICK, type TickContext } from './tickMap';

/** One stock line per test (applyTick keeps per-line state in its context). */
let stock: TickContext;
beforeEach(() => {
  stock = { isOption: false };
});
const opt = { isOption: true };
const q0 = (): Quote => ({ key: 'STK:AAPL', updatedAt: 0 });

describe('applyTick prices', () => {
  it('maps live and delayed price ticks', () => {
    const q = q0();
    const cases: Array<[number, keyof Quote]> = [
      [TICK.BID, 'bid'],
      [TICK.ASK, 'ask'],
      [TICK.LAST, 'last'],
      [TICK.HIGH, 'high'],
      [TICK.LOW, 'low'],
      [TICK.CLOSE, 'close'],
      [TICK.OPEN, 'open'],
      [TICK.MARK_PRICE, 'mark'],
      [TICK.LAST_RTH_TRADE, 'lastRthTrade'],
      [TICK.LOW_52_WEEK, 'week52Low'],
      [TICK.HIGH_52_WEEK, 'week52High'],
    ];
    cases.forEach(([field, key], i) => {
      expect(applyTick(q, { kind: 'price', field, value: 100 + i }, stock)).toBe(true);
      expect(q[key]).toBe(100 + i);
    });
    const delayed: Array<[number, keyof Quote]> = [
      [TICK.DELAYED_BID, 'bid'],
      [TICK.DELAYED_ASK, 'ask'],
      [TICK.DELAYED_LAST, 'last'],
      [TICK.DELAYED_HIGH, 'high'],
      [TICK.DELAYED_LOW, 'low'],
      [TICK.DELAYED_CLOSE, 'close'],
      [TICK.DELAYED_OPEN, 'open'],
    ];
    delayed.forEach(([field, key]) => {
      applyTick(q, { kind: 'price', field, value: 42.5 }, stock);
      expect(q[key]).toBe(42.5);
    });
  });

  it('ignores 13 and 26 week extremes', () => {
    const q = q0();
    for (const field of [15, 16, 17, 18]) expect(applyTick(q, { kind: 'price', field, value: 5 }, stock)).toBe(false);
    expect(q).toEqual(q0());
  });

  it('clears a side on -1 and treats 0 as no data except option bid/ask', () => {
    const q = q0();
    applyTick(q, { kind: 'price', field: TICK.BID, value: 10 }, stock);
    expect(applyTick(q, { kind: 'price', field: TICK.BID, value: -1 }, stock)).toBe(true);
    expect(q.bid).toBeUndefined();
    expect('bid' in q).toBe(true); // kept so the renderer's merge clears it as well
    applyTick(q, { kind: 'price', field: TICK.LAST, value: 0 }, stock);
    expect(q.last).toBeUndefined();
    const o = q0();
    applyTick(o, { kind: 'price', field: TICK.BID, value: 0 }, opt);
    expect(o.bid).toBe(0);
    applyTick(o, { kind: 'price', field: TICK.LAST, value: 0 }, opt);
    expect(o.last).toBeUndefined();
  });

  it('keeps zero and negative combo prices but not the -1 marker', () => {
    const q = q0();
    applyTick(q, { kind: 'price', field: TICK.BID, value: -0.35 }, { isOption: false, isCombo: true });
    expect(q.bid).toBe(-0.35);
    applyTick(q, { kind: 'price', field: TICK.ASK, value: 0 }, { isOption: false, isCombo: true });
    expect(q.ask).toBe(0);
  });

  it('keeps the close a line sent when IB marks it not available, and takes a new one', () => {
    const q = q0();
    applyTick(q, { kind: 'price', field: TICK.CLOSE, value: 233.95 }, stock);
    for (const value of [-1, 0, Number.MAX_VALUE, undefined]) {
      expect(applyTick(q, { kind: 'price', field: TICK.CLOSE, value }, stock)).toBe(false);
      expect(applyTick(q, { kind: 'price', field: TICK.DELAYED_CLOSE, value }, stock)).toBe(false);
      expect(q.close).toBe(233.95);
    }
    // A new session's close replaces it.
    expect(applyTick(q, { kind: 'price', field: TICK.CLOSE, value: 236.59 }, stock)).toBe(true);
    expect(q.close).toBe(236.59);
    // Without a close, a "not available" one leaves the quote as it was.
    const none = q0();
    expect(applyTick(none, { kind: 'price', field: TICK.CLOSE, value: -1 }, { isOption: false })).toBe(false);
    expect(none).toEqual(q0());
  });

  it('does not keep an older line\'s close that the new line marks not available', () => {
    const q = q0();
    applyTick(q, { kind: 'price', field: TICK.CLOSE, value: 233.95 }, stock);
    // A new line (a reconnect, maybe the next session) that marks its close not available clears it ...
    const next: TickContext = { isOption: false };
    applyTick(q, { kind: 'price', field: TICK.LAST, value: 236.59 }, next);
    expect(q.close).toBe(233.95);
    expect(applyTick(q, { kind: 'price', field: TICK.CLOSE, value: -1 }, next)).toBe(true);
    expect(q.close).toBeUndefined();
    // ... and once it sends one, keeps it.
    applyTick(q, { kind: 'price', field: TICK.CLOSE, value: 236.1 }, next);
    expect(applyTick(q, { kind: 'price', field: TICK.CLOSE, value: 0 }, next)).toBe(false);
    expect(q.close).toBe(236.1);
  });

  it('keeps a combo close of zero or below but not the -1 marker', () => {
    const combo = { isOption: false, isCombo: true };
    const q = q0();
    applyTick(q, { kind: 'price', field: TICK.CLOSE, value: -0.35 }, combo);
    expect(q.close).toBe(-0.35);
    expect(applyTick(q, { kind: 'price', field: TICK.CLOSE, value: -1 }, combo)).toBe(false);
    expect(q.close).toBe(-0.35);
    applyTick(q, { kind: 'price', field: TICK.CLOSE, value: 0 }, combo);
    expect(q.close).toBe(0);
  });

  it('takes a line\'s delayed close although the quote still reports the previous line\'s live data', () => {
    // Yesterday's live line set the close; after a reconnect the new line is delayed, and IB sends
    // its first ticks, the close included, before its marketDataType (seen in API logs).
    const q: Quote = { ...q0(), marketDataType: 1, close: 7600 };
    expect(applyTick(q, { kind: 'price', field: TICK.DELAYED_CLOSE, value: 7722 }, stock)).toBe(true);
    expect(q.close).toBe(7722);
    // Live and delayed lines send the same previous close; the latest is taken either way.
    expect(applyTick(q, { kind: 'price', field: TICK.CLOSE, value: 7722.5 }, stock)).toBe(true);
    expect(q.close).toBe(7722.5);
  });

  it('reports no change for repeated values and unknown fields', () => {
    const q = q0();
    expect(applyTick(q, { kind: 'price', field: TICK.LAST, value: 5 }, stock)).toBe(true);
    expect(applyTick(q, { kind: 'price', field: TICK.LAST, value: 5 }, stock)).toBe(false);
    expect(applyTick(q, { kind: 'price', field: 999, value: 5 }, stock)).toBe(false);
    expect(applyTick(q0(), { kind: 'price', field: TICK.LAST, value: Number.MAX_VALUE }, stock)).toBe(false);
  });
});

describe('applyTick sizes', () => {
  it('maps sizes, volume and average volume (live and delayed)', () => {
    const q = q0();
    applyTick(q, { kind: 'size', field: TICK.BID_SIZE, value: 300 }, stock);
    applyTick(q, { kind: 'size', field: TICK.ASK_SIZE, value: 200 }, stock);
    applyTick(q, { kind: 'size', field: TICK.LAST_SIZE, value: 100 }, stock);
    applyTick(q, { kind: 'size', field: TICK.VOLUME, value: 1_234_567 }, stock);
    applyTick(q, { kind: 'size', field: TICK.AVG_VOLUME, value: 9_000_000 }, stock);
    expect(q).toMatchObject({ bidSize: 300, askSize: 200, lastSize: 100, volume: 1_234_567, avgVolume: 9_000_000 });
    applyTick(q, { kind: 'size', field: TICK.DELAYED_BID_SIZE, value: 1 }, stock);
    applyTick(q, { kind: 'size', field: TICK.DELAYED_ASK_SIZE, value: 2 }, stock);
    applyTick(q, { kind: 'size', field: TICK.DELAYED_LAST_SIZE, value: 3 }, stock);
    applyTick(q, { kind: 'size', field: TICK.DELAYED_VOLUME, value: 4 }, stock);
    expect(q).toMatchObject({ bidSize: 1, askSize: 2, lastSize: 3, volume: 4 });
  });

  it('routes option open interest and volume by contract type', () => {
    const und = q0();
    applyTick(und, { kind: 'size', field: TICK.OPTION_CALL_OPEN_INTEREST, value: 1000 }, stock);
    applyTick(und, { kind: 'size', field: TICK.OPTION_PUT_OPEN_INTEREST, value: 800 }, stock);
    applyTick(und, { kind: 'size', field: TICK.OPTION_CALL_VOLUME, value: 50 }, stock);
    applyTick(und, { kind: 'size', field: TICK.OPTION_PUT_VOLUME, value: 40 }, stock);
    expect(und).toMatchObject({ callOpenInterest: 1000, putOpenInterest: 800, callVolume: 50, putVolume: 40 });
    expect(und.openInterest).toBeUndefined();

    const o = q0();
    applyTick(o, { kind: 'size', field: TICK.OPTION_PUT_OPEN_INTEREST, value: 321 }, opt);
    expect(o.openInterest).toBe(321);
    expect(o.putOpenInterest).toBeUndefined();
    // Option volume ticks only fill volume when tick 8 has not.
    applyTick(o, { kind: 'size', field: TICK.OPTION_CALL_VOLUME, value: 12 }, opt);
    expect(o.volume).toBe(12);
    applyTick(o, { kind: 'size', field: TICK.VOLUME, value: 15 }, opt);
    applyTick(o, { kind: 'size', field: TICK.OPTION_CALL_VOLUME, value: 13 }, opt);
    expect(o.volume).toBe(15);
  });
});

describe('applyTick generic and string', () => {
  it('maps volatility and halted', () => {
    const q = q0();
    applyTick(q, { kind: 'generic', field: TICK.OPTION_HISTORICAL_VOL, value: 0.21 }, stock);
    applyTick(q, { kind: 'generic', field: TICK.OPTION_IMPLIED_VOL, value: 0.27 }, stock);
    expect(q).toMatchObject({ histVol: 0.21, impliedVol: 0.27 });
    applyTick(q, { kind: 'generic', field: TICK.HALTED, value: 1 }, stock);
    expect(q).toMatchObject({ halted: true, haltCode: 1 });
    applyTick(q, { kind: 'generic', field: TICK.HALTED, value: 0 }, stock);
    expect(q).toMatchObject({ halted: false, haltCode: 0 });
    expect(applyTick(q, { kind: 'generic', field: TICK.HALTED, value: -1 }, stock)).toBe(false);
  });

  it("keeps IB's halted code apart from the halted flag", () => {
    const q = q0();
    // A volatility halt (2) after a general halt (1): the flag stays, the code changes.
    applyTick(q, { kind: 'generic', field: TICK.DELAYED_HALTED, value: 1 }, stock);
    expect(applyTick(q, { kind: 'generic', field: TICK.DELAYED_HALTED, value: 2 }, stock)).toBe(true);
    expect(q).toMatchObject({ halted: true, haltCode: 2 });
  });

  it('parses last timestamps (seconds) and RTVolume', () => {
    const q = q0();
    applyTick(q, { kind: 'string', field: TICK.LAST_TIMESTAMP, value: '1759500000' }, stock);
    expect(q.lastTime).toBe(1_759_500_000_000);
    applyTick(q, { kind: 'string', field: TICK.DELAYED_LAST_TIMESTAMP, value: '1759500060' }, stock);
    expect(q.lastTime).toBe(1_759_500_060_000);
    applyTick(q, { kind: 'string', field: TICK.RT_VOLUME, value: '227.48;300;1759500123456;48123456;227.1;false' }, stock);
    expect(q).toMatchObject({ last: 227.48, lastSize: 300, lastTime: 1_759_500_123_456, volume: 48_123_456 });
    // Unreported trade: no price, volume still updates.
    applyTick(q, { kind: 'string', field: TICK.RT_VOLUME, value: ';0;1759500123999;48123999;227.1;false' }, stock);
    expect(q).toMatchObject({ last: 227.48, volume: 48_123_999 });
  });

  it('parses IB dividends (tick 59) as seen on the paper account', () => {
    expect(parseDividends('3.64,3.92,20261119,0.98')).toEqual({ past12m: 3.64, next12m: 3.92, nextDate: '20261119', nextAmount: 0.98 });
    expect(parseDividends('0.52,1.00,20261203,0.25')).toEqual({ past12m: 0.52, next12m: 1, nextDate: '20261203', nextAmount: 0.25 });
    // TSLA: no dividend at all.
    expect(parseDividends(',,,')).toEqual({});
    expect(parseDividends('1.2,1.3,,')).toEqual({ past12m: 1.2, next12m: 1.3 });
    expect(parseDividends('')).toBeUndefined();
    expect(parseDividends('garbage')).toBeUndefined();
    expect(parseDividends('x,y,2026-11-19,z')).toEqual({});
  });

  it('keeps the dividends object until a value changes', () => {
    const q = q0();
    expect(applyTick(q, { kind: 'string', field: TICK.IB_DIVIDENDS, value: '3.64,3.92,20261119,0.98' }, stock)).toBe(true);
    const first = q.dividends;
    expect(applyTick(q, { kind: 'string', field: TICK.IB_DIVIDENDS, value: '3.64,3.92,20261119,0.98' }, stock)).toBe(false);
    expect(q.dividends).toBe(first);
    expect(applyTick(q, { kind: 'string', field: TICK.IB_DIVIDENDS, value: '3.64,3.92,20270219,0.98' }, stock)).toBe(true);
    expect(q.dividends?.nextDate).toBe('20270219');
    expect(applyTick(q, { kind: 'string', field: TICK.IB_DIVIDENDS, value: 'bad' }, stock)).toBe(false);
    expect(applyTick(q, { kind: 'string', field: TICK.IB_DIVIDENDS, value: ',,,' }, stock)).toBe(true);
    expect(q.dividends).toEqual({});
  });
});

describe('applyTick option computation', () => {
  it('takes model greeks and ignores IB sentinels', () => {
    const q = q0();
    expect(
      applyTick(q, { kind: 'option', field: TICK.MODEL_OPTION, iv: 0.26, delta: 0.52, gamma: 0.031, vega: 0.21, theta: -0.08, undPrice: 227.4 }, opt),
    ).toBe(true);
    expect(q).toMatchObject({ iv: 0.26, delta: 0.52, gamma: 0.031, vega: 0.21, theta: -0.08, undPrice: 227.4 });
    applyTick(q, { kind: 'option', field: TICK.DELAYED_MODEL_OPTION, iv: -1, delta: -2, gamma: -2, vega: -2, theta: -2, undPrice: -1 }, opt);
    expect(q).toMatchObject({ iv: 0.26, delta: 0.52, gamma: 0.031, vega: 0.21, theta: -0.08, undPrice: 227.4 });
    applyTick(q, { kind: 'option', field: TICK.DELAYED_MODEL_OPTION, iv: 1.7976931348623157e308, delta: undefined }, opt);
    expect(q.iv).toBe(0.26);
  });

  it("keeps the model price and the dividends' present value", () => {
    const q = q0();
    applyTick(q, { kind: 'option', field: TICK.MODEL_OPTION, iv: 0.26, delta: 0.52, optPrice: 3.18, pvDividend: 0.42, undPrice: 227.4 }, opt);
    expect(q).toMatchObject({ optPrice: 3.18, pvDividend: 0.42 });
    // -1 is IB's "not computed"; 0 is a real present value (no dividends before expiry).
    applyTick(q, { kind: 'option', field: TICK.DELAYED_MODEL_OPTION, optPrice: -1, pvDividend: 0 }, opt);
    expect(q).toMatchObject({ optPrice: 3.18, pvDividend: 0 });
  });

  it('ignores bid/ask/last computations', () => {
    const q = q0();
    expect(applyTick(q, { kind: 'option', field: 10, iv: 0.3, delta: 0.5 }, opt)).toBe(false);
  });
});

describe('price helpers', () => {
  it('mid and last-or-mid', () => {
    expect(midPrice({ bid: 1, ask: 1.2 })).toBeCloseTo(1.1);
    expect(midPrice({ bid: 0, ask: 1.2 })).toBeUndefined();
    expect(lastOrMid({ last: 5, bid: 1, ask: 2 })).toBe(5);
    expect(lastOrMid({ bid: 1, ask: 2 })).toBe(1.5);
    expect(lastOrMid({})).toBeUndefined();
  });
});

describe('option open interest', () => {
  it('takes tick 27 for calls and 28 for puts, ignoring the other right', () => {
    const call: Quote = { key: 'c', updatedAt: 0 };
    applyTick(call, { kind: 'size', field: 27, value: 1200 }, { isOption: true, right: 'C' });
    applyTick(call, { kind: 'size', field: 28, value: 0 }, { isOption: true, right: 'C' });
    expect(call.openInterest).toBe(1200);
    const put: Quote = { key: 'p', updatedAt: 0 };
    applyTick(put, { kind: 'size', field: 28, value: 510 }, { isOption: true, right: 'P' });
    applyTick(put, { kind: 'size', field: 27, value: 0 }, { isOption: true, right: 'P' });
    expect(put.openInterest).toBe(510);
  });
});
