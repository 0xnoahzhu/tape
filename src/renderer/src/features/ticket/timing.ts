// Time in force and trading session in the order ticket: the GTD expiry (a New York wall time,
// typed or defaulting to the next session close) and the input of the shared rules
// (shared/orderTiming.ts) the chips are checked against. Pure, so it can be unit tested.

import { NEW_YORK, zonedParts, zonedToUtc, type TimingInput } from '@shared/orderTiming';
import type { ContractRef, TradingSession } from '@shared/types';
import type { TicketState } from '../../state/store';

/** A New York wall time: "20261009", "16:00". */
export interface EasternTime {
  ymd: string;
  hhmm: string;
}

/** Trading hours from contract details, for the default expiry. */
export interface SessionHours {
  /** IB's liquidHours: "20261005:0930-20261005:1600;20261006:CLOSED", in `timeZoneId`. */
  liquidHours?: string;
  timeZoneId?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function addDays(ymd: string, days: number): string {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) + days));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/**
 * The end of the first trading day in IB's liquidHours whose regular session has not ended at
 * `now` (unix ms), if any. A day may have several ranges ("0930-1200;1300-1610" on exchanges with
 * a lunch break): the day closes at its last one.
 */
function closeFromLiquidHours(now: number, liquidHours: string, timeZone: string): number | undefined {
  /** Last range end per trading date (yyyyMMdd sorts as a string). */
  const closes = new Map<string, number>();
  for (const item of liquidHours.split(';')) {
    const date = item.slice(0, 8);
    // Older servers send "20261005:0930-1600", without the date on the end time.
    for (const range of item.split(',')) {
      const m = /-(?:(\d{8}):)?(\d{2})(\d{2})$/.exec(range.trim());
      if (!m) continue;
      const end = zonedToUtc(m[1] ?? date, `${m[2]}:${m[3]}`, timeZone);
      closes.set(date, Math.max(closes.get(date) ?? end, end));
    }
  }
  const date = [...closes.keys()].sort().find((d) => closes.get(d)! > now);
  return date == null ? undefined : closes.get(date);
}

/**
 * Default GTD expiry: the close of the current regular session, or of the next one once it has
 * closed. IB's liquidHours make holidays and early closes count; without them (or with a time
 * zone Intl does not know) weekdays close at 16:00 ET.
 */
export function nextSessionClose(now: number, hours: SessionHours = {}): EasternTime {
  if (hours.liquidHours) {
    try {
      const end = closeFromLiquidHours(now, hours.liquidHours, hours.timeZoneId || NEW_YORK);
      if (end != null) {
        const { ymd, hhmm } = zonedParts(end, NEW_YORK);
        return { ymd, hhmm };
      }
    } catch {
      // unknown time zone name: fall back to weekdays
    }
  }
  const ny = zonedParts(now, NEW_YORK);
  let { ymd, weekday } = ny;
  const weekdayOpen = weekday >= 1 && weekday <= 5 && ny.hhmm < '16:00';
  if (!weekdayOpen) {
    do {
      ymd = addDays(ymd, 1);
      weekday = (weekday + 1) % 7;
    } while (weekday === 0 || weekday === 6);
  }
  return { ymd, hhmm: '16:00' };
}

/** { ymd: '20261009', hhmm: '16:00' } -> "2026-10-09T16:00" (a datetime-local value). */
export function toLocalInput(t: EasternTime): string {
  return `${t.ymd.slice(0, 4)}-${t.ymd.slice(4, 6)}-${t.ymd.slice(6, 8)}T${t.hhmm}`;
}

/** "2026-10-09T16:00" -> { ymd: '20261009', hhmm: '16:00' }; null when not a valid date-time. */
export function fromLocalInput(s: string): EasternTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return { ymd: `${m[1]}${m[2]}${m[3]}`, hhmm: `${m[4]}:${m[5]}` };
}

/** The ticket's GTD expiry: the typed one, or the default while nothing was typed (null). */
export function goodTillTime(goodTill: string | null, now: number, hours?: SessionHours): EasternTime | null {
  return goodTill == null ? nextSessionClose(now, hours) : fromLocalInput(goodTill);
}

export const easternToUtc = (t: EasternTime): number => zonedToUtc(t.ymd, t.hhmm, NEW_YORK);

/** The ticket as the shared TIF / session rules see it. */
export function ticketTiming(t: TicketState, contract: ContractRef, session: TradingSession, goodTill: EasternTime | null): TimingInput {
  return {
    contract,
    orderType: t.orderType,
    tif: t.tif,
    session,
    // Brackets cannot be attached when modifying (buildOrderRequest drops them).
    bracket: t.bracket && t.modifyingOrderId == null,
    iceberg: t.iceberg,
    condition: t.condition,
    goodAfter: t.goodAfter,
    goodTill: goodTill ? easternToUtc(goodTill) : undefined,
  };
}
