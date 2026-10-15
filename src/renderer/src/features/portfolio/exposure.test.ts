import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { ContractRef, Position, Quote } from '@shared/types';
import { positionRow, type PositionRow } from './calc';
import { lastQuotePrice, optionDte, portfolioGreeks, positionDelta } from './exposure';

/** A position row whose price is `mark` (IB's tick 37). */
function row(contract: ContractRef, quantity: number, over: Partial<Position> = {}, mark?: number): PositionRow {
  const p: Position = {
    account: 'DU1',
    key: contractKey(contract),
    contract,
    quantity,
    multiplier: contract.secType === 'OPT' ? 100 : 1,
    updatedAt: 0,
    ...over,
  };
  return positionRow(p, mark, 'x');
}

const q = (key: string, over: Partial<Quote>): Quote => ({ key, updatedAt: 0, ...over });

// Tuesday 2026-10-06, 11:00 in New York (days count on New York's calendar, whatever the machine's zone).
const NOW = new Date(Date.UTC(2026, 9, 6, 15, 0));

describe('one underlying’s greeks (the activity panel)', () => {
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
    // Held as stock: the stock row's price (IB's mark), or its own quote's last trade where there is one.
    expect(portfolioGreeks([aapl, callRow], { [contractKey(call)]: noUnd }).dollarDelta).toBeCloseTo(200 * 250 + 583 * 250);
    expect(portfolioGreeks([aapl, callRow], { [contractKey(call)]: noUnd, 'STK:AAPL': und }).dollarDelta).toBeCloseTo(200 * 251 + 583 * 251);
    const g = portfolioGreeks([callRow], { [contractKey(call)]: noUnd });
    expect(g.delta).toBeCloseTo(583);
    expect(g.dollarDelta).toBeUndefined();
  });

  it('gives each row’s share of the delta: a stock its shares, an option its model delta × quantity × multiplier', () => {
    const quotes = { [contractKey(call)]: greeks };
    expect(positionDelta(aapl, quotes)).toBe(200);
    expect(positionDelta(callRow, quotes)).toBeCloseTo(583);
    expect(positionDelta(row(call, -2, {}, 2), quotes)).toBeCloseTo(-116.6);
    // No greeks from IB yet, or an instrument without a delta of its own here.
    expect(positionDelta(callRow, {})).toBeUndefined();
    expect(positionDelta(row({ secType: 'FUT', symbol: 'ES', lastTradeDate: '20261218', exchange: 'CME', currency: 'USD' }, 1), quotes)).toBeUndefined();
    // The rows add up to the portfolio delta.
    const rows = [aapl, callRow];
    expect(rows.reduce((sum, r) => sum + positionDelta(r, quotes)!, 0)).toBeCloseTo(portfolioGreeks(rows, quotes).delta!);
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

describe('days to expiry (the activity panel’s DTE)', () => {
  const near = option('AAPL', '20261009', 230, 'C');
  const far = option('SPY', '20261218', 560, 'P');
  const past = option('NVDA', '20261002', 100, 'C');

  it('counts calendar days on New York’s calendar, highlighted within a week, never negative', () => {
    expect(optionDte(row(near, 10), NOW)).toEqual({ days: 3, soon: true });
    expect(optionDte(row(far, -2), NOW)).toEqual({ days: 73, soon: false });
    expect(optionDte(row(past, 1), NOW)).toEqual({ days: 0, soon: true });
    // Thursday 10/08 13:00 in New York, already Friday 01:00 in Shanghai: the Friday expiry is 1 day out.
    expect(optionDte(row(near, 10), new Date(Date.UTC(2026, 9, 8, 17, 0)))?.days).toBe(1);
    // Friday 00:30 in New York: the day itself.
    expect(optionDte(row(near, 10), new Date(Date.UTC(2026, 9, 9, 4, 30)))?.days).toBe(0);
  });

  it('is undefined for other instruments and without an expiry date', () => {
    expect(optionDte(row(stock('AAPL'), 1), NOW)).toBeUndefined();
    expect(optionDte(row({ ...near, lastTradeDate: undefined }, 1), NOW)).toBeUndefined();
  });

  it('never takes a futures option’s premium for its underlying price', () => {
    const fop: ContractRef = { secType: 'FOP', symbol: 'ES', lastTradeDate: '20261218', strike: 6000, right: 'C', multiplier: 50, exchange: 'CME', currency: 'USD' };
    const k = contractKey(fop);
    const fopRows = [row(fop, 1, { multiplier: 50 }, 120)];
    expect(optionDte(fopRows[0], NOW)).toEqual({ days: 73, soon: false });
    // Dollar delta needs the underlying price: unknown with only the premium.
    const greeks = { delta: 0.5, gamma: 0.001, theta: -2, vega: 5 };
    expect(portfolioGreeks(fopRows, { [k]: q(k, { last: 120, ...greeks }) }).dollarDelta).toBeUndefined();
    expect(portfolioGreeks(fopRows, { [k]: q(k, { last: 120, undPrice: 6100, ...greeks }) }).dollarDelta).toBeCloseTo(0.5 * 50 * 6100);
  });
});
