// Order selection shared by app-level commands.

import { isOrderActive, type WorkingOrder } from '@shared/types';

/**
 * Target of "Cancel last order" (⌘⌫): the newest working order this API client can cancel.
 * Orders of other clients are skipped (order ids are per client, so cancelling by id would hit
 * a different order), as are orders already being cancelled. Bracket children are skipped while
 * their parent is active: cancelling the parent cancels them too.
 */
export function lastCancellableOrder(orders: WorkingOrder[], clientId: number): WorkingOrder | undefined {
  const own = orders.filter((o) => o.clientId === clientId && o.orderId !== 0 && isOrderActive(o.status));
  const activeIds = new Set(own.map((o) => o.orderId));
  return own
    .filter((o) => o.status !== 'PendingCancel' && !(o.parentId && activeIds.has(o.parentId)))
    .sort((a, b) => b.createdAt - a.createdAt || b.orderId - a.orderId)[0];
}
