import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { Position, Quote } from '@shared/types';
import {
  ETF_SECTOR,
  MARGIN_CALL_CUSHION,
  OTHER_SECTOR,
  accountTotals,
  fxRate,
  grossValue,
  leverage,
  leverageLabel,
  livePrice,
  marginCushion,
  positionRow,
  positionTarget,
  qtyLabel,
  quoteContract,
  sectorOf,
  sortRows,
  sumRows,
  underlyingOf,
  weightLabel,
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
  it('formats weights with a true minus', () => {
    expect(weightLabel(12.94)).toBe('12.9%');
    expect(weightLabel(-1.04)).toBe('−1.0%');
    expect(weightLabel(undefined)).toBe('—');
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

  it('re-marks the account P&L to the rows', () => {
    const row = positionRow(overnight, undefined, 1e6, 'Technology');
    const account = { account: 'DU1', currency: 'USD', netLiquidation: 1e6, updatedAt: 0, dailyPnL: -9.20156484375184, unrealizedPnL: -9.201764843746787 };
    const t = accountTotals(account, [row]);
    expect(t.dayPnl).toBeCloseTo(54.8, 2);
    expect(t.unrealized).toBeCloseTo(54.8, 2);
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

  it('sorts by size and sums fields', () => {
    const a = positionRow(position({ key: 'a', marketValue: -5_000, unrealizedPnL: 1 }), undefined, 1e6, 'x');
    const b = positionRow(position({ key: 'b', marketValue: 3_000, unrealizedPnL: 2 }), undefined, 1e6, 'x');
    const c = positionRow(position({ key: 'c' }), undefined, 1e6, 'x');
    expect(sortRows([c, b, a]).map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(sumRows([a, b], 'value')).toBe(-2_000);
    expect(sumRows([a, b, c], 'value')).toBeUndefined();
    expect(sumRows([a, b, c], 'unrealized', (r) => r.key !== 'c')).toBe(3);
    expect(sumRows([], 'dayPnl')).toBe(0);
    expect(sumRows([a, b], 'valueBase')).toBe(-2_000);
    expect(grossValue([a, b])).toBe(8_000);
    expect(grossValue([a, c])).toBeUndefined();
  });

  it('falls back to position sums for missing account figures', () => {
    const stk = positionRow(position({ key: 'a', marketValue: 22_000, unrealizedPnL: 2_000, dailyPnL: 100 }), undefined, 1e6, 'x');
    const opt = positionRow(
      position({ key: 'b', contract: option('AAPL', '20261016', 230, 'C'), multiplier: 100, quantity: -2, avgPrice: 3, marketValue: -500, unrealizedPnL: 100 }),
      undefined,
      1e6,
      'x',
    );
    const account = { account: 'DU1', currency: 'USD', netLiquidation: 1e6, updatedAt: 0 };
    expect(accountTotals(null, [stk])).toEqual({});
    expect(accountTotals(account, [stk, opt])).toEqual({
      dayPnl: undefined,
      unrealized: 2_100,
      stockValue: 22_000,
      optionValue: -500,
      gross: 22_500,
      realized: undefined,
    });
    // Stocks and options come from the rows first (no option rows: 0, not IB's figure).
    expect(accountTotals({ ...account, dailyPnL: -5, unrealizedPnL: 7, stockMarketValue: 1, optionMarketValue: 2, grossPositionValue: 3, realizedPnL: 4 }, [stk])).toEqual({
      dayPnl: -5,
      unrealized: 7,
      stockValue: 22_000,
      optionValue: 0,
      gross: 3,
      realized: 4,
    });
    expect(accountTotals(account, [])).toEqual({ dayPnl: undefined, unrealized: 0, stockValue: 0, optionValue: 0, gross: 0, realized: undefined });
  });

  it('values stocks and options at the rows, falling back to IB per type', () => {
    const account = { account: 'DU1', currency: 'USD', netLiquidation: 1e6, stockMarketValue: 20_000, optionMarketValue: -400, updatedAt: 0 };
    const stk = positionRow(position({ key: 'a', marketValue: 22_000 }), undefined, 1e6, 'x');
    const unknown = positionRow(position({ key: 'c', marketValue: undefined, marketPrice: undefined }), undefined, 1e6, 'x');
    const fut = positionRow(position({ key: 'f', contract: { symbol: 'MES', secType: 'FUT', exchange: 'CME', currency: 'USD' }, marketValue: 5 }), undefined, 1e6, 'x');
    const call = option('AAPL', '20261016', 230, 'C');
    const unknownOpt = positionRow(position({ key: 'o', contract: call, multiplier: 100, quantity: -1, avgPrice: 3 }), undefined, 1e6, 'x');
    // Live values of the rows (futures are in neither) …
    expect(accountTotals(account, [stk, fut])).toMatchObject({ stockValue: 22_000, optionValue: 0 });
    // … IB's figures when a row of the type has no value.
    expect(accountTotals(account, [stk, unknown]).stockValue).toBe(20_000);
    expect(accountTotals(account, [stk, unknownOpt])).toMatchObject({ stockValue: 22_000, optionValue: -400 });
    expect(accountTotals({ ...account, stockMarketValue: undefined, optionMarketValue: undefined }, [unknown]).stockValue).toBeUndefined();
    // In the account currency: a EUR stock at IB's rate, IB's figure while the rate is unknown.
    const eur = (fx: number | null) =>
      positionRow(position({ key: 'e', contract: { ...stock('SAP'), currency: 'EUR' }, marketValue: 1_000 }), undefined, 1e6, 'x', fx);
    expect(accountTotals(account, [eur(1.1)]).stockValue).toBeCloseTo(1_100, 9);
    expect(accountTotals(account, [eur(null)]).stockValue).toBe(20_000);
  });

  it('takes today’s realized P&L from reqPnL, else from the executions', () => {
    const account = { account: 'DU1', currency: 'USD', updatedAt: 0 };
    const fill = (realizedPnL?: number) => ({ execId: String(realizedPnL), orderId: 1, key: 'STK:AAPL', contract: stock('AAPL'), side: 'SELL' as const, shares: 1, price: 1, time: 0, realizedPnL });
    const executions = [fill(120.5), fill(undefined), fill(-20)];
    expect(accountTotals({ ...account, realizedPnL: 0 }, [], executions).realized).toBe(0);
    expect(accountTotals(account, [], executions).realized).toBeCloseTo(100.5);
    expect(accountTotals(account, [], []).realized).toBe(0);
    expect(accountTotals(account, []).realized).toBeUndefined();
  });

  it('computes leverage', () => {
    expect(leverage(1_772_651, 1_284_530)).toBeCloseTo(1.38, 2);
    expect(leverage(1, 0)).toBeUndefined();
    expect(leverage(undefined, 1)).toBeUndefined();
  });

  it('labels leverage', () => {
    expect(leverageLabel(leverage(1_772_651, 1_284_530))).toBe('1.38×');
    expect(leverageLabel(0)).toBe('0.00×');
    expect(leverageLabel(12.346)).toBe('12.35×');
    expect(leverageLabel(undefined)).toBe('—');
    expect(leverageLabel(NaN)).toBe('—');
  });
});

describe('margin cushion', () => {
  it('is excess liquidity over net liquidation, red below 10 %', () => {
    // The paper account: 961,118.10 / 1,019,763.12.
    expect(marginCushion(961_118.1, 1_019_763.12)).toEqual({ pct: expect.closeTo(94.25, 2), fill: expect.closeTo(94.25, 2), warn: false });
    expect(marginCushion(9, 100)).toEqual({ pct: 9, fill: 9, warn: true });
    expect(marginCushion(10, 100)?.warn).toBe(false);
    expect(marginCushion(-5, 100)).toEqual({ pct: -5, fill: 0, warn: true });
    expect(marginCushion(undefined, 100)).toBeNull();
    expect(marginCushion(5, 0)).toBeNull();
    expect(MARGIN_CALL_CUSHION).toBe(10);
  });
});
