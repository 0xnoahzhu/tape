// Historical data request parameters, the incremental (cached) fetch plan and bar
// post-processing (pure, unit-tested).

import type { Bar, ContractRef, HistoryRequest, Timeframe } from '@shared/types';
import { addDays, type CalendarDay, isWeekday, nyDay, nyWallToEpochMs, previousWeekday, RTH_CLOSE, RTH_OPEN } from './nyTime';

export type WhatToShow = NonNullable<HistoryRequest['whatToShow']>;
/** Periods that bars are regrouped into after loading. */
export type Period = 'day' | 'week' | 'month' | 'year';

export interface HistorySpec {
  /** Bar size requested from IB. */
  barSize: string;
  /** IB duration of a full load (the chart's window). */
  duration: string;
  whatToShow: WhatToShow;
  useRTH: 0 | 1;
  /**
   * Bar size of the stored series. Options have no daily bars at IB ("No data of type
   * EODChart"), so their 8-hour bars are merged into New York calendar days when they arrive
   * and stored as daily bars.
   */
  seriesBarSize: string;
  /** IB's bars are merged into calendar days before they are stored (options). */
  toDays: boolean;
  /** The stored bars are merged into these periods when a request is answered. */
  aggregate?: Exclude<Period, 'day'>;
  /** Monthly bars are aggregated into calendar years after loading (aggregate === 'year'). */
  aggregateYears: boolean;
  /** Bars of the stored series are intraday (the database keeps them for 30 days). */
  intraday: boolean;
  /**
   * Calendar span of the fetch window plus slack: how long stored bars of this series have to
   * stay to cover a full chart. The database keeps intraday bars for 30 days only, so for the
   * 2-month 1h window a load after that refetches the window (see planFetch's coverage check).
   */
  retentionSec: number;
}

const DAY_SEC = 86_400;
/** Calendar seconds per IB duration unit, as upper bounds: 'D' counts trading days (5 per week). */
const DURATION_UNIT_SEC: Record<string, number> = { S: 1, D: (7 / 5) * DAY_SEC, W: 7 * DAY_SEC, M: 31 * DAY_SEC, Y: 366 * DAY_SEC };
/** Retention beyond a fetch window: a weekend plus exchange holidays between trading days. */
const RETENTION_SLACK_SEC = 4 * DAY_SEC;

function parseDuration(duration: string): { n: number; unit: 'S' | 'D' | 'W' | 'M' | 'Y' } {
  const m = /^(\d+) ([SDWMY])$/.exec(duration.trim());
  if (!m) throw new Error(`Invalid IB duration "${duration}"`);
  return { n: Number(m[1]), unit: m[2] as 'S' | 'D' | 'W' | 'M' | 'Y' };
}

/**
 * Calendar seconds an IB duration ("2 D", "2 M", "10 Y") reaches back, as an upper bound:
 * days are trading days, months and years are taken at their longest.
 */
export function durationSpanSec(duration: string): number {
  const { n, unit } = parseDuration(duration);
  return Math.ceil(n * DURATION_UNIT_SEC[unit]);
}

const retentionSec = (duration: string): number => durationSpanSec(duration) + RETENTION_SLACK_SEC;

interface TimeframeSpec {
  barSize: string;
  duration: string;
  intraday: boolean;
}

const TIMEFRAMES: Record<Timeframe, TimeframeSpec> = {
  '1m': { barSize: '1 min', duration: '2 D', intraday: true },
  '5m': { barSize: '5 mins', duration: '10 D', intraday: true },
  '1h': { barSize: '1 hour', duration: '2 M', intraday: true },
  '1D': { barSize: '1 day', duration: '2 Y', intraday: false },
  '1W': { barSize: '1 week', duration: '10 Y', intraday: false },
  '1M': { barSize: '1 month', duration: '20 Y', intraday: false },
  '1Y': { barSize: '1 month', duration: '20 Y', intraday: false },
};

/**
 * Daily and longer timeframes of options and futures options: IB answers every daily, weekly
 * and monthly request with 162 "No data of type EODChart is available … 'Option' and '2 y' and
 * '1 day'" (any duration, any whatToShow; checked live). 8-hour bars work and reach back over
 * the life of the contract, so all four timeframes share one daily series built from them.
 */
const OPTION_DAILY = { barSize: '8 hours', duration: '2 Y' } as const;
const OPTION_PERIODS: Partial<Record<Timeframe, Exclude<Period, 'day'>>> = { '1W': 'week', '1M': 'month', '1Y': 'year' };

export function isTimeframe(tf: unknown): tf is Timeframe {
  return typeof tf === 'string' && tf in TIMEFRAMES;
}

export function isIntraday(tf: Timeframe): boolean {
  return TIMEFRAMES[tf].intraday;
}

const isOptionType = (c: Pick<ContractRef, 'secType'>) => c.secType === 'OPT' || c.secType === 'FOP';

/** Maps a request to reqHistoricalData parameters. */
export function historySpec(req: HistoryRequest): HistorySpec {
  const tf = TIMEFRAMES[req.timeframe];
  const what: WhatToShow = req.whatToShow ?? (req.contract.secType === 'CASH' ? 'MIDPOINT' : 'TRADES');
  // Volatility series are daily only and describe the underlying.
  if (what === 'OPTION_IMPLIED_VOLATILITY' || what === 'HISTORICAL_VOLATILITY') {
    const duration = tf.intraday ? '1 Y' : '2 Y';
    return daily({ barSize: '1 day', duration, whatToShow: what, toDays: false, aggregate: undefined });
  }
  const whatToShow = req.contract.secType === 'CASH' && what === 'TRADES' ? 'MIDPOINT' : what;
  if (!tf.intraday && isOptionType(req.contract)) {
    return daily({ ...OPTION_DAILY, whatToShow, toDays: true, aggregate: OPTION_PERIODS[req.timeframe] });
  }
  const aggregate = req.timeframe === '1Y' ? 'year' : undefined;
  return {
    barSize: tf.barSize,
    duration: tf.duration,
    whatToShow,
    useRTH: tf.intraday && req.outsideRth ? 0 : 1,
    seriesBarSize: tf.barSize,
    toDays: false,
    aggregate,
    aggregateYears: aggregate === 'year',
    intraday: tf.intraday,
    retentionSec: retentionSec(tf.duration),
  };
}

function daily(p: { barSize: string; duration: string; whatToShow: WhatToShow; toDays: boolean; aggregate: HistorySpec['aggregate'] }): HistorySpec {
  return {
    barSize: p.barSize,
    duration: p.duration,
    whatToShow: p.whatToShow,
    useRTH: 1,
    seriesBarSize: '1 day',
    toDays: p.toDays,
    aggregate: p.aggregate,
    aggregateYears: p.aggregate === 'year',
    intraday: false,
    retentionSec: retentionSec(p.duration),
  };
}

/** Cache lifetime: intraday bars change quickly, daily and longer bars rarely. */
export function historyTtlMs(tf: Timeframe): number {
  return isIntraday(tf) ? 30_000 : 5 * 60_000;
}

/**
 * Parses an IB bar time (formatDate 2) to unix seconds:
 * - intraday bars: epoch seconds ("1696426200")
 * - daily and longer: "YYYYMMDD", stored as that calendar date at 00:00 UTC
 * Also tolerates "YYYYMMDD HH:MM:SS" (taken as UTC wall time). Returns NaN when unparseable.
 */
export function parseBarTime(s: string): number {
  const t = s.trim();
  if (/^\d{9,11}$/.test(t)) return Number(t);
  const m = /^(\d{4})(\d{2})(\d{2})(?:[\s-]+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (!m) return NaN;
  const [, y, mo, d, hh, mm, ss] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0)) / 1000;
}

/** Sorts bars by time and drops duplicates (later entries win). */
export function normalizeBars(bars: Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const b of bars) if (Number.isFinite(b.time)) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Periods

const ymd = (t: number) => {
  const d = new Date(t * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() };
};

/**
 * Key of the period a daily-or-longer bar (stamped 00:00 UTC on its date) belongs to. Weeks
 * start on Monday.
 */
export function periodKey(time: number, period: Exclude<Period, 'day'>): number {
  const { y, m, d, w } = ymd(time);
  switch (period) {
    case 'week':
      return Date.UTC(y, m, d - ((w + 6) % 7)) / 1000;
    case 'month':
      return y * 12 + m;
    case 'year':
      return y;
  }
}

/** The period of a stored bar series whose stamps move within the period (IB stamps weekly and
 *  monthly bars with the last trading day so far, so the forming bar is re-stamped every day). */
export function seriesPeriod(seriesBarSize: string): Exclude<Period, 'day' | 'year'> | undefined {
  if (seriesBarSize === '1 week') return 'week';
  if (seriesBarSize === '1 month') return 'month';
  return undefined;
}

/** Combines consecutive bars of one group into one bar stamped `time`. */
function combine(group: readonly Bar[], time: number): Bar {
  const first = group[0];
  const bar: Bar = { time, open: first.open, high: first.high, low: first.low, close: group[group.length - 1].close, volume: 0 };
  for (const b of group) {
    if (b.high > bar.high) bar.high = b.high;
    if (b.low < bar.low) bar.low = b.low;
    bar.volume += b.volume;
  }
  return bar;
}

/** Groups ascending bars by `keyOf` and combines each group into a bar stamped by `stampOf`. */
function groupBars(bars: readonly Bar[], keyOf: (b: Bar) => number, stampOf: (group: readonly Bar[]) => number): Bar[] {
  const out: Bar[] = [];
  let group: Bar[] = [];
  let key = NaN;
  for (const b of bars) {
    const k = keyOf(b);
    if (group.length && k !== key) {
      out.push(combine(group, stampOf(group)));
      group = [];
    }
    key = k;
    group.push(b);
  }
  if (group.length) out.push(combine(group, stampOf(group)));
  return out;
}

/** Intraday bars merged into New York calendar days, stamped like IB's daily bars (00:00 UTC). */
export function barsToDays(bars: Bar[]): Bar[] {
  const day = (b: Bar) => {
    const d = nyDay(b.time * 1000);
    return Date.UTC(d.y, d.m - 1, d.d) / 1000;
  };
  return groupBars(normalizeBars(bars), day, (g) => day(g[0]));
}

/** Aggregates (monthly) bars into calendar-year bars stamped January 1st, 00:00 UTC. */
export function aggregateYears(bars: Bar[]): Bar[] {
  return groupBars(
    normalizeBars(bars),
    (b) => periodKey(b.time, 'year'),
    (g) => Date.UTC(ymd(g[0].time).y, 0, 1) / 1000,
  );
}

/**
 * Daily (or monthly) bars merged into weeks, months or years. Weeks and months are stamped with
 * their last bar's date like IB's own weekly and monthly bars; years with January 1st.
 */
export function aggregateBars(bars: Bar[], period: Exclude<Period, 'day'>): Bar[] {
  if (period === 'year') return aggregateYears(bars);
  return groupBars(
    normalizeBars(bars),
    (b) => periodKey(b.time, period),
    (g) => g[g.length - 1].time,
  );
}

/** Keeps the newest bar of every period (older stamps of a re-stamped forming bar are stale). */
export function dedupePeriods(bars: readonly Bar[], period: Exclude<Period, 'day'>): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    if (out.length && periodKey(out[out.length - 1].time, period) === periodKey(b.time, period)) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys

export function historyKey(req: HistoryRequest, contractKey: string): string {
  const spec = historySpec(req);
  return [contractKey, req.timeframe, spec.useRTH, spec.whatToShow].join('|');
}

/** Bar cache series: contract + stored bar size + whatToShow + useRTH. */
export function seriesKey(spec: HistorySpec, contractKey: string): string {
  return [contractKey, spec.seriesBarSize, spec.whatToShow, spec.useRTH].join('|');
}

// ---------------------------------------------------------------------------
// Incremental loads

/** Bookkeeping per stored series (kv namespace 'series'). */
export interface SeriesMeta {
  /** First bar of the last full load: IB has nothing older (a recent listing, an option). */
  first?: number;
  /** Unix ms of the last successful fetch (full or tail). */
  fetchedAt: number;
}

export type FetchPlan = { kind: 'none' } | { kind: 'full' } | { kind: 'tail'; duration: string; from: number };

const BAR_SEC: Record<string, number> = { '1 min': 60, '5 mins': 300, '1 hour': 3600, '8 hours': 28_800, '1 day': DAY_SEC, '1 week': 7 * DAY_SEC, '1 month': 31 * DAY_SEC };

/** How far after the window start the first stored bar may be and still cover the window. */
function coverageGapSec(seriesBarSize: string): number {
  switch (seriesBarSize) {
    case '1 week':
      return 10 * DAY_SEC;
    case '1 month':
      return 40 * DAY_SEC;
    case '1 day':
      return 7 * DAY_SEC; // a long weekend plus a holiday
    default:
      return 4 * DAY_SEC; // intraday windows start at 00:00 New York; the first bar may be days later
  }
}

const calendarDay = (ms: number): CalendarDay => {
  const d = nyDay(ms);
  return { y: d.y, m: d.m, d: d.d };
};

const dayIndex = (d: CalendarDay) => Date.UTC(d.y, d.m - 1, d.d) / 86_400_000;

/** Trading days (weekdays; holidays are not modelled) from `from` to `to`, both included. */
function weekdaysBetween(from: CalendarDay, to: CalendarDay): number {
  let n = 0;
  for (let d = from; dayIndex(d) <= dayIndex(to); d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
}

/**
 * Unix seconds where a full load of `duration` starts, the way IB counts it: 'D' are trading
 * days back from today (from 00:00 New York of the first), 'W' / 'M' / 'Y' calendar spans.
 */
export function windowStartSec(duration: string, nowMs: number): number {
  const { n, unit } = parseDuration(duration);
  const nowSec = Math.floor(nowMs / 1000);
  switch (unit) {
    case 'S':
      return nowSec - n;
    case 'D': {
      let d = calendarDay(nowMs);
      for (let count = 0; ; d = addDays(d, -1)) {
        if (isWeekday(d) && ++count >= n) break;
      }
      return nyWallToEpochMs(d, 0) / 1000;
    }
    case 'W':
      return nowSec - n * 7 * DAY_SEC;
    case 'M': {
      const t = new Date(nowMs);
      return Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - n, t.getUTCDate()) / 1000;
    }
    case 'Y': {
      const t = new Date(nowMs);
      return Date.UTC(t.getUTCFullYear() - n, t.getUTCMonth(), t.getUTCDate()) / 1000;
    }
  }
}

/** Instruments whose bars only move during US sessions (New York time, weekdays). */
function usSessions(contract: ContractRef): boolean {
  const usd = !contract.currency || contract.currency === 'USD';
  return usd && (contract.secType === 'STK' || contract.secType === 'IND' || contract.secType === 'OPT');
}

/** Extended hours 04:00–20:00 New York; bars are taken as final 30 minutes after a close. */
const EXT_OPEN = 240;
const EXT_CLOSE = 1200;
const SETTLE_MIN = 30;

/**
 * Unix ms since which bars of a US instrument cannot change any more (the last close plus
 * SETTLE_MIN), or undefined while a session (or its settling time) is running. `rthOnly`: regular
 * hours 09:30–16:00, otherwise extended hours. Exchange holidays are treated as trading days,
 * which only costs a refetch.
 */
export function lastSettledMs(nowMs: number, rthOnly: boolean): number | undefined {
  const open = rthOnly ? RTH_OPEN : EXT_OPEN;
  const close = (rthOnly ? RTH_CLOSE : EXT_CLOSE) + SETTLE_MIN;
  const now = nyDay(nowMs);
  const today: CalendarDay = { y: now.y, m: now.m, d: now.d };
  if (isWeekday(today)) {
    if (now.minutes >= close) return nyWallToEpochMs(today, close);
    if (now.minutes >= open) return undefined;
  }
  return nyWallToEpochMs(previousWeekday(today), close);
}

/** Bars of a US instrument fetched after the last session settled stay final until the next session. */
export function isSettled(spec: HistorySpec, contract: ContractRef, fetchedAt: number, nowMs: number): boolean {
  if (!usSessions(contract)) return false;
  const at = lastSettledMs(nowMs, spec.useRTH === 1);
  return at !== undefined && fetchedAt >= at;
}

/**
 * IB duration that reaches back to `fromSec` (a stored bar's time) for bars of `barSize`.
 * Seconds for small bars within a day; trading days for larger intraday and daily bars; weeks
 * and months for weekly and monthly bars. Every unit errs on the long side. `dailyStamps`:
 * `fromSec` is a daily bar's stamp (its date at 00:00 UTC), not an instant.
 */
export function tailDuration(barSize: string, fromSec: number, nowMs: number, dailyStamps = (BAR_SEC[barSize] ?? DAY_SEC) >= DAY_SEC): string {
  const nowSec = Math.floor(nowMs / 1000);
  const span = Math.max(0, nowSec - fromSec);
  const bar = BAR_SEC[barSize] ?? DAY_SEC;
  if (bar <= 300 && !dailyStamps && span + bar <= DAY_SEC) return `${Math.max(60, Math.ceil((span + bar) / 60) * 60)} S`;
  if (barSize === '1 week') return `${Math.ceil(span / (7 * DAY_SEC)) + 1} W`;
  if (barSize === '1 month') {
    const a = new Date(fromSec * 1000);
    const b = new Date(nowMs);
    return `${(b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1} M`;
  }
  const t = new Date(fromSec * 1000);
  const from = dailyStamps ? { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() } : calendarDay(fromSec * 1000);
  return `${Math.max(1, weekdaysBetween(from, calendarDay(nowMs)))} D`;
}

/**
 * What to fetch for a request, given the stored bars from the window start on:
 * - none: the stored series was fetched within `ttlMs` or is settled (and not `fresh`);
 * - tail: from the second-newest stored bar (the newest may have been forming), when the stored
 *   bars cover the window and the tail is less than half of it;
 * - full: otherwise.
 */
export function planFetch(o: {
  spec: HistorySpec;
  contract: ContractRef;
  stored: readonly Bar[];
  meta: SeriesMeta | undefined;
  nowMs: number;
  ttlMs: number;
  fresh?: boolean;
}): FetchPlan {
  const { spec, stored, meta, nowMs } = o;
  if (!stored.length || !meta) return { kind: 'full' };
  const start = windowStartSec(spec.duration, nowMs);
  const first = stored[0].time;
  const covered = first <= start + coverageGapSec(spec.seriesBarSize) || (meta.first !== undefined && first <= meta.first);
  if (!covered) return { kind: 'full' };
  if (!o.fresh && (nowMs - meta.fetchedAt < o.ttlMs || isSettled(spec, o.contract, meta.fetchedAt, nowMs))) return { kind: 'none' };
  const from = stored[Math.max(0, stored.length - 2)].time;
  if (Math.floor(nowMs / 1000) - from > (Math.floor(nowMs / 1000) - start) / 2) return { kind: 'full' };
  const dailyStamps = (BAR_SEC[spec.seriesBarSize] ?? DAY_SEC) >= DAY_SEC;
  return { kind: 'tail', duration: tailDuration(spec.barSize, from, nowMs, dailyStamps), from };
}

/** Relative close difference beyond which an overlapping bar means IB adjusted the history (a split). */
const ADJUSTED_RATIO = 0.01;

/**
 * True when the fetched tail disagrees with the stored bar it overlaps that was already final
 * (the older of the two refetched bars): IB has adjusted the series and it must be reloaded.
 */
export function historyAdjusted(stored: readonly Bar[], tail: readonly Bar[]): boolean {
  if (stored.length < 2 || !tail.length) return false;
  const final = stored[stored.length - 2];
  const fresh = tail.find((b) => b.time === final.time);
  if (!fresh || !(final.close > 0) || !(fresh.close > 0)) return false;
  return Math.abs(fresh.close / final.close - 1) > ADJUSTED_RATIO;
}

/**
 * The stored bars followed by the fetched tail, which replaces everything from its first bar
 * on (and, for weekly / monthly series, the stale stamps of the periods it covers).
 */
export function mergeTail(stored: readonly Bar[], tail: readonly Bar[], seriesBarSize: string): Bar[] {
  if (!tail.length) return stored.slice();
  const start = tail[0].time;
  const period = seriesPeriod(seriesBarSize);
  const firstPeriod = period ? periodKey(start, period) : undefined;
  const head = stored.filter((b) => b.time < start && (period === undefined || periodKey(b.time, period) < firstPeriod!));
  return head.concat(tail);
}
