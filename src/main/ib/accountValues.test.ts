import { describe, expect, it } from 'vitest';
import { accountValueField, exchangeRateOf } from './account';

describe('accountValueField', () => {
  it('reads the plain keys in the account currency', () => {
    expect(accountValueField('StockMarketValue', 'USD', 'USD')).toBe('stockMarketValue');
    expect(accountValueField('OptionMarketValue', 'USD', undefined)).toBe('optionMarketValue');
    expect(accountValueField('StockMarketValue', 'EUR', 'USD')).toBeUndefined();
    expect(accountValueField('NetLiquidation', 'USD', 'USD')).toBeUndefined();
  });

  it('reads the ledger keys of paper accounts from the BASE row only', () => {
    expect(accountValueField('$LEDGER-StockMarketValue', 'BASE', 'USD')).toBe('stockMarketValue');
    expect(accountValueField('$LEDGER-OptionMarketValue', 'BASE', 'USD')).toBe('optionMarketValue');
    // A currency's own ledger holds only that currency's positions.
    expect(accountValueField('$LEDGER-StockMarketValue', 'USD', 'USD')).toBeUndefined();
    expect(accountValueField('$LEDGER-Cushion', 'BASE', 'USD')).toBeUndefined();
  });
});

describe('exchangeRateOf', () => {
  it('reads the exchange rate rows of every currency but BASE', () => {
    expect(exchangeRateOf('ExchangeRate', 'EUR')).toBe('EUR');
    expect(exchangeRateOf('$LEDGER-ExchangeRate', 'EUR')).toBe('EUR');
    expect(exchangeRateOf('$LEDGER-ExchangeRate', 'USD')).toBe('USD');
    expect(exchangeRateOf('$LEDGER-ExchangeRate', 'BASE')).toBeUndefined();
    expect(exchangeRateOf('ExchangeRate', '')).toBeUndefined();
    expect(exchangeRateOf('StockMarketValue', 'EUR')).toBeUndefined();
  });
});
