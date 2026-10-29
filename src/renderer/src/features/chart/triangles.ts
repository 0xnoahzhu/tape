// Triangle patterns over a stretch of bars (the chart's triangle tool): the line along the highs and
// the line along the lows, and what the two make together. Pure, so it can be unit tested.
//
// Swing highs and lows are bars whose high (low) is the highest (lowest) within `span` bars on each
// side (fewer at the stretch's ends). Each line goes through two swings and keeps every bar of the
// stretch on its side, give or take a quarter of the average bar range (a wick may poke through);
// of those, the one through the most swings (within that tolerance: its touches) wins, then the
// longest. The two lines then say what the stretch is:
//
//   highs falling, lows rising, closing in      symmetrical (converging) triangle
//   highs flat, lows rising                     ascending triangle
//   highs falling, lows flat                    descending triangle
//   both rising / both falling, closing in      rising / falling wedge
//   opening out                                 broadening
//   otherwise                                   channel
//
// "Flat" is a line that moves less than FLAT of the stretch's height over the stretch; "closing in"
// a gap at the end at least NARROWING narrower than at the start. Beside the kind: the touches of
// each line, how much narrower the end is, how far the stretch has come towards the apex (where the
// lines meet), the volume of its last third against its first, and the first close beyond a line
// after the stretch (a breakout), if the bars go on.

import type { Bar } from '@shared/types';

export type TriangleKind = 'symmetrical' | 'ascending' | 'descending' | 'risingWedge' | 'fallingWedge' | 'broadening' | 'channel';

/** A line through bars (full-series indices) at prices: price(i) = price + slope · (i − index). */
export interface TriangleLine {
  index: number;
  price: number;
  slope: number;
  /** Indices of the swings within tolerance of the line. */
  touches: number[];
}

export interface Triangle {
  /** The stretch (full-series indices, inclusive). */
  from: number;
  to: number;
  /** What the lines make; null when there is no line along the highs or the lows. */
  kind: TriangleKind | null;
  /** Why there is no kind: too few bars, or no second swing for a line. */
  why?: 'short' | 'lines';
  upper?: TriangleLine;
  lower?: TriangleLine;
  /** Where the lines meet (a fractional index), when they close in. */
  apex?: { index: number; price: number };
  /** The gap between the lines at the end against the start: −0.6 is 60 % narrower. */
  narrowing?: number;
  /** How far the stretch reaches from its start towards the apex, 0–1. */
  progress?: number;
  /** Mean volume of the last third against the first: −0.3 is 30 % lower. */
  volume?: number;
  /** The first close beyond a line after the stretch. */
  breakout?: { dir: 'up' | 'down'; index: number };
}

/** Fewest bars that can show a pattern. */
export const MIN_TRIANGLE_BARS = 10;
/** A line moving less than this share of the stretch's height over the stretch is flat. */
const FLAT = 0.1;
/** The gap must close by this share to be closing in (or grow by it to be opening out). */
const NARROWING = 0.15;
/** A bar may cross a line by this share of the average bar range; a swing this close touches it. */
const PIERCE = 0.25;
const TOUCH = 0.35;
/** Swings considered per line (the most extreme), so a long stretch stays quick. */
const MAX_SWINGS = 24;

export const linePrice = (l: Pick<TriangleLine, 'index' | 'price' | 'slope'>, i: number): number => l.price + l.slope * (i - l.index);

/** Swings of `key` within [from, to]: bars extreme within `span` bars on each side. */
function swings(bars: readonly Bar[], from: number, to: number, span: number, key: 'high' | 'low'): number[] {
  const better = key === 'high' ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
  const out: number[] = [];
  for (let i = from; i <= to; i++) {
    const v = bars[i][key];
    let extreme = true;
    for (let j = Math.max(from, i - span); j <= Math.min(to, i + span) && extreme; j++) {
      // Ties go to the earlier bar.
      if (j !== i && (better(bars[j][key], v) || (j < i && bars[j][key] === v))) extreme = false;
    }
    if (extreme) out.push(i);
  }
  if (out.length <= MAX_SWINGS) return out;
  return out
    .slice()
    .sort((a, b) => (better(bars[a][key], bars[b][key]) ? -1 : 1))
    .slice(0, MAX_SWINGS)
    .sort((a, b) => a - b);
}

/**
 * The line along the highs (`upper`) or the lows: through two swings, every bar on its side within
 * `pierce`, through the most swings within `touch`, then the longest.
 */
function bestLine(bars: readonly Bar[], from: number, to: number, points: number[], upper: boolean, pierce: number, touch: number): TriangleLine | undefined {
  const key = upper ? 'high' : 'low';
  let best: { line: TriangleLine; span: number } | undefined;
  for (let x = 0; x < points.length; x++) {
    for (let y = x + 1; y < points.length; y++) {
      const a = points[x];
      const b = points[y];
      const slope = (bars[b][key] - bars[a][key]) / (b - a);
      const line = { index: a, price: bars[a][key], slope };
      let ok = true;
      for (let i = from; i <= to && ok; i++) {
        const off = bars[i][key] - linePrice(line, i);
        if (upper ? off > pierce : off < -pierce) ok = false;
      }
      if (!ok) continue;
      const touches = points.filter((i) => Math.abs(bars[i][key] - linePrice(line, i)) <= touch);
      const span = b - a;
      if (!best || touches.length > best.line.touches.length || (touches.length === best.line.touches.length && span > best.span)) {
        best = { line: { ...line, touches }, span };
      }
    }
  }
  return best?.line;
}

/** The triangle (or other pattern) the bars from `from` to `to` (full-series indices, either order) make. */
export function findTriangle(bars: readonly Bar[], a: number, b: number): Triangle {
  const from = Math.max(0, Math.min(a, b));
  const to = Math.min(bars.length - 1, Math.max(a, b));
  const n = to - from + 1;
  if (n < MIN_TRIANGLE_BARS) return { from, to, kind: null, why: 'short' };

  let hi = -Infinity;
  let lo = Infinity;
  let ranges = 0;
  for (let i = from; i <= to; i++) {
    hi = Math.max(hi, bars[i].high);
    lo = Math.min(lo, bars[i].low);
    ranges += bars[i].high - bars[i].low;
  }
  const height = hi - lo;
  const avgRange = ranges / n || height / n;
  const span = Math.min(6, Math.max(2, Math.round(n / 15)));
  const upper = bestLine(bars, from, to, swings(bars, from, to, span, 'high'), true, avgRange * PIERCE, avgRange * TOUCH);
  const lower = bestLine(bars, from, to, swings(bars, from, to, span, 'low'), false, avgRange * PIERCE, avgRange * TOUCH);
  if (!upper || !lower) return { from, to, kind: null, why: 'lines', ...(upper ? { upper } : {}), ...(lower ? { lower } : {}) };

  const startGap = linePrice(upper, from) - linePrice(lower, from);
  const endGap = linePrice(upper, to) - linePrice(lower, to);
  const narrowing = startGap > 0 ? endGap / startGap - 1 : 0;
  const flat = (l: TriangleLine) => Math.abs(l.slope * (n - 1)) < FLAT * height;
  const rising = (l: TriangleLine) => !flat(l) && l.slope > 0;
  const falling = (l: TriangleLine) => !flat(l) && l.slope < 0;
  let kind: TriangleKind;
  if (narrowing <= -NARROWING) {
    if (falling(upper) && rising(lower)) kind = 'symmetrical';
    else if (flat(upper) && rising(lower)) kind = 'ascending';
    else if (falling(upper) && flat(lower)) kind = 'descending';
    else if (rising(upper) && rising(lower)) kind = 'risingWedge';
    else if (falling(upper) && falling(lower)) kind = 'fallingWedge';
    else kind = 'channel';
  } else kind = narrowing >= NARROWING ? 'broadening' : 'channel';

  const out: Triangle = { from, to, kind, upper, lower, narrowing };
  if (upper.slope < lower.slope) {
    // price(i) equal on both lines.
    const index = (lower.price - lower.slope * lower.index - (upper.price - upper.slope * upper.index)) / (upper.slope - lower.slope);
    out.apex = { index, price: linePrice(upper, index) };
    if (index > from) out.progress = Math.min(1, (to - from) / (index - from));
  }
  const third = Math.max(1, Math.floor(n / 3));
  const mean = (s: number, e: number) => {
    let v = 0;
    for (let i = s; i < e; i++) v += bars[i].volume ?? 0;
    return v / (e - s);
  };
  const early = mean(from, from + third);
  if (early > 0) out.volume = mean(to + 1 - third, to + 1) / early - 1;
  const pierce = avgRange * PIERCE;
  for (let i = to + 1; i < bars.length; i++) {
    if (bars[i].close > linePrice(upper, i) + pierce) {
      out.breakout = { dir: 'up', index: i };
      break;
    }
    if (bars[i].close < linePrice(lower, i) - pierce) {
      out.breakout = { dir: 'down', index: i };
      break;
    }
  }
  return out;
}
