import { describe, expect, it } from 'vitest';
import { accountValueField, exchangeRateOf } from './account';

describe('accountValueField', () => {
  it('reads the plain keys from the BASE row only', () => {
    expect(accountValueField('StockMarketValue', 'BASE')).toBe('stockMarketValue');
    expect(accountValueField('OptionMarketValue', 'BASE')).toBe('optionMarketValue');
    // A currency's own row holds only that currency's positions, the account currency's row too.
    expect(accountValueField('StockMarketValue', 'USD')).toBeUndefined();
    expect(accountValueField('StockMarketValue', 'HKD')).toBeUndefined();
    expect(accountValueField('StockMarketValue', '')).toBeUndefined();
    expect(accountValueField('NetLiquidation', 'BASE')).toBeUndefined();
  });

  it('reads the ledger keys of paper accounts from the BASE row only', () => {
    expect(accountValueField('$LEDGER-StockMarketValue', 'BASE')).toBe('stockMarketValue');
    expect(accountValueField('$LEDGER-OptionMarketValue', 'BASE')).toBe('optionMarketValue');
    // A currency's own ledger holds only that currency's positions.
    expect(accountValueField('$LEDGER-StockMarketValue', 'USD')).toBeUndefined();
    expect(accountValueField('$LEDGER-Cushion', 'BASE')).toBeUndefined();
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
