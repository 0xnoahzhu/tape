// Working-order presentation for the symbol activity panel (design: stOf / ordMap)
// and the ticket patch used by "Modify". Pure so it can be unit tested.

import { f0, px } from '@shared/format';
import type { OrderType, TimeInForce, WorkingOrder } from '@shared/types';
import type { TicketState } from '../../state/store';

export interface StatusLabels {
  /** Price-conditioned order that has not triggered yet. */
  waiting: string;
  /** Good-after-time order that has not activated yet; receives "09:35". */
  after: (hhmm: string) => string;
  pending: string;
  cancelling: string;
  working: string;
  iceberg: string;
  filled: (n: string) => string;
}

export interface OrderStatusText {
  text: string;
  /** Accent color (scheduled / conditional orders), else muted. */
  accent: boolean;
}

const ORDER_TYPES: readonly OrderType[] = ['LMT', 'MKT', 'STP', 'STP LMT', 'TRAIL'];
const TIFS: readonly TimeInForce[] = ['DAY', 'GTC', 'IOC', 'OPG'];

/** States in which IB has accepted the order but it is not working at the exchange yet. */
function isEarly(o: WorkingOrder): boolean {
  return o.status === 'PreSubmitted' || o.status === 'PendingSubmit' || o.status === 'ApiPending';
}

/** "20261003 09:35:00 US/Eastern" or "09:35" -> "09:35". */
export function goodAfterHhmm(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
}

export function orderStatusText(o: WorkingOrder, L: StatusLabels): OrderStatusText {
  if (o.status === 'PendingCancel') return { text: L.cancelling, accent: false };
  const early = isEarly(o);
  if (o.condition && early) {
    const op = o.condition.operator === '>=' ? '≥' : '≤';
    return { text: `${L.waiting} · ${o.condition.symbol} ${op} ${px(o.condition.price)}`, accent: true };
  }
  const gat = goodAfterHhmm(o.goodAfterTime);
  if (gat && early) return { text: `${L.after(gat)} · ${o.tif}`, accent: true };
  let text = `${early ? L.pending : L.working} · ${o.tif}`;
  if (o.orderType === 'TRAIL' && o.trailingPercent != null) text += ` · ${o.trailingPercent}%`;
  if (o.displaySize != null && o.displaySize > 0) text += ` · ${L.iceberg} ${f0(o.displaySize)}`;
  if (o.filled > 0) text += ` · ${L.filled(`${f0(o.filled)}/${f0(o.totalQuantity)}`)}`;
  return { text, accent: false };
}

/** The price part of "qty @ price". */
export function orderPriceText(o: WorkingOrder): string {
  switch (o.orderType) {
    case 'MKT':
      return 'MKT';
    case 'STP':
      return px(o.auxPrice);
    case 'TRAIL':
      return o.trailStopPrice != null ? px(o.trailStopPrice) : 'TRAIL';
    default:
      if (o.limitPrice != null) return px(o.limitPrice);
      if (o.auxPrice != null) return px(o.auxPrice);
      return o.orderType;
  }
}

/**
 * Whether "Modify" can load the order into the ticket without changing it: the ticket's
 * order types on a single instrument (not a combo). Other orders are only cancelled.
 */
export function canModifyInTicket(o: WorkingOrder): boolean {
  return (ORDER_TYPES as readonly string[]).includes(o.orderType) && o.contract.secType !== 'BAG';
}

/** Loads a working order into the order ticket so submitting modifies it. */
export function ticketPatchFromOrder(o: WorkingOrder): Partial<TicketState> {
  const orderType = (ORDER_TYPES as readonly string[]).includes(o.orderType) ? (o.orderType as OrderType) : 'LMT';
  const tif = (TIFS as readonly string[]).includes(o.tif) ? (o.tif as TimeInForce) : 'DAY';
  const hasStop = orderType === 'STP' || orderType === 'STP LMT';
  const gat = goodAfterHhmm(o.goodAfterTime);
  const iceberg = o.displaySize != null && o.displaySize > 0;
  const patch: Partial<TicketState> = {
    side: o.action,
    qty: o.totalQuantity,
    orderType,
    limitPrice: orderType === 'LMT' || orderType === 'STP LMT' ? (o.limitPrice ?? null) : null,
    stopPrice: hasStop ? (o.auxPrice ?? null) : null,
    tif,
    outsideRth: o.outsideRth,
    bracket: false,
    takeProfit: null,
    stopLoss: null,
    condition: !!o.condition,
    condOp: o.condition?.operator ?? '>=',
    condPx: o.condition ? String(o.condition.price) : null,
    condRth: o.condition?.outsideRth ?? false,
    iceberg,
    iceQty: iceberg ? String(o.displaySize) : '100',
    goodAfter: !!gat,
    goodAfterTime: gat ?? '09:35',
    advancedOpen: !!o.condition || iceberg || !!gat || o.outsideRth,
    modifyingOrderId: o.orderId,
  };
  if (orderType === 'TRAIL') {
    if (o.trailingPercent != null) Object.assign(patch, { trailMode: 'pct', trailAmt: String(o.trailingPercent) });
    else if (o.auxPrice != null) Object.assign(patch, { trailMode: 'amt', trailAmt: String(o.auxPrice) });
  }
  return patch;
}
