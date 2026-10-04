import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import {
  anchorAt,
  anchorIndex,
  axisPrice,
  barDay,
  buildChart,
  chartTimeZone,
  cleanBars,
  clearOfTag,
  extremeBox,
  extremeLayout,
  firstAtOrAfter,
  formatBarTime,
  isCurrentBar,
  keepOlderBars,
  labelWidth,
  latestButtonSpot,
  LATEST_MARGIN,
  LATEST_VIEW,
  MA_PERIOD,
  MAX_SPAN,
  mergeLivePrice,
  MIN_SPAN,
  nearOldest,
  NY_ZONE,
  panView,
  pickTimeStep,
  prependBars,
  priceDecimals,
  renderRange,
  resolveView,
  sma,
  spanLimits,
  spreadAlertTags,
  TIME_TICK_GAP,
  timeAxisLabels,
  timeStepSpacing,
  timeTicks,
  VB_H,
  VB_W,
  visibleBarCount,
  zoomView,
  type ChartView,
  type Rect,
  type TimeAxisLabel,
  type ViewWindow,
} from './chartMath';

const bar = (time: number, open: number, high: number, low: number, close: number, volume = 100): Bar => ({ time, open, high, low, close, volume });

const T0 = Date.UTC(2026, 0, 2) / 1000;
/** n daily bars starting at 2026-01-02 UTC midnight (or `from` days later), closes 100, 101, … */
function series(n: number, from = 0): Bar[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return bar(T0 + i * 86_400, 100 + i, 101 + i, 99 + i, 100 + i, 1000 + i);
  });
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

describe('view window', () => {
  const bars = series(1000);

  it('finds bars by time', () => {
    expect(firstAtOrAfter(bars, T0)).toBe(0);
    expect(firstAtOrAfter(bars, T0 + 10 * 86_400)).toBe(10);
    expect(firstAtOrAfter(bars, T0 + 10 * 86_400 + 1)).toBe(11);
    expect(firstAtOrAfter(bars, T0 + 2000 * 86_400)).toBe(1000);
    expect(firstAtOrAfter([], 5)).toBe(0);
  });

  it('follows the newest bars at the automatic zoom by default', () => {
    expect(resolveView(LATEST_VIEW, bars, 60)).toEqual({ start: 940, span: 60, latest: true });
  });

  it('limits the zoom to 20..400 bars and to the loaded bars (at least 30 slots)', () => {
    expect(spanLimits(1000)).toEqual({ min: MIN_SPAN, max: MAX_SPAN });
    expect(spanLimits(100)).toEqual({ min: 20, max: 100 });
    expect(spanLimits(10)).toEqual({ min: 20, max: 30 });
    expect(resolveView({ span: 5, end: null }, bars, 60).span).toBe(20);
    expect(resolveView({ span: 5000, end: null }, bars, 60).span).toBe(400);
    expect(resolveView(LATEST_VIEW, series(45), 60)).toEqual({ start: 0, span: 45, latest: true });
    // A short series is right-aligned: the empty slots are on the left.
    expect(resolveView(LATEST_VIEW, series(10), 60)).toEqual({ start: -20, span: 30, latest: true });
  });

  it('pans by bars and stops at the oldest and the newest bar', () => {
    const v = panView(LATEST_VIEW, bars, 60, -100);
    expect(v.span).toBeNull();
    expect(resolveView(v, bars, 60)).toEqual({ start: 840, span: 60, latest: false });
    expect(resolveView(panView(v, bars, 60, -10_000), bars, 60)).toMatchObject({ start: 0, latest: false });
    // Back to the newest bar: the view follows new bars again.
    expect(panView(v, bars, 60, 500)).toEqual(LATEST_VIEW);
    expect(panView(LATEST_VIEW, bars, 60, 10)).toEqual(LATEST_VIEW);
    // Fractions of a bar move the view smoothly.
    expect(resolveView(panView(v, bars, 60, 0.25), bars, 60).start).toBeCloseTo(840.25);
  });

  it('cannot pan a series shorter than the screen', () => {
    expect(panView(LATEST_VIEW, series(10), 60, -5)).toEqual(LATEST_VIEW);
  });

  it('zooms around the pointer', () => {
    const v = panView(LATEST_VIEW, bars, 100, -200); // [700, 800)
    const pointer = 0.25; // bar position 725
    const z = zoomView(v, bars, 100, 0.5, pointer);
    const w = resolveView(z, bars, 100);
    expect(w.span).toBe(50);
    expect(w.start + pointer * w.span).toBeCloseTo(725);
    expect(w.start).toBeCloseTo(712.5);
    // Zooming out again around the same point restores the view.
    const back = resolveView(zoomView(z, bars, 100, 2, pointer), bars, 100);
    expect(back.start).toBeCloseTo(700);
    expect(back.span).toBeCloseTo(100);
  });

  it('clamps zooming at the limits and the edges', () => {
    const atMin = { span: 20, end: null };
    expect(zoomView(atMin, bars, 60, 0.5, 0.5)).toBe(atMin);
    // Zooming out at the oldest bar keeps it at the left edge.
    const oldest = panView(LATEST_VIEW, bars, 60, -10_000);
    expect(resolveView(zoomView(oldest, bars, 60, 2, 0.1), bars, 60)).toMatchObject({ start: 0, span: 120 });
    // Zooming at the right edge keeps following; zooming in elsewhere leaves the newest bar.
    expect(zoomView(LATEST_VIEW, bars, 60, 0.5, 1).end).toBeNull();
    expect(resolveView(zoomView(LATEST_VIEW, bars, 60, 0.5, 0.5), bars, 60)).toMatchObject({ span: 30, latest: false });
    expect(resolveView(zoomView(LATEST_VIEW, bars, 60, 2, 0.5), bars, 60)).toEqual({ start: 880, span: 120, latest: true });
    // Not beyond the loaded bars.
    expect(resolveView(zoomView(LATEST_VIEW, series(100), 60, 4, 0.5), series(100), 60)).toEqual({ start: 0, span: 100, latest: true });
  });

  it('keeps the view on the same bars when older bars are put in front', () => {
    const recent = series(500, 500);
    const v: ChartView = panView({ span: 80, end: null }, recent, 60, -123.4);
    const before = resolveView(v, recent, 60);
    const page = series(300, 200);
    const after = resolveView(v, prependBars(page, recent), 60);
    expect(after.start).toBeCloseTo(before.start + 300);
    expect(after.span).toBe(before.span);
    // Same bar under any point of the view.
    const at = (w: typeof before, all: Bar[], fx: number) => all[Math.floor(w.start + fx * w.span)].time;
    for (const fx of [0, 0.3, 0.999]) expect(at(after, prependBars(page, recent), fx)).toBe(at(before, recent, fx));
  });

  it('keeps the view on the same bars when new bars arrive, and follows them at the newest bar', () => {
    const v = panView(LATEST_VIEW, bars, 60, -50);
    const more = bars.concat(series(5, 1000));
    expect(resolveView(v, more, 60)).toEqual(resolveView(v, bars, 60));
    expect(resolveView(LATEST_VIEW, more, 60).start).toBe(945);
  });

  it('anchors to bar times', () => {
    expect(anchorAt(bars, 500)).toEqual({ t: bars[499].time, f: 1 });
    expect(anchorAt(bars, 500.25)).toEqual({ t: bars[500].time, f: 0.25 });
    expect(anchorIndex(bars, anchorAt(bars, 731.6))).toBeCloseTo(731.6);
  });

  it('renders the bars in view plus one on each side', () => {
    expect(renderRange({ start: 100.5, span: 60, latest: false }, 1000)).toEqual({ from: 99, to: 162 });
    expect(renderRange({ start: 0, span: 60, latest: false }, 1000)).toEqual({ from: 0, to: 61 });
    expect(renderRange({ start: 940, span: 60, latest: true }, 1000)).toEqual({ from: 939, to: 1000 });
    expect(renderRange({ start: -20, span: 30, latest: true }, 10)).toEqual({ from: 0, to: 10 });
  });

  it('asks for older bars within a screen of the oldest loaded bar', () => {
    expect(nearOldest({ start: 61, span: 60, latest: false })).toBe(false);
    expect(nearOldest({ start: 59, span: 60, latest: false })).toBe(true);
    expect(nearOldest({ start: -20, span: 30, latest: true })).toBe(true);
  });
});

describe('older pages', () => {
  it('puts strictly older bars in front', () => {
    const recent = series(5, 10);
    expect(prependBars(series(10), recent).map((b) => b.close)).toEqual(series(15).map((b) => b.close));
    // Overlap is dropped; nothing new returns the same array.
    expect(prependBars(series(12), recent)).toHaveLength(15);
    expect(prependBars([], recent)).toBe(recent);
    expect(prependBars(series(3, 20), recent)).toBe(recent);
  });

  it('keeps loaded older bars in front of a reloaded window', () => {
    const prev = series(100); // pages 0..99
    const fresh = series(60, 50); // window 50..109
    const merged = keepOlderBars(prev, fresh);
    expect(merged).toHaveLength(110);
    expect(merged[0]).toBe(prev[0]);
    expect(merged[50]).toBe(fresh[0]);
    expect(keepOlderBars([], fresh)).toBe(fresh);
    expect(keepOlderBars(series(10, 50), fresh)).toBe(fresh);
  });

  it('drops them when IB adjusted the history (a split)', () => {
    const prev = series(100);
    const fresh = series(60, 50).map((b) => ({ ...b, open: b.open / 4, high: b.high / 4, low: b.low / 4, close: b.close / 4 }));
    expect(keepOlderBars(prev, fresh)).toBe(fresh);
  });
});

describe('buildChart', () => {
  it('returns null without bars', () => {
    expect(buildChart([], { count: 60, showMa: true })).toBeNull();
  });

  it('shows the most recent bars and pads the range by 8%', () => {
    const bars = series(100);
    const g = buildChart(bars, { count: 60, showMa: false })!;
    expect(g.window).toEqual({ start: 40, span: 60, latest: true });
    // In view 40..99, plus one off-screen bar on the left.
    expect(g.candles).toHaveLength(61);
    expect(g.candles[0].index).toBe(39);
    expect(g.candles[0].x + g.candles[0].w).toBeLessThan(0);
    // visible lows 139..198 highs 141..200 -> span 61, pad 4.88
    expect(g.hi).toBeCloseTo(200 + 61 * 0.08);
    expect(g.lo).toBeCloseTo(139 - 61 * 0.08);
    expect(g.y(g.hi)).toBeCloseTo(0);
    expect(g.y(g.lo)).toBeCloseTo(VB_H);
    expect(g.axis.map((a) => a.frac)).toEqual([0.15, 0.5, 0.85]);
  });

  it('keeps at least 30 slots and right-aligns short series', () => {
    const g = buildChart(series(10), { count: 60, showMa: false })!;
    expect(g.window).toEqual({ start: -20, span: 30, latest: true });
    const cw = VB_W / 30;
    expect(g.candles[0].x).toBeCloseTo(20 * cw + cw * 0.22);
    expect(g.candles[9].x + g.candles[9].w).toBeLessThan(VB_W);
    expect(g.indexAt(0.1)).toBeNull();
    expect(g.indexAt(0.999)).toBe(9);
    expect(g.centerX(9)).toBeCloseTo(29 * cw + cw / 2);
  });

  it('draws the panned and zoomed window, ranging over the bars in view', () => {
    const bars = series(1000);
    const view = zoomView(panView(LATEST_VIEW, bars, 60, -500.5), bars, 60, 0.5, 0); // [439.5, 469.5)
    const g = buildChart(bars, { count: 60, view, showMa: false })!;
    expect(g.window.start).toBeCloseTo(439.5);
    expect(g.window.span).toBeCloseTo(30);
    expect(g.candles.map((c) => c.index)).toEqual(Array.from({ length: 33 }, (_, i) => 438 + i));
    // Bars 439..469 overlap the view: lows 538..568, highs 540..570.
    expect(g.hi).toBeCloseTo(570 + 32 * 0.08);
    expect(g.lo).toBeCloseTo(538 - 32 * 0.08);
    const cw = VB_W / 30;
    expect(g.centerX(440)).toBeCloseTo(cw);
    expect(g.indexAt(0)).toBe(439);
    expect(g.indexAt(0.5)).toBe(454);
  });

  it('includes extra prices (live last) in the range only while the newest bar is in view', () => {
    const bars = series(400);
    expect(buildChart(bars, { count: 60, showMa: false, include: [900, undefined] })!.hi).toBeGreaterThan(900);
    const back = panView(LATEST_VIEW, bars, 60, -100);
    expect(buildChart(bars, { count: 60, view: back, showMa: false, include: [900] })!.hi).toBeLessThan(500);
  });

  it('draws the moving average from the full series', () => {
    const bars = series(50);
    const g = buildChart(bars, { count: 30, showMa: true })!;
    // Bars 19..49 are drawn, and all have an MA point (index >= MA_PERIOD - 1).
    expect(g.ma.split(' ')).toHaveLength(31);
    const off = buildChart(bars, { count: 30, showMa: false })!;
    expect(off.ma).toBe('');
    const short = buildChart(series(MA_PERIOD - 1), { count: 30, showMa: true })!;
    expect(short.ma).toBe('');
    // A precomputed average is used as given.
    const given = buildChart(bars, { count: 30, showMa: true, ma: bars.map(() => 120) })!;
    expect(new Set(given.ma.split(' ').map((p) => p.split(',')[1])).size).toBe(1);
  });

  it('starts the moving average right at the left edge after panning', () => {
    const bars = series(300);
    const view = panView(LATEST_VIEW, bars, 60, -200); // [40, 100)
    const g = buildChart(bars, { count: 60, view, showMa: true })!;
    const first = g.ma.split(' ')[0].split(',').map(Number);
    expect(first[0]).toBeLessThan(0); // bar 39, just left of the view
    // sma of closes 120..139 = 129.5
    expect(first[1]).toBeCloseTo(g.y(129.5), 1);
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

  it('scales volume to the bars in view, not the series', () => {
    const bars = series(300).map((b, i) => ({ ...b, volume: i < 100 ? 1e9 : 1000 }));
    const view = panView(LATEST_VIEW, bars, 60, -100); // [140, 200)
    const g = buildChart(bars, { count: 60, view, showMa: false })!;
    expect(Math.max(...g.volumes.map((v) => v.h))).toBeCloseTo(54);
  });

  it('builds one path per kind and direction', () => {
    const bars = [bar(1, 10, 11, 9, 11), bar(2, 11, 12, 10, 10), bar(3, 10, 12, 9, 11)];
    const g = buildChart(bars, { count: 30, showMa: false })!;
    expect(g.paths.upWicks.match(/M/g)).toHaveLength(2);
    expect(g.paths.upBodies.match(/z/g)).toHaveLength(2);
    expect(g.paths.dnWicks.match(/M/g)).toHaveLength(1);
    expect(g.paths.dnBodies.match(/z/g)).toHaveLength(1);
    expect(g.paths.upVolume.match(/z/g)).toHaveLength(2);
    expect(g.paths.dnVolume.match(/z/g)).toHaveLength(1);
    const c = g.candles[1];
    const r2 = (v: number) => Math.round(v * 100) / 100;
    expect(g.paths.dnBodies).toBe(`M${r2(c.x)} ${r2(c.top)}h${r2(c.w)}v${r2(c.h)}h${r2(-c.w)}z`);
    expect(g.paths.dnWicks).toBe(`M${r2(c.cx)} ${r2(c.yh)}V${r2(c.yl)}`);
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

  it('draws only the bars in view of a long series', () => {
    const bars = series(20_000);
    const view = zoomView(panView(LATEST_VIEW, bars, 200, -9000), bars, 200, 2, 0.5);
    const g = buildChart(bars, { count: 200, view, showMa: true, ma: sma(bars.map((b) => b.close), MA_PERIOD) })!;
    expect(g.window.span).toBe(400);
    expect(g.candles.length).toBeLessThanOrEqual(402);
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
    // Just after midnight ET, and in another exchange's time zone.
    expect(formatBarTime(Date.UTC(2026, 9, 2, 4, 5) / 1000, '1m', 'en')).toBe('Fri 10/02 00:05');
    const hk = Date.UTC(2026, 9, 1, 1, 30) / 1000; // Thu 09:30 in Hong Kong, Wed 21:30 ET
    expect(formatBarTime(hk, '5m', 'en')).toBe('Wed 09/30 21:30');
    expect(formatBarTime(hk, '5m', 'en', 'Asia/Hong_Kong')).toBe('Thu 10/01 09:30');
    expect(formatBarTime(hk, '5m', 'zh', 'Asia/Hong_Kong')).toBe('10/01 周四 09:30');
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

describe('extreme markers', () => {
  it('finds the highest high and lowest low of the bars in view only', () => {
    const bars = [bar(1, 10, 50, 9, 10), bar(2, 10, 12, 1, 11), ...Array.from({ length: 40 }, (_, i) => bar(3 + i, 20, 21 + (i === 30 ? 9 : 0), 19 - (i === 10 ? 5 : 0), 20))];
    // The newest 30 bars: the old 50 high and 1 low are out of view.
    const g = buildChart(bars, { count: 30, showMa: false })!;
    expect(g.extremes.high).toEqual({ index: 32, price: 30 });
    expect(g.extremes.low).toEqual({ index: 12, price: 14 });
    // The whole series in view: the old extremes win.
    const all = buildChart(bars, { count: 60, showMa: false })!;
    expect(all.extremes.high).toEqual({ index: 0, price: 50 });
    expect(all.extremes.low).toEqual({ index: 1, price: 1 });
  });

  it('ignores the live price included in the range', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 20, 21, 19, 20));
    const g = buildChart(bars, { count: 30, showMa: false, include: [99] })!;
    expect(g.hi).toBeGreaterThan(99);
    expect(g.extremes.high.price).toBe(21);
  });

  it('points the label away from the price axis and into the plot', () => {
    const right = extremeLayout(700, 100, 800, 400, 'high');
    expect(right.dir).toBe(-1);
    expect(right.x).toBe(700 - 16);
    expect(right.y).toBe(94);
    const left = extremeLayout(100, 300, 800, 400, 'low');
    expect(left.dir).toBe(1);
    expect(left.x).toBe(116);
    expect(left.y).toBe(306);
    expect(left.points).toBe('100,300 106,306 116,306');
  });

  it('keeps labels inside the plot at the top and bottom edges', () => {
    expect(extremeLayout(100, 2, 800, 400, 'high').y).toBe(9);
    expect(extremeLayout(100, 398, 800, 400, 'low').y).toBe(391);
  });

  it('boxes the leader and the label', () => {
    // Pointing left: label "200.12" (6 × 6.6 px + 2 × 3 px) ends at the leader, 16 px left of the tip.
    const a = extremeBox(extremeLayout(700, 280, 760, 300, 'low'), '200.12');
    expect(a.left).toBeCloseTo(684 - 45.6);
    expect([a.right, a.top, a.bottom]).toEqual([700, 280 + 6 - 6.5, 280 + 6 + 6.5]);
    // Pointing right from a high: the label runs right of the leader, the tip is below it.
    const b = extremeBox(extremeLayout(100, 30, 760, 300, 'high'), '99.5');
    expect(b.left).toBe(100);
    expect(b.right).toBeCloseTo(116 + 4 * 6.6 + 6);
    expect([b.top, b.bottom]).toEqual([30 - 6 - 6.5, 30 - 6 + 6.5]);
    // Clamped at the bottom edge, the tip may be below the label.
    expect(extremeBox(extremeLayout(100, 299, 760, 300, 'low'), '1')).toMatchObject({ top: 291 - 6.5, bottom: 299 });
  });
});

describe('latest button', () => {
  const W = 760;
  const H = 300;
  const BW = 57;
  const BH = 19;
  /** The button's box for an offset from the plot's bottom-right corner. */
  const buttonBox = (s: { right: number; bottom: number }): Rect => ({ left: W - s.right - BW, right: W - s.right, top: H - s.bottom - BH, bottom: H - s.bottom });
  const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  it('stays in the bottom-right corner when the markers are elsewhere', () => {
    const low = extremeBox(extremeLayout(300, 279, W, H, 'low'), '200.12');
    const high = extremeBox(extremeLayout(700, 21, W, H, 'high'), '210.40');
    expect(latestButtonSpot([low, high], W, H, BW, BH)).toEqual({ right: LATEST_MARGIN, bottom: LATEST_MARGIN });
    expect(latestButtonSpot([], W, H, BW, BH)).toEqual({ right: LATEST_MARGIN, bottom: LATEST_MARGIN });
  });

  it('moves left of the lowest low when that is in the corner', () => {
    // Scrolled back with the lowest bar at the right edge: its tip in the 8 % bottom padding.
    const bars = Array.from({ length: 120 }, (_, i) => bar(i, 205, 206, i === 89 ? 200.12 : 204, 205));
    const g = buildChart(bars, { count: 90, view: { span: 90, end: anchorAt(bars, 90) }, showMa: false })!;
    expect(g.extremes.low.index).toBe(89);
    const tipX = (g.centerX(89) / VB_W) * W;
    const low = extremeLayout(tipX, (g.y(200.12) / VB_H) * H, W, H, 'low');
    const box = extremeBox(low, '200.12');
    // In the corner the button would cover the label and the leader.
    expect(overlaps(buttonBox({ right: LATEST_MARGIN, bottom: LATEST_MARGIN }), box)).toBe(true);
    const spot = latestButtonSpot([box], W, H, BW, BH);
    expect(spot.bottom).toBe(LATEST_MARGIN);
    expect(buttonBox(spot).right).toBeCloseTo(box.left - 4);
    expect(overlaps(buttonBox(spot), box)).toBe(false);
  });

  it('moves past every marker in its way, and up when there is no room on the left', () => {
    const a: Rect = { left: 680, right: 740, top: 270, bottom: 290 };
    const b: Rect = { left: 600, right: 660, top: 275, bottom: 285 };
    const spot = latestButtonSpot([a, b], W, H, BW, BH);
    expect(buttonBox(spot).right).toBe(596);
    for (const r of [a, b]) expect(overlaps(buttonBox(spot), r)).toBe(false);
    // A narrow plot: left of the marker the button would leave the plot.
    const narrow: Rect = { left: 40, right: 140, top: 262, bottom: 290 };
    const up = latestButtonSpot([narrow], 160, H, BW, BH);
    expect(up).toEqual({ right: LATEST_MARGIN, bottom: H - 262 + 4 });
  });
});

// ---------------------------------------------------------------------------

/** New York's UTC offset (hours) on a date: -4 in EDT, -5 in EST. */
function nyOffsetHours(y: number, m: number, d: number): number {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(Date.UTC(y, m - 1, d, 12)));
  return h - 12;
}

/** `minutes` bars of the weekdays from y-m-d on, 09:30–16:00 ET (04:00–20:00 with `extended`). */
function sessionBars(y: number, m: number, d: number, days: number, minutes: number, extended = false): Bar[] {
  const out: Bar[] = [];
  const [open, close] = extended ? [4 * 60, 20 * 60] : [9 * 60 + 30, 16 * 60];
  for (let k = 0, made = 0; made < days; k++) {
    const day = new Date(Date.UTC(y, m - 1, d + k));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    made++;
    const off = nyOffsetHours(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    for (let t = open; t < close; t += minutes) {
      const utc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, t) / 1000 - off * 3600;
      out.push(bar(utc, 100, 101, 99, 100));
    }
  }
  return out;
}

/** Daily-or-longer bars stamped at UTC midnight: weekdays (1D), Mondays (1W), month or year starts. */
function calendarBars(kind: '1D' | '1W' | '1M' | '1Y', y: number, m: number, d: number, count: number): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; out.length < count; k++) {
    const t =
      kind === '1M'
        ? Date.UTC(y, m - 1 + k, 1)
        : kind === '1Y'
          ? Date.UTC(y + k, 0, 1)
          : Date.UTC(y, m - 1, d + (kind === '1W' ? 7 * k : k));
    const wd = new Date(t).getUTCDay();
    if (kind === '1D' && (wd === 0 || wd === 6)) continue;
    out.push(bar(t / 1000, 100, 101, 99, 100));
  }
  return out;
}

const view = (start: number, span: number): ViewWindow => ({ start, span, latest: false });
const texts = (ls: TimeAxisLabel[]) => ls.map((l) => l.label);

/** Labels at least TIME_TICK_GAP apart and fully inside the width. */
function expectReadable(ls: TimeAxisLabel[], width: number) {
  for (let i = 0; i < ls.length; i++) {
    expect(ls[i].x - labelWidth(ls[i].label) / 2).toBeGreaterThanOrEqual(0);
    expect(ls[i].x + labelWidth(ls[i].label) / 2).toBeLessThanOrEqual(width);
    if (i) expect(ls[i].x - ls[i - 1].x).toBeGreaterThanOrEqual(TIME_TICK_GAP);
  }
}

describe('time axis', () => {
  it('labels 5m bars on the half hour and a new day by its date', () => {
    const bars = sessionBars(2026, 9, 28, 5, 5); // Mon 09/28 .. Fri 10/02, 78 bars a day
    // One day in 1000 px (12.8 px per bar): 15 minutes would be 38 px apart, 30 minutes 77 px.
    const ls = timeAxisLabels(bars, '5m', view(76, 78), 1000, 'en');
    expect(texts(ls)).toEqual(['09/29', ...['10', '11', '12', '13', '14', '15'].flatMap((h) => (h === '10' ? ['10:00', '10:30'] : [`${h}:00`, `${h}:30`]))]);
    // Ticks sit at the centers of their bars.
    expect(ls[0].index).toBe(78);
    expect(ls[0].x).toBeCloseTo(2.5 * (1000 / 78));
    expect(ls[1].index).toBe(84);
  });

  it('steps out to hours and days when zoomed out, with month starts by name', () => {
    const bars = sessionBars(2026, 9, 28, 5, 5);
    const ls = timeAxisLabels(bars, '5m', view(0, bars.length), 1000, 'en');
    expect(texts(ls)).toEqual(['12:00', '09/29', '12:00', '09/30', '12:00', 'Oct', '12:00', '10/02', '12:00']);
    expect(texts(timeAxisLabels(bars, '5m', view(0, bars.length), 1000, 'zh'))).toContain('10月');
  });

  it('uses exchange time across a DST change', () => {
    // Fri 03/06 is EST (UTC-5), Mon 03/09 EDT (UTC-4).
    const bars = sessionBars(2026, 3, 6, 2, 5);
    const ls = timeAxisLabels(bars, '5m', view(60, 40), 1000, 'en');
    expect(ls.find((l) => l.index === 78)?.label).toBe('03/09');
    expect(ls.find((l) => l.index === 84)?.label).toBe('10:00');
    expect(bars[84].time).toBe(Date.UTC(2026, 2, 9, 14) / 1000);
    expect(texts(timeAxisLabels(bars, '5m', view(0, 40), 1000, 'en'))).toContain('10:00');
    expect(timeAxisLabels(bars, '5m', view(0, 40), 1000, 'en').find((l) => l.label === '10:00')?.index).toBe(6);
  });

  it('shows hours and days on 1m and 1h bars', () => {
    const minute = sessionBars(2026, 9, 28, 2, 1);
    const m1 = timeAxisLabels(minute, '1m', view(390 - 30, 120), 1000, 'en');
    // 8.3 px per bar: every 15 minutes, from 15:30 on 09/28 to 11:00 on 09/29.
    expect(texts(m1)).toEqual(['15:45', '09/29', '09:45', '10:00', '10:15', '10:30', '10:45']);
    const hourly = sessionBars(2026, 9, 1, 40, 60, true); // 16 bars a day
    const h1 = timeAxisLabels(hourly, '1h', view(hourly.length - 60, 60), 1000, 'en');
    expect(h1.every((l) => /^\d\d\/\d\d$|^\d\d:00$/.test(l.label))).toBe(true);
    expect(h1.some((l) => l.kind === 'day')).toBe(true);
    // Extended hours (04:00–20:00) at 15 px per bar: every 6 hours; the day start wins over 06:00
    // two bars later and over 18:00 two bars before it.
    const h6 = timeAxisLabels(hourly, '1h', view(hourly.length - 66, 66), 990, 'en');
    expect(texts(h6)).toEqual(['10/21', '12:00', '10/22', '12:00', '10/23', '12:00', '10/26', '12:00', '18:00']);
    const h1out = timeAxisLabels(hourly, '1h', view(0, hourly.length), 1000, 'en');
    expect(h1out.some((l) => l.label === 'Oct')).toBe(true);
    expect(h1out.every((l) => l.kind !== 'time')).toBe(true);
    expectReadable(h1out, 1000);
  });

  it('marks weeks, months and the year on daily bars', () => {
    const bars = calendarBars('1D', 2025, 11, 3, 110); // Mon 2025-11-03 .. Fri 2026-04-03
    const at = (time: number) => bars.findIndex((b) => b.time === time / 1000);
    const ls = timeAxisLabels(bars, '1D', view(20, 60), 1200, 'en'); // 20 px per bar: weekly
    expect(ls.find((l) => l.index === at(Date.UTC(2026, 0, 1)))?.label).toBe('2026');
    expect(ls.find((l) => l.index === at(Date.UTC(2025, 11, 1)))?.label).toBe('Dec');
    // Mon 12/29 is three bars before the year start: the coarser label wins.
    expect(ls.some((l) => l.index === at(Date.UTC(2025, 11, 29)))).toBe(false);
    expect(ls.find((l) => l.index === at(Date.UTC(2025, 11, 15)))?.label).toBe('12/15');
    for (const l of ls) if (l.kind === 'day') expect(new Date(bars[l.index].time * 1000).getUTCDay()).toBe(1);
    expectReadable(ls, 1200);
    // Zoomed out: months only, in Chinese as "1月".
    const out = timeAxisLabels(bars, '1D', view(0, 110), 900, 'zh');
    expect(texts(out)).toEqual(['12月', '2026', '2月', '3月', '4月']);
  });

  it('uses months, quarters and years on weekly bars', () => {
    const bars = calendarBars('1W', 2016, 1, 4, 522);
    const out = timeAxisLabels(bars, '1W', view(bars.length - 400, 400), 1000, 'en');
    expect(out.every((l) => /^20\d\d$/.test(l.label))).toBe(true);
    expectReadable(out, 1000);
    const zoomed = timeAxisLabels(bars, '1W', view(bars.length - 40, 40), 1000, 'en'); // 25 px per bar: months
    expect(zoomed.map((l) => l.kind)).toContain('month');
    expectReadable(zoomed, 1000);
  });

  it('uses years on monthly and yearly bars', () => {
    const monthly = calendarBars('1M', 2006, 11, 1, 240);
    const m = timeAxisLabels(monthly, '1M', view(0, 240), 900, 'en'); // 3.75 px per bar: every 2 years
    expect(texts(m)).toEqual(['2008', '2010', '2012', '2014', '2016', '2018', '2020', '2022', '2024', '2026']);
    const q = timeAxisLabels(monthly, '1M', view(200, 30), 900, 'en'); // 2023-07 on, 30 px per bar: quarters
    expect(texts(q)).toEqual(['Jul', 'Oct', '2024', 'Apr', 'Jul', 'Oct', '2025', 'Apr', 'Jul', 'Oct']);
    const h = timeAxisLabels(monthly, '1M', view(180, 60), 900, 'en'); // 15 px per bar: half years
    expect(texts(h)).toEqual(['2022', 'Jul', '2023', 'Jul', '2024', 'Jul', '2025', 'Jul', '2026', 'Jul']);
    const yearly = calendarBars('1Y', 2007, 1, 1, 20);
    expect(texts(timeAxisLabels(yearly, '1Y', view(-10, 30), 900, 'en'))).toEqual(['2010', '2015', '2020', '2025']);
  });

  it('never overlaps labels or the edges, at any zoom and offset', () => {
    const cases: Array<[Bar[], '5m' | '1h' | '1D' | '1W' | '1M']> = [
      [sessionBars(2026, 9, 1, 25, 5), '5m'],
      [sessionBars(2026, 9, 1, 25, 5, true), '5m'],
      [sessionBars(2026, 6, 1, 90, 60), '1h'],
      [calendarBars('1D', 2023, 1, 2, 800), '1D'],
      [calendarBars('1W', 2012, 1, 2, 600), '1W'],
      [calendarBars('1M', 2000, 1, 1, 300), '1M'],
    ];
    for (const [bars, tf] of cases) {
      const spacing = timeStepSpacing(bars, tf);
      for (const span of [20, 37.5, 80, 150, 260, 400]) {
        for (const width of [640, 1000, 1380]) {
          for (const start of [0, 13.3, bars.length / 2 + 0.7, bars.length - span]) {
            const ls = timeAxisLabels(bars, tf, view(start, span), width, 'en', NY_ZONE, spacing);
            expectReadable(ls, width);
            if (span <= 150) expect(ls.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('keeps labels on their bars while panning (no jitter)', () => {
    // Daily bars with a few holidays (short weeks) and 5m bars; pans of 0.37 bars at a time.
    const holidays = new Set([Date.UTC(2026, 0, 19), Date.UTC(2026, 1, 16), Date.UTC(2026, 3, 3), Date.UTC(2026, 4, 25)].map((t) => t / 1000));
    const daily = calendarBars('1D', 2025, 10, 1, 200).filter((b) => !holidays.has(b.time));
    const cases: Array<[Bar[], '5m' | '1D', number, number]> = [
      [sessionBars(2026, 9, 1, 25, 5), '5m', 500, 150],
      [daily, '1D', 60, 66],
      [daily, '1D', 20, 120],
    ];
    const width = 1000;
    for (const [bars, tf, from, span] of cases) {
      const spacing = timeStepSpacing(bars, tf);
      const ppb = width / span;
      const inner = (ls: TimeAxisLabel[]) => ls.filter((l) => l.x > 60 && l.x < width - 60);
      let prev = timeAxisLabels(bars, tf, view(from, span), width, 'en', NY_ZONE, spacing);
      for (let k = 1; k <= 60; k++) {
        const next = timeAxisLabels(bars, tf, view(from + k * 0.37, span), width, 'en', NY_ZONE, spacing);
        const byIndex = new Map(next.map((l) => [l.index, l]));
        for (const l of inner(prev)) {
          // Still well inside after the pan: the same label, moved by exactly the pan.
          if (l.x - 0.37 * ppb <= 60) continue;
          expect(byIndex.get(l.index)?.label).toBe(l.label);
          expect(byIndex.get(l.index)!.x).toBeCloseTo(l.x - 0.37 * ppb, 6);
        }
        // Nothing appears in the middle either.
        const before = new Set(prev.map((l) => l.index));
        for (const l of inner(next)) if (l.x + 0.37 * ppb < width - 60) expect(before.has(l.index)).toBe(true);
        prev = next;
      }
    }
  });

  it('picks the finest step whose ticks are far enough apart', () => {
    expect(pickTimeStep([3, 6, 12, 78], 12)).toBe(1);
    expect(pickTimeStep([3, 6, 12, 78], 5)).toBe(3);
    expect(pickTimeStep([3, 6, 12, 78], 0.5)).toBe(3);
    expect(pickTimeStep([3, 6, 12, 78], 30)).toBe(0);
    // 5m bars, 09:30–16:00: 15 minutes, 30 minutes, 1, 2, 4 and 6 hours, days, weeks, months.
    const s = timeStepSpacing(sessionBars(2026, 9, 28, 10, 5), '5m');
    // 4 and 6 hours tick only 12:00 between day starts: no two of a kind follow each other, so the mean.
    expect(s.slice(0, 7)).toEqual([3, 6, 12, 24, 780 / 19, 780 / 19, 78]);
    // The day start before 10:00 (6 bars) does not count: the day label wins there.
    expect(pickTimeStep(s, 70 / 12)).toBe(2);
    expect(timeStepSpacing([], '1D').every((v) => v === Infinity)).toBe(true);
  });

  it('lets a coarser tick win over a finer one nearby, and the earlier of two equal ones', () => {
    const bars = sessionBars(2026, 9, 28, 2, 5);
    // Every 30 minutes at 10 px per bar: 60 px apart, so 10:30 gives way to 10:00, 11:30 to 11:00, ...
    const ts = timeTicks(bars, '5m', 1, 0, bars.length, 10, 'en');
    expect(ts.slice(0, 4).map((t) => t.label)).toEqual(['10:00', '11:00', '12:00', '13:00']);
    // 15:30 is 6 bars before the next day's start: the day wins.
    expect(ts.map((t) => t.label)).toContain('09/29');
    expect(ts.map((t) => t.label)).not.toContain('15:30');
    for (let i = 1; i < ts.length; i++) expect((ts[i].index - ts[i - 1].index) * 10).toBeGreaterThanOrEqual(TIME_TICK_GAP);
  });

  it('keeps the week after a holiday week that a month start crowded out', () => {
    // Weekdays from 2026-06-01 to 09-25 without Labor Day (Mon 09/07): "Sep" on Tue 09/01 drops
    // Tue 09/08 four bars later at 15 px per bar; 09/14 is four bars after 09/08 but eight after "Sep".
    const bars = calendarBars('1D', 2026, 6, 1, 85).filter((b) => b.time !== Date.UTC(2026, 8, 7) / 1000);
    const ls = timeAxisLabels(bars, '1D', view(bars.length - 24, 24), 24 * 15, 'en');
    expect(texts(ls)).toEqual(['Sep', '09/14', '09/21']);
  });

  it('estimates label widths', () => {
    expect(labelWidth('10月')).toBeCloseTo(6.6 * 2 + 11);
    expect(labelWidth('09/29')).toBeCloseTo(33);
  });

  it('labels weekly bars every two months at the automatic zoom', () => {
    // 15 px per bar: months are 4 or 5 bars (60–75 px) apart, two months 8 or 9.
    const bars = calendarBars('1W', 2024, 1, 1, 150); // Mondays from 2024-01-01
    const ls = timeAxisLabels(bars, '1W', view(bars.length - 48, 48), 48 * 15, 'en');
    expect(texts(ls)).toEqual(['2026', 'Mar', 'May', 'Jul', 'Sep', 'Nov']);
    expectReadable(ls, 48 * 15);
    // Daily bars zoomed out all the way: two months rather than quarters.
    const daily = calendarBars('1D', 2024, 1, 1, 500);
    const d = timeAxisLabels(daily, '1D', view(daily.length - 400, 400), 1000, 'en');
    expect(texts(d)).toEqual(['Jul', 'Sep', 'Nov', '2025', 'Mar', 'May', 'Jul', 'Sep', 'Nov']);
    expectReadable(d, 1000);
  });
});

/** 5m bars of the weekdays from y-m-d on in Hong Kong (UTC+8): 09:30–12:00 and 13:00–16:00. */
function hkBars(y: number, m: number, d: number, days: number): Bar[] {
  const out: Bar[] = [];
  for (let k = 0, made = 0; made < days; k++) {
    const day = new Date(Date.UTC(y, m - 1, d + k));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    made++;
    for (const [open, close] of [
      [9 * 60 + 30, 12 * 60],
      [13 * 60, 16 * 60],
    ]) {
      for (let t = open; t < close; t += 5) out.push(bar(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, t) / 1000 - 8 * 3600, 100, 101, 99, 100));
    }
  }
  return out;
}

describe('exchange time', () => {
  it('maps IB time zone ids, with New York for US exchanges and unknown ids', () => {
    for (const id of [undefined, '', 'US/Eastern', 'EST', 'EST5EDT', 'America/New_York', 'US/Central', 'CST', 'America/Chicago', 'Nowhere/Land']) {
      expect(chartTimeZone(id)).toBe(NY_ZONE);
    }
    expect(chartTimeZone('Hongkong')).toBe('Hongkong');
    expect(chartTimeZone('Asia/Hong_Kong')).toBe('Asia/Hong_Kong');
    expect(chartTimeZone('HKT')).toBe('Asia/Hong_Kong');
    expect(chartTimeZone('MET')).toBe('MET');
    expect(chartTimeZone('Japan')).toBe('Japan');
    expect(chartTimeZone('JST')).toBe('Asia/Tokyo');
    expect(chartTimeZone('GB')).toBe('GB');
    expect(chartTimeZone(' Europe/London ')).toBe('Europe/London');
  });

  it('starts days at the session open in the exchange time zone', () => {
    const bars = hkBars(2026, 9, 28, 5); // Mon 09/28 .. Fri 10/02, 66 bars a day
    const opens = new Set(bars.map((_, i) => i).filter((i) => i % 66 === 0));
    for (const zone of ['Asia/Hong_Kong', chartTimeZone('Hongkong'), chartTimeZone('HKT')]) {
      const spacing = timeStepSpacing(bars, '5m', zone);
      // The newest 132 bars in 900 px (6.8 px per bar): hours, the day start at the open.
      const ls = timeAxisLabels(bars, '5m', view(bars.length - 132, 132), 900, 'en', zone, spacing);
      expect(texts(ls)).toEqual(['11:00', '13:00', '14:00', '15:00', '10/02', '11:00', '13:00', '14:00', '15:00']);
      for (const l of ls) {
        if (l.kind === 'time') expect(opens.has(l.index)).toBe(false);
        else expect(opens.has(l.index)).toBe(true);
        const hm = formatBarTime(bars[l.index].time, '5m', 'en', zone).slice(-5);
        expect(hm >= '09:30' && hm < '16:00').toBe(true);
      }
      // Zoomed out over the week: each open and afternoon re-open, "Oct" on Thursday's open.
      const week = timeAxisLabels(bars, '5m', view(0, bars.length), 1000, 'en', zone, spacing);
      expect(texts(week)).toEqual(['13:00', '09/29', '13:00', '09/30', '13:00', 'Oct', '13:00', '10/02', '13:00']);
      expect(week.filter((l) => l.kind !== 'time').map((l) => [l.label, l.index])).toEqual([
        ['09/29', 66],
        ['09/30', 132],
        ['Oct', 198],
        ['10/02', 264],
      ]);
    }
    // The same bars in New York time would start days and months mid-session (the old behavior).
    const ny = timeAxisLabels(bars, '5m', view(0, bars.length), 1000, 'en');
    expect(ny.filter((l) => l.kind !== 'time').every((l) => opens.has(l.index))).toBe(false);
  });

  it('keeps each zone apart across a DST change', () => {
    // Frankfurt 09:00–17:30 around the end of summer time (Sun 2026-10-25): UTC+2, then UTC+1.
    const bars: Bar[] = [];
    for (const [d, off] of [
      [22, 2],
      [23, 2],
      [26, 1],
      [27, 1],
    ]) {
      for (let t = 9 * 60; t < 17 * 60 + 30; t += 5) bars.push(bar(Date.UTC(2026, 9, d, 0, t) / 1000 - off * 3600, 100, 101, 99, 100));
    }
    const perDay = 102;
    for (let pass = 0; pass < 2; pass++) {
      // New York first, then Frankfurt: the cached offsets of one zone never leak into the other.
      timeAxisLabels(bars, '5m', view(0, bars.length), 1000, 'en', NY_ZONE);
      const met = timeAxisLabels(bars, '5m', view(0, bars.length), 1000, 'en', chartTimeZone('MET'));
      expect(met.filter((l) => l.kind === 'day').map((l) => l.index)).toEqual([perDay, 2 * perDay, 3 * perDay]);
      expect(formatBarTime(bars[2 * perDay].time, '5m', 'en', 'MET')).toBe('Mon 10/26 09:00');
      expect(formatBarTime(bars[2 * perDay - 1].time, '5m', 'en', 'MET')).toBe('Fri 10/23 17:25');
    }
  });
});
