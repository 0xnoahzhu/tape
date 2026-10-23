import { describe, expect, it } from 'vitest';
import { index, option, stock } from '@shared/contract';
import { underlyingOf } from './data';

describe('the chain shown for the selected instrument', () => {
  it('shows a stock’s or an index’s own chain', () => {
    expect(underlyingOf(stock('AAPL'))).toEqual(stock('AAPL'));
    expect(underlyingOf(index('SPX', 'CBOE'))).toEqual(index('SPX', 'CBOE'));
  });

  it('keeps the chain an option was charted from', () => {
    const sox = index('SOX', 'NASDAQ');
    expect(underlyingOf(option('SOX', '20261120', 5000, 'C'), sox)).toBe(sox);
    expect(underlyingOf(option('AAPL', '20261120', 260, 'C'), sox)).toEqual(stock('AAPL'));
    expect(underlyingOf({ ...option('SOX', '20261120', 5000, 'C'), currency: 'EUR' }, sox)).toEqual({ ...stock('SOX'), currency: 'EUR' });
  });

  it('maps another option as a position does: the index for index options, else the stock', () => {
    expect(underlyingOf(option('AAPL', '20261120', 260, 'C'))).toEqual(stock('AAPL'));
    expect(underlyingOf(option('SPX', '20261120', 6000, 'P', { tradingClass: 'SPXW' }), null)).toEqual(index('SPX', 'CBOE'));
  });

  it('shows no chain for other instruments', () => {
    expect(underlyingOf({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218' })).toBeNull();
  });
});
