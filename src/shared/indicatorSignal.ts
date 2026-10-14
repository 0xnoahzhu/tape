// What an indicator alert compares (pure): the two lines of a signal over a bar series, read at the
// two bars a cross is tested on. Shared by the main process, which evaluates indicator alerts
// (main/market/alertEval.ts → measure), and the alert dialog's preview, so the preview shows the
// values the alert will test. The formulas are indicators.ts's.

import { boll, ema, kdj, macd, rsi, sma, type Series } from './indicators';
import type { AlertRule, Bar, IndicatorSignal } from './types';

export type IndicatorRule = Extract<AlertRule, { type: 'indicator' }>;

/** An indicator's two lines at the two bars an alert tests (readIndicator). */
export interface IndicatorReading {
  /** a − b at the older and at the newer bar (two lines, the close against a line or band, a line against a level). */
  prev: number;
  cur: number;
  /** Start (unix s) of the newer bar. */
  bar: number;
  /** Start of the newest closed bar (the baseline: a cross there before the alert was armed does not count). */
  closedBar: number;
  /** The indicator's main value at the newer bar (the line, or the band, a price is compared with). */
  value: number;
  detail: Record<string, number>;
  /** Re-arm band in the line's units (levels), 0 for crosses of two lines. */
  band: number;
}

/** The two lines a signal compares, its detail lines and the bars it needs before it means anything. */
interface Lines {
  a: Series;
  b: Series | number;
  value: Series | number;
  detail: Array<[string, Series]>;
  warmup: number;
  band: number;
}

/** RSI levels re-arm 2 points back, KDJ levels 5 (moomoo's levels are 80 / 20 or 70 / 30). */
const RSI_LEVEL_BAND = 2;
const KDJ_LEVEL_BAND = 5;

function signalLines(signal: IndicatorSignal, bars: readonly Bar[]): Lines {
  const closes = bars.map((b) => b.close);
  switch (signal.ind) {
    case 'ma':
    case 'ema': {
      const avg = (p: number) => (signal.ind === 'ma' ? sma(closes, p) : ema(closes, p));
      const name = (p: number) => `${signal.ind.toUpperCase()}${p}`;
      if (signal.kind === 'price') {
        const line = avg(signal.period);
        return { a: closes, b: line, value: line, detail: [['close', closes], [name(signal.period), line]], warmup: signal.period, band: 0 };
      }
      const fast = avg(signal.fast);
      const slow = avg(signal.slow);
      return { a: fast, b: slow, value: fast, detail: [[name(signal.fast), fast], [name(signal.slow), slow]], warmup: signal.slow, band: 0 };
    }
    case 'macd': {
      const m = macd(closes, signal.fast, signal.slow, signal.signal);
      const detail: Array<[string, Series]> = [
        ['DIF', m.dif],
        ['DEA', m.dea],
        ['MACD', m.bar],
      ];
      return { a: m.dif, b: signal.kind === 'zero' ? 0 : m.dea, value: m.dif, detail, warmup: signal.slow + signal.signal, band: 0 };
    }
    case 'kdj': {
      const { k, d, j } = kdj(bars, signal.n, signal.m1, signal.m2);
      const detail: Array<[string, Series]> = [
        ['K', k],
        ['D', d],
        ['J', j],
      ];
      if (signal.kind === 'cross') return { a: k, b: d, value: k, detail, warmup: signal.n, band: 0 };
      const line = { k, d, j }[signal.line];
      return { a: line, b: signal.level, value: line, detail, warmup: signal.n, band: KDJ_LEVEL_BAND };
    }
    case 'rsi': {
      if (signal.kind === 'level') {
        const line = rsi(closes, signal.period);
        return { a: line, b: signal.level, value: line, detail: [[`RSI${signal.period}`, line]], warmup: signal.period + 1, band: RSI_LEVEL_BAND };
      }
      const fast = rsi(closes, signal.fast);
      const slow = rsi(closes, signal.slow);
      return { a: fast, b: slow, value: fast, detail: [[`RSI${signal.fast}`, fast], [`RSI${signal.slow}`, slow]], warmup: signal.slow + 1, band: 0 };
    }
    case 'boll': {
      const b = boll(closes, signal.period, signal.k);
      const band = { upper: b.upper, middle: b.mid, lower: b.lower }[signal.band];
      const detail: Array<[string, Series]> = [
        ['close', closes],
        ['UPPER', b.upper],
        ['MID', b.mid],
        ['LOWER', b.lower],
      ];
      return { a: closes, b: band, value: band, detail, warmup: signal.period, band: 0 };
    }
  }
}

/** Bars an indicator rule needs: its warm-up, the two bars it compares, and the forming bar in close mode. */
export function barsNeeded(rule: IndicatorRule): number {
  return signalLines(rule.signal, []).warmup + 2;
}

/**
 * Reads an indicator rule on bars (stored plus live, oldest first). `forming`: the newest bar is
 * still forming. 'close' compares the two newest closed bars, 'live' the forming bar with the last
 * closed one (with no bar forming, both compare the two newest bars). Null with too few bars.
 */
export function readIndicator(rule: IndicatorRule, bars: readonly Bar[], forming: boolean): IndicatorReading | null {
  const n = bars.length;
  const newer = forming && rule.on === 'close' ? n - 2 : n - 1;
  const older = newer - 1;
  const lines = signalLines(rule.signal, bars);
  if (older < lines.warmup - 1) return null;
  const at = (s: Series | number, i: number) => (typeof s === 'number' ? s : s[i]);
  const [a0, b0, a1, b1, value] = [at(lines.a, older), at(lines.b, older), at(lines.a, newer), at(lines.b, newer), at(lines.value, newer)];
  if (a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined || value === undefined) return null;
  const detail: Record<string, number> = {};
  for (const [name, s] of lines.detail) {
    const v = s[newer];
    if (v !== undefined) detail[name] = v;
  }
  return { prev: a0 - b0, cur: a1 - b1, bar: bars[newer].time, closedBar: bars[forming ? n - 2 : n - 1].time, value, detail, band: lines.band };
}

/**
 * The two operands a signal compares, as its detail lines name them (readIndicator's `detail`):
 * `a` crosses `b`, which is another line or a level (a number). The close is 'close'.
 */
export function signalOperands(signal: IndicatorSignal): { a: string; b: string | number } {
  switch (signal.ind) {
    case 'ma':
    case 'ema': {
      const name = (p: number) => `${signal.ind.toUpperCase()}${p}`;
      return signal.kind === 'price' ? { a: 'close', b: name(signal.period) } : { a: name(signal.fast), b: name(signal.slow) };
    }
    case 'macd':
      return { a: 'DIF', b: signal.kind === 'zero' ? 0 : 'DEA' };
    case 'kdj':
      return signal.kind === 'cross' ? { a: 'K', b: 'D' } : { a: signal.line.toUpperCase(), b: signal.level };
    case 'rsi':
      return signal.kind === 'level' ? { a: `RSI${signal.period}`, b: signal.level } : { a: `RSI${signal.fast}`, b: `RSI${signal.slow}` };
    case 'boll':
      return { a: 'close', b: { upper: 'UPPER', middle: 'MID', lower: 'LOWER' }[signal.band] };
  }
}
