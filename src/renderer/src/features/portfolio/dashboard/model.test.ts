import { describe, expect, it } from 'vitest';
import { contractKey, index, option, stock } from '@shared/contract';
import type { ContractRef, Execution, Position, Quote } from '@shared/types';
import { positionRow, type PositionRow } from '../calc';
import {
  concentration,
  contributions,
  earningsState,
  etClock,
  expirations,
  holdingUnderlyings,
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

  it('never takes a futures option’s premium for its underlying price', () => {
    const fop: ContractRef = { secType: 'FOP', symbol: 'ES', lastTradeDate: '20261218', strike: 6000, right: 'C', multiplier: 50, exchange: 'CME', currency: 'USD' };
    const k = contractKey(fop);
    const rows = [row(fop, 1, { multiplier: 50 }, 120)];
    expect(expirations(rows, { [k]: q(k, { last: 120 }) }, NOW)[0].moneyness).toBeUndefined();
    expect(expirations(rows, { [k]: q(k, { last: 120, undPrice: 6100 }) }, NOW)[0].moneyness?.itm).toBe(true);
    // Dollar delta needs the underlying price: unknown with only the premium.
    const greeks = { delta: 0.5, gamma: 0.001, theta: -2, vega: 5 };
    expect(portfolioGreeks(rows, { [k]: q(k, { last: 120, ...greeks }) }).dollarDelta).toBeUndefined();
    expect(portfolioGreeks(rows, { [k]: q(k, { last: 120, undPrice: 6100, ...greeks }) }).dollarDelta).toBeCloseTo(0.5 * 50 * 6100);
  });
});

describe('recent fills', () => {
  it('lists the newest five and counts all', () => {
    const fill = (id: string, time: number): Execution => ({ execId: id, orderId: 1, key: 'STK:AAPL', contract: stock('AAPL'), side: 'BUY', shares: 1, price: 1, time });
    const fills = [1, 5, 3, 2, 6, 4].map((t) => fill(String(t), t));
    const r = recentFills(fills, 0);
    expect(r.count).toBe(6);
    expect(r.items.map((e) => e.time)).toEqual([6, 5, 4, 3, 2]);
  });

  it('leaves out fills before the New York day', () => {
    const fill = (id: string, time: number): Execution => ({ execId: id, orderId: 1, key: 'STK:AAPL', contract: stock('AAPL'), side: 'BUY', shares: 1, price: 1, time });
    const r = recentFills([fill('a', 99), fill('b', 100), fill('c', 150)], 100);
    expect(r.count).toBe(2);
    expect(r.items.map((e) => e.execId)).toEqual(['c', 'b']);
    expect(recentFills([fill('a', 99)], 100)).toEqual({ count: 0, items: [] });
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

  it('passes the scanner’s estimates and exact times through', () => {
    const events = upcomingEvents(
      und,
      {},
      {
        status: 'ok',
        source: 'scanner',
        events: [
          { key: 'STK:AAPL', date: '20261029', time: 'amc', estimated: true },
          { key: 'STK:TSLA', date: '20261021', time: 'bmo', minutes: 510, estimated: true },
        ],
      },
      NOW,
    );
    expect(events.map((e) => [e.symbol, e.time, e.minutes, e.estimated])).toEqual([
      ['TSLA', 'bmo', 510, true],
      ['AAPL', 'amc', undefined, true],
    ]);
    expect('minutes' in events[1]).toBe(false);
    expect(etClock(510)).toBe('08:30');
    expect(etClock(960)).toBe('16:00');
    expect(etClock(0)).toBe('00:00');
  });

  it('says where earnings dates come from, or why there are none', () => {
    expect(earningsState(undefined, true)).toBe('ok');
    expect(earningsState({ status: 'ok', events: [], source: 'wsh' }, true)).toBe('ok');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner' }, true)).toBe('estimated');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner', pending: true }, true)).toBe('searching');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner', partial: true }, true)).toBe('estimatedUs');
    expect(earningsState({ status: 'ok', events: [], source: 'scanner', retryInMs: 300_000 }, true)).toBe('estimated');
    expect(earningsState({ status: 'unsubscribed', events: [] }, true)).toBe('unsubscribed');
    expect(earningsState({ status: 'unavailable', events: [] }, true)).toBe('unavailable');
    // Not connected: the widget says so itself.
    expect(earningsState({ status: 'unavailable', events: [] }, false)).toBe('ok');
  });
});
