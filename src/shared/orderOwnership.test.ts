import { describe, expect, it } from 'vitest';
import { stock } from './contract';
import { cancelBlock, isSourceBlock, type CancelContext } from './orderOwnership';
import type { WorkingOrder } from './types';

const order = (patch: Partial<WorkingOrder> = {}): WorkingOrder => ({
  orderId: 3,
  permId: 186573947,
  clientId: 7,
  account: 'U18630011',
  key: 'AAPL',
  contract: stock('AAPL'),
  action: 'BUY',
  orderType: 'LMT',
  totalQuantity: 100,
  limitPrice: 158.11,
  tif: 'GTC',
  outsideRth: false,
  status: 'Submitted',
  filled: 0,
  remaining: 100,
  avgFillPrice: 0,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

/** Tape as client 7 on the live login. */
const tape: CancelContext = { status: 'connected', clientId: 7, accounts: ['U18630011'] };

describe('cancelBlock', () => {
  it('lets Tape cancel its own working order', () => {
    expect(cancelBlock(order(), tape)).toBeNull();
    expect(cancelBlock(order({ status: 'PreSubmitted' }), tape)).toBeNull();
    // An order without an account is the login's.
    expect(cancelBlock(order({ account: undefined }), tape)).toBeNull();
  });

  it('says why it cannot', () => {
    expect(cancelBlock(order(), { ...tape, status: 'reconnecting' })).toBe('notConnected');
    for (const status of ['Filled', 'Cancelled', 'ApiCancelled', 'Inactive'] as const) expect(cancelBlock(order({ status }), tape)).toBe('done');
    expect(cancelBlock(order({ notReported: true }), tape)).toBe('notReported');
    expect(cancelBlock(order({ status: 'PendingCancel' }), tape)).toBe('pendingCancel');
    expect(cancelBlock(order({ clientId: 12 }), tape)).toBe('otherClient');
    expect(cancelBlock(order(), { ...tape, accounts: ['DUP899854'] })).toBe('otherAccount');
  });

  it('treats orders placed in IBKR Mobile, TWS or the web as manual, whatever Tape’s client id', () => {
    // As the user's live GTC orders: order id 0, client 0.
    const mobile = order({ orderId: 0, clientId: 0, permId: 780760062 });
    expect(cancelBlock(mobile, tape)).toBe('manual');
    expect(cancelBlock(mobile, { ...tape, clientId: 0 })).toBe('manual');
    // A TWS order bound to client 0 (it has an order id): only client 0 cancels it.
    const bound = order({ orderId: 12, clientId: 0 });
    expect(cancelBlock(bound, tape)).toBe('manual');
    expect(cancelBlock(bound, { ...tape, clientId: 0 })).toBeNull();
  });

  it('names who placed an order only for the blocks the lists explain', () => {
    expect(['manual', 'otherClient', 'otherAccount'].every((b) => isSourceBlock(b as never))).toBe(true);
    expect(['notConnected', 'done', 'notReported', 'pendingCancel', null].some((b) => isSourceBlock(b as never))).toBe(false);
  });
});
