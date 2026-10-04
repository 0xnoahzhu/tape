import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import {
  anchorAt,
  anchorIndex,
  axisPrice,
  barDay,
  buildChart,
  cleanBars,
  clearOfTag,
  firstAtOrAfter,
  formatBarTime,
  isCurrentBar,
  keepOlderBars,
  LATEST_VIEW,
  MA_PERIOD,
  MAX_SPAN,
  mergeLivePrice,
  MIN_SPAN,
  nearOldest,
  panView,
  prependBars,
  priceDecimals,
  renderRange,
  resolveView,
  sma,
  spanLimits,
  spreadAlertTags,
  VB_H,
  VB_W,
  visibleBarCount,
  zoomView,
  type ChartView,
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
