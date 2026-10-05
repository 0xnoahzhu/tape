import { describe, expect, it } from 'vitest';
import { commissionText, marginText } from './Dialogs';

describe('order estimate texts', () => {
  it('writes the commission as an amount or IB’s range', () => {
    expect(commissionText({ commission: 1, commissionCurrency: 'USD' })).toBe('1.00 USD');
    expect(commissionText({ minCommission: 1, maxCommission: 1.35, commissionCurrency: 'USD' })).toBe('1.00 – 1.35 USD');
    expect(commissionText({ minCommission: 2, maxCommission: 2 })).toBe('2.00');
    expect(commissionText({})).toBeNull();
    // IB's placeholder 0 next to a range shows the range.
    expect(commissionText({ commission: 0, minCommission: 0.01, maxCommission: 0.013, commissionCurrency: 'USD' })).toBe('0.010 – 0.013 USD');
    expect(commissionText({ commission: 0, commissionCurrency: 'USD' })).toBe('0.00 USD');
  });

  it('writes the margin change with before → after under it', () => {
    expect(marginText({ before: 11005.5, change: 110.06, after: 11115.56 })).toEqual({ value: '+110.06', sub: '11,005.50 → 11,115.56' });
    expect(marginText({ change: -5 })).toEqual({ value: '−5.00', sub: undefined });
    expect(marginText({ after: 10 })).toEqual({ value: '10.00' });
    expect(marginText(undefined)).toBeNull();
  });
});
