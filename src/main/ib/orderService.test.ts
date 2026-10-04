import type { Contract, IBApi, Order } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { NewNotification, TapeEvent } from '@shared/ipc';
import type { OrderRequest } from '@shared/types';
import type { IbConnection, IbListener, MainContext } from '../context';
import { CONNECTION_CHANGED_MESSAGE, createOrderService } from './orders';

const CLIENT_ID = 101;

/** A connection stub: tests emit IB callbacks; requests are recorded. */
function fakeIb() {
  const listeners = new Map<string, Set<IbListener>>();
  const ready = new Set<(api: IBApi) => void>();
  const closed = new Set<() => void>();
  const reqErrors = new Set<(e: { reqId: number; code: number; message: string }) => void>();
  const calls: Array<[string, ...unknown[]]> = [];
  const newApi = () =>
    new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (...args: unknown[]) => {
            calls.push([name, ...args]);
          },
      },
    ) as unknown as IBApi;
  let api = newApi();
  let connected = true;
  let clientId = CLIENT_ID;
  let orderId = 50;
  let reqId = 1000;
  const ib: IbConnection = {
    get api() {
      return connected ? api : null;
    },
    getState: () => ({ status: connected ? 'connected' : 'disconnected', host: 'h', port: 1, clientId, accounts: ['DU1'], account: 'DU1', isPaper: true, farms: {} }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    isConnected: () => connected,
    nextReqId: () => reqId++,
    nextOrderId: () => orderId++,
    on(event, l) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(l);
      return () => listeners.get(event)!.delete(l);
    },
    onReady: (l) => (ready.add(l), () => ready.delete(l)),
    onClosed: (l) => (closed.add(l), () => closed.delete(l)),
    onRequestError: (l) => (reqErrors.add(l), () => reqErrors.delete(l)),
  };
  return {
    ib,
    calls,
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => l(...args)),
    error: (reqId: number, code: number, message: string) => reqErrors.forEach((l) => l({ reqId, code, message })),
    ready: () => ready.forEach((l) => l(api)),
    setConnected: (v: boolean) => void (connected = v),
    setClientId: (v: number) => void (clientId = v),
    /** A new IBApi instance, as after a host / port / client id change. */
    replaceApi: () => void (api = newApi()),
  };
}

const ibAapl: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK' as never, exchange: 'SMART', currency: 'USD' };
const lmt = (orderId: number, clientId = CLIENT_ID, extra: Partial<Order> = {}): Order => ({
  orderId,
  clientId,
  permId: 9000 + orderId,
  action: 'BUY' as never,
  totalQuantity: 100,
  orderType: 'LMT' as never,
  lmtPrice: 226.95,
  tif: 'DAY' as never,
  ...extra,
});
const req: OrderRequest = { contract: { ...stock('AAPL'), conId: 265598 }, action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 226.95, tif: 'DAY', outsideRth: false };

function setup() {
  const f = fakeIb();
  const events: TapeEvent[] = [];
  const notices: NewNotification[] = [];
  let resolveContract = async (c: unknown) => ({ ...(c as object), conId: 265598 });
  const ctx = {
    emit: (e: TapeEvent) => events.push(e),
    notifier: { notify: (n: NewNotification) => (notices.push(n), n) },
    contracts: { resolve: (c: unknown) => resolveContract(c), getInfo: async () => null },
    account: { getPositions: () => [] },
    ib: f.ib,
  } as unknown as MainContext;
  const svc = createOrderService(ctx);
  /** Holds contract lookups until the returned function is called (resolves them all). */
  const holdLookups = () => {
    const held: Array<() => void> = [];
    resolveContract = (c: unknown) => new Promise((resolve) => held.push(() => resolve({ ...(c as object), conId: 265598 })));
    return () => held.splice(0).forEach((release) => release());
  };
  return { ...f, svc, notices, events, holdLookups };
}

/** Lets the deferred subscriptions and pending promises run. */
const tick = () => vi.advanceTimersByTimeAsync(0);

describe('OrderService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function loaded() {
    const t = setup();
    await tick();
    t.ready();
    expect(t.calls.map((c) => c[0])).toEqual(['reqAllOpenOrders', 'reqCompletedOrders', 'reqExecutions']);
    t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
    t.emit('openOrderEnd');
    t.emit('execDetailsEnd', 1000);
    t.calls.length = 0;
    return t;
  }

  it('places an order and resolves once IB acknowledges it', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await tick();
    expect(t.calls[0][0]).toBe('placeOrder');
    expect(t.calls[0][1]).toBe(50);
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'PreSubmitted' });
    t.emit('orderStatus', 50, 'Submitted', 0, 100, 0, 9050, 0, 0, CLIENT_ID, '');
    await expect(p).resolves.toEqual({ orderId: 50, childOrderIds: [] });
    expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL submitted']);
    await vi.advanceTimersByTimeAsync(200);
    const orders = t.events.filter((e) => e.type === 'orders').at(-1);
    expect(orders && orders.type === 'orders' && orders.orders.map((o) => [o.orderId, o.status])).toEqual([
      [50, 'Submitted'],
      [7, 'Submitted'],
    ]);
  });

  it('throws the IB message when the order is rejected', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await tick();
    t.error(50, 321, "Error validating request.-'bC' : cause - The API interface is currently in Read-Only mode.");
    await expect(p).rejects.toThrow('The API interface is currently in Read-Only mode. (321)');
    expect(t.notices.map((n) => [n.kind, n.title.en, n.body.en])).toEqual([['order', 'Buy 100 AAPL rejected', 'The API interface is currently in Read-Only mode. (321)']]);
  });

  it('ignores order warnings while waiting', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await tick();
    t.error(50, 399, 'Order Message: BUY 100 AAPL Warning: your order will not be placed at the exchange until 09:30');
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'PreSubmitted' });
    await expect(p).resolves.toMatchObject({ orderId: 50 });
  });

  it('resolves after 2 s without an answer', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toMatchObject({ orderId: 50 });
  });

  it('places brackets as one group', async () => {
    const t = await loaded();
    const p = t.svc.place({ ...req, bracket: { takeProfit: 233, stopLoss: 222 } });
    await tick();
    expect(t.calls.map((c) => [c[0], c[1], (c[3] as Order).transmit])).toEqual([
      ['placeOrder', 50, false],
      ['placeOrder', 51, false],
      ['placeOrder', 52, true],
    ]);
    for (const id of [50, 51, 52]) t.emit('orderStatus', id, 'PreSubmitted', 0, 100, 0, 9000 + id, 0, 0, CLIENT_ID, '');
    // statuses before openOrder are kept until the order itself arrives
    for (const id of [50, 51, 52]) t.emit('openOrder', id, ibAapl, lmt(id, CLIENT_ID, id > 50 ? { parentId: 50, action: 'SELL' as never } : {}), { status: 'PreSubmitted' });
    await expect(p).resolves.toEqual({ orderId: 50, childOrderIds: [51, 52] });
    // one notice for the group, not one per child
    expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL submitted']);
  });

  it('refuses orders when disconnected', async () => {
    const t = await loaded();
    t.setConnected(false);
    await expect(t.svc.place(req)).rejects.toThrow('Not connected');
    expect(t.calls).toEqual([]);
  });

  it('only modifies and cancels orders of this client', async () => {
    const t = await loaded();
    await expect(t.svc.modify(7, req)).rejects.toThrow('Order #7 belongs to client 0 (TWS): only client id 0 can modify it');
    await expect(t.svc.cancel(7)).rejects.toThrow('Order #7 belongs to client 0 (TWS): only client id 0 can cancel it; Cancel all cancels every order of the account');
    t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
    const m = t.svc.modify(40, { ...req, limitPrice: 225 });
    await tick();
    expect(t.calls[0][0]).toBe('placeOrder');
    expect(t.calls[0][1]).toBe(40);
    expect((t.calls[0][3] as Order).lmtPrice).toBe(225);
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { lmtPrice: 225 }), { status: 'Submitted' });
    await expect(m).resolves.toBeUndefined();

    const c = t.svc.cancel(40);
    expect(t.calls.at(-1)?.[0]).toBe('cancelOrder');
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
    await expect(c).resolves.toBeUndefined();
    expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL submitted', 'Buy 100 AAPL cancelled']);
  });

  it('names only its own order by an id that another client also uses', async () => {
    const t = await loaded();
    t.emit('openOrder', 40, ibAapl, lmt(40, 12), { status: 'Submitted' });
    // Only client 12 has #40: refused, nothing is sent.
    await expect(t.svc.cancel(40)).rejects.toThrow('Order #40 belongs to API client 12: only that client can cancel it');
    await expect(t.svc.modify(40, req)).rejects.toThrow('Order #40 belongs to API client 12');
    expect(t.calls).toEqual([]);

    // Once this client has its own #40, the id means that order.
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { permId: 7040 }), { status: 'Submitted' });
    const c = t.svc.cancel(40);
    expect(t.calls).toEqual([['cancelOrder', 40]]);
    // Client 12's order with the same id does not settle the wait.
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, 12, '');
    let settled = false;
    void c.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 7040, 0, 0, CLIENT_ID, '');
    await expect(c).resolves.toBeUndefined();
    expect(t.svc.getOrders().map((o) => [o.clientId, o.orderId, o.status])).toEqual(
      expect.arrayContaining([
        [12, 40, 'Cancelled'],
        [CLIENT_ID, 40, 'Cancelled'],
        [0, 7, 'Submitted'],
      ]),
    );
  });

  describe('when the connection changes while the contract is looked up', () => {
    const unresolved: OrderRequest = { ...req, contract: stock('AAPL'), limitPrice: 225 };

    it('does not send a modify under another client id', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      const release = t.holdLookups();
      const m = t.svc.modify(40, unresolved);
      await tick();
      t.setClientId(102); // reconnected as another client: #40 would be its order, or a new one
      release();
      await expect(m).rejects.toThrow(CONNECTION_CHANGED_MESSAGE);
      expect(t.calls).toEqual([]);
    });

    it('does not send a modify on another instance (other Gateway)', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      const release = t.holdLookups();
      const m = t.svc.modify(40, unresolved);
      await tick();
      t.replaceApi();
      release();
      await expect(m).rejects.toThrow(CONNECTION_CHANGED_MESSAGE);
      expect(t.calls).toEqual([]);
    });

    it('does not modify an order that was filled meanwhile', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      const release = t.holdLookups();
      const m = t.svc.modify(40, unresolved);
      await tick();
      t.emit('orderStatus', 40, 'Filled', 100, 0, 226.95, 9040, 0, 226.95, CLIENT_ID, '');
      release();
      await expect(m).rejects.toThrow('Order #40 is Filled and can no longer be modified');
      expect(t.calls).toEqual([]);
    });

    it('does not place an order on another session', async () => {
      const t = await loaded();
      const release = t.holdLookups();
      const p = t.svc.place(unresolved);
      await tick();
      t.replaceApi();
      t.setClientId(102);
      release();
      await expect(p).rejects.toThrow(CONNECTION_CHANGED_MESSAGE);
      expect(t.calls).toEqual([]);
    });

    it('sends once the lookup is done when nothing changed', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      const release = t.holdLookups();
      const m = t.svc.modify(40, unresolved);
      await tick();
      release();
      await tick();
      expect(t.calls.map((c) => [c[0], c[1], (c[3] as Order).lmtPrice])).toEqual([['placeOrder', 40, 225]]);
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { lmtPrice: 225 }), { status: 'Submitted' });
      await expect(m).resolves.toBeUndefined();
    });
  });

  it('refuses unknown order ids and id 0 without sending anything', async () => {
    const t = await loaded();
    await expect(t.svc.cancel(99)).rejects.toThrow('Order #99 was not found');
    await expect(t.svc.modify(99, req)).rejects.toThrow('Order #99 was not found');
    await expect(t.svc.cancel(0)).rejects.toThrow('Order #0 cannot be cancelled from Tape');
    await expect(t.svc.cancel(1.5)).rejects.toThrow('cannot be cancelled');
    expect(t.calls).toEqual([]);
  });

  it('cancels an order it sent before IB reported it back', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await vi.advanceTimersByTimeAsync(2_000); // no answer: place resolves anyway
    await expect(p).resolves.toMatchObject({ orderId: 50 });
    await expect(t.svc.modify(50, req)).rejects.toThrow('Order #50 has not been confirmed by IB yet');
    const c = t.svc.cancel(50);
    expect(t.calls.at(-1)).toEqual(['cancelOrder', 50]);
    // The status is held until the order itself arrives.
    t.emit('orderStatus', 50, 'Cancelled', 0, 100, 0, 9050, 0, 0, CLIENT_ID, '');
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'Cancelled' });
    await expect(c).resolves.toBeUndefined();
    expect(t.svc.getOrders().find((o) => o.orderId === 50)?.status).toBe('Cancelled');
  });

  it('treats orders of a previous client id as another client', async () => {
    const t = await loaded();
    t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
    t.setClientId(102);
    await expect(t.svc.cancel(40)).rejects.toThrow(`Order #40 belongs to API client ${CLIENT_ID}`);
    expect(t.calls).toEqual([]);
  });

  it('announces live fills with their commission, not the initial load', async () => {
    const t = setup();
    await tick();
    t.ready();
    const exec = (id: string, shares = 100) => ({ execId: id, orderId: 50, permId: 9050, acctNumber: 'DU1', side: 'BOT', shares, price: 226.95, avgPrice: 226.95, time: '20261004 10:31:44 US/Eastern' });
    t.emit('execDetails', 1000, ibAapl, exec('e.01.01'));
    t.emit('execDetailsEnd', 1000);
    t.emit('openOrderEnd');
    t.emit('execDetails', -1, ibAapl, exec('e.02.01', 40));
    t.emit('commissionReport', { execId: 'e.02.01', commission: 1, currency: 'USD', realizedPNL: 1.7976931348623157e308 });
    expect(t.notices.map((n) => [n.kind, n.title.en, n.body.en])).toEqual([['fill', 'AAPL: bought 40 shares', 'Avg 226.95 · Commission 1.00 · Order #50']]);
    expect(t.notices[0].contract?.symbol).toBe('AAPL');
    // without a commission report the fill is announced after 3 s
    t.emit('execDetails', -1, ibAapl, exec('e.03.01', 60));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.notices.at(-1)?.body.en).toBe('Avg 226.95 · Commission — · Order #50');
    // a correction replaces the original execution
    t.emit('execDetails', -1, ibAapl, { ...exec('e.03.02', 60), price: 226.9 });
    expect(t.svc.getExecutions().map((e) => [e.execId, e.shares, e.price, e.commission])).toEqual([
      ['e.01.01', 100, 226.95, undefined],
      ['e.02.01', 40, 226.95, 1],
      ['e.03.02', 60, 226.9, undefined],
    ]);
    expect(t.notices).toHaveLength(2);
  });

  it('keeps completed orders without announcing them', async () => {
    const t = await loaded();
    t.emit('completedOrder', ibAapl, { ...lmt(0, 0), orderId: 0, permId: 777, filledQuantity: 0 }, { status: 'Cancelled', completedStatus: 'Cancelled by Trader', completedTime: '20261004 10:00:00 US/Eastern' });
    expect(t.notices).toEqual([]);
    const o = t.svc.getOrders().find((x) => x.permId === 777);
    expect(o).toMatchObject({ status: 'Cancelled', message: 'Cancelled by Trader', createdAt: Date.UTC(2026, 9, 4, 14, 0, 0) });
  });

  it('looks up the symbol of a price condition', async () => {
    const t = await loaded();
    const order = lmt(41, CLIENT_ID, {
      conditions: [{ type: 1, conjunctionConnection: 'a', isMore: true, price: 500, conId: 756733, exchange: 'SMART', triggerMethod: 0 } as never],
    });
    t.emit('openOrder', 41, ibAapl, order, { status: 'PreSubmitted' });
    expect(t.svc.getOrders().find((o) => o.orderId === 41)?.condition).toEqual({ symbol: '756733', operator: '>=', price: 500, outsideRth: false });
    const lookup = t.calls.find((c) => c[0] === 'reqContractDetails');
    expect(lookup?.[2]).toEqual({ conId: 756733 });
    t.emit('contractDetails', lookup?.[1], { contract: { conId: 756733, symbol: 'SPY' } });
    expect(t.svc.getOrders().find((o) => o.orderId === 41)?.condition?.symbol).toBe('SPY');
  });
});
