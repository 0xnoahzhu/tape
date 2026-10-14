// Order selection shared by app-level commands, the order lists and Cancel all.

import { cancelBlock, isSourceBlock, type CancelContext, type SourceBlock } from '@shared/orderOwnership';
import { isOrderActive, type CancelAllExpect, type ConnectionState, type WorkingOrder } from '@shared/types';

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

/** The key of a cancel the renderer waits for (StoreState.pendingCancels): the permId, else client id + order id. */
export const cancelKey = (o: Pick<WorkingOrder, 'orderId' | 'clientId' | 'permId'>): string => (o.permId ? `p:${o.permId}` : `${o.clientId}:${o.orderId}`);

/** Whether a cancel of `o` sent from here still waits for IB (also when IB has named the order by permId since). */
export function isCancelPending(o: Pick<WorkingOrder, 'orderId' | 'clientId' | 'permId'>, pending: readonly string[]): boolean {
  return pending.length > 0 && (pending.includes(cancelKey(o)) || pending.includes(`${o.clientId}:${o.orderId}`));
}

/**
 * What an order row offers (Portfolio › Orders, the activity panel, a panel's strip): Modify /
 * Cancel for an order Tape can cancel; "Cancelling…" while a cancel sent from here waits for IB;
 * who placed one Tape cannot cancel, with a "Why?" (another app, another client, another account);
 * nothing for an order that is done, being cancelled by IB, not reported, or while disconnected.
 */
export type OrderRowAction = { kind: 'actions' } | { kind: 'cancelling' } | { kind: 'source'; block: SourceBlock } | { kind: 'none' };

export function orderRowAction(o: WorkingOrder, connection: CancelContext, pending: readonly string[]): OrderRowAction {
  // Who placed an order shows while disconnected too; nothing is offered then.
  const block = cancelBlock(o, { ...connection, status: 'connected' });
  if (isSourceBlock(block)) return { kind: 'source', block };
  if (block || connection.status !== 'connected') return { kind: 'none' };
  return isCancelPending(o, pending) ? { kind: 'cancelling' } : { kind: 'actions' };
}

/**
 * Target of "Cancel last order" (⌘⌫): the newest working order this API client can cancel
 * (shared/orderOwnership.ts → cancelBlock: not another app's or client's, not another account's,
 * not being cancelled), and not one whose cancel sent from here still waits. Bracket children are
 * skipped while their parent is active (cancelling the parent cancels them too), has filled, or is
 * not listed (it filled while Tape could not hear it, or on an earlier day: IB cancels the exits of
 * an entry that did not fill): a shortcut never takes the position's protective stop away; the
 * list's dialog warns about that.
 */
export function lastCancellableOrder(orders: WorkingOrder[], connection: CancelContext, pending: readonly string[] = []): WorkingOrder | undefined {
  const mine = ofConnectedAccounts(orders, connection.accounts);
  const own = mine.filter((o) => !cancelBlock(o, connection) && !isCancelPending(o, pending));
  const parentOf = (o: WorkingOrder) => mine.find((p) => p.clientId === o.clientId && p.orderId === o.parentId);
  return own
    .filter((o) => {
      if (!o.parentId) return true;
      const parent = parentOf(o);
      return !!parent && !isOrderActive(parent.status) && parent.filled === 0;
    })
    .sort((a, b) => b.createdAt - a.createdAt || b.orderId - a.orderId)[0];
}

/** Working orders of the login that only other apps or clients can cancel (⌘⌫ says so when nothing else is left). */
export function otherAppsOrders(orders: WorkingOrder[], connection: CancelContext): WorkingOrder[] {
  return ofConnectedAccounts(orders, connection.accounts).filter((o) => {
    const block = cancelBlock(o, connection);
    return block === 'manual' || block === 'otherClient';
  });
}

/**
 * What "Cancel all orders" lists and confirms: every active order of the login's accounts that IB
 * still reports, whichever app placed it (main checks the same set by permId before IB's global
 * cancel), oldest first.
 */
export function cancelAllOrders(orders: WorkingOrder[], accounts: readonly string[]): WorkingOrder[] {
  return ofConnectedAccounts(orders, accounts)
    .filter((o) => isOrderActive(o.status) && !o.notReported)
    .sort((a, b) => a.createdAt - b.createdAt || a.orderId - b.orderId);
}

/**
 * What Cancel all confirms for the orders it lists (`list`, see cancelAllOrders): the login's
 * account, every listed order's permId and the session. Null when there is nothing to confirm (no
 * order, no account yet, or an order IB has not given its permId: main could not check it).
 */
export function cancelAllExpect(list: WorkingOrder[], connection: Pick<ConnectionState, 'account' | 'session'>): CancelAllExpect | null {
  if (!list.length || !connection.account || list.some((o) => !o.permId)) return null;
  return { account: connection.account, permIds: list.map((o) => o.permId!), session: connection.session };
}
