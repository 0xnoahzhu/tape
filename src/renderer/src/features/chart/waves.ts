// Elliott wave counts over a stretch of bars (the chart's waves tool): whether its swings make a
// 3-wave correction (A-B-C), a 5-wave impulse (1-2-3-4-5) or a full 8-wave cycle (an impulse and
// the A-B-C against it), checked against the theory's hard rules. Pure, so it can be unit tested.
//
// Swings come from a zigzag: a turn counts once the price has come back `threshold` from the
// running extreme (highs and lows). The zigzag runs at scales from most of the stretch's height
// down to a few percent of it. A zigzag with as many legs as a count (3, 5, 8) is read as it; one
// with a leg more also without its first or its last leg (a turn inside a leg adds two, so a stretch
// from a low to a low only ever has an even number of legs: the selection may run a little beyond the
// count). For each count, the largest scale at which it keeps every rule is the answer's candidate,
// so a count is read at the most significant swings that give it. The answer is the first of 8, 5
// and 3 found, with the larger count it is not (`rejected`: 5, else 8, the first one read, and the
// rules it breaks); without one, the first count read (5, then 3, then 8) comes back with the rules
// it breaks.
//
//   impulse (5)    wave 2 never retraces all of wave 1; wave 3 is never the shortest of 1, 3 and 5;
//                  wave 4 never enters wave 1's range
//   correction (3) B retraces less than all of A (up to 105 %, a flat); C ends beyond A's end (or
//                  within a tenth of A of it, a flat)
//   cycle (8)      an impulse, then an A-B-C against it that stays short of the impulse's start
//
// Beside the rules, the ratios the guidelines speak of: wave 2 and wave 4 as retracements of 1 and
// 3, waves 3 and 5 against 1, B against A, C against A.

import type { Bar } from '@shared/types';

export type WaveCountSize = 3 | 5 | 8;
export type WaveRuleId = 'w2' | 'w3' | 'w4' | 'b' | 'c' | 'start';

export interface WavePoint {
  /** Full-series bar index of the swing. */
  index: number;
  price: number;
  /** "1" … "5", "A" … "C"; "" for the start. */
  label: string;
}

export interface WaveCount {
  from: number;
  to: number;
  /** The count read (null: the stretch is too short, or its swings never give 3, 5 or 8 legs). */
  waves: WaveCountSize | null;
  /** Whether every rule holds. */
  ok: boolean;
  /** Direction of the impulse (for 3 waves: of wave A). */
  dir: 'up' | 'down';
  points: WavePoint[];
  rules: { id: WaveRuleId; ok: boolean }[];
  /** Retracements and extensions (fractions); for 3 waves only b and c. */
  ratios: { w2?: number; w3?: number; w4?: number; w5?: number; b?: number; c?: number };
  /** For an A-B-C: a zigzag (B retraces up to 80 % of A) or a flat. */
  correction?: 'zigzag' | 'flat';
  /** A larger count the swings also give but which breaks a rule (when this one keeps them all). */
  rejected?: WaveCount;
  why?: 'short' | 'none';
}

export const MIN_WAVE_BARS = 8;
const LABELS: Record<WaveCountSize, string[]> = { 3: ['', 'A', 'B', 'C'], 5: ['', '1', '2', '3', '4', '5'], 8: ['', '1', '2', '3', '4', '5', 'A', 'B', 'C'] };
/** Zigzag scales as shares of the stretch's height, largest first. */
const SCALES = Array.from({ length: 40 }, (_, k) => 0.7 * 0.92 ** k);

interface Swing {
  index: number;
  price: number;
}

/** Swing points of the zigzag turning at `threshold` (price) over [from, to], starting and ending with the stretch's extremes. */
export function zigzag(bars: readonly Bar[], from: number, to: number, threshold: number): Swing[] {
  const out: Swing[] = [];
  let trend = 0;
  let hi = from;
  let lo = from;
  for (let i = from + 1; i <= to; i++) {
    const b = bars[i];
    if (trend === 0) {
      if (b.high > bars[hi].high) hi = i;
      if (b.low < bars[lo].low) lo = i;
      if (bars[hi].high - bars[lo].low >= threshold) {
        if (lo < hi) {
          out.push({ index: lo, price: bars[lo].low });
          trend = 1;
        } else {
          out.push({ index: hi, price: bars[hi].high });
          trend = -1;
        }
      }
    } else if (trend === 1) {
      if (b.high > bars[hi].high) hi = i;
      else if (bars[hi].high - b.low >= threshold) {
        out.push({ index: hi, price: bars[hi].high });
        trend = -1;
        lo = i;
      }
    } else if (b.low < bars[lo].low) lo = i;
    else if (b.high - bars[lo].low >= threshold) {
      out.push({ index: lo, price: bars[lo].low });
      trend = 1;
      hi = i;
    }
  }
  if (trend === 1) out.push({ index: hi, price: bars[hi].high });
  else if (trend === -1) out.push({ index: lo, price: bars[lo].low });
  return out;
}

const len = (p: Swing[], k: number) => Math.abs(p[k].price - p[k - 1].price);

/** Rules of an impulse over p[s] … p[s + 5], in direction d (1 up, −1 down). */
function impulseRules(p: Swing[], s: number, d: number): { id: WaveRuleId; ok: boolean }[] {
  const at = (k: number) => d * p[s + k].price;
  const l1 = len(p, s + 1);
  const l3 = len(p, s + 3);
  const l5 = len(p, s + 5);
  return [
    { id: 'w2', ok: at(2) > at(0) },
    { id: 'w3', ok: !(l3 < l1 && l3 < l5) },
    { id: 'w4', ok: at(4) > at(1) },
  ];
}

/** Rules of an A-B-C over p[s] … p[s + 3]. */
function correctionRules(p: Swing[], s: number): { id: WaveRuleId; ok: boolean }[] {
  const a = len(p, s + 1);
  const d = Math.sign(p[s + 1].price - p[s].price);
  return [
    { id: 'b', ok: len(p, s + 2) < a * 1.05 },
    { id: 'c', ok: d * (p[s + 3].price - p[s + 1].price) > -0.1 * a },
  ];
}

function evaluate(bars: readonly Bar[], from: number, to: number, p: Swing[], waves: WaveCountSize): WaveCount {
  const d = Math.sign(p[1].price - p[0].price) || 1;
  const points = p.map((s, k) => ({ ...s, label: LABELS[waves][k] }));
  const ratios: WaveCount['ratios'] = {};
  let rules: WaveCount['rules'];
  let correction: WaveCount['correction'];
  const abc = (s: number) => {
    const b = len(p, s + 2) / len(p, s + 1);
    ratios.b = b;
    ratios.c = len(p, s + 3) / len(p, s + 1);
    correction = b <= 0.8 ? 'zigzag' : 'flat';
  };
  if (waves === 3) {
    rules = correctionRules(p, 0);
    abc(0);
  } else {
    rules = impulseRules(p, 0, d);
    ratios.w2 = len(p, 2) / len(p, 1);
    ratios.w3 = len(p, 3) / len(p, 1);
    ratios.w4 = len(p, 4) / len(p, 3);
    ratios.w5 = len(p, 5) / len(p, 1);
    if (waves === 8) {
      rules = [...rules, ...correctionRules(p, 5), { id: 'start', ok: d * (p[8].price - p[0].price) > 0 }];
      abc(5);
    }
  }
  return { from, to, waves, ok: rules.every((r) => r.ok), dir: d > 0 ? 'up' : 'down', points, rules, ratios, ...(correction ? { correction } : {}) };
}

/** The wave count the bars from `a` to `b` (full-series indices, either order) make. */
export function findWaves(bars: readonly Bar[], a: number, b: number): WaveCount {
  const from = Math.max(0, Math.min(a, b));
  const to = Math.min(bars.length - 1, Math.max(a, b));
  const none = (why: 'short' | 'none'): WaveCount => ({ from, to, waves: null, ok: false, dir: 'up', points: [], rules: [], ratios: {}, why });
  if (to - from + 1 < MIN_WAVE_BARS) return none('short');
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= to; i++) {
    hi = Math.max(hi, bars[i].high);
    lo = Math.min(lo, bars[i].low);
  }
  const height = hi - lo;
  if (!(height > 0)) return none('none');
  // Per count: the first read (the largest scale giving it) and the first keeping the rules.
  const first = new Map<WaveCountSize, WaveCount>();
  const valid = new Map<WaveCountSize, WaveCount>();
  for (const s of SCALES) {
    const p = zigzag(bars, from, to, s * height);
    const legs = p.length - 1;
    for (const n of [8, 5, 3] as const) {
      if (valid.has(n)) continue;
      const reads = legs === n ? [p] : legs === n + 1 ? [p.slice(0, n + 1), p.slice(1)] : [];
      for (const w of reads) {
        const c = evaluate(bars, from, to, w, n);
        if (!first.has(n)) first.set(n, c);
        if (c.ok) {
          valid.set(n, c);
          break;
        }
      }
    }
  }
  const answer = ([8, 5, 3] as const).map((n) => valid.get(n)).find(Boolean);
  if (answer) {
    const rejected = ([5, 8] as const).map((n) => (n > answer.waves! && !valid.has(n) ? first.get(n) : undefined)).find(Boolean);
    return rejected ? { ...answer, rejected } : answer;
  }
  return ([5, 3, 8] as const).map((n) => first.get(n)).find(Boolean) ?? none('none');
}
