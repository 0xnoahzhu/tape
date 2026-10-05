// Pure helpers for the Orders page: which orders are listed and in what order, and how
// IB's order fields read in the type / price / status columns.

import { multiplierOf, stock } from '@shared/contract';
import { DASH, f0, px } from '@shared/format';
import { isOrderType, ORDER_TYPE_FIELDS, TRAILING_ORDER_TYPES } from '@shared/orderRules';
import { isTimeInForce, NEW_YORK, parseIbDateTime, sessionOf, timingText, zonedParts } from '@shared/orderTiming';
import { CLOCK_24H, type Clock } from '@shared/timeFormat';
import { isOrderActive, type Execution, type OrderType, type WorkingOrder } from '@shared/types';
import type { AdvancedSection, TicketState } from '../../state/store';
import { typedAlgoParams } from '../ticket/algo';
import { conditionRows, newCondition } from '../ticket/ticketConditions';
import { toLocalInput } from '../ticket/timing';
import { attributeFlags, conditionsShort } from './attributes';
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

/** Time column of the order and trade lists: "9:41:07 AM", "下午 2:35:07", "14:35:07". */
export function timeCell(t: number, clock: Clock): string {
  return clock.time(t, { seconds: true });
}

/** Cash amount of a fill: shares × price × multiplier. */
export function tradeAmount(e: Execution): number {
  return e.shares * e.price * multiplierOf(e.contract);
}

export function orderTypeLabel(type: string, m: OrdersMessages): string {
  return m.typeLabels[type] ?? type;
}

/**
 * Price column: limit or trigger price; both for stop-limit and limit-if-touched; the current stop
 * for trailing orders; the offset of relative, snap and pegged orders and the limit of midprice,
 * relative and pegged ones (a cap for a buy, ≤; a floor for a sell, ≥); "—" without a price.
 */
export function orderPriceText(o: WorkingOrder): string {
  const lmt = priceOrUndefined(o.limitPrice);
  const aux = priceOrUndefined(o.auxPrice);
  const cap = lmt != null && lmt > 0 ? `${o.action === 'SELL' ? '≥' : '≤'} ${px(lmt)}` : null;
  const offset = `±${o.percentOffset ? `${o.percentOffset}%` : px(aux ?? 0)}`;
  switch (o.orderType) {
    case 'MKT':
    case 'MOC':
    case 'MTL':
      return DASH;
    case 'SNAP MID':
    case 'SNAP MKT':
      return offset;
    case 'STP':
    case 'MIT':
      return px(aux);
    case 'STP LMT':
    case 'LIT':
      return aux != null && lmt != null ? `${px(aux)} / ${px(lmt)}` : px(lmt ?? aux);
    case 'MIDPRICE':
      return cap ?? DASH;
    case 'REL':
    case 'PEG MID':
      return cap ? `${offset} · ${cap}` : offset;
    default:
      if (o.orderType.startsWith('TRAIL')) return px(priceOrUndefined(o.trailStopPrice));
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
  /** Display text in the clock's format, e.g. "9:35 AM ET" / "09:35 ET". */
  label: string;
  /** "HH:MM" in US/Eastern when known (for the order ticket). */
  etTime?: string;
  /** Activation instant when the string carries a date. */
  at?: number;
}

/**
 * Parses IB's goodAfterTime: "YYYYMMDD HH:MM:SS US/Eastern", "YYYYMMDD-HH:MM:SS" (UTC)
 * or a bare "HH:MM" (US/Eastern, as the order ticket sends it). The label is in `clock`'s format.
 */
export function parseGoodAfter(raw: string, clock: Clock = CLOCK_24H): GoodAfter | null {
  const s = raw.trim();
  if (!s) return null;
  const bare = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (bare) {
    const hhmm = `${two(Number(bare[1]))}:${bare[2]}`;
    return { label: clock.wall(hhmm, { zone: 'ET' }), etTime: hhmm };
  }
  const full = /^(\d{4})(\d{2})(\d{2})([ -])(\d{2}):(\d{2})(?::(\d{2}))?(?:\s+(\S+))?$/.exec(s);
  if (!full) return { label: s };
  const [y, mo, d, h, mi, sec] = [full[1], full[2], full[3], full[5], full[6], full[7] ?? '0'].map(Number);
  const zone = full[8];
  const hhmm = `${full[5]}:${full[6]}`;
  if (full[4] === '-' && !zone) {
    const at = Date.UTC(y, mo - 1, d, h, mi, sec);
    const et = etHhmm(at);
    return { label: clock.wall(et, { zone: 'ET' }), etTime: et, at };
  }
  if (!zone) return { label: clock.wall(hhmm) };
  const isEt = ET_ZONES.has(zone);
  let at: number | undefined;
  try {
    at = wallTimeToUtc(y, mo, d, h, mi, sec, isEt ? 'America/New_York' : zone);
  } catch {
    at = undefined; // unknown zone name
  }
  if (isEt) return { label: clock.wall(hhmm, { zone: 'ET' }), etTime: hhmm, at };
  return { label: clock.wall(hhmm, { zone }), etTime: at != null ? etHhmm(at) : undefined, at };
}

// ---------------------------------------------------------------------------
// Status column

export type StatusTone = 'ac' | 'mu';

export interface OrderStatusText {
  text: string;
  tone: StatusTone;
}

function trailText(o: WorkingOrder): string {
  if (!o.orderType.startsWith('TRAIL')) return '';
  const pctValue = priceOrUndefined(o.trailingPercent);
  if (pctValue != null) return ` · ${+pctValue.toFixed(4)}%`;
  const amt = priceOrUndefined(o.auxPrice);
  return amt != null ? ` · $${px(amt)}` : '';
}

/**
 * Status text as in the design: a pending price condition reads "Waiting · AAPL ≥ 235.00",
 * a pending good-after time "After 9:35 AM ET · DAY", anything else "<status> · <TIF>" plus
 * trailing / iceberg details. The TIF carries a GTD expiry and a session other than regular
 * hours ("GTD 10/09 4:00 PM ET", "DAY · Overnight + Day"). IB warnings and hold reasons are
 * appended. Times are in `clock`'s format.
 */
export function orderStatusText(o: WorkingOrder, m: OrdersMessages, clock: Clock, now: number = Date.now()): OrderStatusText {
  const tif = timingText(o, m.sessions, clock);
  const extra = (o.whyHeld ? ` · ${m.held}: ${o.whyHeld}` : '') + (o.message ? ` · ${o.message}` : '');
  if (o.status === 'PendingCancel') return { text: m.stCancelling + extra, tone: 'mu' };
  if (o.status === 'ApiPending' || o.status === 'PendingSubmit') return { text: `${m.stSubmitting} · ${tif}${extra}`, tone: 'mu' };

  // IB keeps conditional and good-after orders PreSubmitted until they are released (an order
  // that conditions cancel works meanwhile).
  const released = o.status === 'Submitted' || o.filled > 0;
  if (o.conditions?.items.length && !o.conditions.cancel && !released) {
    return { text: `${m.waiting} · ${conditionsShort(o.conditions, m.attr, clock)}${extra}`, tone: 'ac' };
  }
  if (o.condition && !o.conditions && !released) {
    const op = o.condition.operator === '>=' ? '≥' : '≤';
    return { text: `${m.waiting} · ${o.condition.symbol} ${op} ${px(o.condition.price)}${extra}`, tone: 'ac' };
  }
  const gat = o.goodAfterTime ? parseGoodAfter(o.goodAfterTime, clock) : null;
  if (gat && !released && (gat.at == null || gat.at > now)) {
    return { text: `${m.after} ${gat.label} · ${tif}${extra}`, tone: 'ac' };
  }
  const state = o.status === 'PreSubmitted' ? m.stPreSubmitted : o.status === 'Unknown' ? m.stUnknown : m.stWorking;
  const ice = o.displaySize ? ` · ${m.ice} ${f0(o.displaySize)}` : '';
  const flags = attributeFlags(o, m.attr, clock).map((f) => ` · ${f}`).join('');
  return { text: `${state} · ${tif}${trailText(o)}${ice}${flags}${extra}`, tone: 'mu' };
}

// ---------------------------------------------------------------------------
// Modify

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

/**
 * Whether "Modify" can load the order into the ticket without changing it: an order type the
 * ticket offers, on a single instrument (combos are changed in the options desk). Other orders are
 * only cancelled.
 */
export function canModifyInTicket(o: WorkingOrder): boolean {
  // IB refuses API modifies of an order sized by cash amount (10241).
  return isOrderType(o.orderType) && o.contract.secType !== 'BAG' && o.cashQty == null;
}

const OFFSET_TYPES: readonly OrderType[] = ['REL', 'SNAP MID', 'SNAP MKT', 'PEG MID'];

/**
 * Order ticket state that reproduces an existing order, so "Modify" resubmits it with edits: its
 * prices, time in force, GTD expiry and session, and every attribute (IB replaces the whole order
 * on a modify, so one the ticket did not load would be switched off): fill attributes, trigger
 * method, algo, conditions, adjustable stop, OCA group, destination, note and good-after time.
 */
export function ticketPatchFromOrder(o: WorkingOrder): Partial<TicketState> {
  const orderType: OrderType = isOrderType(o.orderType) ? o.orderType : 'LMT';
  const f = ORDER_TYPE_FIELDS[orderType];
  const timing = ticketTimingFor(o);
  const lmt = priceOrUndefined(o.limitPrice);
  const aux = priceOrUndefined(o.auxPrice);
  const trailPct = priceOrUndefined(o.trailingPercent);
  const trailing = TRAILING_ORDER_TYPES.includes(orderType);
  const gat = o.goodAfterTime ? parseGoodAfter(o.goodAfterTime) : null;
  const iceberg = o.displaySize != null && o.displaySize > 0;
  // Orders mapped before every condition was read back carry only the first price condition.
  const legacy = !o.conditions?.items.length && o.condition ? o.condition : undefined;
  const conditions = !!o.conditions?.items.length || !!legacy;
  const adj = o.adjustStop;
  const patch: Partial<TicketState> = {
    side: o.action,
    orderType,
    qty: o.totalQuantity,
    // IB reports 0 for a cap that is not set.
    limitPrice: f.limit !== 'none' && lmt != null && lmt > 0 ? lmt : null,
    // A trailing order keeps its current stop.
    stopPrice: f.stop !== 'none' ? (aux ?? null) : trailing ? (priceOrUndefined(o.trailStopPrice) ?? null) : null,
    limitOffset: f.limitOffset !== 'none' ? (o.limitOffset ?? null) : null,
    offset: OFFSET_TYPES.includes(orderType) ? (o.percentOffset ?? aux ?? 0) : null,
    offsetMode: orderType === 'REL' && o.percentOffset ? 'pct' : 'amt',
    ...timing,
    bracket: false,
    takeProfit: null,
    stopLoss: null,
    adjust: !!adj,
    adjTrigger: adj ? String(adj.trigger) : null,
    adjType: adj?.type ?? 'STP',
    adjStop: adj?.stopPrice != null ? String(adj.stopPrice) : null,
    adjLimit: adj?.limitPrice != null ? String(adj.limitPrice) : null,
    adjTrail: adj?.trailAmount != null ? String(adj.trailAmount) : '1',
    adjTrailUnit: adj?.trailUnit ?? 'percent',
    condition: conditions,
    conds: legacy ? [newCondition('price', { op: legacy.operator, value: String(legacy.price), contract: stock(legacy.symbol) })] : conditionRows(o.conditions),
    condCancel: !!o.conditions?.cancel,
    condRth: o.conditions?.outsideRth ?? o.condition?.outsideRth ?? false,
    iceberg,
    iceQty: iceberg ? String(o.displaySize) : '100',
    allOrNone: !!o.allOrNone,
    minQtyOn: !!o.minQty,
    minQty: o.minQty ? String(o.minQty) : '1',
    hidden: !!o.hidden,
    sweep: !!o.sweepToFill,
    disc: !!o.discretionaryAmt,
    discAmt: o.discretionaryAmt ? String(o.discretionaryAmt) : '0.05',
    cashQtyOn: !!o.cashQty && o.contract.secType === 'CASH',
    cashQty: o.cashQty ? String(o.cashQty) : '10000',
    triggerMethod: o.triggerMethod ?? 0,
    algo: o.algo?.strategy ?? null,
    algoParams: o.algo ? typedAlgoParams(o.algo) : {},
    oca: !!o.oca,
    ocaGroup: o.oca?.group ?? '',
    ocaType: o.oca?.type ?? 1,
    route: o.route ?? 'SMART',
    orderRef: o.orderRef ?? '',
    goodAfter: !!gat?.etTime,
    goodAfterTime: gat?.etTime ?? '09:35',
    modifyingOrderId: o.orderId,
  };
  if (trailing) {
    patch.trailMode = trailPct != null ? 'pct' : 'amt';
    patch.trailAmt = String(trailPct ?? aux ?? 3);
  }
  // The Advanced panel opens on the sections the order uses.
  const sections: AdvancedSection[] = [];
  if (adj) sections.push('exits');
  if (conditions) sections.push('conditions');
  if (o.allOrNone || o.minQty || o.hidden || o.sweepToFill || o.discretionaryAmt || iceberg || patch.cashQtyOn) sections.push('fill');
  if (o.triggerMethod) sections.push('trigger');
  if (o.algo) sections.push('algo');
  if (o.oca || o.route) sections.push('routing');
  if (gat?.etTime || o.orderRef) sections.push('other');
  patch.advSections = sections;
  patch.advancedOpen = timing.session !== 'regular' || sections.length > 0;
  return patch;
}
