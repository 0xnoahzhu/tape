import { beforeEach, describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import type { ConnectionState, Execution, OrderRequest, Position, WorkingOrder } from '@shared/types';
import { applyConnection } from './bridge';
import { useOrderFeedback } from './orderFeedback';
import { initialTicket, useStore } from './store';

const request: OrderRequest = { contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', quantity: 1, limitPrice: 1, tif: 'DAY', outsideRth: false };
const order = { orderId: 40, clientId: 7, key: '7:40', account: 'DUP899854', contract: stock('AAPL'), status: 'Submitted' } as WorkingOrder;
const fill = { execId: 'e1', orderId: 40, account: 'DUP899854', key: 'STK:AAPL', contract: stock('AAPL'), side: 'BUY', shares: 1, price: 1, time: 0 } as Execution;
const position = { account: 'DUP899854', key: 'STK:AAPL', contract: stock('AAPL'), quantity: 100, avgPrice: 1, multiplier: 1, updatedAt: 0 } as Position;

/** The paper session (0) with an order review, a cancel confirmation, a modify and a panel strip open. */
function paperSession(): ConnectionState {
  const connection: ConnectionState = { ...useStore.getState().connection, status: 'connected', port: 4002, session: 0, accounts: ['DUP899854'], account: 'DUP899854', isPaper: true };
  useStore.setState((s) => ({
    connection,
    orders: [order],
    executions: [fill],
    positions: [position],
    positionsLoaded: true,
    account: { account: 'DUP899854', currency: 'USD', netLiquidation: 1_000_000, updatedAt: 0 },
    pendingOrder: { request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', session: 0, isPaper: true },
    confirm: { title: 'Cancel order', rows: [], label: 'Cancel order', session: 0, run: () => undefined },
    cancelAll: { session: 0 },
    pendingCancels: ['7:40'],
    symbol: stock('AAPL'),
    ticket: { ...s.ticket, qty: 25, oca: true, ocaGroup: 'tp-sl', orderRef: 'loaded', modifyingOrderId: 40 },
    toast: null,
  }));
  useOrderFeedback.setState({
    sent: { ticket: { seq: 1, kind: 'place', phase: 'sent', summary: 'Buy 1 AAPL', side: 'BUY', quantity: 1, contractKey: 'STK:AAPL', positionBefore: 0, orderId: 40, clientId: 7, account: 'DUP899854' } },
  });
  return connection;
}

describe('a new connection session', () => {
  beforeEach(() => useStore.setState((s) => ({ settings: { ...s.settings, appearance: { ...s.settings.appearance, language: 'en' } } })));

  it('drops the previous account’s data and everything opened on it', () => {
    const paper = paperSession();
    // Tape moved to the live Gateway (4001): the account is unknown until it names it.
    applyConnection({ ...paper, status: 'connecting', port: 4001, session: 1, accounts: [], account: undefined, isPaper: false });
    const s = useStore.getState();
    expect(s).toMatchObject({ orders: [], executions: [], positions: [], positionsLoaded: false, account: null, pendingOrder: null, confirm: null, cancelAll: null, pendingCancels: [] });
    // The modify ends with a fresh ticket: nothing of the previous account's order carries over.
    expect({ ...s.ticket, conds: [] }).toEqual({ ...initialTicket(s.settings, s.symbol), conds: [] });
    expect(useOrderFeedback.getState().sent).toEqual({});
    // The review was never sent, and the user is told.
    expect(s.toast).toMatchObject({ tone: 'error', text: 'The connection switched to another account; the order was not sent' });
  });

  it('starts the ticket fresh on the same instrument: a side or size prepared on paper never reaches live', () => {
    const paper = paperSession();
    useStore.setState((s) => ({ ticket: { ...s.ticket, side: 'SELL', qty: 2_500, limitPrice: 158.11, orderRef: 'paper test', modifyingOrderId: null } }));
    applyConnection({ ...paper, port: 4001, session: 1, accounts: ['U18630011'], account: 'U18630011', isPaper: false });
    const s = useStore.getState();
    expect(s.symbol).toEqual(stock('AAPL'));
    expect({ ...s.ticket, conds: [] }).toEqual({ ...initialTicket(s.settings, s.symbol), conds: [] });
  });

  it('keeps a confirmation that is not bound to a session', () => {
    const paper = paperSession();
    const generic = { title: 'Delete watchlist', rows: [], label: 'Delete', run: () => undefined };
    useStore.setState({ confirm: generic, pendingOrder: null });
    applyConnection({ ...paper, session: 1, accounts: ['U18630011'], account: 'U18630011', isPaper: false });
    expect(useStore.getState().confirm).toBe(generic);
    // Nothing was under review: no toast.
    expect(useStore.getState().toast).toBeNull();
  });

  it('keeps everything across a plain reconnect (same session)', () => {
    const paper = paperSession();
    applyConnection({ ...paper, status: 'reconnecting', reconnectAttempt: 1 });
    applyConnection({ ...paper, status: 'connected' });
    const s = useStore.getState();
    expect(s.orders).toEqual([order]);
    expect(s.executions).toEqual([fill]);
    expect(s.positions).toEqual([position]);
    expect(s.positionsLoaded).toBe(true);
    expect(s.account).not.toBeNull();
    expect(s.pendingOrder).not.toBeNull();
    expect(s.confirm).not.toBeNull();
    expect(s.cancelAll).toEqual({ session: 0 });
    expect(s.pendingCancels).toEqual(['7:40']);
    expect(s.ticket.modifyingOrderId).toBe(40);
    expect(useOrderFeedback.getState().sent.ticket).toBeDefined();
    expect(s.toast).toBeNull();
  });
});
