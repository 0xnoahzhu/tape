import { describe, expect, it } from 'vitest';
import type { OptionChainParams, Quote } from '@shared/types';
import { atmIv, buildChain, cellColor, chainTotals, expiryKind, fixed, formatCell, groupByMonth, markOf, nearestIndex, optionData, strikeWindow, termExpiries, visibleExpiries } from './chain';

const now = new Date(2026, 9, 3); // Sat 2026-10-03

const p = (exchange: string, tradingClass: string, expirations: string[], strikes: number[]): OptionChainParams => ({
  exchange,
  tradingClass,
  multiplier: 100,
  underlyingConId: 1,
  expirations,
  strikes,
});

describe('buildChain', () => {
  it('prefers SMART, drops expired dates and sorts', () => {
    const chain = buildChain(
      [p('CBOE', 'AAPL', ['20261009'], [100]), p('SMART', 'AAPL', ['20261016', '20261009', '20260918'], [230, 220, 225, 220])],
      'AAPL',
      now,
    );
    expect(chain.map((e) => e.expiry)).toEqual(['20261009', '20261016']);
    expect(chain[0].exchange).toBe('SMART');
    expect(chain[0].strikes).toEqual([220, 225, 230]);
  });

  it('merges trading classes and prefers the one named like the underlying', () => {
    const chain = buildChain([p('SMART', 'SPXW', ['20261009', '20261016'], [5000, 5005]), p('SMART', 'SPX', ['20261016'], [5000])], 'SPX', now);
    expect(chain.map((e) => [e.expiry, e.tradingClass])).toEqual([
      ['20261009', 'SPXW'],
      ['20261016', 'SPX'],
    ]);
  });

  it('falls back to the exchange with the most expirations', () => {
    const chain = buildChain([p('CBOE', 'X', ['20261009', '20261016'], [1]), p('AMEX', 'X', ['20261009'], [1])], 'X', now);
    expect(chain).toHaveLength(2);
    expect(chain[0].exchange).toBe('CBOE');
  });
});

describe('expiryKind', () => {
  it('classifies weekly, monthly, quarterly and LEAPS', () => {
    expect(expiryKind('20261009', now)).toBe('W');
    expect(expiryKind('20261016', now)).toBe('M'); // third Friday
    expect(expiryKind('20261218', now)).toBe('Q'); // third Friday of December
    expect(expiryKind('20261231', now)).toBe('Q'); // quarter-end last business day
    expect(expiryKind('20271217', now)).toBe('L');
    expect(expiryKind('20270325', now)).toBe('W');
  });

  it('treats the Thursday before a third-Friday holiday as monthly', () => {
    // Thursday 2026-11-19 precedes the third Friday (11-20).
    expect(expiryKind('20261119', now)).toBe('M');
  });
});

describe('helpers', () => {
  it('groups by month', () => {
    const g = groupByMonth([{ expiry: '20261009' }, { expiry: '20261016' }, { expiry: '20261120' }], 'en');
    expect(g.map((x) => [x.name, x.rows.length])).toEqual([
      ['Oct 2026', 2],
      ['Nov 2026', 1],
    ]);
    expect(groupByMonth([{ expiry: '20261009' }], 'zh')[0].name).toBe('2026年10月');
  });

  it('shows the first expirations plus the selected one', () => {
    const all = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    expect(visibleExpiries(all, '9')).toEqual(['1', '2', '3', '4', '5', '6', '9']);
    expect(visibleExpiries(all, '2')).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('fits the chips into the room left, keeping the selected one', () => {
    const all = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    expect(visibleExpiries(all, '2', 6, 4)).toEqual(['1', '2', '3', '4']);
    expect(visibleExpiries(all, '9', 6, 4)).toEqual(['1', '2', '3', '9']);
    expect(visibleExpiries(all, '5', 6, 4)).toEqual(['1', '2', '3', '5']);
    expect(visibleExpiries(all, '9', 6, 1)).toEqual(['9']);
    expect(visibleExpiries(all, '9', 6, 0)).toEqual([]);
    expect(visibleExpiries(all, undefined, 6, 12)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('samples one term structure point per monthly cycle', () => {
    const e = (expiry: string) => ({ expiry });
    // SPX: AM-settled Thursday next to the SPXW third Friday, plus a quarter-end date.
    const spx = ['20261009', '20261015', '20261016', '20261119', '20261120', '20261217', '20261218', '20261231', '20270114', '20270115'].map(e);
    expect(termExpiries(spx, 8, now).map((x) => x.expiry)).toEqual(['20261016', '20261120', '20261218', '20270115']);
    expect(termExpiries(spx, 2, now).map((x) => x.expiry)).toEqual(['20261016', '20261120']);
    // Fewer than four monthly cycles: every expiration.
    const short = ['20261009', '20261016', '20261023'].map(e);
    expect(termExpiries(short, 8, now)).toEqual(short);
  });

  it('finds strikes and windows', () => {
    const ks = [100, 105, 110, 115, 120];
    expect(nearestIndex(ks, 111)).toBe(2);
    expect(nearestIndex([], 1)).toBe(-1);
    expect(strikeWindow(ks, 2, 1)).toEqual({ from: 1, to: 4 });
    expect(strikeWindow(ks, 0, 8)).toEqual({ from: 0, to: 5 });
    expect(strikeWindow(ks, 2, 'all')).toEqual({ from: 0, to: 5 });
  });
});

describe('option data', () => {
  const q: Quote = { key: 'k', bid: 2, ask: 2.2, last: 2.3, close: 2, volume: 1200, openInterest: 150, iv: 0.3, delta: 0.55, gamma: 0.04, theta: -0.05, vega: 0.12, bidSize: 10, askSize: 20, updatedAt: 0 };

  it('derives mark, spread, change and model values', () => {
    expect(markOf(q)).toBeCloseTo(2.1, 9);
    const d = optionData(q, 100, 'C', 101, 0.05);
    expect(d.sprd).toBeCloseTo((0.2 / 2.1) * 100, 6);
    expect(d.chg).toBeCloseTo(15, 6);
    expect(d.intr).toBe(1);
    expect(d.tv).toBeCloseTo(1.1, 9);
    expect(d.itm).toBeGreaterThan(0.5);
    expect(d.touch).toBe(Math.min(1, 2 * d.itm!));
    expect(d.delta).toBe(0.55); // IB's model greek wins
  });

  it('leaves unknown values empty', () => {
    const d = optionData(undefined, 100, 'P', undefined, 0.1);
    expect(formatCell('bid', d)).toBe('—');
    expect(formatCell('itm', d)).toBe('—');
    expect(formatCell('size', d)).toBe('—');
  });

  it('formats like the design', () => {
    const d = optionData(q, 100, 'C', 101, 0.05);
    expect(formatCell('iv', d)).toBe('30.0%');
    expect(formatCell('d', d)).toBe('0.55');
    expect(formatCell('th', d)).toBe('−0.050');
    expect(formatCell('size', d)).toBe('10×20');
    expect(formatCell('chg', d)).toBe('+15.00%');
    expect(formatCell('vol', d)).toBe('1,200');
  });

  it('drops the sign of values that round to zero', () => {
    expect(fixed(-0.001, 2)).toBe('0.00');
    expect(fixed(-0.4, 0)).toBe('0');
    expect(fixed(-0.25, 2)).toBe('−0.25');
    expect(fixed(1.5, 1)).toBe('1.5');
    expect(fixed(undefined, 1)).toBe('—');
  });

  it('flags thin open interest and wide spreads in red', () => {
    const d = optionData(q, 100, 'C', 101, 0.05);
    expect(cellColor('oi', d)).toBe('var(--r)');
    expect(cellColor('sprd', d)).toBe('var(--mu)');
    expect(cellColor('sprd', { ...d, sprd: 25 })).toBe('var(--r)');
    expect(cellColor('bid', d)).toBe('var(--dn)');
    expect(cellColor('ask', d)).toBe('var(--up)');
  });

  it('averages ATM IVs', () => {
    expect(atmIv({ ...q, iv: 0.2 }, { ...q, iv: 0.3 })).toBeCloseTo(0.25, 9);
    expect(atmIv({ ...q, iv: undefined }, undefined)).toBeUndefined();
  });
});

describe('chainTotals', () => {
  const quote = (x: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...x });

  it('totals volume by right', () => {
    const t = chainTotals([
      { right: 'C', quote: quote({ volume: 10 }) },
      { right: 'P', quote: quote({ volume: 5 }) },
      { right: 'C', quote: undefined },
    ]);
    expect(t).toEqual({ callVol: 10, putVol: 5 });
  });
});
