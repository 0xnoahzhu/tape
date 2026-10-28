import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import { createClock } from '@shared/timeFormat';
import type { AccountSummary, Position } from '@shared/types';
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
  liveMark,
  pctLabel,
  positionRow,
  chainTarget,
  positionTarget,
  qtyLabel,
  quoteContract,
  rowSize,
  sectorOf,
  sortRows,
  underlyingOf,
} from './calc';

function position(over: Partial<Position> = {}): Position {
  return {
    account: 'DU1',
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    quantity: 100,
    averageCost: 200,
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
    // An option opens its own chart, SMART-routed; its chain is in the row's context menu.
    expect(positionTarget(call)).toEqual({ contract: quoteContract(call), view: 'chart' });
    expect(chainTarget(call)).toEqual({ contract: stock('AAPL'), view: 'opt' });
    expect(positionTarget({ ...stock('NVDA'), conId: 4815747, exchange: 'NASDAQ' })).toEqual({ contract: stock('NVDA'), view: 'chart' });
  });
});

describe('positionRow', () => {
  // Paper DUP899854, AAPL overnight 2026-10-05: the portfolio update marks at 333.50, IB's P&L engine
  // (reqPnLSingle) at about 332.86. The row shows each of IB's figures as IB sends it, the real-time one first.
  const overnight = position({
    averageCost: 332.952003,
    marketPrice: 333.5,
    marketValue: 33_350,
    unrealizedPnL: 54.8,
    realizedPnL: 0,
    dailyPnL: -9.20156484375184,
    pnlValue: 33_285.99853515625,
    pnlUnrealized: -9.201764843746787,
    pnlRealized: 0,
  });

  it('shows IB’s real-time figures first: the mark and reqPnLSingle', () => {
    const r = positionRow(overnight, 332.86, 'Technology');
    expect(r).toMatchObject({
      price: 332.86,
      priceSource: 'mark',
      value: 33_285.99853515625,
      valueSource: 'pnl',
      unrealized: -9.201764843746787,
      unrealizedSource: 'pnl',
      realized: 0,
      realizedSource: 'pnl',
      // As IB sends it: never re-marked to another price.
      dayPnl: -9.20156484375184,
    });
  });

  it('falls back to the portfolio update per figure, each on its own', () => {
    // No mark and no reqPnLSingle yet: every figure from the portfolio update (every 3 minutes).
    const ib = positionRow({ ...overnight, pnlValue: undefined, pnlUnrealized: undefined, pnlRealized: undefined, dailyPnL: undefined }, undefined, 'x');
    expect(ib).toMatchObject({
      price: 333.5,
      priceSource: 'portfolio',
      value: 33_350,
      valueSource: 'portfolio',
      unrealized: 54.8,
      unrealizedSource: 'portfolio',
      realized: 0,
      realizedSource: 'portfolio',
    });
    // The day's P&L has no other source: none.
    expect(ib.dayPnl).toBeUndefined();
    // IB cleared one reqPnLSingle figure ("no value"): only that one falls back.
    const mixed = positionRow({ ...overnight, pnlUnrealized: undefined }, 332.86, 'x');
    expect(mixed).toMatchObject({ valueSource: 'pnl', unrealized: 54.8, unrealizedSource: 'portfolio', realizedSource: 'pnl', priceSource: 'mark' });
  });

  it('takes the price from IB’s mark (tick 37), else the portfolio update’s marketPrice', () => {
    expect(positionRow(overnight, 332.86, 'x')).toMatchObject({ price: 332.86, priceSource: 'mark' });
    // No mark on the line (none sent yet, or IB's −1 / 0 "no price"): the portfolio update's.
    for (const mark of [undefined, -1, 0, NaN]) expect(positionRow(overnight, mark, 'x')).toMatchObject({ price: 333.5, priceSource: 'portfolio' });
    // Neither: unknown, with no source.
    const bare = positionRow(position(), undefined, 'x');
    expect(bare.price).toBeUndefined();
    expect(bare.priceSource).toBeUndefined();
  });

  it('takes no mark from a line that no longer sends data', () => {
    // The line limit gave the position's slot to a visible view: the quote keeps its last mark.
    const evicted = { mark: 332.86, error: { code: -1, message: 'Market data line limit reached', final: true } };
    expect(liveMark(evicted)).toBeUndefined();
    expect(positionRow(overnight, liveMark(evicted), 'x')).toMatchObject({ price: 333.5, priceSource: 'portfolio' });
    // A passing error (data comes again on the same line) keeps it, as does a line without one.
    expect(liveMark({ mark: 332.86, error: { code: 10197, message: 'No market data during competing live session' } })).toBe(332.86);
    expect(liveMark({ mark: 332.86 })).toBe(332.86);
    expect(liveMark(undefined)).toBeUndefined();
  });

  it('computes nothing: no value, P&L or percent from the price or the cost', () => {
    // A mark, an average cost and a quantity, but no IB value or P&L: they stay unknown.
    const r = positionRow(position({ quantity: 100, averageCost: 200 }), 227.48, 'x');
    expect(r.price).toBe(227.48);
    expect([r.value, r.unrealized, r.realized, r.dayPnl]).toEqual([undefined, undefined, undefined, undefined]);
    expect([r.valueSource, r.unrealizedSource, r.realizedSource]).toEqual([undefined, undefined, undefined]);
    expect(Object.keys(r).sort()).toEqual([
      'dayPnl',
      'fx',
      'key',
      'position',
      'price',
      'priceSource',
      'realized',
      'realizedSource',
      'sector',
      'unrealized',
      'unrealizedSource',
      'value',
      'valueSource',
    ]);
  });

  it('keeps IB’s figures of an option per contract, shorts negative, as sent', () => {
    const put = position({ key: 'OPT:SPY', contract: option('SPY', '20261120', 560, 'P'), quantity: -5, averageCost: 680, multiplier: 100, pnlValue: -2_550, pnlUnrealized: 850 });
    const r = positionRow(put, 5.1, ETF_SECTOR);
    expect(r).toMatchObject({ price: 5.1, value: -2_550, unrealized: 850 });
    expect(r.position.averageCost).toBe(680);
  });

  it('carries IB’s exchange rate of a foreign-currency position', () => {
    const sap = position({ key: 'STK:SAP:EUR', contract: { ...stock('SAP', 'IBIS'), currency: 'EUR' }, quantity: 50, pnlValue: 11_000 });
    expect(positionRow(sap, 220, 'Technology', 1.08)).toMatchObject({ value: 11_000, fx: 1.08 });
    // Without the rate: unknown, never 1.
    expect(positionRow(sap, 220, 'Technology', null).fx).toBeUndefined();
    expect(positionRow(position(), 210, 'x').fx).toBe(1);
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

  it('formats fractional quantities', () => {
    expect(qtyLabel(1_200)).toBe('1,200');
    expect(qtyLabel(-5)).toBe('−5');
    expect(qtyLabel(0.0153)).toBe('0.0153');
    expect(qtyLabel(10.5)).toBe('10.5');
    expect(qtyLabel(-1_234.25)).toBe('−1,234.25');
    expect(qtyLabel(2.00001)).toBe('2');
    expect(qtyLabel(undefined)).toBe('—');
  });

  it('orders rows by |Value| in the account currency, unknown values last', () => {
    const a = positionRow(position({ key: 'a', marketValue: -5_000 }), undefined, 'x');
    const b = positionRow(position({ key: 'b', pnlValue: 3_000 }), undefined, 'x');
    const c = positionRow(position({ key: 'c' }), undefined, 'x');
    // 50,000 HKD at 0.128: 6,400 in the account currency, more than b, less than a.
    const hk = positionRow(position({ key: 'hk', contract: { ...stock('700'), currency: 'HKD' }, marketValue: 50_000 }), undefined, 'x', 0.128);
    expect(rowSize(hk)).toBeCloseTo(6_400);
    expect(rowSize(c)).toBe(-1);
    expect(sortRows([c, b, hk, a]).map((r) => r.key)).toEqual(['hk', 'a', 'b', 'c']);
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
