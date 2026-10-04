// Pure helpers for the Orders page: which orders are listed and in what order, and how
// IB's order fields read in the type / price / status columns.

import { multiplierOf } from '@shared/contract';
import { DASH, f0, px } from '@shared/format';
import { isTimeInForce, NEW_YORK, parseIbDateTime, sessionOf, timingText, zonedParts } from '@shared/orderTiming';
import { isOrderActive, type Execution, type OrderType, type WorkingOrder } from '@shared/types';
import type { TicketState } from '../../state/store';
import { toLocalInput } from '../ticket/timing';
import type { OrdersMessages } from './messages';

/** IB sends Double.MAX_VALUE for unset prices; treat it (and non-finite values) as missing. */
export function priceOrUndefined(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e300 ? n : undefined;
}

const orderRef = (clientId: number, orderId: number) => `${clientId}:${orderId}`;

/**
 * Active orders, newest first. Bracket children follow their parent (lowest id first)
 * so a parent and its take-profit / stop-loss read as one block.
 */
export function workingOrders(orders: WorkingOrder[]): WorkingOrder[] {
  const active = orders.filter((o) => isOrderActive(o.status));
  const present = new Set(active.map((o) => orderRef(o.clientId, o.orderId)));
  const children = new Map<string, WorkingOrder[]>();
  const roots: WorkingOrder[] = [];
  for (const o of active) {
    const parent = o.parentId ? orderRef(o.clientId, o.parentId) : '';
    if (parent && present.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(o);
      children.set(parent, list);
    } else {
      roots.push(o);
    }
  }
  roots.sort((a, b) => b.createdAt - a.createdAt || b.orderId - a.orderId);
  return roots.flatMap((r) => [r, ...(children.get(orderRef(r.clientId, r.orderId)) ?? []).sort((a, b) => a.orderId - b.orderId)]);
}

/** True when the order is a bracket child shown under its parent. */
export function isChildRow(o: WorkingOrder, rows: WorkingOrder[]): boolean {
  return !!o.parentId && rows.some((p) => p.clientId === o.clientId && p.orderId === o.parentId);
}

/** Executions newest first. */
export function newestExecutions(executions: Execution[]): Execution[] {
  return [...executions].sort((a, b) => b.time - a.time || (a.execId < b.execId ? 1 : -1));
}

/** Cash amount of a fill: shares × price × multiplier. */
export function tradeAmount(e: Execution): number {
  return e.shares * e.price * multiplierOf(e.contract);
}

export function orderTypeLabel(type: string, m: OrdersMessages): string {
  return m.typeLabels[type] ?? type;
}

/** Price column: limit or trigger price; both for stop-limit; the current stop for trailing orders. */
export function orderPriceText(o: WorkingOrder): string {
  const lmt = priceOrUndefined(o.limitPrice);
  const aux = priceOrUndefined(o.auxPrice);
  switch (o.orderType) {
    case 'MKT':
    case 'MOC':
      return DASH;
    case 'STP':
      return px(aux);
    case 'STP LMT':
      return aux != null && lmt != null ? `${px(aux)} / ${px(lmt)}` : px(lmt ?? aux);
    case 'TRAIL':
    case 'TRAIL LIMIT':
      return px(priceOrUndefined(o.trailStopPrice));
    default:
      return px(lmt ?? aux);
  }
}

// ---------------------------------------------------------------------------
// Good-after time

const ET_ZONES = new Set(['US/Eastern', 'America/New_York', 'EST', 'EDT', 'ET', 'EST5EDT']);
const two = (n: number) => String(n).padStart(2, '0');

/** Offset of a time zone from UTC at an instant, in ms (New York in summer: −4 h). */
function zoneOffsetMs(timeZone: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - t;
}

/** Converts a wall-clock time in a time zone to unix ms. */
function wallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - zoneOffsetMs(timeZone, guess);
  const second = guess - zoneOffsetMs(timeZone, first);
  return second;
}

function etHhmm(t: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(
    new Date(t),
  );
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return `${two(get('hour') % 24)}:${two(get('minute'))}`;
}

export interface GoodAfter {
  /** Display text, e.g. "09:35 ET". */
  label: string;
  /** "HH:MM" in US/Eastern when known (for the order ticket). */
  etTime?: string;
  /** Activation instant when the string carries a date. */
  at?: number;
}

/**
 * Parses IB's goodAfterTime: "YYYYMMDD HH:MM:SS US/Eastern", "YYYYMMDD-HH:MM:SS" (UTC)
 * or a bare "HH:MM" (US/Eastern, as the order ticket sends it).
 */
export function parseGoodAfter(raw: string): GoodAfter | null {
  const s = raw.trim();
  if (!s) return null;
  const bare = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (bare) {
    const hhmm = `${two(Number(bare[1]))}:${bare[2]}`;
    return { label: `${hhmm} ET`, etTime: hhmm };
  }
  const full = /^(\d{4})(\d{2})(\d{2})([ -])(\d{2}):(\d{2})(?::(\d{2}))?(?:\s+(\S+))?$/.exec(s);
  if (!full) return { label: s };
  const [y, mo, d, h, mi, sec] = [full[1], full[2], full[3], full[5], full[6], full[7] ?? '0'].map(Number);
  const zone = full[8];
  const hhmm = `${full[5]}:${full[6]}`;
  if (full[4] === '-' && !zone) {
    const at = Date.UTC(y, mo - 1, d, h, mi, sec);
    const et = etHhmm(at);
    return { label: `${et} ET`, etTime: et, at };
  }
  if (!zone) return { label: hhmm };
  const isEt = ET_ZONES.has(zone);
  let at: number | undefined;
  try {
    at = wallTimeToUtc(y, mo, d, h, mi, sec, isEt ? 'America/New_York' : zone);
  } catch {
    at = undefined; // unknown zone name
  }
  if (isEt) return { label: `${hhmm} ET`, etTime: hhmm, at };
  return { label: `${hhmm} ${zone}`, etTime: at != null ? etHhmm(at) : undefined, at };
}

// ---------------------------------------------------------------------------
// Status column

export type StatusTone = 'ac' | 'mu';

export interface OrderStatusText {
  text: string;
  tone: StatusTone;
}

function trailText(o: WorkingOrder): string {
  if (o.orderType !== 'TRAIL' && o.orderType !== 'TRAIL LIMIT') return '';
  const pctValue = priceOrUndefined(o.trailingPercent);
  if (pctValue != null) return ` · ${+pctValue.toFixed(4)}%`;
  const amt = priceOrUndefined(o.auxPrice);
  return amt != null ? ` · $${px(amt)}` : '';
}

/**
 * Status text as in the design: a pending price condition reads "Waiting · AAPL ≥ 235.00",
 * a pending good-after time "After 09:35 ET · DAY", anything else "<status> · <TIF>" plus
 * trailing / iceberg details. The TIF carries a GTD expiry and a session other than regular
 * hours ("GTD 10/09 16:00 ET", "DAY · Overnight + Day"). IB warnings and hold reasons are appended.
 */
export function orderStatusText(o: WorkingOrder, m: OrdersMessages, now: number = Date.now()): OrderStatusText {
  const tif = timingText(o, m.sessions);
  const extra = (o.whyHeld ? ` · ${m.held}: ${o.whyHeld}` : '') + (o.message ? ` · ${o.message}` : '');
  if (o.status === 'PendingCancel') return { text: m.stCancelling + extra, tone: 'mu' };
  if (o.status === 'ApiPending' || o.status === 'PendingSubmit') return { text: `${m.stSubmitting} · ${tif}${extra}`, tone: 'mu' };

  // IB keeps conditional and good-after orders PreSubmitted until they are released.
  const released = o.status === 'Submitted' || o.filled > 0;
  if (o.condition && !released) {
    const op = o.condition.operator === '>=' ? '≥' : '≤';
    return { text: `${m.waiting} · ${o.condition.symbol} ${op} ${px(o.condition.price)}${extra}`, tone: 'ac' };
  }
  const gat = o.goodAfterTime ? parseGoodAfter(o.goodAfterTime) : null;
  if (gat && !released && (gat.at == null || gat.at > now)) {
    return { text: `${m.after} ${gat.label} · ${tif}${extra}`, tone: 'ac' };
  }
  const state = o.status === 'PreSubmitted' ? m.stPreSubmitted : o.status === 'Unknown' ? m.stUnknown : m.stWorking;
  const ice = o.displaySize ? ` · ${m.ice} ${f0(o.displaySize)}` : '';
  return { text: `${state} · ${tif}${trailText(o)}${ice}${extra}`, tone: 'mu' };
}

// ---------------------------------------------------------------------------
// Modify

const TICKET_TYPES: readonly OrderType[] = ['LMT', 'MKT', 'STP', 'STP LMT', 'TRAIL'];

/** IB's GTD expiry as the ticket's input value (New York time); null when unreadable. */
export function goodTillInput(goodTillDate: string | undefined): string | null {
  const at = parseIbDateTime(goodTillDate);
  return at == null ? null : toLocalInput(zonedParts(at, NEW_YORK));
}

/**
 * A working order's TIF, GTD expiry and trading session as ticket state: "Modify" starts from
 * them, since IB keeps the session and changes the TIF only as tifChangeAllowed says.
 */
export function ticketTimingFor(o: WorkingOrder): Pick<TicketState, 'tif' | 'goodTill' | 'session'> {
  const tif = isTimeInForce(o.tif) ? o.tif : 'DAY';
  // A GTD order whose expiry cannot be read gets the default one, shown in the ticket.
  return { tif, goodTill: tif === 'GTD' ? goodTillInput(o.goodTillDate) : null, session: sessionOf(o) };
}

/** Only stock orders can be edited in the order ticket. */
export function canModifyInTicket(o: WorkingOrder): boolean {
  return o.contract.secType === 'STK' && (TICKET_TYPES as readonly string[]).includes(o.orderType);
}

/**
 * Order ticket state that reproduces an existing order, so "Modify" resubmits it with edits:
 * including its time in force, GTD expiry and trading session.
 */
export function ticketPatchFor(o: WorkingOrder): Partial<TicketState> {
  const orderType = (TICKET_TYPES as readonly string[]).includes(o.orderType) ? (o.orderType as OrderType) : 'LMT';
  const timing = ticketTimingFor(o);
  const lmt = priceOrUndefined(o.limitPrice);
  const aux = priceOrUndefined(o.auxPrice);
  const trailPct = priceOrUndefined(o.trailingPercent);
  const gat = o.goodAfterTime ? parseGoodAfter(o.goodAfterTime) : null;
  const patch: Partial<TicketState> = {
    side: o.action,
    orderType,
    qty: o.totalQuantity,
    limitPrice: (orderType === 'LMT' || orderType === 'STP LMT') && lmt != null ? lmt : null,
    stopPrice: (orderType === 'STP' || orderType === 'STP LMT') && aux != null ? aux : null,
    ...timing,
    bracket: false,
    takeProfit: null,
    stopLoss: null,
    condition: !!o.condition,
    condOp: o.condition?.operator ?? '>=',
    condPx: o.condition ? String(o.condition.price) : null,
    condRth: o.condition?.outsideRth ?? false,
    iceberg: !!o.displaySize,
    iceQty: o.displaySize ? String(o.displaySize) : '100',
    goodAfter: !!gat?.etTime,
    goodAfterTime: gat?.etTime ?? '09:35',
    modifyingOrderId: o.orderId,
  };
  if (orderType === 'TRAIL') {
    patch.trailMode = trailPct != null ? 'pct' : 'amt';
    patch.trailAmt = String(trailPct ?? aux ?? 3);
  }
  patch.advancedOpen = !!(timing.session !== 'regular' || o.condition || o.displaySize || gat?.etTime);
  return patch;
}
