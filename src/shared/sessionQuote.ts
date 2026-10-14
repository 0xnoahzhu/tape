// What the chart header (and the floating ticket's) shows as "the price" depends on the market
// session (design: sessionQuote). Shared with the main process so price alerts measure a day's
// change against the same reference (liveChangeRef). Pure so it can be unit tested.
//
//   regular  last vs previous close                      refs: Prev close
//   post     extended last vs today's close              refs: Close (vs prev close), Prev close
//   pre      last vs previous close                      refs: Prev close
//   closed   today's close vs prev close                 refs: After-hours last (if different), Prev close
//
// "Today's close" is the last regular-hours trade (tick 57). IB does not send it with delayed
// data; the caller then passes the latest daily bar's close. Without either, post and closed
// fall back to the last trade vs the previous close.

import { nyClock, usEquitySession, type MarketSession } from './session';
import { CLOCK_24H, NEW_YORK_ZONE, wallClockAt, type Clock } from './timeFormat';
import type { ContractRef, Quote } from './types';

export type RefKind = 'close' | 'prev' | 'ext';

export interface SessionRef {
  kind: RefKind;
  value: number;
  /** Change reference for this row (none for the previous close itself). */
  base?: number;
}

export interface SessionQuote {
  /** The big price; undefined when IB has not sent a usable price. */
  price?: number;
  /** Reference for the big change. */
  ref?: number;
  refs: SessionRef[];
}

const ok = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Live trade price, else the quote midpoint / mark. Never the previous close. */
function livePrice(q: Quote): number | undefined {
  if (ok(q.last)) return q.last;
  if (ok(q.bid) && ok(q.ask)) return (q.bid + q.ask) / 2;
  if (ok(q.mark)) return q.mark;
  return undefined;
}

/**
 * @param regularClose close of the latest regular session from daily bars, used for post and
 *   closed when the quote has no tick 57
 */
export function sessionQuote(q: Quote | undefined, session: MarketSession, regularClose?: number): SessionQuote {
  if (!q) return { refs: [] };
  const prev = ok(q.close) ? q.close : undefined;
  const rth = todaysClose(q, regularClose);
  const live = livePrice(q);
  const prevRef: SessionRef[] = prev != null ? [{ kind: 'prev', value: prev }] : [];

  switch (session) {
    case 'regular':
    case 'pre':
      return { price: live, ref: prev, refs: prevRef };
    case 'post':
      if (rth == null) return { price: live, ref: prev, refs: prevRef };
      return { price: live, ref: liveChangeRef(q, session, regularClose)?.ref, refs: [{ kind: 'close', value: rth, base: prev }, ...prevRef] };
    case 'closed': {
      const price = rth ?? live;
      const ext = rth != null && ok(q.last) && q.last !== rth ? [{ kind: 'ext' as const, value: q.last, base: rth }] : [];
      return { price, ref: prev, refs: [...ext, ...prevRef] };
    }
  }
}

/** Today's close: the last regular-hours trade (tick 57), else the caller's daily-bar close. */
function todaysClose(q: Quote, regularClose?: number): number | undefined {
  return ok(q.lastRthTrade) ? q.lastRthTrade : ok(regularClose) ? regularClose : undefined;
}

/**
 * The reference a live price's change on the day is measured against, as the chart header shows
 * it: the previous close in the pre-market and the regular session; after the close (post-market,
 * and the overnight session, which usEquitySession counts as closed) today's close, an after-hours
 * change (`afterHours`), as long as it is known (IB sends tick 57 on live lines only, so delayed
 * data falls back to the previous close). Undefined without a reference.
 */
export function liveChangeRef(q: Quote, session: MarketSession | 'overnight', regularClose?: number): { ref: number; afterHours: boolean } | undefined {
  if (session === 'post' || session === 'closed' || session === 'overnight') {
    const rth = todaysClose(q, regularClose);
    if (rth != null) return { ref: rth, afterHours: true };
  }
  return ok(q.close) ? { ref: q.close, afterHours: false } : undefined;
}

/** Session part of a New York day; "night" is the closed time before the pre-market. */
function dayPhase(d: Date, liquidHours?: string): string {
  const clock = nyClock(d);
  const session = usEquitySession(d, liquidHours);
  return `${clock.ymd}:${session === 'closed' && clock.minutes < 240 ? 'night' : session}`;
}

/**
 * Whether daily bars loaded at `loadedAt` are current for the session header at `now`: loaded in
 * the same part of the same New York day, so no regular session has closed since. Bars loaded
 * earlier (e.g. during the regular session) may still show an intraday price as today's close.
 */
export function dailyBarsCurrent(loadedAt: number, now: Date, liquidHours?: string): boolean {
  return dayPhase(new Date(loadedAt), liquidHours) === dayPhase(now, liquidHours);
}

/** Whether US equity session rules (pre / regular / post) apply to an instrument. */
export function usesUsEquitySession(c: ContractRef): boolean {
  return c.currency === 'USD' && (c.secType === 'STK' || c.secType === 'OPT' || c.secType === 'IND' || c.secType === 'WAR' || c.secType === 'BAG');
}

/**
 * Exchange time of a quote in `clock`'s format: "04:00:05 PM" / "16:00:05", or "10/03 04:00 PM" /
 * "10/03 16:00" when it is not from today (New York days).
 */
export function etTime(t: number, now: Date = new Date(), clock: Clock = CLOCK_24H): string {
  const at = wallClockAt(t, NEW_YORK_ZONE);
  const today = wallClockAt(now, NEW_YORK_ZONE);
  const sameDay = at.y === today.y && at.mo === today.mo && at.d === today.d;
  return sameDay ? clock.time(t, { timeZone: NEW_YORK_ZONE, seconds: true }) : clock.time(t, { timeZone: NEW_YORK_ZONE, date: 'md' });
}
