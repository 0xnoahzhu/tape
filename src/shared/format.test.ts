import { describe, expect, it } from 'vitest';
import { compact, compactMyriad, exactCompact, parseQuantity, roundToTick, usd } from './format';

describe('compactMyriad', () => {
  const units = { wan: 'W', yi: 'Y' };

  it('counts in myriads (10⁴) and hundred millions (10⁸), two decimals at most', () => {
    expect(compactMyriad(5_000, units)).toBe('5000');
    expect(compactMyriad(12_000, units)).toBe('1.2W');
    expect(compactMyriad(10_000_000, units)).toBe('1000W');
    expect(compactMyriad(10_200_000, units)).toBe('1020W');
    expect(compactMyriad(12_345_678, units)).toBe('1234.57W');
    expect(compactMyriad(1_000_000_000, units)).toBe('10Y');
    expect(compactMyriad(1_234_567_890, units)).toBe('12.35Y');
    expect(compactMyriad(-12_000, units)).toBe('−1.2W');
    expect(compactMyriad(undefined, units)).toBe('—');
  });

  it('moves to the next unit when rounding reaches it', () => {
    expect(compactMyriad(9_999.6, units)).toBe('1W');
    expect(compactMyriad(99_999_999.9, units)).toBe('1Y');
  });
});

describe('exactCompact', () => {
  it('writes a threshold exactly: a unit with at most two decimals, else every digit', () => {
    expect(exactCompact(1_250_000)).toBe('1.25M');
    expect(exactCompact(10_000_000)).toBe('10M');
    expect(exactCompact(1_500_000_000)).toBe('1.5B');
    expect(exactCompact(15_250)).toBe('15.25K');
    expect(exactCompact(8_200)).toBe('8,200');
    expect(exactCompact(12_345_678)).toBe('12,345,678');
    expect(exactCompact(1_234_567.5)).toBe('1,234,567.5');
    expect(exactCompact(undefined)).toBe('—');
  });

  it('counts in myriads for zh', () => {
    const units = { wan: 'W', yi: 'Y' };
    expect(exactCompact(1_250_000, units)).toBe('125W');
    expect(exactCompact(12_500, units)).toBe('1.25W');
    expect(exactCompact(1e9, units)).toBe('10Y');
    expect(exactCompact(5_000, units)).toBe('5000');
    expect(exactCompact(12_345_678, units)).toBe('12,345,678');
  });
});

describe('compact', () => {
  it('uses K / M / B units', () => {
    expect(compact(8_200)).toBe('8,200');
    expect(compact(12_345)).toBe('12.3K');
    expect(compact(12_400_000)).toBe('12.4M');
    expect(compact(3_210_000_000)).toBe('3.21B');
    expect(compact(-12_400_000)).toBe('−12.4M');
  });

  it('rolls over to the next unit when rounding reaches 1000', () => {
    expect(compact(999_949)).toBe('999.9K');
    expect(compact(999_950)).toBe('1.0M');
    expect(compact(999_999_999)).toBe('1.00B');
    expect(compact(-999_950)).toBe('−1.0M');
  });

  it('drops the sign when the value rounds to zero', () => {
    expect(compact(-0.4)).toBe('0');
  });
});

describe('usd', () => {
  it('formats money with U+2212 for negatives', () => {
    expect(usd(1284530.42)).toBe('$1,284,530.42');
    expect(usd(-12.5)).toBe('−$12.50');
    expect(usd(1234, 0)).toBe('$1,234');
  });

  it('drops the sign when the value rounds to zero', () => {
    expect(usd(-0.004)).toBe('$0.00');
    expect(usd(-0.4, 0)).toBe('$0');
  });
});

describe('roundToTick', () => {
  it('keeps the decimals of quarter and eighth ticks', () => {
    expect(roundToTick(1000.25, 0.25)).toBe(1000.25);
    expect(roundToTick(6800.75, 0.25)).toBe(6800.75);
    expect(roundToTick(6800.8, 0.25)).toBe(6800.75);
    expect(roundToTick(1.125, 0.125)).toBe(1.125);
  });

  it('rounds to small and exponent-notation ticks', () => {
    expect(roundToTick(1.2345, 0.005)).toBe(1.235);
    expect(roundToTick(1.123456, 0.00005)).toBe(1.12345);
    expect(roundToTick(0.0000123, 0.0000005)).toBe(0.0000125);
    expect(roundToTick(228.456, 0.01)).toBe(228.46);
    expect(roundToTick(1234, 5)).toBe(1235);
  });
});

describe('parseQuantity', () => {
  it('reads plain numbers like parseNum', () => {
    expect(parseQuantity('12,000')).toBe(12_000);
    expect(parseQuantity(' 2500.5 ')).toBe(2500.5);
    expect(parseQuantity('.5')).toBe(0.5);
  });

  it('reads K / M / B in any case, with or without a space', () => {
    expect(parseQuantity('10M')).toBe(10_000_000);
    expect(parseQuantity('1.5B')).toBe(1_500_000_000);
    expect(parseQuantity('5k')).toBe(5_000);
    expect(parseQuantity('1.1 m')).toBe(1_100_000);
    expect(parseQuantity('1,200K')).toBe(1_200_000);
  });

  it('reads the Chinese myriad units', () => {
    expect(parseQuantity('1000万')).toBe(10_000_000);
    expect(parseQuantity('2亿')).toBe(200_000_000);
    expect(parseQuantity('1.25 亿')).toBe(125_000_000);
  });

  it('keeps the sign and refuses anything else', () => {
    expect(parseQuantity('−3K')).toBe(-3_000);
    expect(parseQuantity('')).toBeNaN();
    expect(parseQuantity('M')).toBeNaN();
    expect(parseQuantity('10MM')).toBeNaN();
    expect(parseQuantity('10 shares')).toBeNaN();
    expect(parseQuantity('1e6')).toBeNaN();
  });
});
