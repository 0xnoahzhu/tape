// What a floating panel's status strip and collapsed bar show about the latest order sent from it:
// "Submitting…", then IB's live status (pre-submitted / working → partially filled with progress →
// filled with the average price, the position change and the commission; cancelled), or the
// rejection with IB's reason. Pure: the order, executions and position come in as arguments.

import { contractKey } from '@shared/contract';
import { f0, MINUS, px, usd } from '@shared/format';
import type { Execution, Position, WorkingOrder } from '@shared/types';
import type { SentOrder } from '../../state/orderFeedback';
import type { PanelMessages } from './messages';

/** held: TWS / IB Gateway keeps the order without sending it to IB (ApiPending): red, with Cancel. */
export type StripTone = 'busy' | 'working' | 'filled' | 'muted' | 'error' | 'held';

export interface StripView {
  tone: StripTone;
  /** "Submitted #1234", "Modified #1234", "Submitting…", "Rejected". */
  head: string;
  /** IB's status in words ("Working", "Partially filled", "Filled", "Cancelled"). */
  status?: string;
  /** Filled of total while (partly) filled. */
  progress?: { filled: number; total: number };
  /** Average price, position change, commission. */
  details: string[];
  /** IB's reason for a rejection. */
  error?: string;
  /** The working order (inline Modify / Cancel), while it can still change. */
  working?: WorkingOrder;
  /** One line for the bar: "Buy 100 · 60/100", "Buy 100 · Filled" (`lead` · `state`). */
  short: string;
  /** The bar's side and quantity ("Buy 100"; drawn in the side's colour). */
  lead: string;
  /** The bar's status ("60/100", "Filled"; drawn in the tone's colour). */
  state: string;
}

const signedQty = (n: number) => (n < 0 ? MINUS : '') + f0(Math.abs(n));

/**
 * The order IB reports for the sent one (this client's id, the account it went to), if it has
 * reported it. Another account's order with the same client and order id is never adopted.
 */
export function sentWorkingOrder(sent: SentOrder, orders: readonly WorkingOrder[]): WorkingOrder | undefined {
  if (sent.orderId == null) return undefined;
  return orders.find(
    (o) =>
      o.orderId === sent.orderId &&
      (sent.clientId == null || o.clientId === sent.clientId) &&
      (sent.account == null || o.account == null || o.account === sent.account),
  );
}

/**
 * The position the strip compares with the one before the order ("200 → 300"): the instrument's
 * in the account the order went to. While another account is connected (`account`) that position
 * is not known, and the one before is returned (no change is shown).
 */
export function sentPosition(sent: SentOrder, positions: readonly Position[], account: string | undefined): number {
  if (sent.account != null && account !== sent.account) return sent.positionBefore;
  return positions.find((p) => contractKey(p.contract) === sent.contractKey && (sent.account == null || !p.account || p.account === sent.account))?.quantity ?? 0;
}

/** Commission of the order's executions so far (undefined until IB has reported one). */
export function orderCommission(order: WorkingOrder, executions: readonly Execution[]): number | undefined {
  const mine = executions.filter((x) => (order.permId != null && x.permId != null ? x.permId === order.permId : x.orderId === order.orderId));
  const paid = mine.filter((x) => x.commission != null);
  return paid.length ? paid.reduce((sum, x) => sum + x.commission!, 0) : undefined;
}

export function stripView(
  sent: SentOrder,
  live: { orders: readonly WorkingOrder[]; executions: readonly Execution[]; position: number },
  m: PanelMessages,
  sideText: (side: SentOrder['side']) => string,
): StripView {
  const lead = `${sideText(sent.side)} ${f0(sent.quantity)}`;
  const line = (state: string) => ({ short: `${lead} · ${state}`, lead, state });
  if (sent.phase === 'sending') return { tone: 'busy', head: m.submitting, details: [], ...line(m.submitting) };
  if (sent.phase === 'failed') return { tone: 'error', head: m.rejected, details: [], error: sent.error, ...line(m.rejected) };
  // The connection closed after the order was written: IB may have it, so it is not "rejected".
  if (sent.phase === 'unconfirmed') return { tone: 'error', head: m.unconfirmed, details: [], error: sent.error, ...line(m.unconfirmed) };

  const head = sent.kind === 'modify' ? m.modified(sent.orderId!) : m.submitted(sent.orderId!);
  const o = sentWorkingOrder(sent, live.orders);
  if (!o) return { tone: 'working', head, status: m.sent, details: [], ...line(m.sent) };
  const total = o.totalQuantity || sent.quantity;
  const filled = Math.min(o.filled, total);
  const fills = filled > 0 ? [m.avg(px(o.avgFillPrice))] : [];
  const commission = filled > 0 ? orderCommission(o, live.executions) : undefined;
  const position = filled > 0 && live.position !== sent.positionBefore ? [m.positionChange(signedQty(sent.positionBefore), signedQty(live.position))] : [];
  const paid = commission != null ? [m.commission(usd(commission))] : [];

  // IB's list of open orders no longer has it: how it ended follows (no Modify / Cancel meanwhile).
  if (o.notReported) return { tone: 'muted', head, status: m.notReported, details: [...fills, ...position, ...paid], ...line(m.notReported) };
  switch (o.status) {
    case 'ApiPending':
      return { tone: 'held', head, status: m.held, details: [], error: m.heldHint, working: o, ...line(m.held) };
    case 'Inactive':
      return { tone: 'error', head: m.rejected, details: [], error: o.message, ...line(m.rejected) };
    case 'Filled':
      return { tone: 'filled', head, status: m.filled, progress: { filled: total, total }, details: [...fills, ...position, ...paid], ...line(m.filled) };
    case 'Cancelled':
    case 'ApiCancelled':
      return {
        tone: 'muted',
        head,
        status: m.cancelled,
        ...(filled > 0 ? { progress: { filled, total } } : {}),
        details: [...fills, ...position, ...paid],
        ...line(m.cancelled),
      };
    default: {
      if (filled > 0)
        return {
          tone: 'working',
          head,
          status: m.partial,
          progress: { filled, total },
          details: [...fills, ...position, ...paid],
          working: o,
          ...line(`${f0(filled)}/${f0(total)}`),
        };
      const status = o.status === 'PreSubmitted' ? m.preSubmitted : m.working;
      return { tone: 'working', head, status, details: [], working: o, ...line(status) };
    }
  }
}
