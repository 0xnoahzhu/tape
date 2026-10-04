import { describe, expect, it } from 'vitest';
import { option } from '@shared/contract';
import type { Quote } from '@shared/types';
import { unusualActivity, type FlowInput } from './flow';

const item = (strike: number, q: Partial<Quote>): FlowInput => ({
  contract: option('AAPL', '20261009', strike, 'P'),
  right: 'P',
  strike,
  expiry: '20261009',
  multiplier: 100,
  quote: { key: String(strike), updatedAt: 0, ...q },
});

describe('unusualActivity', () => {
  it('ranks by volume / open interest', () => {
    const rows = unusualActivity([item(330, { volume: 600, openInterest: 1000, last: 1 }), item(332.5, { volume: 900, openInterest: 300, last: 1 })]);
    expect(rows.map((r) => [r.strike, r.voi, r.tags])).toEqual([
      [332.5, 3, ['voi']],
      [330, 0.6, ['elevated']],
    ]);
  });

  it('does not treat open interest that has not arrived as zero', () => {
    const rows = unusualActivity([item(330, { volume: 600, openInterest: 1000, last: 1 }), item(332.5, { volume: 17_000, last: 0.5 }), item(335, { volume: 80, openInterest: 0, last: 1 })]);
    expect(rows.map((r) => [r.strike, r.voi])).toEqual([
      [335, Infinity],
      [330, 0.6],
    ]);
  });

  it('still flags a large premium while open interest is unknown', () => {
    const rows = unusualActivity([item(330, { volume: 600, openInterest: 1000, last: 1 }), item(332.5, { volume: 5_000, last: 3 })]);
    expect(rows.map((r) => [r.strike, r.voi, r.tags])).toEqual([
      [330, 0.6, ['elevated']],
      [332.5, undefined, ['large']],
    ]);
  });
});
