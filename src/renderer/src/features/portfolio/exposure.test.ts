import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { ContractRef, Position, Quote } from '@shared/types';
import { positionRow, type PositionRow } from './calc';
import { lastQuotePrice, optionLine, portfolioGreeks, sameOptionLine } from './exposure';

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

// Tuesday 2026-10-06, 11:00 in New York (days count on New York's calendar, whatever the machine's zone).
const NOW = new Date(Date.UTC(2026, 9, 6, 15, 0));

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

  it('reads the underlying quote’s last trade, else its midpoint, mark or previous close', () => {
    expect(lastQuotePrice(undefined)).toBeUndefined();
    expect(lastQuotePrice(q('k', { last: 10, bid: 9, ask: 11 }))).toBe(10);
    expect(lastQuotePrice(q('k', { bid: 9, ask: 11, mark: 12 }))).toBe(10);
    expect(lastQuotePrice(q('k', { mark: 12, close: 8 }))).toBe(12);
    expect(lastQuotePrice(q('k', { close: 8 }))).toBe(8);
    expect(lastQuotePrice(q('k', { last: 0 }))).toBeUndefined();
  });
});

describe('option lines', () => {
  const near = option('AAPL', '20261009', 230, 'C');
  const far = option('SPY', '20261218', 560, 'P');
  const past = option('NVDA', '20261002', 100, 'C');
  const rows = [row(stock('AAPL'), 1, {}, 250), row(far, -2, {}, 6), row(near, 10, {}, 21), row(past, 1, {}, 1)];
  const quotes = { [contractKey(far)]: q(contractKey(far), { undPrice: 580 }) };

  it('gives the right, the days to expiry (highlighted within a week) and the moneyness', () => {
    // AAPL call 230 with AAPL at 250 (the stock row): in the money by 8 %, 3 days out.
    expect(optionLine(rows[2], quotes, rows, NOW)).toEqual({ right: 'C', dte: 3, soon: true, moneyness: { itm: true, pct: 8 } });
    // SPY put 560 with SPY at 580 (the option's model underlying price): out of the money by 3.4 %.
    const spy = optionLine(rows[1], quotes, rows, NOW)!;
    expect(spy).toMatchObject({ right: 'P', dte: 73, soon: false, moneyness: { itm: false } });
    expect(spy.moneyness?.pct).toBeCloseTo(3.448, 2);
    // Past its expiry: 0 days, and without an underlying price no moneyness.
    expect(optionLine(rows[3], quotes, rows, NOW)).toEqual({ right: 'C', dte: 0, soon: true, moneyness: undefined });
  });

  it('counts the days on New York’s calendar', () => {
    // Thursday 10/08 13:00 in New York, already Friday 01:00 in Shanghai: the Friday expiry is 1 day out.
    expect(optionLine(rows[2], quotes, rows, new Date(Date.UTC(2026, 9, 8, 17, 0)))?.dte).toBe(1);
    // Friday 00:30 in New York: the day itself.
    expect(optionLine(rows[2], quotes, rows, new Date(Date.UTC(2026, 9, 9, 4, 30)))?.dte).toBe(0);
  });

  it('is undefined for other instruments, and without an expiry has no days', () => {
    expect(optionLine(rows[0], quotes, rows, NOW)).toBeUndefined();
    const undated = row({ ...near, lastTradeDate: undefined }, 1, {}, 2);
    expect(optionLine(undated, {}, [undated], NOW)).toMatchObject({ dte: undefined, soon: false });
  });

  it('never takes a futures option’s premium for its underlying price', () => {
    const fop: ContractRef = { secType: 'FOP', symbol: 'ES', lastTradeDate: '20261218', strike: 6000, right: 'C', multiplier: 50, exchange: 'CME', currency: 'USD' };
    const k = contractKey(fop);
    const fopRows = [row(fop, 1, { multiplier: 50 }, 120)];
    expect(optionLine(fopRows[0], { [k]: q(k, { last: 120 }) }, fopRows, NOW)?.moneyness).toBeUndefined();
    expect(optionLine(fopRows[0], { [k]: q(k, { last: 120, undPrice: 6100 }) }, fopRows, NOW)?.moneyness?.itm).toBe(true);
    // Dollar delta needs the underlying price: unknown with only the premium.
    const greeks = { delta: 0.5, gamma: 0.001, theta: -2, vega: 5 };
    expect(portfolioGreeks(fopRows, { [k]: q(k, { last: 120, ...greeks }) }).dollarDelta).toBeUndefined();
    expect(portfolioGreeks(fopRows, { [k]: q(k, { last: 120, undPrice: 6100, ...greeks }) }).dollarDelta).toBeCloseTo(0.5 * 50 * 6100);
  });

  it('reads two lines as the same when they would be written the same', () => {
    const a = { right: 'C' as const, dte: 3, soon: true, moneyness: { itm: true, pct: 8.01 } };
    expect(sameOptionLine(a, { ...a, moneyness: { itm: true, pct: 8.04 } })).toBe(true);
    expect(sameOptionLine(a, { ...a, moneyness: { itm: true, pct: 8.06 } })).toBe(false);
    expect(sameOptionLine(a, { ...a, dte: 2 })).toBe(false);
    expect(sameOptionLine(a, undefined)).toBe(false);
    expect(sameOptionLine(undefined, undefined)).toBe(true);
  });
});
