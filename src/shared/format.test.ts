import { describe, expect, it } from 'vitest';
import { compact, roundToTick, usd } from './format';

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
