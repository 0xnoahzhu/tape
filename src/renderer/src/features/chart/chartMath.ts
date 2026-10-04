// Pure chart geometry: which bars are visible, candle/volume/MA coordinates in the
// design's SVG spaces (price 800×300, volume 800×56), axis values, live-price merging
// and hover lookup. No React or store imports so it can be unit tested in node.

import { nyClock, type MarketSession } from '@shared/session';
import type { Bar, Timeframe } from '@shared/types';

/** Price chart viewBox (preserveAspectRatio="none"). */
export const VB_W = 800;
export const VB_H = 300;
/** Volume chart viewBox height; bars use up to VOL_MAX of it. */
export const VOL_VB_H = 56;
const VOL_MAX = 54;

/** Roughly one bar per 15 px of chart width. */
export const PX_PER_BAR = 15;
export const MIN_BARS = 30;
export const MAX_BARS = 200;
export const MA_PERIOD = 20;

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '1h', '1D', '1W', '1M', '1Y'];

const INTRADAY_SECONDS: Partial<Record<Timeframe, number>> = { '1m': 60, '5m': 300, '1h': 3600 };

export function isIntraday(tf: Timeframe): boolean {
  return INTRADAY_SECONDS[tf] != null;
}

/** Number of bars to show for a chart area `widthPx` wide. */
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

export interface ChartGeometry {
  hi: number;
  lo: number;
  /** Bar slots across the 800-wide viewBox (≥ visible bars; extra slots stay empty on the left). */
  slots: number;
  /** Empty slots before the first visible bar. */
  lead: number;
  /** Index of the first visible bar in the full series. */
  offset: number;
  candles: Candle[];
  volumes: VolumeBar[];
  /** SVG polyline points for the moving average ("" when off or not enough data). */
  ma: string;
  /** Right axis labels at 15 / 50 / 85 % of the height. */
  axis: Array<{ frac: number; value: number }>;
  /** Price → viewBox y. */
  y(price: number): number;
  /** Fraction of the height (0 = top) → price. */
  priceAt(fracY: number): number;
  /** Fraction of the width (0 = left) → index into the full series, or null over empty slots. */
  indexAt(fracX: number): number | null;
  /** viewBox x of the center of a bar (full-series index). */
  centerX(index: number): number;
}

export interface ChartOptions {
  /** Maximum number of bars to show (see visibleBarCount). */
  count: number;
  showMa: boolean;
  /** Prices that must stay inside the vertical range (e.g. the live last price). */
  include?: Array<number | undefined>;
}

export function buildChart(all: Bar[], opts: ChartOptions): ChartGeometry | null {
  if (!all.length) return null;
  const count = Math.max(1, Math.floor(opts.count));
  const visible = all.slice(-count);
  const offset = all.length - visible.length;
  const slots = Math.max(visible.length, Math.min(count, MIN_BARS));
  const lead = slots - visible.length;

  let hi = -Infinity;
  let lo = Infinity;
  for (const b of visible) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  for (const p of opts.include ?? []) {
    if (!finite(p) || p <= 0) continue;
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  let pad = (hi - lo) * 0.08;
  if (!(pad > 0)) pad = Math.abs(hi) * 0.01 || 1;
  hi += pad;
  lo -= pad;
  const span = hi - lo;
  const y = (v: number) => ((hi - v) / span) * VB_H;

  const cw = VB_W / slots;
  const maxVol = visible.reduce((m, b) => Math.max(m, b.volume), 0);
  const maValues = opts.showMa ? sma(all.map((b) => b.close), MA_PERIOD) : [];
  const candles: Candle[] = [];
  const volumes: VolumeBar[] = [];
  const ma: string[] = [];
  visible.forEach((b, i) => {
    const x = (lead + i) * cw + cw * 0.22;
    const w = cw * 0.56;
    const up = b.close >= b.open;
    const top = Math.min(y(b.open), y(b.close));
    const h = Math.max(1, Math.abs(y(b.open) - y(b.close)));
    candles.push({ index: offset + i, up, x, w, cx: x + w / 2, top, h, yh: y(b.high), yl: y(b.low) });
    const vh = maxVol > 0 ? (b.volume / maxVol) * VOL_MAX : 0;
    if (vh > 0) volumes.push({ up, x, w, y: VOL_VB_H - vh, h: vh });
    const m = maValues[offset + i];
    if (m != null) ma.push(`${(x + w / 2).toFixed(1)},${y(m).toFixed(1)}`);
  });

  return {
    hi,
    lo,
    slots,
    lead,
    offset,
    candles,
    volumes,
    ma: ma.length > 1 ? ma.join(' ') : '',
    axis: [0.15, 0.5, 0.85].map((frac) => ({ frac, value: hi - span * frac })),
    y,
    priceAt: (fracY) => hi - span * fracY,
    indexAt: (fracX) => {
      const slot = Math.floor(Math.min(0.999999, Math.max(0, fracX)) * slots);
      const i = slot - lead;
      return i < 0 || i >= visible.length ? null : offset + i;
    },
    centerX: (index) => (lead + index - offset) * cw + cw / 2,
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
