import { describe, expect, it } from 'vitest';
import { buildLadder } from './depthModel';

const lv = (price: number, size: number) => ({ price, size });

describe('buildLadder', () => {
  it('returns nothing without a book', () => {
    expect(buildLadder(null)).toEqual({ rows: [], levels: 0 });
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
    expect(l.bestAsk).toBe(10.01);
    expect(l.bestBid).toBe(10);
    expect(l.spread).toBe(0.01);
    expect(l.levels).toBe(2);
  });

  it('scales size bars to the largest size', () => {
    const l = buildLadder({ asks: [lv(10.01, 200)], bids: [lv(10, 400)] });
    expect(l.rows.map((r) => r.width)).toEqual([0.5, 1]);
  });

  it('keeps the 10 levels nearest the touch and skips invalid levels', () => {
    const asks = Array.from({ length: 15 }, (_, i) => lv(10.01 + i * 0.01, 100));
    const bids = [...Array.from({ length: 12 }, (_, i) => lv(10 - i * 0.01, 100)), lv(0, 100), lv(Number.NaN, 1)];
    const l = buildLadder({ asks, bids });
    expect(l.rows).toHaveLength(20);
    expect(l.rows[0].price).toBeCloseTo(10.1);
    expect(l.rows[9].price).toBeCloseTo(10.01);
    expect(l.rows[19].price).toBeCloseTo(9.91);
    expect(l.levels).toBe(10);
  });

  it('works with one side only', () => {
    const l = buildLadder({ asks: [], bids: [lv(10, 0)] });
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].width).toBe(0);
    expect(l.spread).toBeUndefined();
  });
});
