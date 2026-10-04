// Paging bar series back in time, and what a historical data answer adds to a series' coverage
// (pure, unit-tested).
//
// How IB's windows behave (checked live against IB Gateway 10.x with AAPL and an AAPL option):
// - 'N D' returns the last N trading sessions up to the end time, the session in progress
//   counting as one, whatever the calendar dates in the end marker say: "1 D" ending Friday
//   13:00 New York returns Friday from 04:00 (extended hours) but not Thursday afternoon; ending
//   Monday 00:00 it returns Friday.
// - 'W' and 'M' windows of intraday bars are cut to whole sessions as well: "1 M" of 1-hour bars
//   ending 2026-09-25 13:00 started on 08-27 although the marker said 08-25 13:00.
// - Daily and longer bars over 'Y' windows start at (or before) the calendar start.
// - Weekly and monthly bars are stamped with the period's last trading day and are partial at a
//   window's edges (a window ending mid-week ends with a bar for the days so far).
// - Options trade sparsely: a window without trades answers 162 "HMDS query returned no data"
//   although older bars exist. Only the head timestamp (reqHeadTimestamp) tells where a series
//   begins.
// - 'N S' (bars below a minute) counts session time: 1800 S of 1-second bars ending Friday
//   20:30 returned 19:30–20:00, 30 secs x 28800 S of regular hours went back into Thursday.
//   IB fills every bucket of a session (a bucket without trades is a flat bar at the previous
//   close with no volume), also in extended hours, and nothing outside it.
// - 2, 3, 4 and 8-hour bars lie on the UTC grid (epoch multiples) with a partial first bar at
//   the session open; seconds, minutes and 1 hour on New York's (the same epoch grid).
// - endDateTime "yyyymmdd-hh:mm:ss" is UTC; a time without a zone is refused (warning 2174).
//   An end inside a bar returns that bar cut at the end ("5 mins" ending 17:03:27 UTC: the 17:00
//   bar with 3.5 minutes of volume); an end on a bar boundary returns whole bars only (the
//   09:30 bar of regular-hours "1 hour" bars ends at 10:00 New York).
//
// An answer therefore claims (adds to the coverage) only what IB certainly sent: from its first
// bar (the period after it for weekly / monthly bars and for days built from 8-hour bars, which
// may be partial, unless the head timestamp lies in that period: the series begins there), or
// from a conservative calendar start where IB's window is known to reach at least that far: N
// weekdays back for 'N D' on instruments with New York sessions, the calendar start plus a few
// days for 'Y' windows of daily bars.

import { barSeconds } from '@shared/timeframes';
import type { Bar, ContractRef, Timeframe } from '@shared/types';
import { addDays, type CalendarDay, isWeekday, latestSession, nyDay, nyWallToEpochMs, RTH_CLOSE, RTH_OPEN } from './nyTime';
import { BAR_SIZE_SEC, MAX_STEP_SEC, periodKey, seriesPeriod, SETTLE_MIN, usSessions, type HistorySpec, type Period } from './historyParams';

const DAY_SEC = 86_400;

/** How the stored series is stamped: instants, or daily / weekly / monthly date stamps. */
export type SeriesKind = 'intraday' | 'day' | 'week' | 'month';
/** The period of the bars a request is answered with (aggregates included). */
export type PresentedPeriod = SeriesKind | 'quarter' | 'year';

export function seriesKind(spec: HistorySpec): SeriesKind {
  if (spec.intraday) return 'intraday';
  return seriesPeriod(spec.seriesBarSize) ?? 'day';
}

export function presentedPeriod(spec: HistorySpec): PresentedPeriod {
  return spec.aggregate ?? seriesKind(spec);
}

const utc = (t: number) => {
  const d = new Date(t * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() };
};

/** Start (00:00 UTC) of the day, week (Monday), month, quarter or year containing date stamp `t`. */
export function periodStart(t: number, period: Exclude<Period, never>): number {
  const { y, m, d, w } = utc(t);
  switch (period) {
    case 'day':
      return Date.UTC(y, m, d) / 1000;
    case 'week':
      return Date.UTC(y, m, d - ((w + 6) % 7)) / 1000;
    case 'month':
      return Date.UTC(y, m, 1) / 1000;
    case 'quarter':
      return Date.UTC(y, m - (m % 3), 1) / 1000;
    case 'year':
      return Date.UTC(y, 0, 1) / 1000;
  }
}

/** Start of the period after the one containing date stamp `t`. */
export function nextPeriodStart(t: number, period: Period): number {
  const start = periodStart(t, period);
  const { y, m } = utc(start);
  switch (period) {
    case 'day':
      return start + DAY_SEC;
    case 'week':
      return start + 7 * DAY_SEC;
    case 'month':
      return Date.UTC(y, m + 1, 1) / 1000;
    case 'quarter':
      return Date.UTC(y, m + 3, 1) / 1000;
    case 'year':
      return Date.UTC(y + 1, 0, 1) / 1000;
  }
}

/** The first start of a `period` at or after `t`; intraday times are returned as they are. */
export function alignUp(t: number, period: PresentedPeriod): number {
  if (period === 'intraday') return t;
  return periodStart(t, period) === t ? t : nextPeriodStart(t, period);
}

/**
 * Series time below which the bars of a page lie. Bars of weekly, monthly and yearly
 * presentations are stamped inside their period, so a page ends where the period of `before`
 * (the oldest bar the view has) begins: IB is then asked up to a period boundary and never
 * answers with a partial period.
 */
export function pageBound(before: number, spec: HistorySpec): number {
  const p = presentedPeriod(spec);
  return p === 'intraday' || p === 'day' ? before : periodStart(before, p);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** reqHistoricalData endDateTime for a unix time: "yyyymmdd-hh:mm:ss" in UTC. */
export function ibEndDateTime(t: number): string {
  const d = new Date(Math.floor(t) * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Seconds of an intraday series' bars (an hour for unknown sizes). */
const intradayBarSec = (spec: HistorySpec) => BAR_SIZE_SEC[spec.barSize] ?? 3600;

/**
 * End (unix seconds) of a page request for the bars before `start` (series time). Intraday ends
 * are moved up to a multiple of the bar size, which never lies inside a bar (the regular-hours
 * 09:30 bar of "1 hour" ends at 10:00; 2 to 8-hour bars are on the UTC grid), so IB never
 * answers with a bar cut at the end: the bar holding a `start` inside it comes whole, and the
 * caller drops the bars at or after `start`.
 */
export function pageEnd(start: number, spec: HistorySpec): number {
  if (!spec.intraday) return start;
  const bar = intradayBarSec(spec);
  return Math.ceil(start / bar) * bar;
}

/**
 * Start (unix seconds) of the intraday coverage the bar cache can serve at `nowMs`, given that
 * bars `days` old may be gone: 00:00 New York of the next day, moved down to the grid of bars of
 * `barSec` (midnight New York is on the grid of every bar size up to an hour, not on the UTC grid
 * of 2 to 8-hour bars), so pages that continue below the served coverage end between bars, and
 * the boundary stays put for a day.
 */
export function intradayCoverageStart(nowMs: number, days: number, barSec = 60): number {
  const d = nyDay(nowMs - days * DAY_SEC * 1000);
  const midnight = nyWallToEpochMs(addDays({ y: d.y, m: d.m, d: d.d }, 1), 0) / 1000;
  return Math.floor(midnight / barSec) * barSec;
}

/** Series time of IB's head timestamp (unix seconds): daily and longer series use its date. */
export function headStamp(head: number, spec: HistorySpec): number {
  if (spec.intraday) return head;
  const d = nyDay(head * 1000);
  return Date.UTC(d.y, d.m - 1, d.d) / 1000;
}

// ---------------------------------------------------------------------------
// Page requests

/** Seconds of a regular (09:30–16:00) and an extended (04:00–20:00) New York session. */
const RTH_SESSION_SEC = 23_400;
const EXT_SESSION_SEC = 57_600;
/**
 * The most sessions one page request of an intraday bar size (a minute or longer) asks for:
 * about 2,000 bars of extended hours at most (checked live: 3 mins x 1 W, 30 mins x 3 M,
 * 1 hour x 6 M, 2 hours x 1 Y and 4 hours x 2 Y all answered). Smaller bars page in session
 * seconds, at most MAX_STEP_SEC per request.
 */
const MAX_PAGE_SESSIONS: Record<string, number> = {
  '1 min': 5,
  '2 mins': 10,
  '3 mins': 10,
  '5 mins': 10,
  '10 mins': 20,
  '15 mins': 20,
  '20 mins': 30,
  '30 mins': 60,
  '1 hour': 120,
  '2 hours': 250,
  '3 hours': 250,
  '4 hours': 500,
  '8 hours': 500,
};
/** Stored bars per presented bar of an aggregated timeframe. */
const PER_PRESENTED: Record<string, number> = { 'day>week': 5, 'day>month': 21, 'day>quarter': 63, 'day>year': 252, 'month>quarter': 3, 'month>year': 12 };
/** Years one page request of daily / weekly / monthly bars asks for (checked live: 1 W x 5 Y, 1 M x 20 Y). */
const YEARS: Record<Exclude<SeriesKind, 'intraday'>, { perYear: number; min: number; max: number }> = {
  day: { perYear: 252, min: 1, max: 2 },
  week: { perYear: 52, min: 1, max: 10 },
  month: { perYear: 12, min: 2, max: 20 },
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Stored bars per duration unit a page request expects: per session ('D') intraday, per year otherwise. */
export function barsPerUnit(spec: HistorySpec): number {
  const kind = seriesKind(spec);
  if (kind === 'intraday') {
    const bar = intradayBarSec(spec);
    // The regular-hours 1-hour bars start with a 09:30 stub: 7 per session.
    return Math.ceil((spec.useRTH ? RTH_SESSION_SEC : EXT_SESSION_SEC) / bar);
  }
  return YEARS[kind].perYear;
}

/** Number of units of an IB duration ("3 D" → 3). */
export function durationUnits(duration: string): number {
  const n = Number(/^(\d+) [SDWMY]$/.exec(duration.trim())?.[1]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Sessions per duration unit of intraday windows ('W', 'M' and 'Y' are cut to whole sessions at IB). */
const SESSIONS_PER_UNIT: Record<string, number> = { D: 1, W: 5, M: 21, Y: 252 };

/** Stored bars a request of `duration` is expected to return for a series (before density). */
export function expectedBars(spec: HistorySpec, duration: string): number {
  const unit = /^\d+ ([SDWMY])$/.exec(duration.trim())?.[1] ?? 'D';
  const n = durationUnits(duration);
  if (seriesKind(spec) !== 'intraday') return n * barsPerUnit(spec);
  if (unit === 'S') return n / intradayBarSec(spec);
  return n * (SESSIONS_PER_UNIT[unit] ?? 1) * barsPerUnit(spec);
}

/** An intraday window of `sessions` sessions: 'N D' up to 30, then months (up to 11), then years. */
function sessionsDuration(sessions: number): string {
  if (sessions <= 30) return `${sessions} D`;
  const months = Math.ceil(sessions / SESSIONS_PER_UNIT.M);
  return months <= 11 ? `${months} M` : `${Math.ceil(sessions / SESSIONS_PER_UNIT.Y)} Y`;
}

/**
 * IB duration of one page request that should return about `wanted` presented bars: session
 * seconds ('N S') for bars below a minute, sessions ('N D', or months and years for long pages
 * of hour bars) for other intraday bars, years for the rest (a 1Y chart asks for as many years
 * of months). `density` is the share of the expected bars the series really has (sparse options
 * trade in a fraction of the 5-minute bars of a session), learned from earlier answers.
 */
export function pageDuration(spec: HistorySpec, wanted: number, density = 1): string {
  const kind = seriesKind(spec);
  const d = Math.min(1, Math.max(MIN_DENSITY, density));
  if (kind === 'intraday') {
    const bar = intradayBarSec(spec);
    // Merged buckets (45 s) take several stored bars each.
    const n = Math.max(1, Math.ceil(wanted)) * (spec.mergeSec ? Math.ceil(spec.mergeSec / bar) : 1);
    const step = MAX_STEP_SEC[spec.barSize];
    if (step !== undefined) return `${clamp(Math.ceil((n * bar) / d / 60) * 60, 60, step)} S`;
    const per = barsPerUnit(spec) * d;
    return sessionsDuration(clamp(Math.ceil(n / per), 1, MAX_PAGE_SESSIONS[spec.barSize] ?? 20));
  }
  const n = Math.max(1, Math.ceil(wanted));
  const per = barsPerUnit(spec) * d;
  const bars = spec.aggregate ? n * (PER_PRESENTED[`${kind}>${spec.aggregate}`] ?? 1) : n;
  const y = YEARS[kind];
  return `${clamp(Math.ceil(bars / per), y.min, y.max)} Y`;
}

/** Lowest density a page duration is sized for (the caps per bar size apply anyway). */
export const MIN_DENSITY = 0.01;

// ---------------------------------------------------------------------------
// Claims

/** Slack added to the calendar start of 'Y' windows of daily bars (IB may count sessions). */
const DAILY_CLAIM_SLACK_SEC = 3 * DAY_SEC;

const nyCalendarDay = (sec: number): CalendarDay => {
  const d = nyDay(sec * 1000);
  return { y: d.y, m: d.m, d: d.d };
};

const stampOf = (day: CalendarDay) => Date.UTC(day.y, day.m - 1, day.d) / 1000;

/**
 * 00:00 New York of the N-th weekday back from `end`, counting the day `end` falls on when it
 * is a weekday and `end` is past its midnight. IB's 'N D' window starts at the N-th session
 * back, which for New York sessions is never later than this (holidays push it further back).
 */
export function weekdaysBackStart(end: number, n: number): number {
  let day = nyCalendarDay(end - 1);
  for (let count = 0; ; day = addDays(day, -1)) {
    if (isWeekday(day) && ++count >= n) break;
  }
  return nyWallToEpochMs(day, 0) / 1000;
}

/** The calendar start of a 'Y' window ending at `end`: the same New York wall time `n` years earlier. */
export function yearsBackStart(end: number, n: number): number {
  const d = nyDay(end * 1000);
  const day = addDays({ y: d.y - n, m: d.m, d: d.d }, 0);
  return nyWallToEpochMs(day, d.minutes) / 1000;
}

/**
 * First series time an answer's bars certainly cover completely (see the header). The first
 * weekly / monthly bar, or day built from 8-hour bars, may be partial, unless the series begins
 * in its period (`begin.head`: the series time of IB's head timestamp) and the window reaches
 * back before that period (`begin.reach`).
 */
function firstComplete(bars: readonly Bar[], spec: HistorySpec, begin?: { head: number; reach: number }): number | undefined {
  if (!bars.length) return undefined;
  const first = bars[0].time;
  const kind = seriesKind(spec);
  if (kind === 'intraday' || (kind === 'day' && !spec.toDays)) return first;
  const start = periodStart(first, kind);
  const next = nextPeriodStart(first, kind);
  const whole = begin !== undefined && begin.reach <= start && start <= begin.head && begin.head < next;
  return whole ? start : next;
}

/** First date (series time) of a 'N Y' window ending at `end`: the day after its calendar start plus `slack`. */
function yearsReach(end: number, n: number, slack: number): number {
  return stampOf(nyCalendarDay(yearsBackStart(end, n) + slack)) + DAY_SEC;
}

/** Calendar start IB's window certainly reaches (New York session instruments only), in series time. */
function calendarStart(spec: HistorySpec, contract: ContractRef, end: number, duration: string): number | undefined {
  if (!usSessions(contract)) return undefined;
  const m = /^(\d+) ([SDWMY])$/.exec(duration.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const kind = seriesKind(spec);
  if (m[2] === 'D' && kind === 'intraday') return weekdaysBackStart(end, n);
  if (m[2] === 'Y' && kind !== 'intraday') return alignUp(yearsReach(end, n, kind === 'day' ? DAILY_CLAIM_SLACK_SEC : 0), kind);
  return undefined;
}

/**
 * Start of the range an answer to a request ending at `end` (series time; now for the newest
 * bars) adds to the coverage, or undefined when it proves nothing. `bars` are the answer as it
 * is stored (ascending, days already built for options). `head`: the series time of IB's head
 * timestamp (headStamp), when known.
 */
export function claimStart(o: { spec: HistorySpec; contract: ContractRef; end: number; duration: string; bars: readonly Bar[]; head?: number }): number | undefined {
  const years = /^(\d+) Y$/.exec(o.duration.trim());
  const reach = years ? yearsReach(o.end, Number(years[1]), DAILY_CLAIM_SLACK_SEC) : undefined;
  const fromBars = firstComplete(o.bars, o.spec, o.head !== undefined && reach !== undefined ? { head: o.head, reach } : undefined);
  const fromCalendar = calendarStart(o.spec, o.contract, o.end, o.duration);
  const candidates = [fromBars, fromCalendar].filter((x): x is number => x !== undefined && x < o.end);
  return candidates.length ? Math.min(...candidates) : undefined;
}

// ---------------------------------------------------------------------------
// Staleness of the newest bars

const TIMEFRAME_PERIOD: Partial<Record<Timeframe, Period>> = { '1D': 'day', '1W': 'week', '1M': 'month', '1Q': 'quarter', '1Y': 'year' };

/**
 * True when the newest bars loaded at `fetchedAtMs` may lack what only IB can tell, so a load
 * waits for IB. Otherwise only the newest bar can have moved: the cache is answered at once and
 * the tail is refreshed in the background.
 * - Intraday: a new bar has started since the load.
 * - Daily and longer (New York regular sessions): a session has opened since the load (a new
 *   daily bar; weekly and longer bars only in a new period), or the latest session has closed
 *   or settled (SETTLE_MIN after the close) since: its bar became final then, and a load after
 *   the close has to show the session's close, not a price from during the session.
 */
export function newestBarsStale(timeframe: Timeframe, fetchedAtMs: number, nowMs: number): boolean {
  const fetched = fetchedAtMs / 1000;
  const bar = barSeconds(timeframe);
  if (bar) return Math.floor(nowMs / 1000 / bar) * bar > fetched;
  const latest = latestSession(nowMs).day;
  const open = nyWallToEpochMs(latest, RTH_OPEN);
  const close = nyWallToEpochMs(latest, RTH_CLOSE);
  const settled = nyWallToEpochMs(latest, RTH_CLOSE + SETTLE_MIN);
  const last = nowMs >= settled ? settled : nowMs >= close ? close : open;
  if (last <= fetchedAtMs) return false;
  if (last !== open) return true;
  const period = TIMEFRAME_PERIOD[timeframe] ?? 'day';
  if (period === 'day') return true;
  return periodKey(stampOf(latest), period) !== periodKey(stampOf(nyCalendarDay(fetched)), period);
}
