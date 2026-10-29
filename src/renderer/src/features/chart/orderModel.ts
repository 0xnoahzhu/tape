// Working-order presentation for the symbol activity panel (design: stOf / ordMap) and the layout
// of its rows; "Modify" loads the order into the ticket as on Portfolio › Orders. Pure so it can be
// unit tested.

import { DASH, f0, px } from '@shared/format';
import { timingText } from '@shared/orderTiming';
import type { Clock } from '@shared/timeFormat';
import type { TradingSession, WorkingOrder } from '@shared/types';
import { attributeFlags, conditionsShort, type AttributeLabels } from '../orders/attributes';
import { orderPriceText as listPriceText, parseGoodAfter } from '../orders/model';

export interface StatusLabels {
  /** Price-conditioned order that has not triggered yet. */
  waiting: string;
  /** Good-after-time order that has not activated yet; receives the time with its zone as the clock writes it ("09:35 AM ET", "21:35 Asia/Shanghai"). */
  after: (time: string) => string;
  pending: string;
  cancelling: string;
  /** IB's list of open orders no longer has it (WorkingOrder.notReported). */
  notReported: string;
  /** TWS / IB Gateway keeps it without sending it to IB (ApiPending; main/ib/orders.ts › Held orders). */
  held: string;
  working: string;
  iceberg: string;
  filled: (n: string) => string;
  /** Trading session names for the TIF part ("DAY · Overnight + Day"). */
  sessions: Record<TradingSession, string>;
  /** Order attributes (AON, algo, OCA group, …). */
  attr: AttributeLabels;
}

export interface OrderStatusText {
  text: string;
  /** Accent color (scheduled / conditional orders), else muted. */
  accent: boolean;
  /** Red: an order TWS / IB Gateway holds. */
  warn?: boolean;
}

/** States in which IB has accepted the order but it is not working at the exchange yet. */
function isEarly(o: WorkingOrder): boolean {
  return o.status === 'PreSubmitted' || o.status === 'PendingSubmit' || o.status === 'ApiPending';
}

/** Status text of a working order; its times (good-after, GTD expiry) are written in `clock`'s format. */
export function orderStatusText(o: WorkingOrder, L: StatusLabels, clock: Clock): OrderStatusText {
  if (o.notReported) return { text: L.notReported, accent: false };
  if (o.status === 'PendingCancel') return { text: L.cancelling, accent: false };
  const early = isEarly(o);
  // TIF with its GTD expiry and any session other than regular hours, as on Portfolio › Orders.
  const tif = timingText(o, L.sessions, clock);
  if (o.status === 'ApiPending') return { text: `${L.held} · ${tif}`, accent: false, warn: true };
  if (o.conditions?.items.length && !o.conditions.cancel && early) {
    return { text: `${L.waiting} · ${conditionsShort(o.conditions, L.attr, clock)}`, accent: true };
  }
  if (o.condition && !o.conditions && early) {
    const op = o.condition.operator === '>=' ? '≥' : '≤';
    return { text: `${L.waiting} · ${o.condition.symbol} ${op} ${px(o.condition.price)}`, accent: true };
  }
  // Parsed as on Portfolio › Orders: IB's UTC form and other zones are read, not taken as ET.
  const gat = o.goodAfterTime ? parseGoodAfter(o.goodAfterTime, clock) : null;
  if (gat && early) return { text: `${L.after(gat.label)} · ${tif}`, accent: true };
  let text = `${early ? L.pending : L.working} · ${tif}`;
  if (o.orderType.startsWith('TRAIL') && o.trailingPercent != null) text += ` · ${o.trailingPercent}%`;
  if (o.displaySize != null && o.displaySize > 0) text += ` · ${L.iceberg} ${f0(o.displaySize)}`;
  for (const f of attributeFlags(o, L.attr, clock)) text += ` · ${f}`;
  if (o.filled > 0) text += ` · ${L.filled(`${f0(o.filled)}/${f0(o.totalQuantity)}`)}`;
  return { text, accent: false };
}

/** The price part of "qty @ price": the order's price, else its type ("MKT", "MOC"). */
export function orderPriceText(o: WorkingOrder): string {
  const p = listPriceText(o);
  return p === DASH ? o.orderType : p;
}

// ---------------------------------------------------------------------------
// Row layout

// Fixed widths of an order row (px): side, the least of "qty @ price" (room for "100 @ 226.50"),
// the least of Last ("12,345.67") and Modify / Cancel; its side padding and the gap between cells
// (SymbolActivityPanel).
const SIDE_W = 48;
const QTY_PRICE_W = 96;
const LAST_W = 72;
const ACTIONS_W = 110;
const ROW_PAD = 24;
const GAP = 12;
/** Least width the contract and the status keep between them beside the Last column (split 1.5 : 1.3). */
const TEXT_MIN_W = 200;

/**
 * Columns of an order row and of the names above it. The time column is sized for the clock format
 * (timeColumn). "qty @ price" grows little beyond its least width, as does Last; the rest goes to
 * contract and status (with its good-after and GTD times), which clip first in a narrow window.
 * Without the Last column the status gets the larger share; beside it the contract keeps room for an
 * option ("AAPL 10/16 230 Call") in a 1440px window.
 */
export function orderColumns(time: string, withLast: boolean): string {
  const qtyPrice = `minmax(${QTY_PRICE_W}px,0.5fr)`;
  return withLast
    ? `${time} ${SIDE_W}px minmax(0,1.5fr) ${qtyPrice} minmax(${LAST_W}px,0.6fr) minmax(0,1.3fr) ${ACTIONS_W}px`
    : `${time} ${SIDE_W}px minmax(0,1.2fr) ${qtyPrice} minmax(0,2fr) ${ACTIONS_W}px`;
}

/**
 * Whether a panel `width` px wide has room for the Last column: the fixed columns, "qty @ price", Last
 * and TEXT_MIN_W for contract and status together, with the gaps and the side padding. Narrower, the
 * last price is in the tooltip of "qty @ price".
 */
export function lastColumnFits(width: number, time: string): boolean {
  const fixed = parseFloat(time) + SIDE_W + QTY_PRICE_W + LAST_W + ACTIONS_W;
  return width >= 2 * ROW_PAD + fixed + TEXT_MIN_W + 6 * GAP;
}

// Modify loads the order the same way from here and from Portfolio › Orders.
export { canModifyInTicket, ticketPatchFromOrder } from '../orders/model';
