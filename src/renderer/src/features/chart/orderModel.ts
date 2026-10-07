// Working-order presentation for the symbol activity panel (design: stOf / ordMap); "Modify"
// loads the order into the ticket as on Portfolio › Orders. Pure so it can be unit tested.

import { DASH, f0, px } from '@shared/format';
import { timingText } from '@shared/orderTiming';
import type { Clock } from '@shared/timeFormat';
import type { TradingSession, WorkingOrder } from '@shared/types';
import { attributeFlags, conditionsShort, type AttributeLabels } from '../orders/attributes';
import { orderPriceText as listPriceText, parseGoodAfter } from '../orders/model';

export interface StatusLabels {
  /** Price-conditioned order that has not triggered yet. */
  waiting: string;
  /** Good-after-time order that has not activated yet; receives the time with its zone as the clock writes it ("9:35 AM ET", "21:35 Asia/Shanghai"). */
  after: (time: string) => string;
  pending: string;
  cancelling: string;
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
}

/** States in which IB has accepted the order but it is not working at the exchange yet. */
function isEarly(o: WorkingOrder): boolean {
  return o.status === 'PreSubmitted' || o.status === 'PendingSubmit' || o.status === 'ApiPending';
}

/** Status text of a working order; its times (good-after, GTD expiry) are written in `clock`'s format. */
export function orderStatusText(o: WorkingOrder, L: StatusLabels, clock: Clock): OrderStatusText {
  if (o.status === 'PendingCancel') return { text: L.cancelling, accent: false };
  const early = isEarly(o);
  // TIF with its GTD expiry and any session other than regular hours, as on Portfolio › Orders.
  const tif = timingText(o, L.sessions, clock);
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

// Modify loads the order the same way from here and from Portfolio › Orders.
export { canModifyInTicket, ticketPatchFromOrder } from '../orders/model';
