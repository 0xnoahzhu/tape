// Reversal patterns over a stretch of bars (the chart's reversal tool): head and shoulders (top and
// bottom) and double tops and bottoms, read from the stretch's swings. Pure, so it can be unit tested.
//
// The swings are a zigzag (waves.ts) at scales from most of the stretch's height down to a few
// percent of it; the largest scale with a pattern wins (the most significant one), a head and
// shoulders before a double top or bottom at the same scale, the tallest of a kind before the rest.
// For a top (a bottom is the same upside down):
//
//   head and shoulders  five swings high-low-high-low-high: the head above both shoulders by at least
//                       a tenth of the pattern's height (head to neckline); each shoulder at least a
//                       fifth of that above the neckline (the line through the two lows), the lower at
//                       least half as high as the other; the shoulders' distances from the head within
//                       2.5 times each other; the neckline moving less than half the height
//   double top          three swings high-low-high: the two tops within a tenth of the height of
//                       each other, at least three bars apart; the neckline flat at the low between
//
// A pattern's swings are turns: the zigzag's first and last points (the stretch's ends, or where it
// stops before turning) are not, so a stretch shows a pattern with the move into it and out of it.
//
// After the last swing: the first close beyond the neckline (the breakdown, or breakout for a
// bottom) and the measured move from there, the pattern's height.

import type { Bar } from '@shared/types';
import { zigzag } from './waves';

export type ReversalKind = 'headShouldersTop' | 'headShouldersBottom' | 'doubleTop' | 'doubleBottom';

export interface ReversalPoint {
  index: number;
  price: number;
  /** "LS", "H", "RS" (shoulders and head), "T1", "T2" (tops or bottoms), "N" (the lows between). */
  label: string;
}

export interface Reversal {
  from: number;
  to: number;
  kind: ReversalKind | null;
  why?: 'short' | 'none';
  points: ReversalPoint[];
  /** The neckline: price(i) = price + slope · (i − index). */
  neckline?: { index: number; price: number; slope: number };
  /** Head (or higher top) to the neckline, in price. */
  height?: number;
  /** The first close beyond the neckline after the pattern, and the measured move's target from it. */
  breakout?: { index: number; target: number };
}

export const MIN_REVERSAL_BARS = 10;
const SCALES = Array.from({ length: 40 }, (_, k) => 0.7 * 0.92 ** k);

interface Swing {
  index: number;
  price: number;
}

/** A head and shoulders over swings w[0..4] in the sense s (1 top, −1 bottom); undefined when they are not one. */
function headShoulders(w: Swing[], s: number): Omit<Reversal, 'from' | 'to' | 'kind'> | undefined {
  const [ls, n1, h, n2, rs] = w;
  const v = (x: Swing) => s * x.price;
  const slope = (n2.price - n1.price) / (n2.index - n1.index);
  const neck = (i: number) => s * (n1.price + slope * (i - n1.index));
  const height = v(h) - neck(h.index);
  if (!(height > 0)) return undefined;
  const left = v(ls) - neck(ls.index);
  const right = v(rs) - neck(rs.index);
  if (v(h) - Math.max(v(ls), v(rs)) < 0.1 * height) return undefined;
  if (left < 0.2 * height || right < 0.2 * height || Math.min(left, right) < 0.5 * Math.max(left, right)) return undefined;
  const spread = (h.index - ls.index) / (rs.index - h.index);
  if (!(spread >= 0.4 && spread <= 2.5)) return undefined;
  if (Math.abs(n2.price - n1.price) > 0.5 * height) return undefined;
  return {
    points: [
      { ...ls, label: 'LS' },
      { ...n1, label: 'N' },
      { ...h, label: 'H' },
      { ...n2, label: 'N' },
      { ...rs, label: 'RS' },
    ],
    neckline: { index: n1.index, price: n1.price, slope },
    height,
  };
}

/** A double top over swings w[0..2] in the sense s; undefined when they are not one. */
function double(w: Swing[], s: number): Omit<Reversal, 'from' | 'to' | 'kind'> | undefined {
  const [t1, n, t2] = w;
  const v = (x: Swing) => s * x.price;
  const height = Math.max(v(t1), v(t2)) - v(n);
  if (!(height > 0) || Math.abs(v(t1) - v(t2)) > 0.1 * height || t2.index - t1.index < 3) return undefined;
  return {
    points: [
      { ...t1, label: 'T1' },
      { ...n, label: 'N' },
      { ...t2, label: 'T2' },
    ],
    neckline: { index: n.index, price: n.price, slope: 0 },
    height,
  };
}

/** The head and shoulders or double top / bottom the bars from `a` to `b` (full-series indices, either order) make. */
export function findReversal(bars: readonly Bar[], a: number, b: number): Reversal {
  const from = Math.max(0, Math.min(a, b));
  const to = Math.min(bars.length - 1, Math.max(a, b));
  if (to - from + 1 < MIN_REVERSAL_BARS) return { from, to, kind: null, why: 'short', points: [] };
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= to; i++) {
    hi = Math.max(hi, bars[i].high);
    lo = Math.min(lo, bars[i].low);
  }
  const range = hi - lo;
  if (!(range > 0)) return { from, to, kind: null, why: 'none', points: [] };
  for (const scale of SCALES) {
    const p = zigzag(bars, from, to, scale * range);
    let best: Reversal | undefined;
    const consider = (kind: ReversalKind, found: Omit<Reversal, 'from' | 'to' | 'kind'> | undefined) => {
      if (found && (!best || (best.kind!.startsWith('double') && kind.startsWith('head')) || (best.kind!.startsWith('head') === kind.startsWith('head') && found.height! > best.height!))) {
        best = { from, to, kind, ...found };
      }
    };
    for (let k = 1; k + 3 < p.length; k++) {
      // A top starts on a high (above the next swing), a bottom on a low.
      const s = p[k].price > p[k + 1].price ? 1 : -1;
      if (k + 5 < p.length) consider(s > 0 ? 'headShouldersTop' : 'headShouldersBottom', headShoulders(p.slice(k, k + 5), s));
      consider(s > 0 ? 'doubleTop' : 'doubleBottom', double(p.slice(k, k + 3), s));
    }
    if (best) return withBreakout(bars, best);
  }
  return { from, to, kind: null, why: 'none', points: [] };
}

/** The first close beyond the neckline after the pattern's last swing, and the measured move from it. */
function withBreakout(bars: readonly Bar[], r: Reversal): Reversal {
  const neck = r.neckline!;
  const s = r.kind === 'headShouldersTop' || r.kind === 'doubleTop' ? 1 : -1;
  const last = r.points[r.points.length - 1].index;
  for (let i = last + 1; i < bars.length; i++) {
    const line = neck.price + neck.slope * (i - neck.index);
    if (s * (bars[i].close - line) < 0) return { ...r, breakout: { index: i, target: line - s * r.height! } };
  }
  return r;
}
