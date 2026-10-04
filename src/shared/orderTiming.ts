// Time in force and trading session rules, shared by the order ticket (which disables what does
// not combine and says why) and the main process (orderBuilder checks every request again), plus
// the time zone helpers of GTD expiries.
//
// The rules follow IBKR's documentation and what IB answered on a paper account
// (docs/ARCHITECTURE.md › Orders): FOK only for options; OPG only as market / limit on open and
// not for SMART-routed options; IOC, FOK and OPG only in regular hours (IB ignores outside RTH for
// them) and not with a bracket (its children take the parent's TIF); the overnight sessions only
// for US stocks and ETFs, with DAY limit orders and without iceberg, condition or good-after time.
// A working order can change its TIF only between DAY and GTC, or to IOC (tifChangeAllowed).

import { CLOCK_24H, type Clock } from './timeFormat';
import type { ContractRef, TimeInForce, TradingSession } from './types';

export const TIME_IN_FORCES: readonly TimeInForce[] = ['DAY', 'GTC', 'IOC', 'FOK', 'OPG', 'GTD'];
export const TRADING_SESSIONS: readonly TradingSession[] = ['regular', 'extended', 'overnight', 'overnightDay'];

export const isTimeInForce = (s: string): s is TimeInForce => (TIME_IN_FORCES as readonly string[]).includes(s);
export const isOvernight = (s: TradingSession): boolean => s === 'overnight' || s === 'overnightDay';

/** The session of an order or request; without one (older data, other callers) it follows outsideRth. */
export function sessionOf(o: { session?: TradingSession; outsideRth?: boolean }): TradingSession {
  return o.session ?? (o.outsideRth ? 'extended' : 'regular');
}

/** IB's outsideRth flag for a session (IB turns it on by itself for overnight + day). */
export const sessionOutsideRth = (s: TradingSession): boolean => s === 'extended' || s === 'overnightDay';

/** IB's overnight session trades US-listed stocks and ETFs. */
export function overnightEligible(c: Pick<ContractRef, 'secType' | 'currency'>): boolean {
  return c.secType === 'STK' && (c.currency || 'USD') === 'USD';
}

const isOption = (c: Pick<ContractRef, 'secType'>) => c.secType === 'OPT' || c.secType === 'FOP';

export type TimingProblem =
  | 'overnightInstrument'
  | 'overnightType'
  | 'overnightTif'
  | 'overnightBracket'
  | 'overnightIceberg'
  | 'overnightCondition'
  | 'overnightGoodAfter'
  | 'regularHoursTif'
  | 'opgType'
  | 'fokInstrument'
  | 'opgInstrument'
  | 'bracketTif'
  | 'gtdTime';

export interface TimingInput {
  contract: Pick<ContractRef, 'secType' | 'currency'>;
  orderType: string;
  tif: TimeInForce;
  session: TradingSession;
  /** Take-profit / stop-loss children are attached. */
  bracket?: boolean;
  /** Iceberg (display size), price condition and good-after time, which the overnight sessions refuse. */
  iceberg?: boolean;
  condition?: boolean;
  goodAfter?: boolean;
  /** GTD expiry in unix ms; undefined when missing or unreadable. */
  goodTill?: number;
}

/** The choices of the ticket a problem depends on: changing any of them can resolve it. */
export type TimingField = 'tif' | 'session' | 'orderType' | 'bracket' | 'iceberg' | 'condition' | 'goodAfter';

const INVOLVES: Record<TimingProblem, readonly TimingField[]> = {
  overnightInstrument: ['session'],
  overnightType: ['session', 'orderType'],
  overnightTif: ['session', 'tif'],
  overnightBracket: ['session', 'bracket'],
  overnightIceberg: ['session', 'iceberg'],
  overnightCondition: ['session', 'condition'],
  overnightGoodAfter: ['session', 'goodAfter'],
  regularHoursTif: ['session', 'tif'],
  opgType: ['tif', 'orderType'],
  fokInstrument: ['tif'],
  opgInstrument: ['tif'],
  bracketTif: ['tif', 'bracket'],
  gtdTime: [],
};

/** Every problem of a request, most fundamental first. */
export function timingProblems(x: TimingInput, now: number): TimingProblem[] {
  const out: TimingProblem[] = [];
  if (isOvernight(x.session)) {
    if (!overnightEligible(x.contract)) out.push('overnightInstrument');
    if (x.orderType !== 'LMT') out.push('overnightType');
    if (x.tif !== 'DAY') out.push('overnightTif');
    // The stop-loss child is a stop order, which the overnight sessions do not take.
    if (x.bracket) out.push('overnightBracket');
    // IB rejects these after accepting the order (201 "not supported for this combination of
    // exchange and security type"), so the order would only show up as Inactive.
    if (x.iceberg) out.push('overnightIceberg');
    if (x.condition) out.push('overnightCondition');
    if (x.goodAfter) out.push('overnightGoodAfter');
  }
  if (x.session === 'extended' && (x.tif === 'IOC' || x.tif === 'FOK' || x.tif === 'OPG')) out.push('regularHoursTif');
  if (x.tif === 'OPG' && x.orderType !== 'MKT' && x.orderType !== 'LMT') out.push('opgType');
  if (x.tif === 'FOK' && !isOption(x.contract)) out.push('fokInstrument');
  if (x.tif === 'OPG' && isOption(x.contract)) out.push('opgInstrument');
  // Bracket children take the parent's TIF: IB rejects a stop with IOC or FOK (201), and exits
  // on the open could only join an opening auction that is over once the parent has filled.
  if (x.bracket && (x.tif === 'IOC' || x.tif === 'FOK' || x.tif === 'OPG')) out.push('bracketTif');
  if (x.tif === 'GTD' && !(x.goodTill != null && x.goodTill > now)) out.push('gtdTime');
  return out;
}

export function timingProblem(x: TimingInput, now: number): TimingProblem | null {
  return timingProblems(x, now)[0] ?? null;
}

/**
 * Why `field` cannot take `value` with the rest of the request as it is: the first problem that
 * choice would cause (an expiry still to be entered does not count). Null when it can.
 */
export function unavailableReason<F extends TimingField>(x: TimingInput, field: F, value: TimingInput[F]): TimingProblem | null {
  const next = { ...x, [field]: value };
  return timingProblems(next, 0).find((p) => INVOLVES[p].includes(field)) ?? null;
}

/** English texts of the problems (main process errors). */
export const TIMING_PROBLEM_TEXT: Readonly<Record<TimingProblem, string>> = {
  overnightInstrument: 'Overnight trading is only available for US stocks and ETFs',
  overnightType: 'The overnight sessions take limit orders only',
  overnightTif: 'The overnight sessions take DAY orders only',
  overnightBracket: 'A bracket cannot be attached in the overnight sessions (its stop-loss is a stop order)',
  overnightIceberg: 'The overnight sessions do not take iceberg orders (display size)',
  overnightCondition: 'The overnight sessions do not take conditional orders',
  overnightGoodAfter: 'The overnight sessions do not take good-after-time orders',
  regularHoursTif: 'IOC, FOK and OPG orders work in regular trading hours only',
  opgType: 'OPG works only with market or limit orders (market / limit on open)',
  fokInstrument: 'IBKR accepts FOK only for options',
  opgInstrument: 'IBKR rejects OPG for SMART-routed options',
  bracketTif: 'A bracket cannot use IOC, FOK or OPG (its take-profit and stop-loss take the same TIF)',
  gtdTime: 'A GTD order needs an expiry date and time in the future',
};

export const isTimingProblem = (s: string): s is TimingProblem => Object.hasOwn(TIMING_PROBLEM_TEXT, s);

/**
 * Whether IB lets a working order change its TIF from `from` (as WorkingOrder.tif) to `to`. On the
 * paper account it accepted DAY <-> GTC and DAY / GTC -> IOC, and answered 462 ("Cannot change to
 * the new Time in Force") for any change to or from GTD or OPG; a GTD order can change its expiry.
 */
export function tifChangeAllowed(from: string, to: TimeInForce): boolean {
  if (from === to) return true;
  return (from === 'DAY' || from === 'GTC') && (to === 'DAY' || to === 'GTC' || to === 'IOC');
}

// ---------------------------------------------------------------------------
// Time zones (GTD expiries are sent and shown in New York time)

export const NEW_YORK = 'America/New_York';
/** Names IB and TWS use for New York time. */
const EASTERN_NAMES = new Set(['US/Eastern', 'America/New_York', 'EST5EDT', 'EST', 'EDT', 'ET']);

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number) => String(n).padStart(2, '0');

export interface WallTime {
  /** "20261009" */
  ymd: string;
  /** "16:00" */
  hhmm: string;
  /** 0 = Sunday */
  weekday: number;
}

function parts(t: number, timeZone: string) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const n = (k: string) => Number(p[k]);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour') % 24, mi: n('minute'), s: n('second'), weekday: WEEKDAYS.indexOf(p.weekday) };
}

/** Wall clock of an instant in a time zone. Throws for unknown zones. */
export function zonedParts(t: number, timeZone: string): WallTime {
  const p = parts(t, timeZone);
  return { ymd: `${p.y}${two(p.mo)}${two(p.d)}`, hhmm: `${two(p.h)}:${two(p.mi)}`, weekday: p.weekday };
}

/** A wall clock time ("20261009", "16:00") in a time zone -> unix ms, DST-aware. Throws for unknown zones. */
export function zonedToUtc(ymd: string, hhmm: string, timeZone: string): number {
  const wall = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)), Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
  const offset = (t: number) => {
    const p = parts(t, timeZone);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  // The offset at the first guess may be on the other side of a DST change.
  const first = wall - offset(wall);
  return wall - offset(first);
}

const zoneOf = (name: string | undefined): string => (!name || EASTERN_NAMES.has(name) ? NEW_YORK : name);

/** "20261009 16:00:00 US/Eastern": the GTD expiry IB expects for a New York wall time. */
export function ibEasternTime(ymd: string, hhmm: string): string {
  return `${ymd} ${hhmm}:00 US/Eastern`;
}

/**
 * IB date-time -> unix ms: "20261009 16:00:00 US/Eastern" (or another zone name),
 * "20261009-20:00:00" (UTC), or without a zone, taken as New York time. Undefined when unreadable.
 */
export function parseIbDateTime(s: string | undefined): number | undefined {
  const m = /^(\d{8})([ -]+)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(\S+))?$/.exec((s ?? '').trim());
  if (!m) return undefined;
  const [, ymd, sep, h, mi, sec, zone] = m;
  const hhmm = `${two(Number(h))}:${mi}`;
  const seconds = Number(sec ?? 0) * 1000;
  if (sep.trim() === '-' && !zone) return zonedToUtc(ymd, hhmm, 'UTC') + seconds;
  try {
    return zonedToUtc(ymd, hhmm, zoneOf(zone)) + seconds;
  } catch {
    return undefined; // a zone name Intl does not know
  }
}

/** The order fields timingText describes (a request or a working order). */
export interface TimingFields {
  tif: string;
  session?: TradingSession;
  outsideRth?: boolean;
  goodTillDate?: string;
}

/**
 * TIF and trading session as shown in reviews, lists and notifications: "DAY",
 * "GTC · Extended hours", "DAY · Overnight + Day", "GTD 10/09 4:00 PM ET" (the expiry in
 * `clock`'s format; 24-hour "GTD 10/09 16:00 ET" without one).
 */
export function timingText(o: TimingFields, sessions: Record<TradingSession, string>, clock: Clock = CLOCK_24H): string {
  let tif = o.tif || 'DAY';
  if (tif === 'GTD' && o.goodTillDate) {
    const at = parseIbDateTime(o.goodTillDate);
    tif = at != null ? `GTD ${clock.time(at, { timeZone: NEW_YORK, zone: 'ET', date: 'md' })}` : `GTD ${o.goodTillDate}`;
  }
  const session = sessionOf(o);
  return session === 'regular' ? tif : `${tif} · ${sessions[session]}`;
}
