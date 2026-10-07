// The symbol activity panel's pure parts (SymbolActivityPanel.tsx): the order of its position rows
// and which open order flashes as new.

import { contractLabel } from '@shared/contract';
import type { ContractRef, Position, WorkingOrder } from '@shared/types';
import type { SentOrder } from '../../state/orderFeedback';

/** How long an order just placed from a floating panel flashes in the open orders. */
export const FRESH_MS = 15_000;

const isOption = (c: ContractRef) => c.secType === 'OPT' || c.secType === 'FOP';
const rank = (c: ContractRef) => (c.secType === 'STK' ? 0 : isOption(c) ? 1 : 2);

/**
 * Stock first, then the options by expiry, strike and right (calls first), then anything else by
 * label. Labels alone would sort by month name ("Dec" before "Oct").
 */
export function byInstrument(a: Position, b: Position): number {
  const ca = a.contract;
  const cb = b.contract;
  const ra = rank(ca);
  const rb = rank(cb);
  if (ra !== rb) return ra - rb;
  if (ra === 1) {
    const byOption =
      (ca.lastTradeDate ?? '').localeCompare(cb.lastTradeDate ?? '') || (ca.strike ?? 0) - (cb.strike ?? 0) || (ca.right === 'P' ? 1 : 0) - (cb.right === 'P' ? 1 : 0);
    if (byOption) return byOption;
  }
  return contractLabel(ca).localeCompare(contractLabel(cb));
}

/**
 * Whether `o` is the order a floating panel just placed (`sent`: its latest order,
 * state/orderFeedback.ts), accepted by IB less than FRESH_MS ago. A modify does not flash.
 */
export function isFreshOrder(o: WorkingOrder, sent: SentOrder | undefined, now: number): boolean {
  return (
    sent?.phase === 'sent' &&
    sent.kind === 'place' &&
    sent.orderId === o.orderId &&
    sent.clientId === o.clientId &&
    sent.acceptedAt != null &&
    now - sent.acceptedAt < FRESH_MS
  );
}
