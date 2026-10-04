// Pure chart geometry: the pan / zoom window over the bars, which bars are visible,
// candle/volume/MA coordinates in the design's SVG spaces (price 800×300, volume 800×56),
// axis values, merging of older pages and the live price, and hover lookup. No React or
// store imports so it can be unit tested in node.

import { nyClock, type MarketSession } from '@shared/session';
import type { Bar, Timeframe } from '@shared/types';

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
export const MA_PERIOD = 20;

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '1h', '1D', '1W', '1M', '1Y'];

const INTRADAY_SECONDS: Partial<Record<Timeframe, number>> = { '1m': 60, '5m': 300, '1h': 3600 };

export function isIntraday(tf: Timeframe): boolean {
  return INTRADAY_SECONDS[tf] != null;
}

/** Bars per screen at the automatic zoom for a chart area `widthPx` wide. */
export function visibleBarCount(widthPx: number): number {
  const n = Math.floor((Number.isFinite(widthPx) ? widthPx : 0) / PX_PER_BAR);
  return Math.min(MAX_BARS, Math.max(MIN_BARS, n));
}

/** Simple moving average of `values`; undefined until `period` values are available. */
export function sma(values: number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
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

/** Zoom limits in bars per screen. */
export const MIN_SPAN = 20;
export const MAX_SPAN = 400;

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

/** Bars to draw: the ones in view plus one on each side (so the MA line runs to the edges). */
export function renderRange(w: ViewWindow, n: number): { from: number; to: number } {
  return { from: Math.max(0, Math.floor(w.start) - 1), to: Math.min(n, Math.ceil(w.start + w.span) + 1) };
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

export interface ChartGeometry {
  hi: number;
  lo: number;
  window: ViewWindow;
  /** Drawn bars: the ones in view plus one on each side. */
  candles: Candle[];
  volumes: VolumeBar[];
  paths: ChartPaths;
  /** SVG polyline points for the moving average ("" when off or not enough data). */
  ma: string;
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
  showMa: boolean;
  /** The moving average of the full series (sma of the closes), when the caller keeps it per series. */
  ma?: ReadonlyArray<number | undefined>;
  /** Prices that stay inside the vertical range while the newest bar is in view (e.g. the live last price). */
  include?: Array<number | undefined>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Geometry of the bars in view. Work is proportional to the bars in view (not the series), except
 * for the moving average when `ma` is not passed.
 */
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
  let pad = (hi - lo) * 0.08;
  if (!(pad > 0)) pad = Math.abs(hi) * 0.01 || 1;
  hi += pad;
  lo -= pad;
  const range = hi - lo;
  const y = (v: number) => ((hi - v) / range) * VB_H;

  const cw = VB_W / span;
  const bw = cw * 0.56;
  const ma = opts.showMa ? (opts.ma ?? sma(all.map((b) => b.close), MA_PERIOD)) : [];
  const { from, to } = renderRange(win, n);
  const candles: Candle[] = [];
  const volumes: VolumeBar[] = [];
  const maPts: string[] = [];
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
    const m = ma[i];
    if (m != null) maPts.push(`${r2(cx)},${r2(y(m))}`);
  }

  return {
    hi,
    lo,
    window: win,
    candles,
    volumes,
    paths: { upWicks, upBodies, dnWicks, dnBodies, upVolume, dnVolume },
    ma: maPts.length > 1 ? maPts.join(' ') : '',
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
  const dur = INTRADAY_SECONDS[tf];
  if (dur != null) return session !== 'closed' && nowSec >= bar.time && nowSec < bar.time + dur;
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
    case '1Y':
      return day.slice(0, 4) === today.slice(0, 4);
    default:
      return false;
  }
}

/** Extends the forming bar with the live last price (close, plus high/low extension). */
export function mergeLivePrice(bars: Bar[], last: number | undefined, tf: Timeframe, now: Date, session: MarketSession): Bar[] {
  if (!bars.length || !finite(last) || last <= 0) return bars;
  const lastBar = bars[bars.length - 1];
  if (!isCurrentBar(lastBar, tf, now, session)) return bars;
  if (lastBar.close === last && lastBar.high >= last && lastBar.low <= last) return bars;
  const merged: Bar = { ...lastBar, close: last, high: Math.max(lastBar.high, last), low: Math.min(lastBar.low, last) };
  return [...bars.slice(0, -1), merged];
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
  /** Label anchor (px): the leader's end; the label extends to the right (dir 1) or left (dir -1). */
  x: number;
  y: number;
  dir: 1 | -1;
}

/**
 * Leader and label position for the highest (kind 'high') or lowest ('low') bar in view. The
 * marker points into the free side: left when the bar is in the right 40 % of the plot (the
 * label would otherwise run into the price axis), right otherwise; up for the high, down for
 * the low, kept inside the plot vertically.
 */
export function extremeLayout(tipX: number, tipY: number, width: number, height: number, kind: 'high' | 'low'): ExtremeLayout {
  const dir: 1 | -1 = tipX > width * 0.6 ? -1 : 1;
  const want = kind === 'high' ? tipY - EXTREME_DIAG : tipY + EXTREME_DIAG;
  const y = clamp(want, EXTREME_EDGE, Math.max(EXTREME_EDGE, height - EXTREME_EDGE));
  const elbowX = tipX + dir * EXTREME_DIAG;
  const endX = elbowX + dir * EXTREME_RUN;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { points: `${r(tipX)},${r(tipY)} ${r(elbowX)},${r(y)} ${r(endX)},${r(y)}`, x: endX, y, dir };
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

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hour12: false,
});

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
    year: (y: string) => y,
  },
  zh: {
    weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    intraday: (wd: string, md: string, hm: string) => `${md} ${wd} ${hm}`,
    day: (day: string, wd: string) => `${day} ${wd}`,
    week: (day: string) => `${day} 当周`,
    month: (y: string, m: number) => `${y}年${m}月`,
    year: (y: string) => `${y}年`,
  },
};

/**
 * Hover label for a bar. Intraday bars are shown in exchange time (ET);
 * daily and longer bars by their trading date.
 */
export function formatBarTime(time: number, tf: Timeframe, lang: 'en' | 'zh'): string {
  const L = BAR_LABELS[lang];
  if (isIntraday(tf)) {
    const p = Object.fromEntries(nyParts.formatToParts(new Date(time * 1000)).map((x) => [x.type, x.value]));
    const hh = String(Number(p.hour) % 24).padStart(2, '0');
    return L.intraday(L.weekdays[WEEKDAYS.indexOf(p.weekday)] ?? p.weekday, `${p.month}/${p.day}`, `${hh}:${p.minute}`);
  }
  const day = barDay(time);
  const [y, m] = [day.slice(0, 4), Number(day.slice(5, 7))];
  const wd = L.weekdays[new Date(day + 'T12:00:00Z').getUTCDay()];
  switch (tf) {
    case '1W':
      return L.week(day);
    case '1M':
      return L.month(y, m);
    case '1Y':
      return L.year(y);
    default:
      return L.day(day, wd);
  }
}
