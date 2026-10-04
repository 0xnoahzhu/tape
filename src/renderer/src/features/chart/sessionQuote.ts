// What the chart header shows as "the price" depends on the market session
// (design: sessionQuote). Pure so it can be unit tested.
//
//   regular  last vs previous close                      refs: Prev close
//   post     extended last vs today's close              refs: Close (vs prev close), Prev close
//   pre      last vs previous close                      refs: Prev close
//   closed   today's close vs prev close                 refs: After-hours last (if different), Prev close
//
// "Today's close" is the last regular-hours trade (tick 57). IB does not send it with delayed
// data; the caller then passes the latest daily bar's close. Without either, post and closed
// fall back to the last trade vs the previous close.

import { nyClock, usEquitySession, type MarketSession } from '@shared/session';
import type { ContractRef, Quote } from '@shared/types';

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
  const rth = ok(q.lastRthTrade) ? q.lastRthTrade : ok(regularClose) ? regularClose : undefined;
  const live = livePrice(q);
  const prevRef: SessionRef[] = prev != null ? [{ kind: 'prev', value: prev }] : [];

  switch (session) {
    case 'regular':
    case 'pre':
      return { price: live, ref: prev, refs: prevRef };
    case 'post':
      if (rth == null) return { price: live, ref: prev, refs: prevRef };
      return { price: live, ref: rth, refs: [{ kind: 'close', value: rth, base: prev }, ...prevRef] };
    case 'closed': {
      const price = rth ?? live;
      const ext = rth != null && ok(q.last) && q.last !== rth ? [{ kind: 'ext' as const, value: q.last, base: rth }] : [];
      return { price, ref: prev, refs: [...ext, ...prevRef] };
    }
  }
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

const nyTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Exchange time of a quote: "16:00:00", or "10/03 16:00" when it is not from today (ET). */
export function etTime(t: number, now: Date = new Date()): string {
  const parts = (d: Date) => Object.fromEntries(nyTime.formatToParts(d).map((p) => [p.type, p.value]));
  const p = parts(new Date(t));
  const n = parts(now);
  const hh = String(Number(p.hour) % 24).padStart(2, '0');
  if (p.month === n.month && p.day === n.day) return `${hh}:${p.minute}:${p.second}`;
  return `${p.month}/${p.day} ${hh}:${p.minute}`;
}
