import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import {
  axisPrice,
  barDay,
  buildChart,
  cleanBars,
  clearOfTag,
  formatBarTime,
  isCurrentBar,
  MA_PERIOD,
  mergeLivePrice,
  priceDecimals,
  sma,
  spreadAlertTags,
  VB_H,
  VB_W,
  visibleBarCount,
} from './chartMath';

const bar = (time: number, open: number, high: number, low: number, close: number, volume = 100): Bar => ({ time, open, high, low, close, volume });

/** n daily bars starting at 2026-01-02 UTC midnight, closes 100, 101, … */
function series(n: number): Bar[] {
  const t0 = Date.UTC(2026, 0, 2) / 1000;
  return Array.from({ length: n }, (_, i) => bar(t0 + i * 86_400, 100 + i, 101 + i, 99 + i, 100 + i, 1000 + i));
}

describe('visibleBarCount', () => {
  it('uses about one bar per 15 px, clamped to 30..200', () => {
    expect(visibleBarCount(0)).toBe(30);
    expect(visibleBarCount(300)).toBe(30);
    expect(visibleBarCount(900)).toBe(60);
    expect(visibleBarCount(10_000)).toBe(200);
    expect(visibleBarCount(Number.NaN)).toBe(30);
  });
});

describe('sma', () => {
  it('is undefined until the period is filled', () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([undefined, undefined, 2, 3]);
  });
});

describe('cleanBars', () => {
  it('drops malformed bars and normalizes highs, lows and negative volume', () => {
    const out = cleanBars([bar(1, 10, 9, 11, 10.5, -1), bar(2, Number.NaN, 1, 1, 1), bar(3, 1, 0, 0, 1)]);
    expect(out).toEqual([bar(1, 10, 10.5, 10, 10.5, 0)]);
  });
});

describe('buildChart', () => {
  it('returns null without bars', () => {
    expect(buildChart([], { count: 60, showMa: true })).toBeNull();
  });

  it('shows the most recent bars and pads the range by 8%', () => {
    const bars = series(100);
    const g = buildChart(bars, { count: 60, showMa: false })!;
    expect(g.candles).toHaveLength(60);
    expect(g.offset).toBe(40);
    expect(g.lead).toBe(0);
    expect(g.candles[0].index).toBe(40);
    // visible lows 139..198 highs 141..200 -> span 61, pad 4.88
    expect(g.hi).toBeCloseTo(200 + 61 * 0.08);
    expect(g.lo).toBeCloseTo(139 - 61 * 0.08);
    expect(g.y(g.hi)).toBeCloseTo(0);
    expect(g.y(g.lo)).toBeCloseTo(VB_H);
    expect(g.axis.map((a) => a.frac)).toEqual([0.15, 0.5, 0.85]);
  });

  it('keeps at least 30 slots and right-aligns short series', () => {
    const g = buildChart(series(10), { count: 60, showMa: false })!;
    expect(g.slots).toBe(30);
    expect(g.lead).toBe(20);
    const cw = VB_W / 30;
    expect(g.candles[0].x).toBeCloseTo(20 * cw + cw * 0.22);
    expect(g.candles[9].x + g.candles[9].w).toBeLessThan(VB_W);
    expect(g.indexAt(0.1)).toBeNull();
    expect(g.indexAt(0.999)).toBe(9);
    expect(g.centerX(9)).toBeCloseTo(29 * cw + cw / 2);
  });

  it('includes extra prices (live last) in the range', () => {
    const g = buildChart(series(40), { count: 60, showMa: false, include: [500, undefined] })!;
    expect(g.hi).toBeGreaterThan(500);
  });

  it('draws the moving average from the full series', () => {
    const bars = series(50);
    const g = buildChart(bars, { count: 30, showMa: true })!;
    // offset 20 >= MA_PERIOD - 1, so every visible bar has an MA point
    expect(g.ma.split(' ')).toHaveLength(30);
    const off = buildChart(bars, { count: 30, showMa: false })!;
    expect(off.ma).toBe('');
    const short = buildChart(series(MA_PERIOD - 1), { count: 30, showMa: true })!;
    expect(short.ma).toBe('');
  });

  it('scales volume to the largest visible bar', () => {
    const bars = [bar(1, 10, 11, 9, 11, 50), bar(2, 11, 12, 10, 10, 100), bar(3, 10, 10, 10, 10, 0)];
    const g = buildChart(bars, { count: 30, showMa: false })!;
    expect(g.volumes).toHaveLength(2);
    expect(g.volumes[1].h).toBeCloseTo(54);
    expect(g.volumes[1].y).toBeCloseTo(2);
    expect(g.volumes[0].h).toBeCloseTo(27);
    expect(g.volumes[0].up).toBe(true);
    expect(g.volumes[1].up).toBe(false);
  });

  it('handles a flat series', () => {
    const g = buildChart([bar(1, 10, 10, 10, 10)], { count: 30, showMa: false })!;
    expect(g.hi).toBeGreaterThan(10);
    expect(g.lo).toBeLessThan(10);
    expect(g.candles[0].h).toBe(1);
  });

  it('maps hover fractions to prices', () => {
    const g = buildChart(series(40), { count: 40, showMa: false })!;
    expect(g.priceAt(0)).toBeCloseTo(g.hi);
    expect(g.priceAt(1)).toBeCloseTo(g.lo);
  });
});

describe('live price merge', () => {
  // Wednesday 2026-10-07 11:00 ET (15:00 UTC)
  const now = new Date(Date.UTC(2026, 9, 7, 15, 0, 0));
  const nowSec = now.getTime() / 1000;

  it('extends the forming intraday bar', () => {
    const bars = [bar(nowSec - 120, 10, 10.5, 9.5, 10), bar(nowSec - 30, 10, 10.2, 9.9, 10.1)];
    const out = mergeLivePrice(bars, 10.6, '1m', now, 'regular');
    expect(out[1]).toMatchObject({ close: 10.6, high: 10.6, low: 9.9 });
    expect(out[0]).toBe(bars[0]);
    expect(mergeLivePrice(bars, 9.5, '1m', now, 'regular')[1]).toMatchObject({ close: 9.5, low: 9.5, high: 10.2 });
  });

  it('leaves finished bars alone', () => {
    const bars = [bar(nowSec - 120, 10, 10.5, 9.5, 10)];
    expect(mergeLivePrice(bars, 11, '1m', now, 'regular')).toBe(bars);
    expect(mergeLivePrice(bars, 11, '5m', now, 'closed')).toBe(bars);
    expect(mergeLivePrice(bars, undefined, '5m', now, 'regular')).toBe(bars);
  });

  it('only moves daily bars during the regular session and on the same day', () => {
    const today = Date.UTC(2026, 9, 7) / 1000; // bar at UTC midnight
    const bars = [bar(today, 10, 11, 9, 10)];
    expect(mergeLivePrice(bars, 12, '1D', now, 'regular')[0].high).toBe(12);
    expect(mergeLivePrice(bars, 12, '1D', now, 'post')).toBe(bars);
    const yesterday = [bar(today - 86_400, 10, 11, 9, 10)];
    expect(mergeLivePrice(yesterday, 12, '1D', now, 'regular')).toBe(yesterday);
  });

  it('recognizes the current week, month and year', () => {
    const monday = Date.UTC(2026, 9, 5) / 1000;
    expect(isCurrentBar(bar(monday, 1, 1, 1, 1), '1W', now, 'regular')).toBe(true);
    expect(isCurrentBar(bar(monday - 7 * 86_400, 1, 1, 1, 1), '1W', now, 'regular')).toBe(false);
    expect(isCurrentBar(bar(Date.UTC(2026, 9, 1) / 1000, 1, 1, 1, 1), '1M', now, 'regular')).toBe(true);
    expect(isCurrentBar(bar(Date.UTC(2026, 8, 1) / 1000, 1, 1, 1, 1), '1M', now, 'regular')).toBe(false);
    expect(isCurrentBar(bar(Date.UTC(2026, 0, 2) / 1000, 1, 1, 1, 1), '1Y', now, 'regular')).toBe(true);
  });
});

describe('labels', () => {
  it('derives the trading day whether bars are stamped at UTC, ET or Asia midnight', () => {
    expect(barDay(Date.UTC(2026, 9, 3) / 1000)).toBe('2026-10-03');
    expect(barDay(Date.UTC(2026, 9, 3, 4) / 1000)).toBe('2026-10-03'); // ET midnight (EDT)
    expect(barDay(Date.UTC(2026, 9, 2, 16) / 1000)).toBe('2026-10-03'); // UTC+8 midnight
  });

  it('formats hover times per timeframe', () => {
    const intraday = Date.UTC(2026, 9, 2, 14, 31) / 1000; // Fri 10:31 ET
    expect(formatBarTime(intraday, '5m', 'en')).toBe('Fri 10/02 10:31');
    expect(formatBarTime(intraday, '1m', 'zh')).toBe('10/02 周五 10:31');
    const day = Date.UTC(2026, 9, 2) / 1000;
    expect(formatBarTime(day, '1D', 'en')).toBe('Fri 2026-10-02');
    expect(formatBarTime(day, '1D', 'zh')).toBe('2026-10-02 周五');
    expect(formatBarTime(day, '1W', 'en')).toBe('Week of 2026-10-02');
    expect(formatBarTime(day, '1M', 'en')).toBe('Oct 2026');
    expect(formatBarTime(day, '1M', 'zh')).toBe('2026年10月');
    expect(formatBarTime(day, '1Y', 'en')).toBe('2026');
  });

  it('chooses price decimals from the tick size and price level', () => {
    expect(priceDecimals(0.01)).toBe(2);
    expect(priceDecimals(undefined)).toBe(2);
    expect(priceDecimals(0.0001)).toBe(4);
    expect(priceDecimals(0.005)).toBe(3);
    expect(priceDecimals(0.01, 0.42)).toBe(4);
  });

  it('keeps axis prices short', () => {
    expect(axisPrice(227.484)).toBe('227.48');
    expect(axisPrice(5712.3)).toBe('5712.30');
    expect(axisPrice(20104.56)).toBe('20104.6');
    expect(axisPrice(1.08654, 0.00005)).toBe('1.08654');
    expect(axisPrice(-3.5)).toBe('−3.50');
  });
});

describe('right axis tags', () => {
  it('moves alert tags out from under the last-price tag, keeping their order', () => {
    // Last tag 20 px tall at 100; alert tags 17 px: centers at least 19.5 px from it, 18 px apart.
    expect(spreadAlertTags([95, 104], 100, 300)).toEqual([80.5, 119.5]);
    expect(spreadAlertTags([97, 92, 40], 100, 300)).toEqual([80.5, 62.5, 40]);
    expect(spreadAlertTags([130, 101], 100, 300)).toEqual([137.5, 119.5]);
  });

  it('leaves distant tags alone and keeps tags inside the chart', () => {
    expect(spreadAlertTags([20, 250], 100, 300)).toEqual([20, 250]);
    expect(spreadAlertTags([5], 15, 300)).toEqual([8.5]);
    expect(spreadAlertTags([50, 55], null, 300)).toEqual([50, 68]);
  });

  it('hides axis labels that would peek out behind a tag', () => {
    // Axis label 12 px tall: clear of a 20 px tag at 17 px, of a 17 px tag at 15.5 px.
    expect(clearOfTag(100, 115, 20)).toBe(false);
    expect(clearOfTag(100, 117, 20)).toBe(true);
    expect(clearOfTag(100, 85, 17)).toBe(false);
    expect(clearOfTag(100, 84, 17)).toBe(true);
  });
});
