// Chart ranges (time spans, not bar sizes): picking one picks an interval and fits the view to
// the span from its start to the newest bar (pure, unit-tested).
//
// The intervals keep a range at a few hundred to about a thousand bars (intraday charts include
// extended hours, 16 hours a session): 1M of 30-minute bars is about 700, 3M of 1-hour bars about
// 1,000, a year of days about 250, five years of weeks about 260, and all of a stock's months
// since its listing (AAPL since 1980: 551) fit the widest zoom (chartMath MAX_SPAN). 1M and 3M
// take a coarser interval when the plot is too narrow for those (at least MIN_PX_PER_BAR pixels a
// bar: 1M → 30m, 1h or 2h; 3M → 1h, 2h or 4h). YTD in the first weeks of January would be only a
// few daily bars: it takes the finest interval below days that gives at least MIN_SPAN bars
// instead.

import { barSeconds } from '@shared/timeframes';
import type { Timeframe } from '@shared/types';
import { MIN_SPAN } from './chartMath';

export type ChartRange = '1M' | '3M' | 'YTD' | '1Y' | '5Y' | 'MAX';

/** Every range, in picker order. */
export const RANGES: readonly ChartRange[] = ['1M', '3M', 'YTD', '1Y', '5Y', 'MAX'];

export function isChartRange(r: unknown): r is ChartRange {
  return typeof r === 'string' && RANGES.includes(r as ChartRange);
}

const RANGE_TIMEFRAME: Record<Exclude<ChartRange, '1M' | '3M'>, Timeframe> = { YTD: '1D', '1Y': '1D', '5Y': '1W', MAX: '1M' };

/** Intervals YTD falls back to early in the year (when days would be fewer than MIN_SPAN bars). */
const YTD_FALLBACK: readonly Timeframe[] = ['1h', '30m', '15m', '5m'];

/** Extended-hours bars of an intraday interval per session (04:00–20:00 New York). */
const EXT_SESSION_SEC = 16 * 3600;

interface NyDate {
  y: number;
  /** 1–12 */
  m: number;
  d: number;
}

const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function nyDate(ms: number): NyDate {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

/** Weekdays from January 1st of the New York year of `nowMs` up to that day, both included. */
export function weekdaysThisYear(nowMs: number): number {
  const today = nyDate(nowMs);
  let n = 0;
  for (let t = Date.UTC(today.y, 0, 1); t <= Date.UTC(today.y, today.m - 1, today.d); t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/** Intervals of the intraday ranges, finest first: the finest whose bars fit the plot is taken. */
const RANGE_CHOICES: Partial<Record<ChartRange, readonly Timeframe[]>> = { '1M': ['30m', '1h', '2h'], '3M': ['1h', '2h', '4h'] };

/** Narrowest candle slot (px) a range is drawn with when a coarser interval is available. */
export const MIN_PX_PER_BAR = 1.25;

/**
 * The interval a range shows its span with at `nowMs`, in a plot `plotWidth` pixels wide (unknown:
 * the finest one).
 */
export function rangeTimeframe(range: ChartRange, nowMs: number, plotWidth?: number): Timeframe {
  const choices = RANGE_CHOICES[range];
  if (choices) {
    if (!(plotWidth != null && plotWidth > 0)) return choices[0];
    const span = nowMs / 1000 - rangeStartSec(range, nowMs, choices[0])!;
    return choices.find((tf) => (span / secondsPerBar(tf)) * MIN_PX_PER_BAR <= plotWidth) ?? choices[choices.length - 1];
  }
  if (range !== 'YTD') return RANGE_TIMEFRAME[range as Exclude<ChartRange, '1M' | '3M'>];
  const sessions = weekdaysThisYear(nowMs);
  if (sessions >= MIN_SPAN) return '1D';
  return YTD_FALLBACK.find((tf) => sessions * (EXT_SESSION_SEC / barSeconds(tf)!) >= MIN_SPAN) ?? YTD_FALLBACK[YTD_FALLBACK.length - 1];
}

/** Calendar date `months` before `d` (the last day of a shorter month: March 31st back one month is February 28th). */
function monthsBack(d: NyDate, months: number): NyDate {
  const first = new Date(Date.UTC(d.y, d.m - 1 - months, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(d.d, last) };
}

const nyOffsetParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });

/** Unix seconds of 00:00 New York on a date. */
function nyMidnight(d: NyDate): number {
  const naive = Date.UTC(d.y, d.m - 1, d.d);
  const offsetMin = (t: number) => {
    const name = nyOffsetParts.formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT-5';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    const v = m ? Number(m[2]) * 60 + Number(m[3] ?? 0) : 300;
    return m?.[1] === '+' ? v : -v;
  };
  // Midnight New York is 04:00 or 05:00 UTC; the offset at 12:00 UTC of the date is that day's.
  return (naive - offsetMin(naive + 12 * 3_600_000) * 60_000) / 1000;
}

/**
 * Where a range starts at `nowMs` (New York calendar), as a bar time of `tf`: daily and longer
 * bars are stamped 00:00 UTC on their date, intraday bars are instants (00:00 New York of the
 * start date). null for MAX: everything there is.
 */
export function rangeStartSec(range: ChartRange, nowMs: number, tf: Timeframe): number | null {
  if (range === 'MAX') return null;
  const today = nyDate(nowMs);
  const start: NyDate =
    range === 'YTD'
      ? { y: today.y, m: 1, d: 1 }
      : range === '1M'
        ? monthsBack(today, 1)
        : range === '3M'
          ? monthsBack(today, 3)
          : monthsBack(today, range === '1Y' ? 12 : 60);
  return barSeconds(tf) != null ? nyMidnight(start) : Date.UTC(start.y, start.m - 1, start.d) / 1000;
}

/** Calendar seconds per bar of an interval, roughly, counting only the time the bars cover. */
function secondsPerBar(tf: Timeframe): number {
  const bar = barSeconds(tf);
  // Weekday extended sessions: 16 of 24 hours, 5 of 7 days.
  if (bar != null) return (bar * 24 * 7) / (16 * 5);
  switch (tf) {
    case '1W':
      return 7 * 86_400;
    case '1M':
      return 30.4 * 86_400;
    case '1Q':
      return 91.3 * 86_400;
    case '1Y':
      return 365.25 * 86_400;
    default:
      return (7 / 5) * 86_400;
  }
}

/**
 * Bars a range still lacks before the oldest loaded bar (`oldest`, unix s), with some slack, for
 * the size of the page that loads them: about the bars of the span between the range start and
 * `oldest`; 0 when the loaded bars reach the start.
 */
export function missingBars(tf: Timeframe, start: number, oldest: number): number {
  if (oldest <= start) return 0;
  return Math.ceil(((oldest - start) / secondsPerBar(tf)) * 1.15) + 10;
}

/**
 * Whether the bars of a range are loaded: they reach its start, or nothing older exists
 * (`done`, e.g. a listing younger than the range, or MAX with the series' head reached).
 */
export function rangeLoaded(start: number | null, bars: readonly { time: number }[], done: boolean): boolean {
  if (!bars.length) return false;
  if (done) return true;
  return start !== null && bars[0].time <= start;
}
