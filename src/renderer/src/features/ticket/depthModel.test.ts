import { describe, expect, it } from 'vitest';
import { BOOK_LEVELS, buildLadder, levelPatch, levelTarget } from './depthModel';

const lv = (price: number, size: number) => ({ price, size });

describe('buildLadder', () => {
  it('returns nothing without a book', () => {
    expect(buildLadder(null)).toEqual({ rows: [] });
  });

  it('orders asks highest first, then bids best first, and marks the best bid', () => {
    const l = buildLadder({ asks: [lv(10.02, 300), lv(10.01, 100)], bids: [lv(9.99, 50), lv(10, 600)] });
    expect(l.rows.map((r) => [r.side, r.price])).toEqual([
      ['ask', 10.02],
      ['ask', 10.01],
      ['bid', 10],
      ['bid', 9.99],
    ]);
    expect(l.rows.map((r) => r.best)).toEqual([false, false, true, false]);
  });

  it('scales size bars to the largest size', () => {
    const l = buildLadder({ asks: [lv(10.01, 200)], bids: [lv(10, 400)] });
    expect(l.rows.map((r) => r.width)).toEqual([0.5, 1]);
  });

  it('keeps the 5 levels a side nearest the touch and skips invalid levels', () => {
    expect(BOOK_LEVELS).toBe(5);
    const asks = Array.from({ length: 15 }, (_, i) => lv(10.01 + i * 0.01, 100));
    const bids = [...Array.from({ length: 12 }, (_, i) => lv(10 - i * 0.01, 100)), lv(0, 100), lv(Number.NaN, 1)];
    const l = buildLadder({ asks, bids });
    expect(l.rows).toHaveLength(10);
    expect(l.rows[0].price).toBeCloseTo(10.05);
    expect(l.rows[4].price).toBeCloseTo(10.01);
    expect(l.rows[9].price).toBeCloseTo(9.96);
  });

  it('shows more levels when asked', () => {
    const asks = Array.from({ length: 15 }, (_, i) => lv(10.01 + i * 0.01, 100));
    const bids = Array.from({ length: 12 }, (_, i) => lv(10 - i * 0.01, 100));
    const l = buildLadder({ asks, bids }, 10);
    expect(l.rows).toHaveLength(20);
    expect(l.rows[0].price).toBeCloseTo(10.1);
    expect(l.rows[19].price).toBeCloseTo(9.91);
  });

  it('works with one side only', () => {
    const l = buildLadder({ asks: [], bids: [lv(10, 0)] });
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].width).toBe(0);
  });
});

describe('a click on a level', () => {
  const fresh = { type: 'STP' as const, mainKey: 'stopPrice' as const, modifying: false };

  it('loads a limit order at its price: buy at an ask, sell at a bid', () => {
    expect(levelPatch({ side: 'ask', price: 10.02 }, fresh)).toEqual({ orderType: 'LMT', limitPrice: 10.02, side: 'BUY', stopPrice: null, limitOffset: null });
    expect(levelPatch({ side: 'bid', price: 9.99 }, { type: 'MKT', mainKey: null, modifying: false })).toMatchObject({ orderType: 'LMT', limitPrice: 9.99, side: 'SELL' });
  });

  it('moves only the price of an order being modified (its side and type stay)', () => {
    const level = { side: 'ask' as const, price: 10.02 };
    expect(levelPatch(level, { type: 'LMT', mainKey: 'limitPrice', modifying: true })).toEqual({ limitPrice: 10.02 });
    expect(levelPatch(level, { type: 'STP', mainKey: 'stopPrice', modifying: true })).toEqual({ stopPrice: 10.02 });
    // A stop limit's level goes to its limit, as a quote does.
    expect(levelPatch(level, { type: 'STP LMT', mainKey: 'stopPrice', modifying: true })).toEqual({ limitPrice: 10.02 });
    expect(levelPatch(level, { type: 'MKT', mainKey: null, modifying: true })).toBeNull();
  });

  it('names what it sets (the tooltip of the Book)', () => {
    expect(levelTarget({ type: 'MKT', mainKey: null, modifying: false })).toBe('order');
    expect(levelTarget({ type: 'LMT', mainKey: 'limitPrice', modifying: true })).toBe('limitPrice');
    expect(levelTarget({ type: 'STP', mainKey: 'stopPrice', modifying: true })).toBe('stopPrice');
    expect(levelTarget({ type: 'MIT', mainKey: 'stopPrice', modifying: true })).toBe('stopPrice');
    expect(levelTarget({ type: 'STP LMT', mainKey: 'stopPrice', modifying: true })).toBe('limitPrice');
    expect(levelTarget({ type: 'MKT', mainKey: null, modifying: true })).toBeNull();
  });
});
