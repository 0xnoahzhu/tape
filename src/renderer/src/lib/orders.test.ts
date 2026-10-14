import { describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import type { CancelContext } from '@shared/orderOwnership';
import type { WorkingOrder } from '@shared/types';
import { cancelAllExpect, cancelAllOrders, cancelKey, isCancelPending, lastCancellableOrder, ofConnectedAccounts, orderRowAction, otherAppsOrders } from './orders';

/** The connected login's accounts. */
const ACCOUNTS = ['DU1'];
/** Tape connected as client 48 to the login with ACCOUNTS. */
const C48: CancelContext = { status: 'connected', clientId: 48, accounts: ACCOUNTS };

let t = 0;
function order(p: Partial<WorkingOrder> & Pick<WorkingOrder, 'orderId' | 'clientId'>): WorkingOrder {
  t += 1000;
  return {
    key: '',
    contract: stock('AAPL'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 1,
    limitPrice: 1,
    tif: 'DAY',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 1,
    avgFillPrice: 0,
    createdAt: t,
    updatedAt: t,
    ...p,
  };
}

describe('lastCancellableOrder', () => {
  it('picks the newest own working order', () => {
    const a = order({ orderId: 1, clientId: 48 });
    const b = order({ orderId: 2, clientId: 48 });
    expect(lastCancellableOrder([a, b], C48)).toBe(b);
  });

  it('skips orders of other clients, even when newer', () => {
    const own = order({ orderId: 1, clientId: 48 });
    const tws = order({ orderId: 1, clientId: 0, contract: stock('TSLA') });
    const manual = order({ orderId: 0, clientId: 0 });
    expect(lastCancellableOrder([own, tws, manual], C48)).toBe(own);
    expect(lastCancellableOrder([tws], C48)).toBeUndefined();
  });

  it('targets the bracket parent, not its take-profit / stop-loss', () => {
    const parent = order({ orderId: 2, clientId: 48 });
    const tp = order({ orderId: 3, clientId: 48, parentId: 2, action: 'SELL', limitPrice: 2 });
    const sl = order({ orderId: 4, clientId: 48, parentId: 2, action: 'SELL', orderType: 'STP', auxPrice: 0.5 });
    expect(lastCancellableOrder([parent, tp, sl], C48)).toBe(parent);
  });

  it('never takes the exits of a filled entry (the position’s protective stop)', () => {
    const older = order({ orderId: 1, clientId: 48 });
    const parent = order({ orderId: 2, clientId: 48, status: 'Filled', filled: 1 });
    const tp = order({ orderId: 3, clientId: 48, parentId: 2 });
    const sl = order({ orderId: 4, clientId: 48, parentId: 2, orderType: 'STP' });
    expect(lastCancellableOrder([older, parent, tp, sl], C48)).toBe(older);
    expect(lastCancellableOrder([parent, tp, sl], C48)).toBeUndefined();
  });

  it('never takes the exits of an entry that is not listed: it filled while Tape could not hear it', () => {
    const older = order({ orderId: 1, clientId: 48 });
    // IB lists the GTC exits of #2 without #2 (it filled offline, or on an earlier day).
    const tp = order({ orderId: 3, clientId: 48, parentId: 2 });
    const sl = order({ orderId: 4, clientId: 48, parentId: 2, orderType: 'STP' });
    expect(lastCancellableOrder([older, tp, sl], C48)).toBe(older);
    expect(lastCancellableOrder([tp, sl], C48)).toBeUndefined();
  });

  it('skips orders placed in other apps and orders whose cancel waits for IB, and nothing while disconnected', () => {
    const older = order({ orderId: 1, clientId: 48, permId: 501 });
    const newer = order({ orderId: 2, clientId: 48, permId: 502 });
    const mobile = order({ orderId: 0, clientId: 0, permId: 780760062 });
    expect(lastCancellableOrder([older, newer, mobile], C48, ['p:502'])).toBe(older);
    expect(lastCancellableOrder([older, newer], { ...C48, status: 'reconnecting' })).toBeUndefined();
  });

  it('skips orders already being cancelled and their children', () => {
    const older = order({ orderId: 1, clientId: 48 });
    const parent = order({ orderId: 2, clientId: 48, status: 'PendingCancel' });
    const child = order({ orderId: 3, clientId: 48, parentId: 2 });
    expect(lastCancellableOrder([older, parent, child], C48)).toBe(older);
    expect(lastCancellableOrder([parent, child], C48)).toBeUndefined();
  });

  it('ignores finished orders', () => {
    expect(lastCancellableOrder([order({ orderId: 1, clientId: 48, status: 'Cancelled' })], C48)).toBeUndefined();
  });

  it('skips an order of an account the login does not manage, even when newer', () => {
    const own = order({ orderId: 1, clientId: 48, account: 'DU1' });
    const leftover = order({ orderId: 3, clientId: 48, account: 'U1' });
    expect(lastCancellableOrder([own, leftover], C48)).toBe(own);
    expect(lastCancellableOrder([leftover], C48)).toBeUndefined();
  });
});

describe('orderRowAction', () => {
  it('offers Modify / Cancel for an order Tape can cancel, “Cancelling…” while its cancel waits', () => {
    const own = order({ orderId: 1, clientId: 48, permId: 501 });
    expect(orderRowAction(own, C48, [])).toEqual({ kind: 'actions' });
    expect(orderRowAction(own, C48, [cancelKey(own)])).toEqual({ kind: 'cancelling' });
    // Sent before IB named it by permId.
    expect(orderRowAction(own, C48, ['48:1'])).toEqual({ kind: 'cancelling' });
  });

  it('names who placed an order Tape cannot cancel, also while disconnected', () => {
    const mobile = order({ orderId: 0, clientId: 0, permId: 780760062 });
    const other = order({ orderId: 5, clientId: 12 });
    const leftover = order({ orderId: 6, clientId: 48, account: 'U1' });
    expect(orderRowAction(mobile, C48, [])).toEqual({ kind: 'source', block: 'manual' });
    expect(orderRowAction(other, C48, [])).toEqual({ kind: 'source', block: 'otherClient' });
    expect(orderRowAction(leftover, C48, [])).toEqual({ kind: 'source', block: 'otherAccount' });
    expect(orderRowAction(mobile, { ...C48, status: 'disconnected' }, [])).toEqual({ kind: 'source', block: 'manual' });
  });

  it('offers nothing for an order that is done, being cancelled by IB or not reported, or while disconnected', () => {
    for (const o of [order({ orderId: 1, clientId: 48, status: 'Filled' }), order({ orderId: 2, clientId: 48, status: 'PendingCancel' }), order({ orderId: 3, clientId: 48, notReported: true })]) {
      expect(orderRowAction(o, C48, [])).toEqual({ kind: 'none' });
    }
    expect(orderRowAction(order({ orderId: 4, clientId: 48 }), { ...C48, status: 'disconnected' }, [])).toEqual({ kind: 'none' });
  });
});

describe('cancel keys', () => {
  it('names a cancel by permId, else by client and order id', () => {
    expect(cancelKey({ orderId: 3, clientId: 7, permId: 186573947 })).toBe('p:186573947');
    expect(cancelKey({ orderId: 3, clientId: 7 })).toBe('7:3');
    expect(isCancelPending({ orderId: 3, clientId: 7, permId: 1 }, ['7:3'])).toBe(true);
    expect(isCancelPending({ orderId: 3, clientId: 7, permId: 1 }, [])).toBe(false);
  });
});

describe('Cancel all', () => {
  it('lists every active order of the login IB still reports, whichever app placed it, oldest first', () => {
    const own = order({ orderId: 1, clientId: 48, permId: 501, account: 'DU1' });
    const mobile = order({ orderId: 0, clientId: 0, permId: 780760062, account: 'DU1', tif: 'GTC' });
    const done = order({ orderId: 2, clientId: 48, permId: 502, status: 'Cancelled' });
    const gone = order({ orderId: 3, clientId: 48, permId: 503, notReported: true });
    const leftover = order({ orderId: 4, clientId: 48, permId: 504, account: 'U1' });
    const list = cancelAllOrders([mobile, leftover, gone, done, own], ACCOUNTS);
    expect(list).toEqual([own, mobile]);
    expect(otherAppsOrders([own, mobile, done], C48)).toEqual([mobile]);
    expect(cancelAllExpect(list, { account: 'DU1', session: 4 })).toEqual({ account: 'DU1', permIds: [501, 780760062], session: 4 });
    // Nothing to confirm without an order, the account, or an order's permId.
    expect(cancelAllExpect([], { account: 'DU1', session: 4 })).toBeNull();
    expect(cancelAllExpect(list, { account: undefined, session: 4 })).toBeNull();
    expect(cancelAllExpect([order({ orderId: 9, clientId: 48 })], { account: 'DU1', session: 4 })).toBeNull();
  });
});

describe('ofConnectedAccounts', () => {
  it('drops entries of accounts the login does not manage, keeping those without an account', () => {
    const paper = order({ orderId: 1, clientId: 48, account: 'DU1' });
    const sub = order({ orderId: 2, clientId: 48, account: 'DU2' });
    const live = order({ orderId: 0, clientId: 0, account: 'U1' });
    const unknown = order({ orderId: 4, clientId: 48 });
    // An advisor login manages several accounts: all of them stay.
    expect(ofConnectedAccounts([paper, sub, live, unknown], ['DU1', 'DU2'])).toEqual([paper, sub, unknown]);
    expect(ofConnectedAccounts([paper, live], [])).toEqual([]);
  });

  it('returns the same list when nothing is dropped', () => {
    const list = [order({ orderId: 1, clientId: 48, account: 'DU1' }), order({ orderId: 2, clientId: 48 })];
    expect(ofConnectedAccounts(list, ACCOUNTS)).toBe(list);
  });
});
