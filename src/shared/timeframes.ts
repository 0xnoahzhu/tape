// Chart intervals (bar sizes) shared by the history service and the chart (pure).
//
// IB's bar sizes (TWS API, checked live): 1/5/10/15/30 secs, 1/2/3/5/10/15/20/30 mins,
// 1/2/3/4/8 hours, 1 day, 1 week, 1 month. 45-second bars are three 15-second bars merged,
// quarters are months merged. Intraday bars lie on the epoch grid of their length: for seconds,
// minutes and 1 hour that is also New York's (midnight New York is a whole number of hours from
// midnight UTC); 2, 3 and 4 hours are on the UTC grid, with a partial first bar at the session
// open (04:00 or 09:30 New York).

import type { Timeframe } from './types';

export type TimeframeGroup = 'seconds' | 'minutes' | 'hours' | 'days';

/** Intervals by picker section, in picker order. */
export const TIMEFRAME_GROUPS: ReadonlyArray<{ group: TimeframeGroup; timeframes: readonly Timeframe[] }> = [
  { group: 'seconds', timeframes: ['1s', '5s', '10s', '15s', '30s', '45s'] },
  { group: 'minutes', timeframes: ['1m', '3m', '5m', '10m', '15m', '30m'] },
  { group: 'hours', timeframes: ['1h', '2h', '3h', '4h'] },
  { group: 'days', timeframes: ['1D', '1W', '1M', '1Q', '1Y'] },
];

/** Every interval, in picker order. */
export const TIMEFRAMES: readonly Timeframe[] = TIMEFRAME_GROUPS.flatMap((g) => g.timeframes);

/** Length (s) of the intraday intervals. */
const BAR_SECONDS: Partial<Record<Timeframe, number>> = {
  '1s': 1,
  '5s': 5,
  '10s': 10,
  '15s': 15,
  '30s': 30,
  '45s': 45,
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '10m': 600,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '3h': 10_800,
  '4h': 14_400,
};

/**
 * IB keeps bars of 30 seconds or less for six months (TWS API docs; this paper account served
 * them further back, but paging stops here on purpose, see history.ts).
 */
export const SECONDS_HISTORY_DAYS = 183;
/** Bars this short or shorter are IB's "small bars" (six-month limit, strict pacing). */
const SMALL_BAR_SEC = 30;

export function isTimeframe(tf: unknown): tf is Timeframe {
  return typeof tf === 'string' && TIMEFRAMES.includes(tf as Timeframe);
}

/** Length (s) of a bar of an intraday interval; undefined for daily and longer. */
export function barSeconds(tf: Timeframe): number | undefined {
  return BAR_SECONDS[tf];
}

export function isIntraday(tf: Timeframe): boolean {
  return BAR_SECONDS[tf] != null;
}

/** Second intervals (1 s to 45 s): built from IB's small bars. */
export function isSecondsTimeframe(tf: Timeframe): boolean {
  return (BAR_SECONDS[tf] ?? Infinity) < 60;
}

/** IB's small bars (30 s or less), the six-month limit applies. */
export function isSmallBarSize(barSec: number): boolean {
  return barSec <= SMALL_BAR_SEC;
}

export function timeframeGroup(tf: Timeframe): TimeframeGroup {
  return TIMEFRAME_GROUPS.find((g) => g.timeframes.includes(tf))?.group ?? 'days';
}

/**
 * Start (unix s) of the intraday bar of `barSec` holding `t`: the epoch grid of the bar length,
 * but not before `sessionOpen` (unix s) when the session opened inside that bar (2, 3 and 4-hour
 * bars on the UTC grid start with a partial bar at the open).
 */
export function barStartSec(t: number, barSec: number, sessionOpen?: number): number {
  const grid = Math.floor(t / barSec) * barSec;
  return sessionOpen !== undefined && sessionOpen > grid && sessionOpen <= t ? sessionOpen : grid;
}

/** End (unix s) of the intraday bar of `barSec` starting at `start`: the next grid line. */
export function barEndSec(start: number, barSec: number): number {
  return Math.floor(start / barSec) * barSec + barSec;
}
