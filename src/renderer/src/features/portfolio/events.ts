// The holdings' next corporate event (pure): the chip on a Positions group or row ("Earnings 10/23
// AMC", "Ex-div 10/15 $0.24") and the footer note on why earnings dates are missing. Both come from
// IB: earnings from Wall Street Horizon, else from IB's market scanner (its nextEarningsDateTime,
// for an account without the WSH subscription), ex-dividend dates from IB's dividend tick (456) on
// the holdings' stock lines.
// No React and no store access; which row carries a chip is groups.ts → chipTargets.

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
  /** Earnings: found through IB's market scanner, not Wall Street Horizon (the chip's tooltip says so). */
  fromScanner?: boolean;
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
 * (Wall Street Horizon) or its ex-dividend date (IB's dividend tick),
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
  const add = (key: string, kind: CorporateEvent['kind'], date: string, extra: Pick<CorporateEvent, 'time' | 'fromScanner' | 'amount'>) => {
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
      const extra: Pick<CorporateEvent, 'time' | 'fromScanner'> = {};
      if (e.time) extra.time = e.time;
      if (e.estimated) extra.fromScanner = true;
      add(e.key, 'earnings', e.date, extra);
    }
  }
  for (const [key, d] of Object.entries(dividends)) {
    if (d?.nextDate) add(key, 'dividend', d.nextDate, finite(d.nextAmount) ? { amount: d.nextAmount } : {});
  }
  return out;
}

/** "10/23", "01/05" from YYYYMMDD. */
export const monthDay = (yyyymmdd: string): string => `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;

/** A dividend per share: "$0.24" in US dollars, else "0.24 EUR". */
export function dividendAmount(amount: number, currency: string | undefined): string {
  return !currency || currency === 'USD' ? `$${f2(amount)}` : `${f2(amount)} ${currency}`;
}

/** The words of a chip (messages.ts). */
export interface EventWords {
  earnings: string;
  exDiv: string;
  times: Record<NonNullable<EarningsEvent['time']>, string>;
}

/** A chip's text: "Earnings 10/23 AMC" or "Ex-div 10/15 $0.24" (the amount in the underlying's currency). */
export function eventLabel(e: CorporateEvent, w: EventWords): string {
  if (e.kind === 'dividend') return [w.exDiv, monthDay(e.date), e.amount != null ? dividendAmount(e.amount, e.underlying.currency) : undefined].filter(Boolean).join(' ');
  return [w.earnings, monthDay(e.date), e.time ? w.times[e.time] : undefined].filter(Boolean).join(' ');
}

/** An event's identity for redrawing: its chip changes only when one of these does. */
export function eventSig(e: CorporateEvent | undefined): string {
  return e ? [e.key, e.kind, e.date, e.time, e.fromScanner, e.amount].join('|') : '';
}

export type EarningsState = 'ok' | 'searching' | 'unsubscribed' | 'unavailable';

/**
 * What the Positions tab can say about earnings: 'ok' (listed, or still loading), 'searching' (IB's
 * market scanner is still looking some up), 'unsubscribed' (IB refused Wall Street Horizon and the
 * scanner) or 'unavailable' (IB did not answer while connected). Not connected counts as 'ok': the
 * table then says so itself.
 */
export function earningsState(earnings: CorporateEarnings | undefined, connected: boolean): EarningsState {
  if (earnings?.status === 'unsubscribed') return 'unsubscribed';
  if (earnings?.status === 'unavailable' && connected) return 'unavailable';
  if (earnings?.status === 'ok' && earnings.pending) return 'searching';
  return 'ok';
}
