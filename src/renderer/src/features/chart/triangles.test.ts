import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { findTriangle, linePrice, MIN_TRIANGLE_BARS } from './triangles';

/**
 * Bars swinging between two lines: the top at `top(i)`, the bottom at `bottom(i)`, a full swing
 * every `period` bars (peaks at i = 0, 8, 16 … for 8), each bar 0.4 high.
 */
function swingBars(n: number, top: (i: number) => number, bottom: (i: number) => number, period = 8, volume = (_i: number) => 1000): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const mid = (top(i) + bottom(i)) / 2;
    const amp = (top(i) - bottom(i)) / 2 - 0.2;
    const p = mid + amp * Math.cos((2 * Math.PI * i) / period);
    return { time: 1_700_000_000 + i * 86_400, open: p, high: p + 0.2, low: p - 0.2, close: p, volume: volume(i) };
  });
}

const kindOf = (bars: Bar[], from = 0, to = bars.length - 1) => findTriangle(bars, from, to).kind;

describe('findTriangle', () => {
  it('finds a symmetrical triangle: highs falling, lows rising, closing in', () => {
    const bars = swingBars(41, (i) => 110 - i * 0.2, (i) => 90 + i * 0.2, 8, (i) => 2000 - i * 30);
    const p = findTriangle(bars, 0, 40);
    expect(p.kind).toBe('symmetrical');
    expect(p.upper!.slope).toBeLessThan(0);
    expect(p.lower!.slope).toBeGreaterThan(0);
    expect(p.upper!.touches.length).toBeGreaterThanOrEqual(3);
    expect(p.lower!.touches.length).toBeGreaterThanOrEqual(3);
    // The gap goes from 20 to 4: 80 % narrower; the lines meet at bar 50, the stretch is 80 % there.
    expect(p.narrowing!).toBeCloseTo(-0.8, 1);
    expect(p.apex!.index).toBeCloseTo(50, 0);
    expect(p.progress!).toBeCloseTo(0.8, 1);
    expect(p.volume!).toBeLessThan(-0.3);
    expect(p.breakout).toBeUndefined();
    // Every bar stays between the lines (give or take the tolerance).
    for (let i = 0; i <= 40; i++) {
      expect(bars[i].high).toBeLessThanOrEqual(linePrice(p.upper!, i) + 0.2);
      expect(bars[i].low).toBeGreaterThanOrEqual(linePrice(p.lower!, i) - 0.2);
    }
  });

  it('either order of the ends is the same stretch', () => {
    const bars = swingBars(41, (i) => 110 - i * 0.2, (i) => 90 + i * 0.2);
    expect(findTriangle(bars, 40, 0)).toEqual(findTriangle(bars, 0, 40));
  });

  it('tells the other triangles, wedges, channels and broadening apart', () => {
    expect(kindOf(swingBars(41, () => 110, (i) => 90 + i * 0.4))).toBe('ascending');
    expect(kindOf(swingBars(41, (i) => 110 - i * 0.4, () => 90))).toBe('descending');
    expect(kindOf(swingBars(41, (i) => 100 + i * 0.3, (i) => 80 + i * 0.7))).toBe('risingWedge');
    expect(kindOf(swingBars(41, (i) => 120 - i * 0.7, (i) => 100 - i * 0.3))).toBe('fallingWedge');
    expect(kindOf(swingBars(41, (i) => 110 + i * 0.3, (i) => 90 + i * 0.3))).toBe('channel');
    expect(kindOf(swingBars(41, (i) => 105 + i * 0.25, (i) => 95 - i * 0.25))).toBe('broadening');
  });

  it('needs enough bars', () => {
    const bars = swingBars(41, (i) => 110 - i * 0.2, (i) => 90 + i * 0.2);
    expect(findTriangle(bars, 3, 3 + MIN_TRIANGLE_BARS - 2)).toMatchObject({ kind: null, why: 'short' });
  });

  it('has no line without a second swing', () => {
    // Straight up: no swing high but the last bar, no swing low but the first.
    const bars = Array.from({ length: 20 }, (_, i): Bar => ({ time: i, open: 100 + i, high: 100.5 + i, low: 99.5 + i, close: 100 + i, volume: 1 }));
    expect(findTriangle(bars, 0, 19)).toMatchObject({ kind: null, why: 'lines' });
  });

  it('reports the first close beyond a line after the stretch', () => {
    const bars = swingBars(41, (i) => 110 - i * 0.2, (i) => 90 + i * 0.2);
    const t = bars[40].time;
    const after = [101, 103, 106].map((c, k): Bar => ({ time: t + (k + 1) * 86_400, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1 }));
    const p = findTriangle([...bars, ...after], 0, 40);
    expect(p.kind).toBe('symmetrical');
    // The top line is at about 101.6 at bar 42: 103 closes above it.
    expect(p.breakout).toEqual({ dir: 'up', index: 42 });
  });
});
