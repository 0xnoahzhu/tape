import { describe, expect, it } from 'vitest';
import { contractKey, index, option, stock } from '@shared/contract';
import type { Bar, ContractRef, Execution, Position, Quote } from '@shared/types';
import { positionRow, type PositionRow } from '../calc';
import {
  benchmarkReturn,
  benchmarkRows,
  barsCover,
  closeAtOrBefore,
  concentration,
  contributions,
  expirations,
  holdingUnderlyings,
  marginCushion,
  portfolioGreeks,
  recentFills,
  upcomingEvents,
} from './model';

function row(contract: ContractRef, quantity: number, over: Partial<Position> = {}, livePx?: number, netLiq = 1_000_000): PositionRow {
  const p: Position = {
    account: 'DU1',
    key: contractKey(contract),
    contract,
    quantity,
    avgPrice: 1,
    multiplier: contract.secType === 'OPT' ? 100 : 1,
    updatedAt: 0,
    ...over,
  };
  return positionRow(p, livePx, netLiq, 'x');
}

const q = (key: string, over: Partial<Quote>): Quote => ({ key, updatedAt: 0, ...over });

// Tuesday 2026-10-06, local time.
const NOW = new Date(2026, 9, 6, 11, 0);

describe('margin cushion', () => {
  it('is excess liquidity over net liquidation, red below 10 %', () => {
    // The paper account: 961,118.10 / 1,019,763.12.
    expect(marginCushion(961_118.1, 1_019_763.12)).toEqual({ pct: expect.closeTo(94.25, 2), fill: expect.closeTo(94.25, 2), warn: false });
    expect(marginCushion(9, 100)).toEqual({ pct: 9, fill: 9, warn: true });
    expect(marginCushion(10, 100)?.warn).toBe(false);
    expect(marginCushion(-5, 100)).toEqual({ pct: -5, fill: 0, warn: true });
    expect(marginCushion(undefined, 100)).toBeNull();
    expect(marginCushion(5, 0)).toBeNull();
  });
});

describe('portfolio greeks', () => {
  const aapl = row(stock('AAPL'), 200, {}, 250);
  const call = option('AAPL', '20261120', 330, 'C');
  const callRow = row(call, 10, {}, 2);
  const greeks = q(contractKey(call), { delta: 0.583, gamma: 0.01255, theta: -0.147, vega: 0.478, undPrice: 252 });

  it('adds stock shares and option greeks × quantity × multiplier', () => {
    const g = portfolioGreeks([aapl, callRow], { [contractKey(call)]: greeks });
    expect(g.pending).toBe(0);
    expect(g.options).toBe(1);
    expect(g.delta).toBeCloseTo(200 + 583);
    expect(g.dollarDelta).toBeCloseTo(200 * 250 + 583 * 252);
    expect(g.gamma).toBeCloseTo(12.55);
    expect(g.theta).toBeCloseTo(-147);
    expect(g.vega).toBeCloseTo(478);
  });

  it('counts shorts negative and stocks only when there are no options', () => {
    const g = portfolioGreeks([row(stock('TSLA'), -100, {}, 400), aapl], {});
    expect(g).toMatchObject({ delta: 100, dollarDelta: -40_000 + 50_000, gamma: 0, theta: 0, vega: 0, pending: 0, options: 0 });
  });

  it('shows no totals while an option waits for its model greeks', () => {
    const g = portfolioGreeks([aapl, callRow], { [contractKey(call)]: q(contractKey(call), { delta: 0.5 }) });
    expect(g).toEqual({ pending: 1, options: 1 });
  });

  it('takes the underlying price from its quote when the option has none, else leaves the dollar delta unknown', () => {
    const noUnd = { ...greeks, undPrice: undefined };
    const und = q('STK:AAPL', { last: 251 });
    expect(portfolioGreeks([callRow], { [contractKey(call)]: noUnd, 'STK:AAPL': und }).dollarDelta).toBeCloseTo(583 * 251);
    // Held as stock: the stock row's price.
    expect(portfolioGreeks([aapl, callRow], { [contractKey(call)]: noUnd }).dollarDelta).toBeCloseTo(200 * 250 + 583 * 250);
    const g = portfolioGreeks([callRow], { [contractKey(call)]: noUnd });
    expect(g.delta).toBeCloseTo(583);
    expect(g.dollarDelta).toBeUndefined();
  });
});

describe('concentration', () => {
  it('combines stock and options per underlying as a share of net liquidation', () => {
    const rows = [
      row(stock('AAPL'), 200, {}, 250), // 50,000
      row(option('AAPL', '20261120', 330, 'C'), -10, {}, 5), // |−5,000|
      row(stock('NVDA'), 1000, {}, 180), // 180,000
      row(stock('TSLA'), 100, {}, 400), // 40,000
      row(stock('META'), 10, {}, 700), // 7,000
      row(stock('KO'), 10, {}, 60), // 600
      row(stock('X'), 1, { marketPrice: undefined, marketValue: undefined }), // no value
    ];
    const c = concentration(rows, 500_000)!;
    expect(c.items.map((i) => i.key)).toEqual(['STK:NVDA', 'STK:AAPL', 'STK:TSLA', 'STK:META', 'STK:KO']);
    expect(c.items[0]).toMatchObject({ value: 180_000, pct: 36, flagged: true });
    expect(c.items[1]).toMatchObject({ value: 55_000, pct: 11, flagged: false });
    expect(c.top3).toBeCloseTo(36 + 11 + 8);
    expect(c.max).toBe(36);
    expect(concentration(rows, 500_000, 2)!.items).toHaveLength(2);
    expect(concentration(rows, undefined)).toBeNull();
    expect(concentration([], 1)).toEqual({ items: [], top3: 0, max: 0 });
  });

  it('flags at 20 % exactly', () => {
    expect(concentration([row(stock('A'), 200, {}, 100)], 100_000)!.items[0].flagged).toBe(true);
  });
});

describe('contributions', () => {
  it('ranks positions by the size of today’s P&L', () => {
    const mk = (sym: string, daily?: number) => row(stock(sym), 1, { dailyPnL: daily }, 10);
    const list = contributions([mk('A', 50), mk('B', -200), mk('C'), mk('D', 100), mk('E', 0)], 3);
    expect(list.map((c) => [c.row.key, c.pnl, c.frac])).toEqual([
      ['STK:B', -200, 1],
      ['STK:D', 100, 0.5],
      ['STK:A', 50, 0.25],
    ]);
    expect(contributions([mk('E', 0)])).toEqual([{ row: expect.anything(), pnl: 0, frac: 0 }]);
  });

  it('uses the re-marked day P&L of the row', () => {
    // IB's engine valued the position at 1,000; the row shows 1,100.
    const r = row(stock('A'), 100, { dailyPnL: 20, pnlValue: 1_000 }, 11);
    expect(contributions([r])[0].pnl).toBe(120);
  });
});

describe('expirations', () => {
  it('lists option positions soonest first with days to expiry and moneyness', () => {
    const near = option('AAPL', '20261009', 230, 'C');
    const far = option('SPY', '20261218', 560, 'P');
    const past = option('NVDA', '20261002', 100, 'C');
    const rows = [row(stock('AAPL'), 1, {}, 250), row(far, -2, {}, 6), row(near, 10, {}, 21), row(past, 1, {}, 1)];
    const quotes = { [contractKey(far)]: q(contractKey(far), { undPrice: 580 }) };
    const list = expirations(rows, quotes, NOW);
    expect(list.map((e) => [e.row.key, e.dte, e.soon])).toEqual([
      [contractKey(past), 0, true],
      [contractKey(near), 3, true],
      [contractKey(far), 73, false],
    ]);
    // AAPL call 230 with AAPL at 250 (the stock row): in the money by 8 %.
    expect(list[1].moneyness).toEqual({ itm: true, pct: 8 });
    // SPY put 560 with SPY at 580: out of the money by 3.4 %.
    expect(list[2].moneyness?.itm).toBe(false);
    expect(list[2].moneyness?.pct).toBeCloseTo(3.448, 2);
    // NVDA: no underlying price.
    expect(list[0].moneyness).toBeUndefined();
    expect(expirations(rows, quotes, NOW, 1)).toHaveLength(1);
    expect(expirations([row(stock('AAPL'), 1)], {}, NOW)).toEqual([]);
  });
});

describe('recent fills', () => {
  it('lists the newest five and counts all', () => {
    const fill = (id: string, time: number): Execution => ({ execId: id, orderId: 1, key: 'STK:AAPL', contract: stock('AAPL'), side: 'BUY', shares: 1, price: 1, time });
    const fills = [1, 5, 3, 2, 6, 4].map((t) => fill(String(t), t));
    const r = recentFills(fills);
    expect(r.count).toBe(6);
    expect(r.items.map((e) => e.time)).toEqual([6, 5, 4, 3, 2]);
  });
});

describe('upcoming events', () => {
  const rows = [row(stock('AAPL'), 1), row(stock('TSLA'), 1), row(option('NVDA', '20261120', 200, 'C'), 1), row(index('SPX', 'CBOE'), 1)];
  const und = holdingUnderlyings(rows);

  it('collects the holdings’ underlyings', () => {
    expect([...und.keys()].sort()).toEqual(['STK:AAPL', 'STK:NVDA', 'STK:TSLA']);
  });

  it('merges earnings and ex-dividend dates of holdings, today or later, soonest first', () => {
    const events = upcomingEvents(
      und,
      { 'STK:AAPL': { nextDate: '20261109', nextAmount: 0.26 }, 'STK:TSLA': {}, 'STK:NVDA': { nextDate: '20261001', nextAmount: 0.01 } },
      {
        status: 'ok',
        events: [
          { key: 'STK:AAPL', date: '20261029', time: 'amc' },
          { key: 'STK:NVDA', date: '20261006' },
          { key: 'STK:MSFT', date: '20261007' },
        ],
      },
      NOW,
    );
    expect(events.map((e) => [e.symbol, e.kind, e.days, e.soon, e.time, e.amount])).toEqual([
      ['NVDA', 'earnings', 0, true, undefined, undefined],
      ['AAPL', 'earnings', 23, false, 'amc', undefined],
      ['AAPL', 'dividend', 34, false, undefined, 0.26],
    ]);
  });

  it('shows only dividends without the WSH subscription, and at most five', () => {
    const div = Object.fromEntries(['AAPL', 'TSLA', 'NVDA'].map((s, i) => [`STK:${s}`, { nextDate: `2026101${i}` }]));
    const events = upcomingEvents(und, div, { status: 'unsubscribed', events: [{ key: 'STK:AAPL', date: '20261007' }] }, NOW);
    expect(events.every((e) => e.kind === 'dividend')).toBe(true);
    expect(events).toHaveLength(3);
    expect(upcomingEvents(und, div, undefined, NOW, 2)).toHaveLength(2);
  });
});

describe('benchmark', () => {
  // Daily bars are stamped at 00:00 UTC of their day.
  const day = (y: number, m: number, d: number, close: number): Bar => ({ time: Date.UTC(y, m - 1, d) / 1000, open: close, high: close, low: close, close, volume: 1 });
  const bars = [day(2025, 12, 30, 600), day(2025, 12, 31, 610), day(2026, 1, 2, 620), day(2026, 10, 5, 671)];

  it('takes the last close at or before the start', () => {
    // A NAV sample on Dec 31 before the close counts from Dec 30's close; after it, from Dec 31's.
    expect(closeAtOrBefore(bars, Date.UTC(2025, 11, 31, 15))).toBe(600);
    expect(closeAtOrBefore(bars, Date.UTC(2026, 0, 1, 3))).toBe(610);
    expect(closeAtOrBefore(bars, Date.UTC(2025, 11, 1))).toBeUndefined();
    expect(barsCover(bars, Date.UTC(2026, 0, 1))).toBe(true);
    expect(barsCover(bars, Date.UTC(2025, 11, 30, 12))).toBe(false);
  });

  it('measures the live price against that close', () => {
    expect(benchmarkReturn(bars, Date.UTC(2026, 0, 1, 3), 671)).toBeCloseTo(10);
    // Without a live price: the newest close.
    expect(benchmarkReturn(bars, Date.UTC(2026, 0, 1, 3), undefined)).toBeCloseTo(10);
    expect(benchmarkReturn(bars, undefined, 671)).toBeUndefined();
    expect(benchmarkReturn([], 1, 1)).toBeUndefined();
  });

  it('builds the three rows and the difference to SPY', () => {
    const { rows, vsSpy } = benchmarkRows(12, 8, -16);
    expect(rows).toEqual([
      { key: 'portfolio', pct: 12, frac: 0.75 },
      { key: 'SPY', pct: 8, frac: 0.5 },
      { key: 'QQQ', pct: -16, frac: 1 },
    ]);
    expect(vsSpy).toBe(4);
    expect(benchmarkRows(3, undefined, undefined).vsSpy).toBeUndefined();
    expect(benchmarkRows(undefined, undefined, undefined).rows.every((r) => r.frac === 0)).toBe(true);
  });
});
