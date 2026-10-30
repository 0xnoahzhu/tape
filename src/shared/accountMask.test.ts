import { describe, expect, it } from 'vitest';
import { maskAccountIds } from './accountMask';

describe('maskAccountIds', () => {
  it('keeps PAPER / LIVE of a tag and reads "—" for any other mention', () => {
    expect(maskAccountIds('Buy 100 AAPL · LIVE U18630011', ['U18630011'])).toBe('Buy 100 AAPL · LIVE');
    expect(maskAccountIds('卖出 1 SPY · 模拟 DUP899854', ['DUP899854'])).toBe('卖出 1 SPY · 模拟');
    expect(maskAccountIds('Order rejected - reason: account U18630011 (201)', ['U18630011'])).toBe('Order rejected - reason: account — (201)');
  });

  it('replaces whole ids only, the longest first', () => {
    expect(maskAccountIds('U123456 U1234567 U12345678 XU123456', ['U123456', 'U1234567'])).toBe('— — U12345678 XU123456');
    expect(maskAccountIds('acct=DU1,DU2.', ['DU1', 'DU2'])).toBe('acct=—,—.');
  });

  it('changes nothing without known ids, and skips empty ones', () => {
    expect(maskAccountIds('LIVE U18630011', [])).toBe('LIVE U18630011');
    expect(maskAccountIds('LIVE U18630011', [null, undefined, ''])).toBe('LIVE U18630011');
  });
});
