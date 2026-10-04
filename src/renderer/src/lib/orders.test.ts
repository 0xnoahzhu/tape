import { describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import type { WorkingOrder } from '@shared/types';
import { lastCancellableOrder } from './orders';

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
    expect(lastCancellableOrder([a, b], 48)).toBe(b);
  });

  it('skips orders of other clients, even when newer', () => {
    const own = order({ orderId: 1, clientId: 48 });
    const tws = order({ orderId: 1, clientId: 0, contract: stock('TSLA') });
    const manual = order({ orderId: 0, clientId: 0 });
    expect(lastCancellableOrder([own, tws, manual], 48)).toBe(own);
    expect(lastCancellableOrder([tws], 48)).toBeUndefined();
  });

  it('targets the bracket parent, not its take-profit / stop-loss', () => {
    const parent = order({ orderId: 2, clientId: 48 });
    const tp = order({ orderId: 3, clientId: 48, parentId: 2, action: 'SELL', limitPrice: 2 });
    const sl = order({ orderId: 4, clientId: 48, parentId: 2, action: 'SELL', orderType: 'STP', auxPrice: 0.5 });
    expect(lastCancellableOrder([parent, tp, sl], 48)).toBe(parent);
  });

  it('treats children of a filled parent as standalone orders', () => {
    const parent = order({ orderId: 2, clientId: 48, status: 'Filled' });
    const tp = order({ orderId: 3, clientId: 48, parentId: 2 });
    const sl = order({ orderId: 4, clientId: 48, parentId: 2 });
    expect(lastCancellableOrder([parent, tp, sl], 48)).toBe(sl);
  });

  it('skips orders already being cancelled and their children', () => {
    const older = order({ orderId: 1, clientId: 48 });
    const parent = order({ orderId: 2, clientId: 48, status: 'PendingCancel' });
    const child = order({ orderId: 3, clientId: 48, parentId: 2 });
    expect(lastCancellableOrder([older, parent, child], 48)).toBe(older);
    expect(lastCancellableOrder([parent, child], 48)).toBeUndefined();
  });

  it('ignores finished orders', () => {
    expect(lastCancellableOrder([order({ orderId: 1, clientId: 48, status: 'Cancelled' })], 48)).toBeUndefined();
  });
});
