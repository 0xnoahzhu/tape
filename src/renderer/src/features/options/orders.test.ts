import { describe, expect, it } from 'vitest';
import { comboContract, comboTerms, defaultTrigger, gcd, limitOrder } from './orders';

describe('comboTerms', () => {
  it('prices a debit vertical as BUY', () => {
    const t = comboTerms([
      { side: 'BUY', ratio: 1, price: 3.4 },
      { side: 'SELL', ratio: 1, price: 1.2 },
    ]);
    expect(t).toEqual({ action: 'BUY', quantity: 1, ratios: [1, 1], legActions: ['BUY', 'SELL'], limitPrice: 2.2 });
  });

  it('sends a credit as SELL with a positive price and reversed legs', () => {
    const t = comboTerms([
      { side: 'SELL', ratio: 1, price: 2.5 },
      { side: 'BUY', ratio: 1, price: 0.9 },
    ]);
    expect(t.action).toBe('SELL');
    expect(t.limitPrice).toBeCloseTo(1.6, 9);
    expect(t.legActions).toEqual(['BUY', 'SELL']);
  });

  it('reduces common ratios into the quantity', () => {
    const t = comboTerms([
      { side: 'BUY', ratio: 2, price: 5 },
      { side: 'SELL', ratio: 4, price: 2 },
      { side: 'BUY', ratio: 2, price: 0.5 },
    ]);
    expect(t.quantity).toBe(2);
    expect(t.ratios).toEqual([1, 2, 1]);
    expect(t.limitPrice).toBeCloseTo(1.5, 9);
  });

  it('keeps a minimum tick', () => {
    expect(comboTerms([{ side: 'BUY', ratio: 1, price: 0 }]).limitPrice).toBe(0.01);
  });

  it('gcd', () => {
    expect(gcd(100, 1)).toBe(1);
    expect(gcd(4, 6)).toBe(2);
  });
});

describe('requests', () => {
  it('builds the BAG contract', () => {
    const c = comboContract('AAPL', [
      { conId: 11, ratio: 1, action: 'BUY' },
      { conId: 12, ratio: 1, action: 'SELL' },
    ]);
    expect(c).toEqual({
      symbol: 'AAPL',
      secType: 'BAG',
      exchange: 'SMART',
      currency: 'USD',
      comboLegs: [
        { conId: 11, ratio: 1, action: 'BUY', exchange: 'SMART' },
        { conId: 12, ratio: 1, action: 'SELL', exchange: 'SMART' },
      ],
    });
  });

  it('builds a DAY limit order with an optional condition', () => {
    const c = comboContract('AAPL', []);
    expect(limitOrder(c, 'BUY', 1, 2.2)).toEqual({ contract: c, action: 'BUY', orderType: 'LMT', quantity: 1, limitPrice: 2.2, tif: 'DAY', outsideRth: false });
    const cond = { contract: c, operator: '>=' as const, price: 230, outsideRth: false };
    expect(limitOrder(c, 'SELL', 1, 1, cond).condition).toBe(cond);
  });

  it('defaults the trigger 3% away', () => {
    expect(defaultTrigger(200, '>=')).toBe('206.00');
    expect(defaultTrigger(200, '<=')).toBe('194.00');
  });
});
