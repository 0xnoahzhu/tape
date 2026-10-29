import { describe, expect, it } from 'vitest';
import { index, option, stock } from './contract';
import { createClock } from './timeFormat';
import type { Quote } from './types';
import { dailyBarsCurrent, etTime, headerSession, liveChangeRef, sessionQuote, usesUsEquitySession } from './sessionQuote';

const q = (fields: Partial<Quote>): Quote => ({ key: 'STK:AAPL', updatedAt: 0, ...fields });

describe('sessionQuote', () => {
  const full = q({ last: 228.1, close: 224.52, lastRthTrade: 227.48, bid: 228, ask: 228.2 });

  it('regular: last vs previous close', () => {
    expect(sessionQuote(full, 'regular')).toEqual({ price: 228.1, ref: 224.52, refs: [{ kind: 'prev', value: 224.52 }] });
  });

  it('pre-market: last vs previous close', () => {
    expect(sessionQuote(full, 'pre')).toEqual({ price: 228.1, ref: 224.52, refs: [{ kind: 'prev', value: 224.52 }] });
  });

  it("after hours: extended last vs today's close, with the close and previous close as refs", () => {
    expect(sessionQuote(full, 'post')).toEqual({
      price: 228.1,
      ref: 227.48,
      refs: [
        { kind: 'close', value: 227.48, base: 224.52 },
        { kind: 'prev', value: 224.52 },
      ],
    });
  });

  it("overnight: the overnight last vs today's close, the close as a ref", () => {
    expect(sessionQuote(full, 'overnight')).toEqual({
      price: 228.1,
      ref: 227.48,
      refs: [
        { kind: 'close', value: 227.48, base: 224.52 },
        { kind: 'prev', value: 224.52 },
      ],
    });
    // From 20:00 IB's close is today's (live AAPL at 01:00: last 346.38, close and tick 57 343.83).
    expect(sessionQuote(q({ last: 346.38, close: 343.829987, lastRthTrade: 343.83 }), 'overnight')).toEqual({ price: 346.38, ref: 343.83, refs: [{ kind: 'close', value: 343.83 }] });
    expect(sessionQuote(q({ last: 10, close: 9 }), 'overnight')).toEqual({ price: 10, ref: 9, refs: [{ kind: 'prev', value: 9 }] });
  });

  it('heads US stocks with the overnight session, other US instruments with the day sessions', () => {
    const wedNight = new Date('2026-10-28T22:30:00-04:00');
    const satNight = new Date('2026-10-31T22:30:00-04:00');
    expect(headerSession(stock('AAPL'), wedNight)).toBe('overnight');
    expect(headerSession(stock('AAPL'), satNight)).toBe('closed');
    expect(headerSession(option('AAPL', '20261120', 230, 'C'), wedNight)).toBe('closed');
    expect(headerSession(index('SPX', 'CBOE'), wedNight)).toBe('closed');
    expect(headerSession({ ...stock('SAP'), currency: 'EUR' }, wedNight)).toBe('regular');
  });

  it('after hours without tick 57 falls back to the previous close', () => {
    expect(sessionQuote(q({ last: 10, close: 9 }), 'post')).toEqual({ price: 10, ref: 9, refs: [{ kind: 'prev', value: 9 }] });
  });

  it("closed: today's close vs previous close, plus the after-hours last when it differs", () => {
    expect(sessionQuote(full, 'closed')).toEqual({
      price: 227.48,
      ref: 224.52,
      refs: [
        { kind: 'ext', value: 228.1, base: 227.48 },
        { kind: 'prev', value: 224.52 },
      ],
    });
    expect(sessionQuote(q({ last: 227.48, lastRthTrade: 227.48, close: 224.52 }), 'closed').refs).toEqual([{ kind: 'prev', value: 224.52 }]);
    expect(sessionQuote(q({ last: 5, close: 4 }), 'closed')).toEqual({ price: 5, ref: 4, refs: [{ kind: 'prev', value: 4 }] });
  });

  describe('without tick 57 (delayed data), the daily close stands in for the regular close', () => {
    // Real AAPL delayed-frozen quote on Sunday 2026-10-04: last is a 19:59 ET after-hours trade.
    const delayed = q({ last: 333.6, close: 330.32, marketDataType: 4 });

    it('closed: regular close vs previous close, after-hours last vs the close', () => {
      expect(sessionQuote(delayed, 'closed', 333.69)).toEqual({
        price: 333.69,
        ref: 330.32,
        refs: [
          { kind: 'ext', value: 333.6, base: 333.69 },
          { kind: 'prev', value: 330.32 },
        ],
      });
    });

    it('post: extended last vs the close, with the close as a ref', () => {
      expect(sessionQuote(delayed, 'post', 333.69)).toEqual({
        price: 333.6,
        ref: 333.69,
        refs: [
          { kind: 'close', value: 333.69, base: 330.32 },
          { kind: 'prev', value: 330.32 },
        ],
      });
    });

    it('tick 57 wins over the daily close; the daily close is ignored in regular hours', () => {
      expect(sessionQuote(full, 'closed', 1).price).toBe(227.48);
      expect(sessionQuote(delayed, 'regular', 333.69)).toEqual({ price: 333.6, ref: 330.32, refs: [{ kind: 'prev', value: 330.32 }] });
      expect(sessionQuote(delayed, 'closed', Number.NaN).price).toBe(333.6);
    });
  });

  it('uses the midpoint without trades and never shows the previous close as the price', () => {
    expect(sessionQuote(q({ bid: 9.9, ask: 10.1, close: 9 }), 'regular').price).toBeCloseTo(10);
    expect(sessionQuote(q({ close: 9 }), 'regular').price).toBeUndefined();
    expect(sessionQuote(q({ error: { code: 10197, message: 'No market data during competing live session' } }), 'regular')).toEqual({ refs: [] });
    expect(sessionQuote(undefined, 'regular')).toEqual({ refs: [] });
  });

  it('ignores IB placeholder values (-1, 0)', () => {
    expect(sessionQuote(q({ last: -1, close: 0 }), 'regular')).toEqual({ price: undefined, ref: undefined, refs: [] });
  });
});

describe('liveChangeRef', () => {
  const full = q({ last: 228.1, close: 224.52, lastRthTrade: 227.48 });

  it('is the previous close before and during the regular session', () => {
    expect(liveChangeRef(full, 'pre')).toEqual({ ref: 224.52, afterHours: false });
    expect(liveChangeRef(full, 'regular')).toEqual({ ref: 224.52, afterHours: false });
  });

  it("is today's close after the close and overnight, as the header's after-hours change", () => {
    expect(liveChangeRef(full, 'post')).toEqual({ ref: 227.48, afterHours: true });
    expect(liveChangeRef(full, 'overnight')).toEqual({ ref: 227.48, afterHours: true });
    expect(liveChangeRef(full, 'post')!.ref).toBe(sessionQuote(full, 'post').ref);
    expect(liveChangeRef(q({ last: 10, close: 9 }), 'post', 9.5)).toEqual({ ref: 9.5, afterHours: true });
  });

  it("falls back to the previous close without today's close, and to nothing without either", () => {
    expect(liveChangeRef(q({ last: 10, close: 9, marketDataType: 3 }), 'post')).toEqual({ ref: 9, afterHours: false });
    expect(liveChangeRef(q({ last: 10 }), 'regular')).toBeUndefined();
    expect(liveChangeRef(q({ last: 10, close: 0 }), 'regular')).toBeUndefined();
  });
});

describe('dailyBarsCurrent', () => {
  // 2026-10-02 is a Friday: ET = UTC − 4.
  const et = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, day, h + 4, m));

  it('accepts bars loaded in the same part of the same New York day', () => {
    expect(dailyBarsCurrent(et(2, 16, 5).getTime(), et(2, 19, 30))).toBe(true);
    expect(dailyBarsCurrent(et(2, 20, 30).getTime(), et(2, 23, 0))).toBe(true);
  });

  it('rejects bars loaded before a close: during the session, the previous phase or day', () => {
    expect(dailyBarsCurrent(et(2, 15, 58).getTime(), et(2, 16, 1))).toBe(false);
    expect(dailyBarsCurrent(et(2, 18, 0).getTime(), et(2, 20, 30))).toBe(false);
    // Overnight (before 04:00) and evening are both "closed" but a session lies between them.
    expect(dailyBarsCurrent(et(2, 2, 0).getTime(), et(2, 21, 0))).toBe(false);
    expect(dailyBarsCurrent(et(3, 12, 0).getTime(), et(4, 12, 0))).toBe(false);
  });
});

describe('usesUsEquitySession', () => {
  it('applies to US stocks, options and indices only', () => {
    expect(usesUsEquitySession(stock('AAPL'))).toBe(true);
    expect(usesUsEquitySession(option('AAPL', '20261016', 230, 'C'))).toBe(true);
    expect(usesUsEquitySession(index('SPX', 'CBOE'))).toBe(true);
    expect(usesUsEquitySession({ symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' })).toBe(false);
    expect(usesUsEquitySession({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD' })).toBe(false);
  });
});

describe('etTime', () => {
  const now = new Date(Date.UTC(2026, 9, 2, 21, 0)); // 17:00 ET
  it('shows the time for today and the date otherwise', () => {
    expect(etTime(Date.UTC(2026, 9, 2, 20, 0, 5), now)).toBe('16:00:05');
    expect(etTime(Date.UTC(2026, 9, 1, 20, 0, 5), now)).toBe('10/01 16:00');
  });

  it('follows the clock format and language', () => {
    expect(etTime(Date.UTC(2026, 9, 2, 20, 0, 5), now, createClock('12h', 'en'))).toBe('04:00:05 PM');
    expect(etTime(Date.UTC(2026, 9, 2, 20, 0, 5), now, createClock('12h', 'zh'))).toBe('下午 04:00:05');
    expect(etTime(Date.UTC(2026, 9, 2, 16, 0, 0), now, createClock('12h', 'en'))).toBe('12:00:00 PM');
    expect(etTime(Date.UTC(2026, 9, 1, 20, 0, 5), now, createClock('12h', 'en'))).toBe('10/01 04:00 PM');
    expect(etTime(Date.UTC(2026, 9, 1, 4, 30), now, createClock('12h', 'zh'))).toBe('10/01 上午 12:30');
    expect(etTime(Date.UTC(2026, 9, 2, 20, 0, 5), now, createClock('24h', 'zh'))).toBe('16:00:05');
  });

  it('compares New York days, not UTC ones', () => {
    // 21:30 ET on 10/02 is already 10/03 in UTC; "now" is 22:00 ET the same New York day.
    const late = new Date(Date.UTC(2026, 9, 3, 2, 0));
    expect(etTime(Date.UTC(2026, 9, 3, 1, 30), late, createClock('12h', 'en'))).toBe('09:30:00 PM');
  });
});
