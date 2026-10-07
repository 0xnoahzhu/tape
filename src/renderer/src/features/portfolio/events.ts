// The holdings' next corporate event (pure): the chip on a Positions group or row ("Earnings 10/23
// AMC · Est.", "Ex-div 10/15 $0.24") and the footer note on where earnings dates come from. Earnings
// are Wall Street Horizon's, else estimated from IB's market scanner (marked Est.); ex-dividend
// dates come from IB's dividend tick (456) on the holdings' stock lines. No React and no store
// access; which row carries a chip is groups.ts → chipTargets.

import { contractKey } from '@shared/contract';
import { f2 } from '@shared/format';
import { nyDaysUntil } from '@shared/orderTiming';
import type { ContractRef, CorporateEarnings, EarningsEvent, QuoteDividends } from '@shared/types';
import { underlyingOf, type PositionRow } from './calc';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isOption = (r: PositionRow) => r.position.contract.secType === 'OPT' || r.position.contract.secType === 'FOP';

/** How far ahead an event gets a chip (calendar days in New York, today included). */
export const EVENT_WINDOW_DAYS = 14;

export interface CorporateEvent {
  /** Underlying contract key. */
  key: string;
  symbol: string;
  underlying: ContractRef;
  kind: 'earnings' | 'dividend';
  /** YYYYMMDD. */
  date: string;
  /** Calendar days from today in New York (orderTiming.ts → nyDaysUntil). */
  days: number;
  /** Earnings: before the open, after the close or during the session. */
  time?: 'bmo' | 'amc' | 'dmh';
  /** Earnings: the release time in minutes after midnight New York, when known exactly. */
  minutes?: number;
  /** Earnings: estimated from IB's market scanner, not a confirmed date. */
  estimated?: boolean;
  /** Dividend per share, in the underlying's currency. */
  amount?: number;
}

/**
 * The holdings' underlyings by contract key: a stock position's own contract (it carries the
 * conId), the underlying stock or index of an option.
 */
export function holdingUnderlyings(rows: readonly PositionRow[]): Map<string, ContractRef> {
  const out = new Map<string, ContractRef>();
  for (const r of rows) {
    const c = r.position.contract;
    if (c.secType === 'STK') out.set(contractKey(c), { ...c, exchange: 'SMART' });
    else if (isOption(r)) {
      const und = underlyingOf(c);
      const k = contractKey(und);
      if (!out.has(k)) out.set(k, und);
    }
  }
  return out;
}

/**
 * The next event of each holding's underlying within `withinDays` (today included): its earnings
 * (Wall Street Horizon or the scanner's estimate) or its ex-dividend date (IB's dividend tick),
 * whichever comes first, earnings on the same day. `underlyings` are the holdings' underlyings by
 * key; events of other instruments, past dates and dates further out are ignored.
 */
export function nextEvents(
  underlyings: ReadonlyMap<string, ContractRef>,
  dividends: Readonly<Record<string, QuoteDividends | undefined>>,
  earnings: CorporateEarnings | undefined,
  now: Date,
  withinDays = EVENT_WINDOW_DAYS,
): Map<string, CorporateEvent> {
  const out = new Map<string, CorporateEvent>();
  const add = (key: string, kind: CorporateEvent['kind'], date: string, extra: Pick<CorporateEvent, 'time' | 'minutes' | 'estimated' | 'amount'>) => {
    const und = underlyings.get(key);
    if (!und || !/^\d{8}$/.test(date)) return;
    const days = nyDaysUntil(date, now);
    if (days < 0 || days > withinDays) return;
    const cur = out.get(key);
    if (cur && (cur.days < days || (cur.days === days && (cur.kind === 'earnings' || kind !== 'earnings')))) return;
    out.set(key, { key, symbol: und.symbol, underlying: und, kind, date, days, ...extra });
  };
  if (earnings?.status === 'ok') {
    for (const e of earnings.events) {
      const extra: Pick<CorporateEvent, 'time' | 'minutes' | 'estimated'> = {};
      if (e.time) extra.time = e.time;
      if (finite(e.minutes)) extra.minutes = e.minutes;
      if (e.estimated) extra.estimated = true;
      add(e.key, 'earnings', e.date, extra);
    }
  }
  for (const [key, d] of Object.entries(dividends)) {
    if (d?.nextDate) add(key, 'dividend', d.nextDate, finite(d.nextAmount) ? { amount: d.nextAmount } : {});
  }
  return out;
}

/** "08:30" for 510 minutes after midnight (New York): a 24-hour wall time for Clock.wall. */
export function etClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** "10/23" from YYYYMMDD. */
export const monthDay = (yyyymmdd: string): string => `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;

/** A dividend per share: "$0.24" in US dollars, else "0.24 EUR". */
export function dividendAmount(amount: number, currency: string | undefined): string {
  return !currency || currency === 'USD' ? `$${f2(amount)}` : `${f2(amount)} ${currency}`;
}

/** The words of a chip (messages.ts). */
export interface EventWords {
  earnings: string;
  exDiv: string;
  estimated: string;
  times: Record<NonNullable<EarningsEvent['time']>, string>;
  /** An exact release time, New York, in the user's clock format: "8:30 AM ET". */
  atEt(t: string): string;
}

/**
 * A chip's text: "Earnings 10/23 AMC · Est.", "Earnings 10/21 8:30 AM ET" (an exact time says more
 * than before the open / after the close; `wall` writes it in the user's clock format) or "Ex-div
 * 10/15 $0.24" (the amount in the underlying's currency).
 */
export function eventLabel(e: CorporateEvent, w: EventWords, wall: (hhmm: string) => string): string {
  if (e.kind === 'dividend') return [w.exDiv, monthDay(e.date), e.amount != null ? dividendAmount(e.amount, e.underlying.currency) : undefined].filter(Boolean).join(' ');
  const when = e.minutes != null ? w.atEt(wall(etClock(e.minutes))) : e.time ? w.times[e.time] : undefined;
  const label = [w.earnings, monthDay(e.date), when].filter(Boolean).join(' ');
  return e.estimated ? `${label} · ${w.estimated}` : label;
}

/** An event's identity for redrawing: its chip changes only when one of these does. */
export function eventSig(e: CorporateEvent | undefined): string {
  return e ? [e.key, e.kind, e.date, e.time, e.minutes, e.estimated, e.amount].join('|') : '';
}

export type EarningsState = 'ok' | 'estimated' | 'estimatedUs' | 'searching' | 'unsubscribed' | 'unavailable';

/**
 * What the Positions tab can say about earnings: 'ok' (listed, or still loading), 'estimated'
 * (dates from IB's market scanner), 'estimatedUs' (the same, but the scanner covers US stocks only
 * and some holdings are not), 'searching' (the scanner is still looking some up), 'unsubscribed'
 * (no Wall Street Horizon subscription and no scanner) or 'unavailable' (IB did not answer while
 * connected). Not connected counts as 'ok': the table then says so itself.
 */
export function earningsState(earnings: CorporateEarnings | undefined, connected: boolean): EarningsState {
  if (earnings?.status === 'unsubscribed') return 'unsubscribed';
  if (earnings?.status === 'unavailable' && connected) return 'unavailable';
  if (earnings?.status === 'ok' && earnings.pending) return 'searching';
  if (earnings?.status === 'ok' && earnings.source === 'scanner') return earnings.partial ? 'estimatedUs' : 'estimated';
  return 'ok';
}
