import { describe, expect, it } from 'vitest';
import type { ContractDetails } from '../ib/tws';
import { index, option, stock } from '@shared/contract';
import type { SymbolMatch } from '@shared/types';
import { fromIbContract, lastTradeTimeOf, pickDetails, sortMatches, toContractInfo, toIbContract, toSymbolMatch } from './ibContract';

describe('toIbContract', () => {
  it('describes stocks, options and indices', () => {
    expect(toIbContract(stock('AAPL', 'NASDAQ'))).toEqual({ symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExch: 'NASDAQ' });
    expect(toIbContract(option('AAPL', '20261016', 230, 'C', { tradingClass: 'AAPL' }))).toEqual({
      symbol: 'AAPL',
      secType: 'OPT',
      exchange: 'SMART',
      currency: 'USD',
      lastTradeDateOrContractMonth: '20261016',
      strike: 230,
      right: 'C',
      multiplier: 100,
      tradingClass: 'AAPL',
    });
    expect(toIbContract(index('SPX', 'CBOE'))).toEqual({ symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' });
  });

  it('uses the conId alone once resolved, with SMART for an empty exchange', () => {
    expect(toIbContract({ ...stock('AAPL'), exchange: '', conId: 265598 })).toEqual({ conId: 265598, exchange: 'SMART', secType: 'STK', currency: 'USD' });
  });

  it('never sends a stock multiplier', () => {
    expect(toIbContract({ ...stock('AAPL'), multiplier: 1 }).multiplier).toBeUndefined();
  });

  it('passes combo legs', () => {
    const c = toIbContract({
      symbol: 'AAPL',
      secType: 'BAG',
      exchange: 'SMART',
      currency: 'USD',
      comboLegs: [{ conId: 1, ratio: 1, action: 'BUY', exchange: 'SMART' }],
    });
    expect(c.comboLegs).toEqual([{ conId: 1, ratio: 1, action: 'BUY', exchange: 'SMART' }]);
  });
});

describe('fromIbContract / toContractInfo', () => {
  it('maps a resolved option contract', () => {
    const ref = fromIbContract({
      symbol: 'AAPL',
      secType: 'OPT',
      lastTradeDateOrContractMonth: '20261016 16:00:00 US/Eastern',
      strike: 230,
      right: 'C' as never,
      exchange: 'SMART',
      currency: 'USD',
      localSymbol: 'AAPL  261016C00230000',
      tradingClass: 'AAPL',
      conId: 855958685,
      multiplier: 100,
      primaryExch: '',
    });
    expect(ref).toEqual({
      symbol: 'AAPL',
      secType: 'OPT',
      exchange: 'SMART',
      currency: 'USD',
      conId: 855958685,
      lastTradeDate: '20261016',
      strike: 230,
      right: 'C',
      multiplier: 100,
      localSymbol: 'AAPL  261016C00230000',
      tradingClass: 'AAPL',
    });
  });

  it('builds ContractInfo from details', () => {
    const d = {
      contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: 265598, primaryExch: 'NASDAQ', multiplier: 0, strike: 0, localSymbol: 'AAPL', tradingClass: 'NMS' },
      longName: 'APPLE INC',
      industry: 'Technology',
      category: 'Computers',
      subcategory: 'Computers',
      minTick: 0.01,
      timeZoneId: 'US/Eastern',
      tradingHours: '20261005:0400-20261005:2000',
      liquidHours: '20261005:0930-20261005:1600',
      validExchanges: 'SMART,AMEX,NYSE',
      orderTypes: 'ACTIVETIM,AD,LMT',
    } as unknown as ContractDetails;
    const info = toContractInfo(d, stock('AAPL'));
    expect(info).toEqual({
      contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: 265598, primaryExchange: 'NASDAQ', localSymbol: 'AAPL', tradingClass: 'NMS' },
      longName: 'APPLE INC',
      industry: 'Technology',
      category: 'Computers',
      subcategory: 'Computers',
      minTick: 0.01,
      timeZoneId: 'US/Eastern',
      tradingHours: '20261005:0400-20261005:2000',
      liquidHours: '20261005:0930-20261005:1600',
      validExchanges: ['SMART', 'AMEX', 'NYSE'],
      orderTypes: ['ACTIVETIM', 'AD', 'LMT'],
      v: 2,
    });
  });

  // Server 193, October 2026 probe of the paper account.
  const details = (contract: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ contract, minTick: 0.01, ...extra }) as unknown as ContractDetails;

  it('keeps a stock’s ISIN and market name (version 2)', () => {
    const d = details(
      { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: 265598, primaryExch: 'NASDAQ', tradingClass: 'NMS' },
      { longName: 'APPLE INC', secIdList: [{ tag: 'ISIN', value: 'US0378331005' }], marketName: 'NMS', contractMonth: '', realExpirationDate: '', underSymbol: '', underConId: 0, stockType: 'COMMON', timeZoneId: 'US/Eastern' },
    );
    const info = toContractInfo(d, stock('AAPL'));
    expect(info).toMatchObject({ v: 2, isin: 'US0378331005', marketName: 'NMS', stockType: 'COMMON' });
    for (const k of ['contractMonth', 'realExpirationDate', 'lastTradeTime', 'lastTradeZone', 'underSymbol', 'underConId', 'underSecType', 'bond'] as const) expect(info[k], k).toBeUndefined();
  });

  it('takes an option’s month, expiration, last trading time and underlying', () => {
    const d = details(
      {
        symbol: 'AAPL',
        secType: 'OPT',
        lastTradeDateOrContractMonth: '20261016 16:00:00 US/Eastern',
        lastTradeDate: '20261016',
        strike: 335,
        right: 'C',
        exchange: 'SMART',
        currency: 'USD',
        localSymbol: 'AAPL  261016C00335000',
        tradingClass: 'AAPL',
        conId: 855959259,
        multiplier: 100,
      },
      { secIdList: undefined, marketName: 'AAPL', contractMonth: '202610', realExpirationDate: '20261016', underSymbol: 'AAPL', underConId: 265598, underSecType: 'STK', stockType: '', timeZoneId: 'US/Eastern' },
    );
    const info = toContractInfo(d, option('AAPL', '20261016', 335, 'C'));
    expect(info).toMatchObject({
      contract: { lastTradeDate: '20261016' },
      marketName: 'AAPL',
      contractMonth: '202610',
      realExpirationDate: '20261016',
      lastTradeTime: '16:00:00',
      lastTradeZone: 'US/Eastern',
      underSymbol: 'AAPL',
      underConId: 265598,
      underSecType: 'STK',
    });
    expect(info.isin).toBeUndefined();
  });

  it('takes a future’s and a futures option’s underlying', () => {
    const fut = details(
      { symbol: 'ES', secType: 'FUT', lastTradeDateOrContractMonth: '20261218 08:30:00 US/Central', lastTradeDate: '20261218', exchange: 'CME', currency: 'USD', localSymbol: 'ESZ6', tradingClass: 'ES', conId: 515416632, multiplier: 50 },
      { marketName: 'ES', contractMonth: '202612', realExpirationDate: '20261218', underSymbol: 'ES', underConId: 11004968, underSecType: 'IND', timeZoneId: 'US/Central' },
    );
    const esz6 = toContractInfo(fut, { symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218' });
    expect(esz6).toMatchObject({ contractMonth: '202612', lastTradeTime: '08:30:00', lastTradeZone: 'US/Central', underSymbol: 'ES', underConId: 11004968, underSecType: 'IND' });
    const fop = details(
      { symbol: 'ES', secType: 'FOP', lastTradeDateOrContractMonth: '20261016 15:00:00 US/Central', lastTradeDate: '20261016', strike: 7880, right: 'C', exchange: 'CME', currency: 'USD', tradingClass: 'EW3', conId: 919511013, multiplier: 50 },
      { underSymbol: 'ESZ6', underConId: 515416632, underSecType: 'FUT' },
    );
    expect(toContractInfo(fop, { symbol: 'ES', secType: 'FOP', exchange: 'CME', currency: 'USD' })).toMatchObject({ underSymbol: 'ESZ6', underConId: 515416632, underSecType: 'FUT', lastTradeTime: '15:00:00' });
  });

  it('reads the last trading time as older servers split it, in the instrument’s zone', () => {
    const d = (lastTradeDateOrContractMonth: string, extra: Record<string, unknown> = {}) => details({ symbol: 'X', secType: 'OPT', lastTradeDateOrContractMonth }, extra);
    expect(lastTradeTimeOf(d('20261016', { lastTradeTime: '16:00:00', timeZoneId: 'US/Eastern' }))).toEqual({ time: '16:00:00', zone: 'US/Eastern' });
    expect(lastTradeTimeOf(d('20261016 16:00', { timeZoneId: 'US/Eastern' }))).toEqual({ time: '16:00', zone: 'US/Eastern' });
    expect(lastTradeTimeOf(d('20261016 16:00:00'))).toEqual({ time: '16:00:00' });
    expect(lastTradeTimeOf(d('20261016'))).toEqual({});
    expect(lastTradeTimeOf(d('202612'))).toEqual({});
  });

  it('keeps a bond’s contract and its bond details', () => {
    // What bondContractDetails decodes to (ib/tws/decoder.ts): the contract and the bond fields side by side.
    const d = details(
      { symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 742000123, tradingClass: 'US-T' },
      {
        longName: 'United States Treasury',
        minTick: 0.0001,
        cusip: '91282CLW9',
        coupon: 4.25,
        maturity: '20341115',
        issueDate: '20241115',
        bondType: 'US-T',
        couponType: 'FIXED',
        callable: false,
        putable: false,
        convertible: false,
        descAppend: 'T 4 1/4 11/15/34',
        notes: '',
        marketName: 'US-T',
        secIdList: [{ tag: 'ISIN', value: 'US91282CLW90' }],
      },
    );
    const info = toContractInfo(d, { symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 742000123 });
    expect(info).toMatchObject({
      contract: { symbol: 'US-T', secType: 'BOND', conId: 742000123 },
      longName: 'United States Treasury',
      minTick: 0.0001,
      isin: 'US91282CLW90',
      bond: { cusip: '91282CLW9', coupon: 4.25, maturity: '20341115', issueDate: '20241115', bondType: 'US-T', couponType: 'FIXED', callable: false, putable: false, convertible: false, descAppend: 'T 4 1/4 11/15/34' },
    });
    expect(info.bond?.notes).toBeUndefined();
    // Server 193's "date time zone" form, which the decoder keeps whole: the maturity is its date.
    const zoned = toContractInfo({ ...d, maturity: '20341115 16:00:00 US/Eastern' } as ContractDetails, { symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 742000123 });
    expect(zoned.bond?.maturity).toBe('20341115');
  });

  it('drops the "*" subcategory of indices', () => {
    const d = { contract: { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD', conId: 416904 }, longName: 'S&P 500 Stock Index', subcategory: '*', minTick: 0.01 } as unknown as ContractDetails;
    expect(toContractInfo(d, index('SPX', 'CBOE')).subcategory).toBeUndefined();
  });
});

describe('pickDetails', () => {
  const d = (exchange: string, currency: string, conId: number) => ({ contract: { symbol: 'AAPL', secType: 'STK', exchange, currency, conId } }) as unknown as ContractDetails;

  it('prefers the SMART / USD listing of a stock', () => {
    const list = [d('AMEX', 'USD', 1), d('SMART', 'CHF', 2), d('SMART', 'USD', 3), d('MEXI', 'MXN', 4)];
    expect(pickDetails(list, { ...stock('AAPL'), exchange: '' })?.contract.conId).toBe(3);
  });

  it('returns null for no results', () => {
    expect(pickDetails([], stock('AAPL'))).toBeNull();
  });
});

describe('symbol search results', () => {
  it('converts descriptions and skips unsupported types', () => {
    expect(
      toSymbolMatch({
        contract: { conId: 265598, symbol: 'AAPL', secType: 'STK' as never, primaryExch: 'NASDAQ', currency: 'USD', description: 'APPLE INC' },
        derivativeSecTypes: ['CFD', 'OPT'] as never,
      }),
    ).toEqual({
      contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: 265598, primaryExchange: 'NASDAQ' },
      description: 'APPLE INC',
      derivativeSecTypes: ['CFD', 'OPT'],
    });
    expect(toSymbolMatch({ contract: { symbol: '', secType: 'BOND' as never } })).toBeNull();
    expect(toSymbolMatch({ contract: { symbol: 'AUD', secType: 'CASH' as never } })).toBeNull();
    expect(toSymbolMatch({ contract: { symbol: 'SPX', secType: 'IND' as never, primaryExch: 'CBOE', currency: 'USD' } })?.contract.exchange).toBe('CBOE');
  });

  it('sorts USD stocks and indices first, exact symbol first, IB order otherwise', () => {
    const m = (symbol: string, secType: 'STK' | 'IND' | 'CRYPTO', currency: string): SymbolMatch => ({
      contract: { symbol, secType, exchange: 'SMART', currency },
      description: '',
      derivativeSecTypes: [],
    });
    const sorted = sortMatches(
      [m('A', 'STK', 'EUR'), m('AAVE', 'CRYPTO', 'USD'), m('AAPL', 'STK', 'USD'), m('AMZN', 'STK', 'USD'), m('A', 'STK', 'USD'), m('AP', 'IND', 'AUD')],
      'a',
    );
    expect(sorted.map((x) => `${x.contract.symbol}/${x.contract.currency}`)).toEqual(['A/USD', 'AAPL/USD', 'AMZN/USD', 'A/EUR', 'AP/AUD', 'AAVE/USD']);
  });
});
