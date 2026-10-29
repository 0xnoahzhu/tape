import { describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import type { Execution, Position, WorkingOrder } from '@shared/types';
import type { SentOrder } from '../../state/orderFeedback';
import { usePanelMessages } from './messages';
import { orderCommission, sentPosition, stripView } from './stripModel';

const m = usePanelMessages.now();
const side = (s: 'BUY' | 'SELL') => (s === 'BUY' ? 'Buy' : 'Sell');

const sent = (patch: Partial<SentOrder> = {}): SentOrder => ({
  seq: 1,
  kind: 'place',
  phase: 'sent',
  summary: 'Buy 100 AAPL · Limit 227.56 · DAY',
  side: 'BUY',
  quantity: 100,
  contractKey: 'STK:AAPL',
  positionBefore: 200,
  orderId: 1234,
  clientId: 7,
  ...patch,
});

const order = (patch: Partial<WorkingOrder> = {}): WorkingOrder => ({
  orderId: 1234,
  permId: 99,
  clientId: 7,
  key: '7:1234',
  contract: stock('AAPL'),
  action: 'BUY',
  orderType: 'LMT',
  totalQuantity: 100,
  limitPrice: 227.56,
  tif: 'DAY',
  outsideRth: false,
  status: 'Submitted',
  filled: 0,
  remaining: 100,
  avgFillPrice: 0,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

const exec = (shares: number, commission?: number): Execution => ({
  execId: `e${shares}`,
  orderId: 1234,
  permId: 99,
  key: 'STK:AAPL',
  contract: stock('AAPL'),
  side: 'BUY',
  shares,
  price: 227.55,
  time: 0,
  ...(commission != null ? { commission } : {}),
});

const live = (orders: WorkingOrder[], position = 200, executions: Execution[] = []) => ({ orders, executions, position });

describe('status strip', () => {
  it('says “Submitting…” until IB answers', () => {
    const v = stripView(sent({ phase: 'sending', orderId: undefined }), live([]), m, side);
    expect(v).toMatchObject({ tone: 'busy', head: 'Submitting…', short: 'Buy 100 · Submitting…' });
  });

  it('follows the order from submitted to partially filled to filled', () => {
    expect(stripView(sent(), live([]), m, side)).toMatchObject({ head: 'Submitted #1234', status: 'Sent' });
    expect(stripView(sent(), live([order({ status: 'PreSubmitted' })]), m, side)).toMatchObject({ status: 'Pre-submitted', working: { orderId: 1234 } });
    const working = stripView(sent(), live([order()]), m, side);
    expect(working).toMatchObject({ tone: 'working', status: 'Working', short: 'Buy 100 · Working' });
    // TWS / IB Gateway holds it: red, with its hint, and still cancellable.
    expect(stripView(sent(), live([order({ status: 'ApiPending' })]), m, side)).toMatchObject({ tone: 'held', status: m.held, error: m.heldHint, working: { orderId: 1234 } });

    const partial = stripView(sent(), live([order({ filled: 60, remaining: 40, avgFillPrice: 227.55 })], 260, [exec(60, 0.6)]), m, side);
    expect(partial).toMatchObject({ status: 'Partially filled', progress: { filled: 60, total: 100 }, short: 'Buy 100 · 60/100', lead: 'Buy 100', state: '60/100' });
    expect(partial.details).toEqual(['avg 227.55', 'position 200 → 260', 'commission $0.60']);
    expect(partial.working).toBeDefined();

    const filled = stripView(sent(), live([order({ status: 'Filled', filled: 100, remaining: 0, avgFillPrice: 227.55 })], 300, [exec(60, 0.6), exec(40, 0.4)]), m, side);
    expect(filled).toMatchObject({ tone: 'filled', status: 'Filled', progress: { filled: 100, total: 100 }, short: 'Buy 100 · Filled' });
    expect(filled.details).toEqual(['avg 227.55', 'position 200 → 300', 'commission $1.00']);
    expect(filled.working).toBeUndefined();
  });

  it('shows a cancel, and a modify as “Modified”', () => {
    expect(stripView(sent(), live([order({ status: 'Cancelled' })]), m, side)).toMatchObject({ tone: 'muted', status: 'Cancelled', short: 'Buy 100 · Cancelled' });
    expect(stripView(sent({ kind: 'modify' }), live([order()]), m, side).head).toBe('Modified #1234');
  });

  it('turns red with IB’s reason on a rejection, also a late one (Inactive)', () => {
    expect(stripView(sent({ phase: 'failed', error: 'Order rejected (201)' }), live([]), m, side)).toMatchObject({ tone: 'error', head: 'Rejected', error: 'Order rejected (201)' });
    expect(stripView(sent(), live([order({ status: 'Inactive', message: 'No trading permissions (201)' })]), m, side)).toMatchObject({
      tone: 'error',
      error: 'No trading permissions (201)',
      short: 'Buy 100 · Rejected',
    });
  });

  it('says an order the closing connection left unconfirmed is not confirmed, never rejected', () => {
    expect(stripView(sent({ phase: 'unconfirmed', error: 'IBKR may have it' }), live([]), m, side)).toMatchObject({ tone: 'error', head: 'Not confirmed', error: 'IBKR may have it', short: 'Buy 100 · Not confirmed' });
  });

  it('offers nothing for an order IB no longer lists', () => {
    const view = stripView(sent(), live([order({ notReported: true })]), m, side);
    expect(view).toMatchObject({ tone: 'muted', status: 'Not reported by IB', short: 'Buy 100 · Not reported by IB' });
    expect(view.working).toBeUndefined();
  });

  it('matches only this client’s order of that id', () => {
    expect(stripView(sent(), live([order({ clientId: 0 })]), m, side).status).toBe('Sent');
  });

  it('never adopts another account’s order with the same client and order id', () => {
    const paper = sent({ account: 'DUP899854' });
    const v = stripView(paper, live([order({ account: 'U18630011' })]), m, side);
    expect(v).toMatchObject({ status: 'Sent' });
    expect(v.working).toBeUndefined();
    expect(stripView(paper, live([order({ account: 'DUP899854' })]), m, side).working).toBeDefined();
  });

  it('compares positions only within the account the order went to', () => {
    const pos = (account: string, quantity: number) => ({ account, key: 'STK:AAPL', contract: stock('AAPL'), quantity, multiplier: 1, updatedAt: 0 }) as Position;
    const paper = sent({ account: 'DUP899854' });
    expect(sentPosition(paper, [pos('DUP899854', 300)], 'DUP899854')).toBe(300);
    // Live connected now: its 40 shares are not the paper account's; no change is shown.
    expect(sentPosition(paper, [pos('U18630011', 40)], 'U18630011')).toBe(200);
    expect(sentPosition(sent(), [pos('DUP899854', 300)], 'DUP899854')).toBe(300);
    expect(sentPosition(paper, [], 'DUP899854')).toBe(0);
  });

  it('adds commissions by permId (orderId when IB sent none)', () => {
    expect(orderCommission(order(), [exec(10, 0.5), { ...exec(20, 0.25), permId: 98 }])).toBe(0.5);
    expect(orderCommission(order({ permId: undefined }), [{ ...exec(10, 0.5), permId: undefined }])).toBe(0.5);
    expect(orderCommission(order(), [exec(10)])).toBeUndefined();
  });
});
