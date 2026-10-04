import { describe, expect, it } from 'vitest';
import type { ContractDetails } from '../ib/tws';
import { index, option, stock } from '@shared/contract';
import type { SymbolMatch } from '@shared/types';
import { fromIbContract, pickDetails, sortMatches, toContractInfo, toIbContract, toSymbolMatch } from './ibContract';

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
    });
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
