// Whether Tape can cancel an order, and if not why: one rule for the order lists, the panels'
// strips, "Cancel last order" (⌘⌫) and main's cancel(), which refuses what the lists do not offer.
//
// IB lets an API client cancel only the orders it placed (its client id; client 0 also the TWS
// orders bound to it). Orders placed in IBKR Mobile, TWS or the web that no API client has bound
// carry order id 0 and client id 0: no API client can cancel them one by one, only IB's global
// cancel (Cancel all orders) reaches them. An order id names a client's own order, so an order of
// another client, or of an account the login does not manage, is never cancelled by its id.

import { isOrderActive, type ConnectionState, type WorkingOrder } from './types';

/**
 * Why an order cannot be cancelled from Tape now:
 * - notConnected: not connected to TWS / IB Gateway;
 * - done: filled, cancelled or rejected;
 * - notReported: IB's open orders no longer list it (it ended meanwhile; WorkingOrder.notReported);
 * - manual: placed outside the API (IBKR Mobile, TWS, the web: order id 0), or bound to client 0
 *   while Tape is another client;
 * - otherClient: placed by another API client;
 * - otherAccount: of an account the connected login does not manage;
 * - pendingCancel: IB is cancelling it already.
 */
export type CancelBlock = 'notConnected' | 'done' | 'notReported' | 'manual' | 'otherClient' | 'otherAccount' | 'pendingCancel';

/** The connection fields the rule reads. */
export type CancelContext = Pick<ConnectionState, 'status' | 'clientId' | 'accounts'>;

/** Why Tape cannot cancel `o` now, or null when it can (see CancelBlock). */
export function cancelBlock(o: WorkingOrder, c: CancelContext): CancelBlock | null {
  if (c.status !== 'connected') return 'notConnected';
  if (!isOrderActive(o.status)) return 'done';
  if (o.notReported) return 'notReported';
  // Order id 0: never bound to an API client, so no client can name it.
  if (o.orderId === 0) return 'manual';
  if (o.clientId !== c.clientId) return o.clientId === 0 ? 'manual' : 'otherClient';
  if (o.account && !c.accounts.includes(o.account)) return 'otherAccount';
  if (o.status === 'PendingCancel') return 'pendingCancel';
  return null;
}

/** Blocks the lists explain ("Other app", "Client 12", "Other account" with a "Why?"): who placed the order or whose it is. */
export type SourceBlock = Extract<CancelBlock, 'manual' | 'otherClient' | 'otherAccount'>;

export const isSourceBlock = (b: CancelBlock | null): b is SourceBlock => b === 'manual' || b === 'otherClient' || b === 'otherAccount';
