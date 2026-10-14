// Order selection shared by app-level commands.

import { isOrderActive, type WorkingOrder } from '@shared/types';

/**
 * The orders or fills of the connected login: one whose account is set and is not among
 * `accounts` (ConnectionState.accounts) belongs to another account. Main drops those when Tape
 * moves to another account or Gateway; this is the renderer's backstop wherever orders and fills
 * are listed or acted on. Every account of the login stays (an advisor login manages several).
 * Returns `items` itself when nothing is dropped.
 */
export function ofConnectedAccounts<T extends { account?: string }>(items: T[], accounts: readonly string[]): T[] {
  const mine = (x: T) => !x.account || accounts.includes(x.account);
  return items.every(mine) ? items : items.filter(mine);
}

/**
 * Target of "Cancel last order" (⌘⌫): the newest working order this API client can cancel.
 * Orders of other clients are skipped (order ids are per client, so cancelling by id would hit
 * a different order), as are orders of accounts the connected login does not manage, and orders
 * already being cancelled. Bracket children are skipped while their parent is active: cancelling
 * the parent cancels them too.
 */
export function lastCancellableOrder(orders: WorkingOrder[], clientId: number, accounts: readonly string[]): WorkingOrder | undefined {
  const own = ofConnectedAccounts(orders, accounts).filter((o) => o.clientId === clientId && o.orderId !== 0 && isOrderActive(o.status));
  const activeIds = new Set(own.map((o) => o.orderId));
  return own
    .filter((o) => o.status !== 'PendingCancel' && !(o.parentId && activeIds.has(o.parentId)))
    .sort((a, b) => b.createdAt - a.createdAt || b.orderId - a.orderId)[0];
}
