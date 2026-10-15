import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import { createClock } from '@shared/timeFormat';
import type { AccountSummary, Position, Quote } from '@shared/types';
import {
  ETF_SECTOR,
  MARGIN_CALL_CUSHION,
  OTHER_SECTOR,
  asOfText,
  cushionBar,
  fxRate,
  headerFigures,
  headerStale,
  leverageLabel,
  livePrice,
  pctLabel,
  positionRow,
  positionTarget,
  qtyLabel,
  quoteContract,
  sectorOf,
  sortRows,
  underlyingOf,
} from './calc';

const quote = (over: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...over });

function position(over: Partial<Position> = {}): Position {
  return {
    account: 'DU1',
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    quantity: 100,
    avgPrice: 200,
    multiplier: 1,
    updatedAt: 0,
    ...over,
  };
}
describe('labels', () => {
  it('formats percentages and leverage with a true minus', () => {
    expect(pctLabel(12.94)).toBe('12.9%');
    expect(pctLabel(-1.04)).toBe('−1.0%');
    expect(pctLabel(undefined)).toBe('—');
    expect(leverageLabel(1.3812)).toBe('1.38×');
    expect(leverageLabel(0)).toBe('0.00×');
    expect(leverageLabel(undefined)).toBe('—');
    expect(leverageLabel(NaN)).toBe('—');
  });
});

describe('sectors', () => {
  it('classifies by IB industry, funds and indices', () => {
    expect(sectorOf('STK', { industry: 'Technology', category: 'Computers' })).toBe('Technology');
    expect(sectorOf('STK', { industry: 'Funds', category: 'Equity Fund' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { industry: '', category: '', longName: 'SPDR S&P 500 ETF TRUST' })).toBe(ETF_SECTOR);
    expect(sectorOf('IND', undefined)).toBe(ETF_SECTOR);
    expect(sectorOf('STK', undefined)).toBe(OTHER_SECTOR);
    expect(sectorOf('FUT', { longName: 'E-mini S&P 500' })).toBe(OTHER_SECTOR);
  });

  it('uses the stock type when IB reports it', () => {
    // IB reports SPY as stock type ETF (checked live); the stock type wins over the heuristic.
    expect(sectorOf('STK', { stockType: 'ETF' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { stockType: 'ETN', industry: 'Financial' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { stockType: 'COMMON', industry: 'Technology', category: 'Computers' })).toBe('Technology');
    // A company without industry is not taken for a fund once its stock type says otherwise.
    expect(sectorOf('STK', { stockType: 'COMMON' })).toBe(OTHER_SECTOR);
    expect(sectorOf('STK', { stockType: 'common', longName: 'SOME ETF ADVISORS INC' })).toBe(OTHER_SECTOR);
  });

  it('treats unclassified stocks as funds', () => {
    // IB sends QQQ, GLD and TLT without industry and category.
    expect(sectorOf('STK', { longName: 'INVESCO QQQ TRUST SERIES 1' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { industry: ' ', category: '', longName: 'SPDR GOLD SHARES' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { category: 'Computers' })).toBe(OTHER_SECTOR);
  });

  it('requests quotes SMART-routed', () => {
    expect(quoteContract({ ...stock('AAPL'), exchange: 'NASDAQ', conId: 265598 })).toEqual({ ...stock('AAPL', 'NASDAQ'), conId: 265598 });
    expect(quoteContract({ ...option('AAPL', '20261016', 230, 'C'), exchange: '' }).exchange).toBe('SMART');
    const fut = { symbol: 'ES', secType: 'FUT' as const, exchange: 'CME', currency: 'USD', lastTradeDate: '20261218' };
    expect(quoteContract(fut)).toBe(fut);
  });

  it('resolves underlyings and click targets', () => {
    const call = option('AAPL', '20261016', 230, 'C');
    expect(underlyingOf(call)).toEqual(stock('AAPL'));
    expect(underlyingOf(option('SPX', '20261016', 5700, 'P'))).toMatchObject({ symbol: 'SPX', secType: 'IND', exchange: 'CBOE' });
    // An option on a non-USD stock: the stock in the option's currency, keyed as a stock row of it is.
    const hk = { ...stock('700'), currency: 'HKD', primaryExchange: 'SEHK' };
    expect(underlyingOf({ ...option('700', '20261029', 500, 'C'), currency: 'HKD' })).toEqual({ ...stock('700'), currency: 'HKD' });
    expect(contractKey(underlyingOf({ ...option('700', '20261029', 500, 'C'), currency: 'HKD' }))).toBe(contractKey(underlyingOf(hk)));
    expect(positionTarget(call)).toEqual({ contract: stock('AAPL'), view: 'opt' });
    expect(positionTarget({ ...stock('NVDA'), conId: 4815747, exchange: 'NASDAQ' })).toEqual({ contract: stock('NVDA'), view: 'chart' });
  });
});

describe('positionRow', () => {
  it('values a stock at the live price', () => {
    const r = positionRow(position({ marketPrice: 220, marketValue: 22_000, unrealizedPnL: 2_000, dailyPnL: 150 }), 227.48, 1_284_530, 'Technology');
    expect(r.last).toBe(227.48);
    expect(r.value).toBeCloseTo(22_748);
    expect(r.unrealized).toBeCloseTo(2_748);
    expect(r.unrealizedPct).toBeCloseTo(13.74);
    expect(r.dayPnl).toBe(150);
    expect(r.weight).toBeCloseTo((22_748 / 1_284_530) * 100);
  });

  // Paper DUP899854, AAPL overnight 2026-10-05: the portfolio update marks at 333.50, IB's P&L engine
  // (reqPnLSingle) at about 332.86. The row keeps one price and re-marks IB's daily P&L to it.
  const overnight = position({
    avgPrice: 332.952003,
    marketPrice: 333.5,
    marketValue: 33_350,
    unrealizedPnL: 54.8,
    dailyPnL: -9.20156484375184,
    pnlValue: 33_285.99853515625,
  });

  it('re-marks the daily P&L to the price the row shows', () => {
    const ib = positionRow(overnight, undefined, 1e6, 'Technology');
    expect(ib.last).toBe(333.5);
    expect(ib.value).toBe(33_350);
    expect(ib.unrealized).toBe(54.8);
    // Bought today: the day's P&L equals the unrealized P&L at the same price.
    expect(ib.dayPnl).toBeCloseTo(54.8, 2);
    const live = positionRow(overnight, 334, 1e6, 'Technology');
    expect(live.value).toBeCloseTo(33_400);
    expect(live.unrealized).toBeCloseTo(104.8, 2);
    expect(live.dayPnl).toBeCloseTo(104.8, 2);
    // Without the P&L engine's value IB's figure is shown as it is.
    expect(positionRow({ ...overnight, pnlValue: undefined }, undefined, 1e6, 'x').dayPnl).toBeCloseTo(-9.2, 2);
  });

  it('falls back to IB portfolio values without a quote', () => {
    const r = positionRow(position({ marketPrice: 220, marketValue: 22_000, unrealizedPnL: 2_000 }), undefined, undefined, 'Technology');
    expect(r.last).toBe(220);
    expect(r.value).toBe(22_000);
    expect(r.unrealized).toBe(2_000);
    expect(r.unrealizedPct).toBeCloseTo(10);
    expect(r.weight).toBeUndefined();
    expect(r.dayPnl).toBeUndefined();
  });

  it('converts a foreign-currency position with IB’s exchange rate', () => {
    const sap = position({ key: 'STK:SAP:EUR', contract: { ...stock('SAP', 'IBIS'), currency: 'EUR' }, quantity: 50, avgPrice: 200 });
    const r = positionRow(sap, 220, 1_000_000, 'Technology', 1.08);
    expect(r.value).toBe(11_000);
    expect(r.fx).toBe(1.08);
    expect(r.valueBase).toBeCloseTo(11_880);
    expect(r.weight).toBeCloseTo(1.188);
    // Without the rate: no base-currency value and no weight, never the unconverted one.
    const unknown = positionRow(sap, 220, 1_000_000, 'Technology', null);
    expect(unknown.value).toBe(11_000);
    expect(unknown).toMatchObject({ fx: undefined, valueBase: undefined, weight: undefined });
    // A position in the account currency needs no rate.
    expect(positionRow(position(), 210, 1_000_000, 'x')).toMatchObject({ fx: 1, valueBase: 21_000 });
  });

  it('finds the exchange rate of a position’s currency', () => {
    const account = { currency: 'USD', exchangeRates: { EUR: 1.0812, USD: 1 } };
    expect(fxRate('USD', account)).toBe(1);
    expect(fxRate(undefined, account)).toBe(1);
    expect(fxRate('EUR', account)).toBe(1.0812);
    expect(fxRate('GBP', account)).toBeNull();
    expect(fxRate('EUR', { currency: 'EUR' })).toBe(1);
    expect(fxRate('USD', null)).toBeNull();
  });

  it('applies the option multiplier and short sign', () => {
    const put = position({ key: 'OPT:SPY', contract: option('SPY', '20261120', 560, 'P'), quantity: -5, avgPrice: 6.8, multiplier: 100 });
    const r = positionRow(put, 5.1, 1_284_530, ETF_SECTOR);
    expect(r.value).toBeCloseTo(-2_550);
    expect(r.unrealized).toBeCloseTo(850);
    expect(r.unrealizedPct).toBeCloseTo(25);
  });

  it('values options at the mark, not a stale last trade', () => {
    const call = option('AAPL', '20261016', 230, 'C');
    const q = quote({ last: 1, bid: 3.1, ask: 3.3 });
    expect(livePrice('OPT', q, 1)).toBeCloseTo(3.2);
    expect(livePrice('FOP', { ...q, mark: 3.25 }, 1)).toBe(3.25);
    expect(livePrice('OPT', quote({ last: 1, bid: 0, ask: 0.1 }), 1)).toBeCloseTo(0.05);
    // No two-sided market (closed, delayed-frozen): keep IB's portfolio values.
    expect(livePrice('OPT', quote({ last: 1, bid: -1, ask: -1 }), 1)).toBeUndefined();
    expect(livePrice('OPT', undefined, undefined)).toBeUndefined();
    expect(livePrice('STK', q, 1)).toBe(1);

    const p = position({ key: 'OPT:AAPL', contract: call, quantity: 10, avgPrice: 3.1, multiplier: 100, marketPrice: 4.25, unrealizedPnL: 1_150 });
    const live = positionRow(p, livePrice('OPT', q, 1), 1e6, 'Technology');
    expect(live.last).toBeCloseTo(3.2);
    expect(live.value).toBeCloseTo(3_200);
    expect(live.unrealized).toBeCloseTo(100);
    const ib = positionRow(p, livePrice('OPT', quote({ last: 1 }), 1), 1e6, 'Technology');
    expect(ib.last).toBe(4.25);
    expect(ib.value).toBeCloseTo(4_250);
    expect(ib.unrealized).toBe(1_150);
  });

  it('formats fractional quantities', () => {
    expect(qtyLabel(1_200)).toBe('1,200');
    expect(qtyLabel(-5)).toBe('−5');
    expect(qtyLabel(0.0153)).toBe('0.0153');
    expect(qtyLabel(10.5)).toBe('10.5');
    expect(qtyLabel(-1_234.25)).toBe('−1,234.25');
    expect(qtyLabel(2.00001)).toBe('2');
    expect(qtyLabel(undefined)).toBe('—');
  });

  it('leaves unknown prices unknown', () => {
    const r = positionRow(position(), undefined, 1e6, OTHER_SECTOR);
    expect(r.last).toBeUndefined();
    expect(r.value).toBeUndefined();
    expect(r.unrealized).toBeUndefined();
  });

  it('sorts by size', () => {
    const a = positionRow(position({ key: 'a', marketValue: -5_000 }), undefined, 1e6, 'x');
    const b = positionRow(position({ key: 'b', marketValue: 3_000 }), undefined, 1e6, 'x');
    const c = positionRow(position({ key: 'c' }), undefined, 1e6, 'x');
    expect(sortRows([c, b, a]).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('header figures', () => {
  const summary: AccountSummary = {
    account: 'DU1',
    currency: 'USD',
    netLiquidation: 1_019_763.12,
    excessLiquidity: 961_118.1,
    dailyPnL: -9.20156484375184,
    unrealizedPnL: -9.201764843746787,
    realizedPnL: 12.5,
    stockMarketValue: 33_350,
    optionMarketValue: -400,
    cushion: 0.942508,
    leverage: 1.38,
    updatedAt: 0,
  };

  it('shows IB’s own figures as sent: reqPnL, StockMarketValue / OptionMarketValue, Leverage and Cushion', () => {
    expect(headerFigures(summary)).toEqual({
      dayPnl: -9.20156484375184,
      unrealized: -9.201764843746787,
      realized: 12.5,
      stockValue: 33_350,
      optionValue: -400,
      leverage: 1.38,
      cushionPct: expect.closeTo(94.2508, 9),
    });
    expect(headerFigures(null)).toEqual({});
  });

  it('leaves out what IB has not sent rather than computing it', () => {
    // No reqPnL, no account updates, no Leverage or Cushion tag: nothing, even with every other figure at hand.
    const bare = headerFigures({ account: 'DU1', currency: 'USD', netLiquidation: 1e6, excessLiquidity: 9e5, initMarginReq: 1e5, updatedAt: 0 });
    expect(bare).toEqual({
      dayPnl: undefined,
      unrealized: undefined,
      realized: undefined,
      stockValue: undefined,
      optionValue: undefined,
      leverage: undefined,
      cushionPct: undefined,
    });
  });

  it('draws IB’s cushion as a bar, red below 10 %', () => {
    expect(cushionBar(headerFigures(summary).cushionPct)).toEqual({ fill: expect.closeTo(94.25, 2), warn: false });
    expect(cushionBar(9)).toEqual({ fill: 9, warn: true });
    expect(cushionBar(10)?.warn).toBe(false);
    expect(cushionBar(-5)).toEqual({ fill: 0, warn: true });
    expect(cushionBar(120)).toEqual({ fill: 100, warn: false });
    expect(cushionBar(undefined)).toBeNull();
    expect(MARGIN_CALL_CUSHION).toBe(10);
  });
});

describe('header staleness', () => {
  const summary = { account: 'U1' };

  it('marks the figures as not live while Tape is not connected to their account', () => {
    expect(headerStale('connected', summary, 'U1')).toBeNull();
    expect(headerStale('disconnected', summary, 'U1')).toBe('disconnected');
    expect(headerStale('connecting', summary, 'U1')).toBe('connecting');
    expect(headerStale('reconnecting', summary, 'U1')).toBe('connecting');
    // A summary of another account than the connected one is not this account's.
    expect(headerStale('connected', summary, 'U2')).toBe('otherAccount');
    // Nothing to mark without figures.
    expect(headerStale('disconnected', null, 'U1')).toBeNull();
  });

  it('says since when, with the date when not today', () => {
    const clock = createClock('24h', 'en');
    const now = new Date(2026, 9, 14, 10, 0).getTime();
    expect(asOfText(new Date(2026, 9, 14, 9, 41).getTime(), now, clock)).toBe('09:41');
    expect(asOfText(new Date(2026, 9, 13, 16, 0).getTime(), now, clock)).toBe('10/13 16:00');
    expect(asOfText(new Date(2026, 9, 14, 9, 41).getTime(), now, createClock('12h', 'zh'))).toBe('上午 09:41');
  });
});
