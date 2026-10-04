// Pure chart geometry: the pan / zoom window over the bars, which bars are visible,
// candle/volume/moving-average coordinates in the design's SVG spaces (price 800×300, volume
// 800×56), axis values, time axis ticks, the MA legend, merging of older pages and the live
// price, and hover lookup.
// No React or store imports so it can be unit tested in node.

import { nyClock, type MarketSession } from '@shared/session';
import { barEndSec, barSeconds, barStartSec, isIntraday, isSecondsTimeframe, TIMEFRAMES } from '@shared/timeframes';
import type { Bar, Timeframe } from '@shared/types';

export { isIntraday, TIMEFRAMES };

/** Price chart viewBox (preserveAspectRatio="none"). */
export const VB_W = 800;
export const VB_H = 300;
/** Volume chart viewBox height; bars use up to VOL_MAX of it. */
export const VOL_VB_H = 56;
const VOL_MAX = 54;

/** The automatic zoom: roughly one bar per 15 px of chart width, 30..200 bars. */
export const PX_PER_BAR = 15;
export const MIN_BARS = 30;
export const MAX_BARS = 200;

/** Moving averages offered on the chart (simple, on closes), shortest first. */
export const MA_PERIODS = [5, 10, 20, 50, 200] as const;
export type MaPeriod = (typeof MA_PERIODS)[number];
/** Moving averages shown until the user picks others. */
export const DEFAULT_MAS: readonly MaPeriod[] = [20, 50, 200];

/** Bars per screen at the automatic zoom for a chart area `widthPx` wide. */
export function visibleBarCount(widthPx: number): number {
  const n = Math.floor((Number.isFinite(widthPx) ? widthPx : 0) / PX_PER_BAR);
  return Math.min(MAX_BARS, Math.max(MIN_BARS, n));
}

/** Simple moving average of `values`; undefined until `period` values are available. */
export function sma(values: ArrayLike<number>, period: number): Array<number | undefined> {
  const n = values.length;
  const out: Array<number | undefined> = new Array(n).fill(undefined);
  if (!(period >= 1) || !Number.isInteger(period)) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** A moving average over a whole bar series: `values[i]` belongs to bar i (undefined before `period` bars). */
export interface MaSeries {
  period: MaPeriod;
  values: ReadonlyArray<number | undefined>;
}

/** Simple moving averages of the closes for each of `periods`, over the full series. */
export function movingAverages(bars: readonly Bar[], periods: readonly MaPeriod[]): MaSeries[] {
  if (!periods.length) return [];
  const closes = bars.map((b) => b.close);
  return periods.map((period) => ({ period, values: sma(closes, period) }));
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Drops malformed bars (IB occasionally sends -1 or NaN fields) and normalizes volume. */
export function cleanBars(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    if (!finite(b.time) || !finite(b.open) || !finite(b.high) || !finite(b.low) || !finite(b.close)) continue;
    if (b.high <= 0 || b.low <= 0) continue;
    const high = Math.max(b.high, b.open, b.close);
    const low = Math.min(b.low, b.open, b.close);
    out.push({ ...b, high, low, volume: finite(b.volume) && b.volume > 0 ? b.volume : 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// View window (pan / zoom)

/**
 * Zoom limits in bars per screen. The widest zoom holds a range's bars (ranges.ts: about 1,000
 * one-hour bars of extended hours for 3M, all of a stock's months since 1980); the candles are
 * then a pixel wide, drawn as one path per kind as always.
 */
export const MIN_SPAN = 20;
export const MAX_SPAN = 1200;

/**
 * The view's right edge, anchored to a bar time: `f` bars after the start of the first bar at or
 * after time `t`. Bars added in front (older pages) or behind (new bars) do not move the view.
 */
export interface ViewAnchor {
  t: number;
  f: number;
}

/** Pan / zoom state of a chart; resolveView turns it into a window over the bars. */
export interface ChartView {
  /** Bars per screen; null: automatic from the chart width (visibleBarCount). */
  span: number | null;
  /** Right edge; null follows the newest bar. */
  end: ViewAnchor | null;
}

export const LATEST_VIEW: ChartView = { span: null, end: null };

/** A view in bar units of the full series: it shows bar positions [start, start + span). */
export interface ViewWindow {
  start: number;
  span: number;
  /** The newest bar is at the right edge. */
  latest: boolean;
}

/** Index of the first bar at or after `time` (bars.length when there is none). */
export function firstAtOrAfter(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Zoom range for `n` loaded bars: out to all of them (at least MIN_BARS slots), at most MAX_SPAN. */
export function spanLimits(n: number): { min: number; max: number } {
  return { min: MIN_SPAN, max: Math.max(MIN_BARS, Math.min(MAX_SPAN, n)) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Right edges allowed for `n` bars: the oldest bar stays at or right of the left edge, nothing beyond the newest. */
const clampEnd = (end: number, span: number, n: number) => clamp(end, Math.min(n, span), n);

/** An anchor for bar position `end` (inside the series). */
export function anchorAt(bars: readonly Bar[], end: number): ViewAnchor {
  const i = clamp(Math.ceil(end) - 1, 0, bars.length - 1);
  return { t: bars[i].time, f: end - i };
}

/** Bar position of an anchor in `bars`. */
export function anchorIndex(bars: readonly Bar[], a: ViewAnchor): number {
  return firstAtOrAfter(bars, a.t) + a.f;
}

export function resolveView(view: ChartView, bars: readonly Bar[], autoSpan: number): ViewWindow {
  const n = bars.length;
  const { min, max } = spanLimits(n);
  const span = clamp(view.span ?? autoSpan, min, max);
  const end = clampEnd(view.end && n ? anchorIndex(bars, view.end) : n, span, n);
  return { start: end - span, span, latest: end >= n };
}

/**
 * The view fitted to the bars from time `from` (null: all of them) to the newest: a range
 * (ranges.ts). resolveView keeps it within the zoom limits (at least MIN_SPAN bars).
 */
export function fitView(bars: readonly Bar[], from: number | null): ChartView {
  const i = from == null ? 0 : firstAtOrAfter(bars, from);
  return { span: Math.max(1, bars.length - i), end: null };
}

/** `span` with the right edge at bar position `end` (clamped); at the newest bar the view follows new bars. */
function withEnd(span: number | null, end: number, bars: readonly Bar[]): ChartView {
  return { span, end: end >= bars.length ? null : anchorAt(bars, end) };
}

/** Pans by `delta` bars (positive: towards newer bars). */
export function panView(view: ChartView, bars: readonly Bar[], autoSpan: number, delta: number): ChartView {
  if (!bars.length || !delta) return view;
  const w = resolveView(view, bars, autoSpan);
  return withEnd(view.span, clampEnd(w.start + w.span + delta, w.span, bars.length), bars);
}

/**
 * Zooms by `factor` (< 1 zooms in) around the point at fraction `fx` of the width: the bar under
 * that point stays in place unless the view has to be clamped.
 */
export function zoomView(view: ChartView, bars: readonly Bar[], autoSpan: number, factor: number, fx: number): ChartView {
  const n = bars.length;
  if (!n || !(factor > 0)) return view;
  const w = resolveView(view, bars, autoSpan);
  const { min, max } = spanLimits(n);
  const span = clamp(w.span * factor, min, max);
  if (span === w.span) return view;
  const at = clamp(Number.isFinite(fx) ? fx : 1, 0, 1);
  const pivot = w.start + at * w.span;
  return withEnd(span, clampEnd(pivot + (1 - at) * span, span, n), bars);
}

/** The view is within one screen of the oldest loaded bar: time to load older ones. */
export function nearOldest(w: ViewWindow): boolean {
  return w.start < w.span;
}

/** Bars to draw: the ones in view plus one on each side (so the MA lines run to the edges). */
export function renderRange(w: ViewWindow, n: number): { from: number; to: number } {
  return { from: Math.max(0, Math.floor(w.start) - 1), to: Math.min(n, Math.ceil(w.start + w.span) + 1) };
}

/** Index of the newest bar (at least partly) in view, for readouts while nothing is hovered. */
export function latestInView(w: ViewWindow, n: number): number {
  return clamp(Math.ceil(w.start + w.span) - 1, 0, n - 1);
}

// ---------------------------------------------------------------------------
// Older pages

/** Older bars (a history page) in front of `bars`; only bars strictly older than the first one are taken. */
export function prependBars(older: readonly Bar[], bars: Bar[]): Bar[] {
  if (!bars.length) return older.slice();
  const first = bars[0].time;
  const add = older.filter((b) => b.time < first);
  return add.length ? add.concat(bars) : bars;
}

/** Relative close difference above which a reloaded bar means IB adjusted the history (a split). */
const ADJUSTED = 0.005;

/**
 * A reloaded window (`fresh`) behind the loaded bars older than its first bar (pages fetched while
 * scrolling back), so a refresh keeps the history and the view. Returns `fresh` alone when nothing
 * is older or when the bar both have disagrees, i.e. IB adjusted the history.
 */
export function keepOlderBars(prev: readonly Bar[], fresh: Bar[]): Bar[] {
  if (!prev.length || !fresh.length) return fresh;
  const k = firstAtOrAfter(prev, fresh[0].time);
  if (k === 0) return fresh;
  const same = prev[k];
  if (same && same.time === fresh[0].time && Math.abs(same.close - fresh[0].close) > Math.abs(fresh[0].close) * ADJUSTED) return fresh;
  return prev.slice(0, k).concat(fresh);
}

// ---------------------------------------------------------------------------
// Geometry

export interface Candle {
  /** Index into the full bar series. */
  index: number;
  up: boolean;
  x: number;
  w: number;
  cx: number;
  top: number;
  h: number;
  yh: number;
  yl: number;
}

export interface VolumeBar {
  up: boolean;
  x: number;
  w: number;
  y: number;
  h: number;
}

/** SVG path data of the drawn bars, one path per kind and direction (a few DOM nodes for any zoom). */
export interface ChartPaths {
  upWicks: string;
  upBodies: string;
  dnWicks: string;
  dnBodies: string;
  upVolume: string;
  dnVolume: string;
}

/** SVG path of one moving average over the drawn bars ("" with fewer than two points there). */
export interface MaLine {
  period: MaPeriod;
  d: string;
}

export interface ChartGeometry {
  hi: number;
  lo: number;
  window: ViewWindow;
  /** Drawn bars: the ones in view plus one on each side. */
  candles: Candle[];
  volumes: VolumeBar[];
  paths: ChartPaths;
  /** One path per moving average passed in ChartOptions.mas, in that order. */
  mas: MaLine[];
  /** Right axis labels at 15 / 50 / 85 % of the height. */
  axis: Array<{ frac: number; value: number }>;
  /** Highest high and lowest low of the bars in view (full-series indices), for the extreme markers. */
  extremes: { high: Extreme; low: Extreme };
  /** Price → viewBox y. */
  y(price: number): number;
  /** Fraction of the height (0 = top) → price. */
  priceAt(fracY: number): number;
  /** Fraction of the width (0 = left) → index into the full series, or null where there is no bar. */
  indexAt(fracX: number): number | null;
  /** viewBox x of the center of a bar (full-series index). */
  centerX(index: number): number;
}

export interface Extreme {
  index: number;
  price: number;
}

export interface ChartOptions {
  /** Automatic bars per screen (see visibleBarCount). */
  count: number;
  /** Pan / zoom state; the newest bars at the automatic zoom by default. */
  view?: ChartView;
  /**
   * Moving averages of the full series (movingAverages), kept by the caller per series so a pan
   * or zoom only slices them. They never widen the vertical range: the candles define the scale.
   */
  mas?: readonly MaSeries[];
  /** Prices that stay inside the vertical range while the newest bar is in view (e.g. the live last price). */
  include?: Array<number | undefined>;
  /**
   * Fraction of the height kept free above the highest price in range (for the MA legend and the
   * high marker under it); the range's top padding grows to it when the usual 8 % is less.
   */
  topClear?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Geometry of the bars in view. Work is proportional to the bars in view (not the series). */
export function buildChart(all: readonly Bar[], opts: ChartOptions): ChartGeometry | null {
  const n = all.length;
  if (!n) return null;
  const win = resolveView(opts.view ?? LATEST_VIEW, all, opts.count);
  const { start, span } = win;

  // Vertical range and volume scale from the bars that overlap the view.
  const v0 = Math.max(0, Math.floor(start));
  const v1 = Math.min(n, Math.ceil(start + span));
  let hi = -Infinity;
  let lo = Infinity;
  let maxVol = 0;
  let hiIndex = v0;
  let loIndex = v0;
  for (let i = v0; i < v1; i++) {
    const b = all[i];
    if (b.high > hi) {
      hi = b.high;
      hiIndex = i;
    }
    if (b.low < lo) {
      lo = b.low;
      loIndex = i;
    }
    if (b.volume > maxVol) maxVol = b.volume;
  }
  // Extremes of the bars themselves, before the live price may widen the range.
  const extremes = { high: { index: hiIndex, price: hi }, low: { index: loIndex, price: lo } };
  if (v1 >= n) {
    for (const p of opts.include ?? []) {
      if (!finite(p) || p <= 0) continue;
      if (p > hi) hi = p;
      if (p < lo) lo = p;
    }
  }
  if (!(hi >= lo)) hi = lo = all[n - 1].close;
  const raw = hi - lo;
  let pad = raw * 0.08;
  if (!(pad > 0)) pad = Math.abs(hi) * 0.01 || 1;
  // The top pad is `clear` of the padded range: pad / (raw + pad + bottom pad) = clear.
  const clear = clamp(opts.topClear ?? 0, 0, 0.5);
  const padTop = Math.max(pad, (clear * (raw + pad)) / (1 - clear));
  hi += padTop;
  lo -= pad;
  const range = hi - lo;
  const y = (v: number) => ((hi - v) / range) * VB_H;

  const cw = VB_W / span;
  const bw = cw * 0.56;
  const maSeries = opts.mas ?? [];
  const maD = maSeries.map(() => '');
  const maPts = maSeries.map(() => 0);
  const { from, to } = renderRange(win, n);
  const candles: Candle[] = [];
  const volumes: VolumeBar[] = [];
  let upWicks = '';
  let upBodies = '';
  let dnWicks = '';
  let dnBodies = '';
  let upVolume = '';
  let dnVolume = '';
  for (let i = from; i < to; i++) {
    const b = all[i];
    const x = (i - start) * cw + cw * 0.22;
    const cx = x + bw / 2;
    const up = b.close >= b.open;
    const top = Math.min(y(b.open), y(b.close));
    const h = Math.max(1, Math.abs(y(b.open) - y(b.close)));
    const c: Candle = { index: i, up, x, w: bw, cx, top, h, yh: y(b.high), yl: y(b.low) };
    candles.push(c);
    const wick = `M${r2(cx)} ${r2(c.yh)}V${r2(c.yl)}`;
    const body = `M${r2(x)} ${r2(top)}h${r2(bw)}v${r2(h)}h${r2(-bw)}z`;
    if (up) {
      upWicks += wick;
      upBodies += body;
    } else {
      dnWicks += wick;
      dnBodies += body;
    }
    const vh = maxVol > 0 ? Math.min(VOL_MAX, (b.volume / maxVol) * VOL_MAX) : 0;
    if (vh > 0) {
      volumes.push({ up, x, w: bw, y: VOL_VB_H - vh, h: vh });
      const rect = `M${r2(x)} ${r2(VOL_VB_H - vh)}h${r2(bw)}v${r2(vh)}h${r2(-bw)}z`;
      if (up) upVolume += rect;
      else dnVolume += rect;
    }
    for (let k = 0; k < maSeries.length; k++) {
      const v = maSeries[k].values[i];
      if (v == null) continue;
      // An average only starts (it is undefined before `period` bars), so one moveto per line.
      maD[k] += `${maPts[k]++ ? 'L' : 'M'}${r2(cx)} ${r2(y(v))}`;
    }
  }

  return {
    hi,
    lo,
    window: win,
    candles,
    volumes,
    paths: { upWicks, upBodies, dnWicks, dnBodies, upVolume, dnVolume },
    mas: maSeries.map((m, k) => ({ period: m.period, d: maPts[k] > 1 ? maD[k] : '' })),
    axis: [0.15, 0.5, 0.85].map((frac) => ({ frac, value: hi - range * frac })),
    extremes,
    y,
    priceAt: (fracY) => hi - range * fracY,
    indexAt: (fracX) => {
      const i = Math.floor(start + clamp(fracX, 0, 0.999999) * span);
      return i < 0 || i >= n ? null : i;
    },
    centerX: (index) => (index - start + 0.5) * cw,
  };
}

// ---------------------------------------------------------------------------
// Live price merge

/** "YYYY-MM-DD" of a daily-or-longer bar. Robust to the bar time being midnight UTC, ET or local. */
export function barDay(time: number): string {
  return new Date((time + 12 * 3600) * 1000).toISOString().slice(0, 10);
}

/** Monday of the week containing a "YYYY-MM-DD" day. */
function weekStart(day: string): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function nyToday(now: Date): string {
  const { ymd } = nyClock(now);
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** Whether the last bar of a series is the one that is still forming now. */
export function isCurrentBar(bar: Bar, tf: Timeframe, now: Date, session: MarketSession): boolean {
  const nowSec = now.getTime() / 1000;
  const dur = barSeconds(tf);
  // Intraday bars end on their grid (a partial first bar of 2 to 4 hours ends at the next grid line).
  if (dur != null) return session !== 'closed' && nowSec >= bar.time && nowSec < barEndSec(bar.time, dur);
  // Daily and longer bars are regular-hours bars: only the regular session moves them.
  if (session !== 'regular') return false;
  const day = barDay(bar.time);
  const today = nyToday(now);
  switch (tf) {
    case '1D':
      return day === today;
    case '1W':
      // IB may stamp a weekly bar with any day of its week: compare Monday-based weeks.
      return weekStart(day) === weekStart(today);
    case '1M':
      return day.slice(0, 7) === today.slice(0, 7);
    case '1Q':
      return day.slice(0, 4) === today.slice(0, 4) && quarterOf(day) === quarterOf(today);
    case '1Y':
      return day.slice(0, 4) === today.slice(0, 4);
    default:
      return false;
  }
}

/** Quarter (0–3) of a "YYYY-MM-DD" day. */
const quarterOf = (day: string) => Math.floor((Number(day.slice(5, 7)) - 1) / 3);

/**
 * Longest gap (s) after the newest bar's end that the live price bridges with new bars: about two
 * of the chart's reloads (ChartView reloads intraday bars every 60 s), or three bars. A longer gap
 * (a stalled feed) waits for IB's bars.
 */
const ROLL_MAX_GAP_SEC = 120;
const rollMaxGap = (dur: number) => Math.max(ROLL_MAX_GAP_SEC, 3 * dur);

/**
 * The live bars still ahead of the stored ones (a reload replaces those it reaches). A live copy
 * of the stored newest bar keeps the extremes the quotes saw and the last price as its close (a
 * real-time last price is never older than a reload); open and volume are the stored bar's.
 */
function reconcileLive(stored: readonly Bar[], live: readonly Bar[]): Bar[] {
  const newest = stored[stored.length - 1];
  if (!newest || !live.length) return [];
  let i = 0;
  while (i < live.length && live[i].time < newest.time) i++;
  if (i === live.length) return [];
  const rest = live.slice(i);
  if (rest[0].time === newest.time) {
    const b = rest[0];
    if (b.high <= newest.high && b.low >= newest.low && b.close === newest.close) rest.shift();
    else rest[0] = { ...newest, high: Math.max(newest.high, b.high), low: Math.min(newest.low, b.low), close: b.close };
  }
  return rest;
}

/**
 * Advances the live bars (the chart's tail beyond the stored bars, kept between quotes) with the
 * live last price at `now` (`live`: real-time quotes; delayed or frozen quotes are minutes old, so
 * they never touch intraday bars and only extend daily and longer ones):
 * - it extends the forming bar (close, plus high / low extension), which stays extended between
 *   quotes (a live copy of a stored bar);
 * - intraday, while a session runs, once the newest bar's time is over it starts the bar of the
 *   bucket holding `now` on the interval's grid, like IB's next bar: the buckets in between as
 *   flat bars at the previous close without volume (IB fills every bucket of a session that way),
 *   the new one opening at the previous close;
 * - across a session break (the newest bar is older than `sessionOpen`, unix s) nothing is filled:
 *   the first bar starts at the open (a partial first bar of 2 to 4 hours) at the live price.
 * A reload of the stored bars replaces the live bars it reaches (reconcileLive). Applying the
 * same price at the same time again changes nothing.
 */
export function advanceLiveBars(
  stored: readonly Bar[],
  live: readonly Bar[],
  last: number | undefined,
  tf: Timeframe,
  now: Date,
  session: MarketSession,
  opts: { live?: boolean; sessionOpen?: number } = {},
): Bar[] {
  const dur = barSeconds(tf);
  if (!stored.length || (dur != null && opts.live === false)) return [];
  const tail = reconcileLive(stored, live);
  if (!finite(last) || last <= 0) return tail;
  const base = tail.length ? tail[tail.length - 1] : stored[stored.length - 1];
  if (isCurrentBar(base, tf, now, session)) {
    if (base.close === last && base.high >= last && base.low <= last) return tail;
    const merged: Bar = { ...base, close: last, high: Math.max(base.high, last), low: Math.min(base.low, last) };
    return tail.length ? [...tail.slice(0, -1), merged] : [merged];
  }
  if (dur == null || session === 'closed') return tail;
  const nowSec = Math.floor(now.getTime() / 1000);
  const end = barEndSec(base.time, dur);
  if (nowSec < end) return tail;
  const open = opts.sessionOpen;
  if (open !== undefined && base.time < open && open <= nowSec) {
    // A new session: no bars across the break; the first one starts at the open.
    if (nowSec - open > rollMaxGap(dur)) return tail;
    return [...tail, { time: barStartSec(nowSec, dur, open), open: last, high: last, low: last, close: last, volume: 0 }];
  }
  if (nowSec - end > rollMaxGap(dur)) return tail;
  const current = barStartSec(nowSec, dur, open);
  if (current <= base.time) return tail;
  const prev = base.close;
  const added: Bar[] = [];
  for (let t = end; t < current; t += dur) added.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: 0 });
  added.push({ time: current, open: prev, high: Math.max(prev, last), low: Math.min(prev, last), close: last, volume: 0 });
  return tail.concat(added);
}

/** The stored bars with the live bars (advanceLiveBars) in place of those they replace. */
export function withLiveBars(stored: Bar[], live: readonly Bar[]): Bar[] {
  if (!live.length) return stored;
  const first = live[0].time;
  let n = stored.length;
  while (n > 0 && stored[n - 1].time >= first) n--;
  return stored.slice(0, n).concat(live);
}

/** The live last price on the bars, from no live bars: advanceLiveBars once (tests, one-off merges). */
export function mergeLivePrice(
  bars: Bar[],
  last: number | undefined,
  tf: Timeframe,
  now: Date,
  session: MarketSession,
  opts: { live?: boolean; sessionOpen?: number } = {},
): Bar[] {
  return withLiveBars(bars, advanceLiveBars(bars, [], last, tf, now, session, opts));
}

// ---------------------------------------------------------------------------
// Right axis tags

/** Heights (px) of the right-axis elements; they follow the styles in PriceChart. */
export const AXIS_LABEL_H = 12;
export const LAST_TAG_H = 20;
/** Alert and crosshair tags. */
export const SMALL_TAG_H = 17;
const TAG_GAP = 1;

/**
 * Vertical centers (px from the top) for alert tags so none hides behind the last-price tag or
 * another alert tag. The last-price tag stays at its price; alert tags keep their order and move
 * away from it, staying inside `height`. The alert lines themselves keep their true prices.
 */
export function spreadAlertTags(ys: number[], lastY: number | null, height: number): number[] {
  const out = [...ys];
  const half = SMALL_TAG_H / 2;
  const step = SMALL_TAG_H + TAG_GAP;
  const clamp = (y: number) => Math.min(Math.max(y, half), Math.max(half, height - half));
  const idx = ys.map((_, i) => i);
  // Places tags nearest-first, each at least one step beyond the previous one.
  const up = (list: number[], edge: number) => {
    for (const i of list) {
      out[i] = clamp(Math.min(ys[i], edge));
      edge = out[i] - step;
    }
  };
  const down = (list: number[], edge: number) => {
    for (const i of list) {
      out[i] = clamp(Math.max(ys[i], edge));
      edge = out[i] + step;
    }
  };
  if (lastY == null) {
    down(idx.sort((a, b) => ys[a] - ys[b]), -Infinity);
    return out;
  }
  const clear = (LAST_TAG_H + SMALL_TAG_H) / 2 + TAG_GAP;
  up(idx.filter((i) => ys[i] < lastY).sort((a, b) => ys[b] - ys[a]), lastY - clear);
  down(idx.filter((i) => ys[i] >= lastY).sort((a, b) => ys[a] - ys[b]), lastY + clear);
  return out;
}

/** Whether an axis label at `labelY` stays clear of a tag `tagH` px tall centered at `tagY`. */
export function clearOfTag(labelY: number, tagY: number, tagH: number): boolean {
  return Math.abs(labelY - tagY) >= (AXIS_LABEL_H + tagH) / 2 + TAG_GAP;
}

// ---------------------------------------------------------------------------
// Extreme markers

/** Leader of an extreme marker: a short diagonal away from the wick, then a horizontal run (px). */
export const EXTREME_DIAG = 6;
export const EXTREME_RUN = 10;
/** Half the label height plus a margin: labels stay this far inside the plot. */
const EXTREME_EDGE = 9;

export interface ExtremeLayout {
  /** SVG polyline points in plot pixels: wick tip, elbow, end of the leader. */
  points: string;
  /** The wick tip the leader starts at (px). */
  tipX: number;
  tipY: number;
  /** Label anchor (px): the leader's end; the label extends to the right (dir 1) or left (dir -1). */
  x: number;
  y: number;
  dir: 1 | -1;
}

/**
 * Leader and label position for the highest (kind 'high') or lowest ('low') bar in view. The
 * marker points into the free side: left when the bar is in the right 40 % of the plot (the
 * label would otherwise run into the price axis), right otherwise; up for the high, down for
 * the low, kept inside the plot vertically and with the label's center at or below `minY`.
 */
export function extremeLayout(tipX: number, tipY: number, width: number, height: number, kind: 'high' | 'low', minY = EXTREME_EDGE): ExtremeLayout {
  const dir: 1 | -1 = tipX > width * 0.6 ? -1 : 1;
  const want = kind === 'high' ? tipY - EXTREME_DIAG : tipY + EXTREME_DIAG;
  const top = Math.max(EXTREME_EDGE, minY);
  const y = clamp(want, top, Math.max(top, height - EXTREME_EDGE));
  const elbowX = tipX + dir * EXTREME_DIAG;
  const endX = elbowX + dir * EXTREME_RUN;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { points: `${r(tipX)},${r(tipY)} ${r(elbowX)},${r(y)} ${r(endX)},${r(y)}`, tipX, tipY, x: endX, y, dir };
}

/** A rectangle in plot pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Extreme marker labels (PriceChart's extremeTag): 11px monospace text, 1px × 3px padding. */
const EXTREME_LABEL_H = 13;
const EXTREME_LABEL_PAD_X = 3;

/** Box around an extreme marker: its leader from the wick tip and its label showing `text`. */
export function extremeBox(m: ExtremeLayout, text: string): Rect {
  const w = labelWidth(text) + 2 * EXTREME_LABEL_PAD_X;
  const labelLeft = m.dir === 1 ? m.x : m.x - w;
  return {
    left: Math.min(m.tipX, labelLeft),
    right: Math.max(m.tipX, labelLeft + w),
    top: Math.min(m.tipY, m.y - EXTREME_LABEL_H / 2),
    bottom: Math.max(m.tipY, m.y + EXTREME_LABEL_H / 2),
  };
}

/** Whether two boxes overlap or come closer than `gap` px. */
function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;
}

/** Space (px) an extreme marker keeps from the MA legend. */
const LEGEND_CLEAR_GAP = 2;

/**
 * Layout and box of an extreme marker showing `text` (see extremeLayout). A marker whose label
 * would touch `avoid` (the MA legend) drops its label below it, beside the wick; the range keeps
 * room above the highest bar for the legend (legendClearance), so this only happens in a very
 * short plot.
 */
export function placeExtreme(
  tipX: number,
  tipY: number,
  width: number,
  height: number,
  kind: 'high' | 'low',
  text: string,
  avoid?: Rect | null,
): ExtremeLayout & { box: Rect } {
  const layout = extremeLayout(tipX, tipY, width, height, kind);
  const box = extremeBox(layout, text);
  if (!avoid || !overlaps(box, avoid, LEGEND_CLEAR_GAP)) return { ...layout, box };
  const moved = extremeLayout(tipX, tipY, width, height, kind, avoid.bottom + LEGEND_CLEAR_GAP + EXTREME_LABEL_H / 2);
  return { ...moved, box: extremeBox(moved, text) };
}

// ---------------------------------------------------------------------------
// MA legend

/**
 * The MA legend (PriceChart): 11px monospace items on a panel-colored pad at the plot's top-left
 * (px), on as many lines of LEGEND_H as they need in the plot's width (legendLines).
 */
export const LEGEND_LEFT = 8;
export const LEGEND_TOP = 6;
export const LEGEND_H = 17;
export const LEGEND_PAD_X = 6;
export const LEGEND_GAP = 10;

/**
 * Room (px) kept above the highest price in range while a legend of `lines` lines shows
 * (buildChart's topClear): the legend, a gap, and the high marker's leader and half its label
 * (plus a pixel for rounding), so neither the bars nor the marker run under the legend.
 */
export function legendClearance(lines: number): number {
  return LEGEND_TOP + lines * LEGEND_H + LEGEND_CLEAR_GAP + EXTREME_DIAG + EXTREME_LABEL_H / 2 + 1;
}

/** A legend item: the average's label and its value at a bar, or a dash where it has not started. */
export function legendItem(label: string, value: number | undefined, minTick?: number): string {
  return `${label} ${value != null ? axisPrice(value, minTick) : '—'}`;
}

/** Width (px) of the widest axisPrice text of any price from `lo` to `hi`. */
function widestPriceWidth(lo: number, hi: number, minTick?: number): number {
  // The text grows with the integer digits, but just below ±1 and ±10,000 it carries more decimals
  // (and rounds up to "1.0000" or "10000.00"), so those are probed too.
  const probes = [lo, hi, ...[1, -1, 10_000, -10_000].map((t) => t * (1 - 1e-12)).filter((p) => p > lo && p < hi)];
  return Math.max(...probes.map((p) => labelWidth(axisPrice(p, minTick))));
}

/**
 * Width (px) each legend item (legendItem) can take for a series: its label and the widest value
 * of any price between the lowest and highest close, as a simple average of closes stays between
 * them. Lines are packed by these widths, so hovering and panning never move items between lines
 * or change the room the legend takes from the chart.
 */
export function legendItemWidths(bars: readonly Bar[], labels: readonly string[], minTick?: number): number[] {
  if (!labels.length) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    if (b.close < lo) lo = b.close;
    if (b.close > hi) hi = b.close;
  }
  const value = Math.max(labelWidth('—'), lo <= hi ? widestPriceWidth(lo, hi, minTick) : 0);
  return labels.map((label) => labelWidth(`${label} `) + value);
}

/**
 * labelWidth's 0.6em per character is a hair under the monospace fonts' advance (SF Mono and
 * Menlo at 11px measure about 6.62px): legend lines are packed with this margin, so a full line
 * does not overflow and get cut.
 */
const LEGEND_FIT = 1.01;

/**
 * The legend's items as lines in a plot `width` px wide: in order, as many on a line as fit by
 * their `widths` (legendItemWidths). An item too wide for any line gets a line of its own, where
 * PriceChart cuts it with an ellipsis.
 */
export function legendLines(widths: readonly number[], width: number): number[][] {
  const room = Math.max(0, width - 2 * LEGEND_LEFT - 2 * LEGEND_PAD_X) / LEGEND_FIT;
  const lines: number[][] = [];
  let used = 0;
  widths.forEach((w, i) => {
    const line = lines[lines.length - 1];
    if (line && used + LEGEND_GAP + w <= room) {
      line.push(i);
      used += LEGEND_GAP + w;
    } else {
      lines.push([i]);
      used = w;
    }
  });
  return lines;
}

/** Box (px) of the MA legend showing `items` on `lines` (legendLines) in a plot `width` px wide, from approximate text widths. */
export function legendBox(items: readonly string[], lines: readonly (readonly number[])[], width: number): Rect {
  const text = Math.max(0, ...lines.map((line) => line.reduce((sum, i) => sum + labelWidth(items[i] ?? ''), 0) + LEGEND_GAP * Math.max(0, line.length - 1)));
  const w = text + 2 * LEGEND_PAD_X;
  return {
    left: LEGEND_LEFT,
    top: LEGEND_TOP,
    right: LEGEND_LEFT + Math.min(w, Math.max(0, width - 2 * LEGEND_LEFT)),
    bottom: LEGEND_TOP + lines.length * LEGEND_H,
  };
}

export interface MaReading {
  period: MaPeriod;
  /** Undefined where the average has not started (fewer than `period` bars up to there). */
  value: number | undefined;
}

/** The legend's values: each moving average at bar `index` (the hovered bar, else latestInView). */
export function maReadings(mas: readonly MaSeries[], index: number): MaReading[] {
  return mas.map((m) => ({ period: m.period, value: m.values[index] }));
}

/** The "Latest" button's distance (px) from the plot's bottom-right corner, and the space it keeps from markers. */
export const LATEST_MARGIN = 8;
const LATEST_CLEAR = 4;

/**
 * Where the "Latest" button (`w` × `h` px) goes in a plot `width` × `height` px, as offsets from the
 * plot's right and bottom edges: the bottom-right corner, unless one of the `avoid` boxes (the extreme
 * markers) is there. It then moves left past the boxes in its way, staying in the padding under the
 * lowest low rather than covering the bars above it; only where that leaves no room on the left
 * does it move up past them instead.
 */
export function latestButtonSpot(avoid: readonly Rect[], width: number, height: number, w: number, h: number): { right: number; bottom: number } {
  const blocking = (right: number, bottom: number) => {
    const l = width - right - w;
    const t = height - bottom - h;
    return avoid.filter(
      (r) => r.left < l + w + LATEST_CLEAR && l < r.right + LATEST_CLEAR && r.top < t + h + LATEST_CLEAR && t < r.bottom + LATEST_CLEAR,
    );
  };
  const corner = { right: LATEST_MARGIN, bottom: LATEST_MARGIN };
  if (!blocking(corner.right, corner.bottom).length) return corner;
  // Each move clears at least one more box, so this ends after a pass per box.
  const left = { ...corner };
  for (let hit = blocking(left.right, left.bottom); hit.length; hit = blocking(left.right, left.bottom)) {
    left.right = width - Math.min(...hit.map((r) => r.left)) + LATEST_CLEAR;
  }
  if (width - left.right - w >= LATEST_MARGIN) return left;
  const up = { ...corner };
  for (let hit = blocking(up.right, up.bottom); hit.length; hit = blocking(up.right, up.bottom)) {
    up.bottom = height - Math.min(...hit.map((r) => r.top)) + LATEST_CLEAR;
  }
  return up;
}

// ---------------------------------------------------------------------------
// Labels

/** Decimals for prices of an instrument: 2 by default, more for sub-cent ticks or prices below 1. */
export function priceDecimals(minTick: number | undefined, price?: number): number {
  let d = 2;
  if (finite(minTick) && minTick > 0 && minTick < 0.01) d = Math.min(6, Math.ceil(-Math.log10(minTick) - 1e-9));
  if (finite(price) && Math.abs(price) > 0 && Math.abs(price) < 1) d = Math.max(d, 4);
  return d;
}

/** Compact price for the narrow right axis: no grouping; fewer decimals for very large prices. */
export function axisPrice(v: number, minTick?: number): string {
  if (!finite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 10_000 ? 1 : priceDecimals(minTick, v);
  const s = a.toFixed(d);
  return v < 0 && Number(s) !== 0 ? '−' + s : s;
}

// ---------------------------------------------------------------------------
// Exchange time

/** Intraday bars of US instruments, and of any whose exchange time zone is unknown, are shown in New York time. */
export const NY_ZONE = 'America/New_York';

/**
 * IB time zone ids (contract details' timeZoneId) that are not IANA names, or not the zone IB
 * means by them: older TWS versions send abbreviations ("EST", "HKT"); "EST" and "MST" are fixed
 * offsets in the IANA database, IB means the exchange's local time.
 */
const IB_ZONES: Record<string, string> = {
  EST: NY_ZONE,
  EDT: NY_ZONE,
  ET: NY_ZONE,
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',
  PST: 'America/Los_Angeles',
  GMT: 'Europe/London',
  BST: 'Europe/London',
  HKT: 'Asia/Hong_Kong',
  JST: 'Asia/Tokyo',
  CTT: 'Asia/Shanghai',
  KST: 'Asia/Seoul',
  SGT: 'Asia/Singapore',
  IST: 'Asia/Kolkata',
  AET: 'Australia/Sydney',
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
  NZT: 'Pacific/Auckland',
};

/** US zones besides IANA's "US/…" links: their instruments are shown in New York time, like the rest of the app. */
const US_ZONES = new Set([NY_ZONE, 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'EST5EDT', 'CST6CDT', 'MST7MDT', 'PST8PDT']);

const zoneNames = new Map<string, string>();

/**
 * The IANA time zone an instrument's intraday bars are shown in (time axis and hover label): the
 * exchange's, from IB's timeZoneId ("Hongkong", "Asia/Hong_Kong", "MET", "HKT", ...), but New York
 * for US exchanges and when the id is missing or unknown.
 */
export function chartTimeZone(timeZoneId: string | undefined): string {
  const id = timeZoneId?.trim() ?? '';
  let zone = zoneNames.get(id);
  if (zone === undefined) {
    zone = IB_ZONES[id.toUpperCase()] ?? id;
    if (!zone || zone.startsWith('US/') || US_ZONES.has(zone)) zone = NY_ZONE;
    else {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
      } catch {
        zone = NY_ZONE; // not a zone this runtime knows
      }
    }
    zoneNames.set(id, zone);
  }
  return zone;
}

/** Per zone: a formatter and its UTC offsets (s) per hour since the epoch (exchange zones change offset on the hour, UTC). */
const zoneClocks = new Map<string, { parts: Intl.DateTimeFormat; offsets: Map<number, number> }>();

/** UTC offset (s) of time zone `zone` at unix time `t` (s). */
function zoneOffset(zone: string, t: number): number {
  let clock = zoneClocks.get(zone);
  if (!clock) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    clock = { parts, offsets: new Map() };
    zoneClocks.set(zone, clock);
  }
  const h = Math.floor(t / 3600);
  let off = clock.offsets.get(h);
  if (off === undefined) {
    const p = Object.fromEntries(clock.parts.formatToParts(new Date(h * 3_600_000)).map((x) => [x.type, x.value]));
    off = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) / 1000 - h * 3600;
    if (clock.offsets.size >= 100_000) clock.offsets.clear();
    clock.offsets.set(h, off);
  }
  return off;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Bar time labels per language (weekday names are indexed like Date.getUTCDay). */
const BAR_LABELS = {
  en: {
    weekdays: WEEKDAYS,
    intraday: (wd: string, md: string, hm: string) => `${wd} ${md} ${hm}`,
    day: (day: string, wd: string) => `${wd} ${day}`,
    week: (day: string) => `Week of ${day}`,
    month: (y: string, m: number) => `${MONTH_EN[m - 1]} ${y}`,
    quarter: (y: string, q: number) => `Q${q} ${y}`,
    year: (y: string) => y,
  },
  zh: {
    weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    intraday: (wd: string, md: string, hm: string) => `${md} ${wd} ${hm}`,
    day: (day: string, wd: string) => `${day} ${wd}`,
    week: (day: string) => `${day} 当周`,
    month: (y: string, m: number) => `${y}年${m}月`,
    quarter: (y: string, q: number) => `${y}年Q${q}`,
    year: (y: string) => `${y}年`,
  },
};

/** "HH:MM", or "HH:MM:SS" with `seconds`, of a bar's exchange clock. */
const clockText = (f: BarFields, seconds: boolean) =>
  `${pad2(Math.floor(f.min / 60))}:${pad2(f.min % 60)}${seconds ? `:${pad2(f.sec % 60)}` : ''}`;

/**
 * Hover label for a bar. Intraday bars are shown in exchange time (`zone`, see chartTimeZone), as
 * on the time axis, with seconds for second intervals; daily and longer bars by their trading
 * date (quarters as "Q3 2026").
 */
export function formatBarTime(time: number, tf: Timeframe, lang: 'en' | 'zh', zone: string = NY_ZONE): string {
  const L = BAR_LABELS[lang];
  if (isIntraday(tf)) {
    const f = barFields(time, true, zone);
    return L.intraday(L.weekdays[f.wd], `${pad2(f.mo)}/${pad2(f.d)}`, clockText(f, isSecondsTimeframe(tf)));
  }
  const day = barDay(time);
  const [y, m] = [day.slice(0, 4), Number(day.slice(5, 7))];
  const wd = L.weekdays[new Date(day + 'T12:00:00Z').getUTCDay()];
  switch (tf) {
    case '1W':
      return L.week(day);
    case '1M':
      return L.month(y, m);
    case '1Q':
      return L.quarter(y, quarterOf(day) + 1);
    case '1Y':
      return L.year(y);
    default:
      return L.day(day, wd);
  }
}

// ---------------------------------------------------------------------------
// Time axis

/** Minimum distance (px) between the centers of two time axis labels. */
export const TIME_TICK_GAP = 70;

/**
 * What a tick marks, from the finest to the coarsest calendar unit it starts. The label follows
 * the kind ("10:30", "10/02", "Oct", "2026"), and a coarser kind wins where two labels would collide.
 */
export type TimeTickKind = 'time' | 'day' | 'month' | 'year';
const KIND_RANK: Record<TimeTickKind, number> = { time: 0, day: 1, month: 2, year: 3 };

export interface TimeTick {
  /** Index into the full bar series. */
  index: number;
  kind: TimeTickKind;
  label: string;
}

/** A tick in view: `x` is the center of its bar in px from the plot's left edge. */
export interface TimeAxisLabel extends TimeTick {
  x: number;
}

/** Calendar fields of a bar: exchange time for intraday bars, the trading date otherwise. */
interface BarFields {
  y: number;
  /** 1..12 */
  mo: number;
  d: number;
  /** Days since 1970-01-01 of the (exchange) date. */
  day: number;
  /** 0 = Sunday */
  wd: number;
  /** Minutes since midnight (exchange time); 0 for daily and longer bars. */
  min: number;
  /** Seconds since midnight (exchange time); 0 for daily and longer bars. */
  sec: number;
}

function barFields(time: number, intraday: boolean, zone: string): BarFields {
  // Daily and longer bars: the trading date as in barDay (robust to the bar's midnight time zone).
  const s = intraday ? time + zoneOffset(zone, time) : time + 12 * 3600;
  const dt = new Date(s * 1000);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    day: Math.floor(s / 86_400),
    wd: dt.getUTCDay(),
    min: intraday ? dt.getUTCHours() * 60 + dt.getUTCMinutes() : 0,
    sec: intraday ? dt.getUTCHours() * 3600 + dt.getUTCMinutes() * 60 + dt.getUTCSeconds() : 0,
  };
}

/** A tick step: a bar starts a tick where its key differs from the previous bar's. */
type TimeStep = (f: BarFields) => number;

const monthIndex = (f: BarFields) => f.y * 12 + f.mo - 1;
/** Every `n` seconds of the exchange clock; every new day too. */
const everySeconds =
  (n: number): TimeStep =>
  (f) =>
    f.day * 86_400 + Math.floor(f.sec / n);
/** Every `n` minutes of the exchange clock; every new day too. */
const everyMinutes =
  (n: number): TimeStep =>
  (f) =>
    f.day * 1440 + Math.floor(f.min / n);
const everyDay: TimeStep = (f) => f.day;
/** Monday-based weeks; the first bar of a month too (the month label replaces its week's). */
const everyWeek: TimeStep = (f) => monthIndex(f) * 1e6 + (f.day - ((f.wd + 6) % 7));
const everyMonths =
  (n: number): TimeStep =>
  (f) =>
    Math.floor(monthIndex(f) / n);
const everyYears =
  (n: number): TimeStep =>
  (f) =>
    Math.floor(f.y / n);

/** Clock steps (s) of second intervals and (min) of minute intervals; an interval uses those that are whole multiples of its bar and longer than it. */
const SECOND_STEPS = [5, 10, 15, 30, 60, 90, 120, 180, 300, 360, 600, 900, 1800, 3600, 7200, 14_400, 21_600];
const MINUTE_STEPS = [5, 15, 30, 60, 120, 240, 360];
const CALENDAR_STEPS: TimeStep[] = [everyDay, everyWeek, everyMonths(1), everyMonths(3), everyYears(1)];

/**
 * Candidate steps of an intraday interval, finest first: clock steps that are whole multiples of
 * the bar (so ticks fall on bars: "09:31:30" for 45 s bars, never a bar inside a step), up to six
 * hours, then days, weeks, months, quarters and years. 2 to 4-hour bars on the UTC grid go by
 * days and longer only.
 */
function intradaySteps(barSec: number): TimeStep[] {
  const fits = (s: number) => s >= barSec && s % barSec === 0 && (s > barSec || barSec === 3600);
  const clock =
    barSec < 60
      ? SECOND_STEPS.filter(fits).map((s) => (s % 60 === 0 ? everyMinutes(s / 60) : everySeconds(s)))
      : barSec <= 3600
        ? MINUTE_STEPS.filter((m) => fits(m * 60)).map(everyMinutes)
        : [];
  return clock.concat(CALENDAR_STEPS);
}

/** Candidate steps per timeframe, finest first; the finest one whose labels stay TIME_TICK_GAP apart is used. */
const TIME_STEPS: Record<Timeframe, TimeStep[]> = {
  ...(Object.fromEntries(TIMEFRAMES.filter(isIntraday).map((tf) => [tf, intradaySteps(barSeconds(tf)!)])) as Record<Timeframe, TimeStep[]>),
  '1D': [everyDay, everyWeek, everyMonths(1), everyMonths(2), everyMonths(3), ...[1, 2, 5, 10].map(everyYears)],
  '1W': [everyMonths(1), everyMonths(2), everyMonths(3), ...[1, 2, 5, 10].map(everyYears)],
  '1M': [everyMonths(3), everyMonths(6), ...[1, 2, 5, 10, 20].map(everyYears)],
  '1Q': [1, 2, 5, 10, 20, 50].map(everyYears),
  '1Y': [1, 2, 5, 10, 20, 50].map(everyYears),
};

/** Bars sampled (the newest) to measure how far apart each step's ticks are. */
const SPACING_SAMPLE = 5000;
/**
 * The spacing of a step is this quantile of the gaps between its ticks of the same kind: the median,
 * so the odd short gap (a holiday week, a half day) does not make the step look denser than it is.
 */
const SPACING_QUANTILE = 0.5;

/**
 * How far apart (in bars) the ticks of each of the timeframe's steps (TIME_STEPS order) are,
 * measured over the newest bars: the median gap between consecutive ticks of the same kind. Ticks
 * of different kinds may be closer (a day start half an hour before "10:00"); the coarser one wins
 * there. It only changes with the series (and its time zone, see chartTimeZone), not with the view,
 * so the step stays put while panning; callers keep it per series.
 */
export function timeStepSpacing(bars: readonly Bar[], tf: Timeframe, zone: string = NY_ZONE): number[] {
  const steps = TIME_STEPS[tf];
  const from = Math.max(0, bars.length - SPACING_SAMPLE);
  const n = bars.length - from;
  if (n < 2) return steps.map(() => Infinity);
  const intraday = isIntraday(tf);
  const last = steps.map(() => ({ index: -1, kind: 'time' as TimeTickKind }));
  const gaps: number[][] = steps.map(() => []);
  const counts = steps.map(() => 0);
  let prev = barFields(bars[from].time, intraday, zone);
  for (let i = from + 1; i < bars.length; i++) {
    const f = barFields(bars[i].time, intraday, zone);
    const kind = tickKind(prev, f, intraday);
    for (let s = 0; s < steps.length; s++) {
      if (steps[s](f) === steps[s](prev)) continue;
      counts[s]++;
      if (last[s].index >= 0 && last[s].kind === kind) gaps[s].push(i - last[s].index);
      last[s] = { index: i, kind };
    }
    prev = f;
  }
  return gaps.map((g, s) => {
    if (!g.length) return n / Math.max(1, counts[s]);
    g.sort((a, b) => a - b);
    return g[Math.floor(SPACING_QUANTILE * (g.length - 1))];
  });
}

/** Index of the finest step whose ticks are on average at least `minGap` px apart (else the coarsest). */
export function pickTimeStep(spacing: readonly number[], pxPerBar: number, minGap = TIME_TICK_GAP): number {
  const i = spacing.findIndex((bars) => bars * pxPerBar >= minGap);
  return i < 0 ? spacing.length - 1 : i;
}

/**
 * Priority of a tick where labels would collide: its kind first, then how round it is (10:00 over
 * 10:30, July over August, 2030 over 2028), so a too dense row thins out to the rounder ticks.
 */
function tickRank(kind: TimeTickKind, f: BarFields): number {
  const divides = (v: number, ds: number[]) => ds.filter((d) => v % d === 0).length;
  const round =
    kind === 'time'
      ? divides(f.sec, [15, 30, 60, 300, 900, 1800, 3600, 7200, 14_400])
      : kind === 'month'
        ? divides(f.mo - 1, [3, 6])
        : kind === 'year'
          ? divides(f.y, [2, 5, 10])
          : 0;
  return KIND_RANK[kind] * 10 + round;
}

function tickKind(prev: BarFields, f: BarFields, intraday: boolean): TimeTickKind {
  if (f.y !== prev.y) return 'year';
  if (f.mo !== prev.mo) return 'month';
  return intraday && f.day === prev.day ? 'time' : 'day';
}

function tickLabel(kind: TimeTickKind, f: BarFields, lang: 'en' | 'zh'): string {
  switch (kind) {
    case 'year':
      return String(f.y);
    case 'month':
      return lang === 'zh' ? `${f.mo}月` : MONTH_EN[f.mo - 1];
    case 'day':
      return `${pad2(f.mo)}/${pad2(f.d)}`;
    default:
      // Seconds only where the tick is not on a whole minute (second intervals).
      return clockText(f, f.sec % 60 !== 0);
  }
}

/**
 * Ticks of step `step` (an index into the timeframe's steps) for the bars in [from, to). A tick is
 * dropped when one of a higher rank (tickRank) is within `minGap` px, or an earlier one of the same
 * rank that is not itself dropped for a higher one ("Sep" on Tue 09/01 drops the week start on Tue
 * 09/08 after Labor Day, and 09/14 stays). Only ticks within twice `minGap` decide, and they are
 * read beyond [from, to) as well, so a tick keeps its label and visibility wherever the view is
 * (no jitter while panning). Intraday ticks follow the clock of time zone `zone` (see chartTimeZone).
 */
export function timeTicks(
  bars: readonly Bar[],
  tf: Timeframe,
  step: number,
  from: number,
  to: number,
  pxPerBar: number,
  lang: 'en' | 'zh',
  zone: string = NY_ZONE,
  minGap = TIME_TICK_GAP,
): TimeTick[] {
  const steps = TIME_STEPS[tf];
  const key = steps[Math.min(Math.max(0, step), steps.length - 1)];
  if (!(pxPerBar > 0) || !key) return [];
  const reach = Math.ceil(minGap / pxPerBar);
  const lo = Math.max(1, Math.floor(from) - 2 * reach);
  const hi = Math.min(bars.length, Math.ceil(to) + reach);
  if (lo >= hi) return [];
  const intraday = isIntraday(tf);
  const cands: Array<TimeTick & { rank: number }> = [];
  let prev = barFields(bars[lo - 1].time, intraday, zone);
  for (let i = lo; i < hi; i++) {
    const f = barFields(bars[i].time, intraday, zone);
    if (key(f) !== key(prev)) {
      const kind = tickKind(prev, f, intraday);
      cands.push({ index: i, kind, label: tickLabel(kind, f, lang), rank: tickRank(kind, f) });
    }
    prev = f;
  }
  const near = (j: number, k: number) => j >= 0 && j < cands.length && Math.abs(cands[j].index - cands[k].index) * pxPerBar < minGap;
  // A higher rank within the gap on either side.
  const outranked = cands.map((c, k) => {
    for (let j = k - 1; near(j, k); j--) if (cands[j].rank > c.rank) return true;
    for (let j = k + 1; near(j, k); j++) if (cands[j].rank > c.rank) return true;
    return false;
  });
  const out: TimeTick[] = [];
  for (let k = 0; k < cands.length; k++) {
    const c = cands[k];
    if (c.index < from || c.index >= to || outranked[k]) continue;
    let keep = true;
    for (let j = k - 1; keep && near(j, k); j--) keep = cands[j].rank !== c.rank || outranked[j];
    if (keep) out.push({ index: c.index, kind: c.kind, label: c.label });
  }
  return out;
}

/** Approximate width (px) of 11px monospace text: 0.6em per Latin character, 1em per CJK one. */
export function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? 11 : 6.6;
  return w;
}

/**
 * Time axis labels for a view `widthPx` wide: ticks at their bars' centers (px), without the ones
 * whose label would run past either edge. Intraday bars are labelled in time zone `zone` (see
 * chartTimeZone); `spacing` is timeStepSpacing of the series in that zone.
 */
export function timeAxisLabels(
  bars: readonly Bar[],
  tf: Timeframe,
  win: ViewWindow,
  widthPx: number,
  lang: 'en' | 'zh',
  zone: string = NY_ZONE,
  spacing: readonly number[] = timeStepSpacing(bars, tf, zone),
): TimeAxisLabel[] {
  if (!bars.length || !(widthPx > 0) || !(win.span > 0)) return [];
  const ppb = widthPx / win.span;
  const step = pickTimeStep(spacing, ppb);
  const out: TimeAxisLabel[] = [];
  for (const t of timeTicks(bars, tf, step, Math.max(0, Math.floor(win.start)), Math.ceil(win.start + win.span), ppb, lang, zone)) {
    const x = (t.index - win.start + 0.5) * ppb;
    const half = labelWidth(t.label) / 2;
    if (x - half >= 0 && x + half <= widthPx) out.push({ ...t, x });
  }
  return out;
}
