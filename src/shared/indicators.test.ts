import { describe, expect, it } from 'vitest';
import { boll, crossed, ema, kdj, macd, rsi, sma, type Series } from './indicators';

/** Rounds a series for comparison with hand-computed values (undefined stays). */
const r = (s: Series, digits = 6) => s.map((x) => (x === undefined ? undefined : Number(x.toFixed(digits))));

describe('sma', () => {
  it('averages the last n values once n are there', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
    expect(sma([1, 2], 1)).toEqual([1, 2]);
  });

  it('is undefined everywhere for an invalid period', () => {
    expect(sma([1, 2, 3], 0)).toEqual([undefined, undefined, undefined]);
    expect(sma([1, 2, 3], 1.5)).toEqual([undefined, undefined, undefined]);
  });
});

describe('ema', () => {
  it('uses α = 2 / (n + 1) seeded with the first value (TDX)', () => {
    // α = 0.5: 1, 0.5·2 + 0.5·1 = 1.5, 0.5·3 + 0.75 = 2.25, …
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([1, 1.5, 2.25, 3.125, 4.0625]);
  });

  it('starts at the first defined value', () => {
    expect(ema([undefined, undefined, 4, 6], 3)).toEqual([undefined, undefined, 4, 5]);
  });
});

describe('macd', () => {
  // EMA(2) α = 2/3, EMA(3) α = 1/2, DEA = EMA(DIF, 2); computed by hand with exact fractions.
  const closes = [10, 11, 12, 11, 13, 12];
  const m = macd(closes, 2, 3, 2);

  it('takes DIF = EMA(fast) − EMA(slow) and DEA = EMA(DIF, signal)', () => {
    expect(r(m.dif)).toEqual([0, 0.166667, 0.305556, 0.060185, 0.332562, 0.100437]);
    expect(r(m.dea)).toEqual([0, 0.111111, 0.240741, 0.12037, 0.261831, 0.154235]);
  });

  it('draws the histogram as 2 × (DIF − DEA)', () => {
    expect(r(m.bar)).toEqual([0, 0.111111, 0.12963, -0.12037, 0.141461, -0.107596]);
  });
});

describe('kdj', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 10, close: 12 },
    { high: 12, low: 9, close: 9 },
    { high: 10, low: 8, close: 10 },
  ];

  it('smooths RSV over n bars from K = D = 50, J = 3K − 2D', () => {
    const { k, d, j } = kdj(bars, 3, 3, 3);
    // RSV: 50, 66.67 (10 in 8–11), 100, 0, 50 (10 in 8–12).
    expect(r(k, 4)).toEqual([50, 55.5556, 70.3704, 46.9136, 47.9424]);
    expect(r(d, 4)).toEqual([50, 51.8519, 58.0247, 54.321, 52.1948]);
    expect(r(j, 4)).toEqual([50, 62.963, 95.0617, 32.0988, 39.4376]);
  });

  it('keeps K and D through a run of flat bars', () => {
    const flat = [...bars, { high: 10, low: 10, close: 10 }, { high: 10, low: 10, close: 10 }, { high: 10, low: 10, close: 10 }];
    const { k, d } = kdj(flat, 3, 3, 3);
    expect(k[7]).toBe(k[6]);
    expect(d[7]).toBe(d[6]);
  });
});

describe('rsi', () => {
  it("smooths gains and moves with Wilder's 1/n, seeded with the first change", () => {
    // Δ: +1, −0.5, +1.5, −1 → 100, 80, 89.47, 60.71
    expect(r(rsi([10, 11, 10.5, 12, 11], 3), 4)).toEqual([undefined, 100, 80, 89.4737, 60.7143]);
  });

  it('keeps its value while the closes do not move, and has none before they do', () => {
    expect(rsi([5, 5, 5], 6)).toEqual([undefined, undefined, undefined]);
    const s = rsi([5, 6, 6, 6], 6);
    expect(s[3]).toBeCloseTo(100);
  });
});

describe('boll', () => {
  it('puts the bands k population standard deviations around MA(n)', () => {
    const { mid, upper, lower } = boll([1, 2, 3, 4, 5], 3, 2);
    // σ of (1, 2, 3) = √(2/3) = 0.816497
    expect(mid).toEqual([undefined, undefined, 2, 3, 4]);
    expect(r(upper)).toEqual([undefined, undefined, 3.632993, 4.632993, 5.632993]);
    expect(r(lower)).toEqual([undefined, undefined, 0.367007, 1.367007, 2.367007]);
  });
});

describe('crossed', () => {
  it('needs a − b at or below zero before and above it now (up), mirrored for down', () => {
    expect(crossed('up', -1, 0.5)).toBe(true);
    expect(crossed('up', 0, 0.5)).toBe(true);
    expect(crossed('up', 0.1, 0.5)).toBe(false);
    expect(crossed('up', -1, 0)).toBe(false);
    expect(crossed('down', 1, -0.5)).toBe(true);
    expect(crossed('down', 0, -0.5)).toBe(true);
    expect(crossed('down', -0.1, -0.5)).toBe(false);
  });
});
