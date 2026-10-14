// Bars a live price extends (pure; no React or store imports): the chart's tail of live bars beyond
// the stored ones between IB's bar loads.

import { nyClock, type MarketSession } from './session';
import { barEndSec, barSeconds, barStartSec } from './timeframes';
import type { Bar, Timeframe } from './types';

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
  const dur = barSeconds(tf);
  // Intraday bars end on their grid (a partial first bar of 2 to 4 hours ends at the next grid line).
  if (dur != null) return session !== 'closed' && nowSec >= bar.time && nowSec < barEndSec(bar.time, dur);
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
    case '1Q':
      return day.slice(0, 4) === today.slice(0, 4) && quarterOf(day) === quarterOf(today);
    case '1Y':
      return day.slice(0, 4) === today.slice(0, 4);
    default:
      return false;
  }
}

/** Quarter (0–3) of a "YYYY-MM-DD" day. */
export const quarterOf = (day: string) => Math.floor((Number(day.slice(5, 7)) - 1) / 3);

/**
 * Longest gap (s) after the newest bar's end that the live price bridges with new bars: about two
 * of the chart's reloads (ChartView reloads intraday bars every 60 s), or three bars. A longer gap
 * (a stalled feed) waits for IB's bars.
 */
const ROLL_MAX_GAP_SEC = 120;
const rollMaxGap = (dur: number) => Math.max(ROLL_MAX_GAP_SEC, 3 * dur);

/**
 * The live bars still ahead of the stored ones (a reload replaces those it reaches). A live copy
 * of the stored newest bar keeps the extremes the quotes saw and the last price as its close (a
 * real-time last price is never older than a reload); open and volume are the stored bar's.
 */
function reconcileLive(stored: readonly Bar[], live: readonly Bar[]): Bar[] {
  const newest = stored[stored.length - 1];
  if (!newest || !live.length) return [];
  let i = 0;
  while (i < live.length && live[i].time < newest.time) i++;
  if (i === live.length) return [];
  const rest = live.slice(i);
  if (rest[0].time === newest.time) {
    const b = rest[0];
    if (b.high <= newest.high && b.low >= newest.low && b.close === newest.close) rest.shift();
    else rest[0] = { ...newest, high: Math.max(newest.high, b.high), low: Math.min(newest.low, b.low), close: b.close };
  }
  return rest;
}

/**
 * Advances the live bars (the chart's tail beyond the stored bars, kept between quotes) with the
 * live last price at `now` (`live`: real-time quotes; delayed or frozen quotes are minutes old, so
 * they never touch intraday bars and only extend daily and longer ones):
 * - it extends the forming bar (close, plus high / low extension), which stays extended between
 *   quotes (a live copy of a stored bar);
 * - intraday, while a session runs, once the newest bar's time is over it starts the bar of the
 *   bucket holding `now` on the interval's grid, like IB's next bar: the buckets in between as
 *   flat bars at the previous close without volume (IB fills every bucket of a session that way),
 *   the new one opening at the previous close;
 * - across a session break (the newest bar is older than `sessionOpen`, unix s) nothing is filled:
 *   the first bar starts at the open (a partial first bar of 2 to 4 hours) at the live price.
 * A reload of the stored bars replaces the live bars it reaches (reconcileLive). Applying the
 * same price at the same time again changes nothing.
 */
export function advanceLiveBars(
  stored: readonly Bar[],
  live: readonly Bar[],
  last: number | undefined,
  tf: Timeframe,
  now: Date,
  session: MarketSession,
  opts: { live?: boolean; sessionOpen?: number } = {},
): Bar[] {
  const dur = barSeconds(tf);
  if (!stored.length || (dur != null && opts.live === false)) return [];
  const tail = reconcileLive(stored, live);
  if (!finite(last) || last <= 0) return tail;
  const base = tail.length ? tail[tail.length - 1] : stored[stored.length - 1];
  if (isCurrentBar(base, tf, now, session)) {
    if (base.close === last && base.high >= last && base.low <= last) return tail;
    const merged: Bar = { ...base, close: last, high: Math.max(base.high, last), low: Math.min(base.low, last) };
    return tail.length ? [...tail.slice(0, -1), merged] : [merged];
  }
  if (dur == null || session === 'closed') return tail;
  const nowSec = Math.floor(now.getTime() / 1000);
  const end = barEndSec(base.time, dur);
  if (nowSec < end) return tail;
  const open = opts.sessionOpen;
  if (open !== undefined && base.time < open && open <= nowSec) {
    // A new session: no bars across the break; the first one starts at the open.
    if (nowSec - open > rollMaxGap(dur)) return tail;
    return [...tail, { time: barStartSec(nowSec, dur, open), open: last, high: last, low: last, close: last, volume: 0 }];
  }
  if (nowSec - end > rollMaxGap(dur)) return tail;
  const current = barStartSec(nowSec, dur, open);
  if (current <= base.time) return tail;
  const prev = base.close;
  const added: Bar[] = [];
  for (let t = end; t < current; t += dur) added.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: 0 });
  added.push({ time: current, open: prev, high: Math.max(prev, last), low: Math.min(prev, last), close: last, volume: 0 });
  return tail.concat(added);
}

/** The stored bars with the live bars (advanceLiveBars) in place of those they replace. */
export function withLiveBars(stored: Bar[], live: readonly Bar[]): Bar[] {
  if (!live.length) return stored;
  const first = live[0].time;
  let n = stored.length;
  while (n > 0 && stored[n - 1].time >= first) n--;
  return stored.slice(0, n).concat(live);
}

/** The live last price on the bars, from no live bars: advanceLiveBars once (tests, one-off merges). */
export function mergeLivePrice(
  bars: Bar[],
  last: number | undefined,
  tf: Timeframe,
  now: Date,
  session: MarketSession,
  opts: { live?: boolean; sessionOpen?: number } = {},
): Bar[] {
  return withLiveBars(bars, advanceLiveBars(bars, [], last, tf, now, session, opts));
}

/** Extended hours open at 04:00 New York (the partial first bar of 2 to 4-hour bars). */
const EXT_OPEN_MIN = 240;

/** Unix seconds of today's 04:00 New York (extended hours open) at `now`: advanceLiveBars' `sessionOpen` for US instruments. */
export function sessionOpenSec(now: Date): number {
  const sec = Math.floor(now.getTime() / 1000);
  return sec - (sec % 60) - (nyClock(now).minutes - EXT_OPEN_MIN) * 60;
}
