import type { Contract, IBApi, Order } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { NewNotification, TapeEvent } from '@shared/ipc';
import type { OrderRequest } from '@shared/types';
import type { IbConnection, IbListener, MainContext } from '../context';
import { CONNECTION_CHANGED_MESSAGE, createOrderService, sameGoodAfter } from './orders';

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
  let info: object | null = null;
  const lock = { locked: false };
  const ctx = {
    lock: { isLocked: () => lock.locked },
    emit: (e: TapeEvent) => events.push(e),
    notifier: { notify: (n: NewNotification) => (notices.push(n), n) },
    contracts: { resolve: (c: unknown) => resolveContract(c), getInfo: async (c: { symbol?: string }) => (info ? { contract: c, ...info } : null) },
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
  /** ContractInfo fields getInfo returns from now on (order types, valid exchanges). */
  const setInfo = (i: object | null) => void (info = i);
  return { ...f, svc, notices, events, holdLookups, lock, setInfo };
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

  it('sends nothing while Tape is locked', async () => {
    const t = await loaded();
    t.lock.locked = true;
    await expect(t.svc.place(req)).rejects.toThrow('Tape is locked');
    await expect(t.svc.modify(7, req)).rejects.toThrow('Tape is locked');
    await expect(t.svc.cancel(7)).rejects.toThrow('Tape is locked');
    await expect(t.svc.cancelAll()).rejects.toThrow('Tape is locked');
    expect(t.calls).toEqual([]);
  });

  it('does not send an order when Tape locks while its contract is being resolved', async () => {
    const t = await loaded();
    const release = t.holdLookups();
    const p = t.svc.place({ ...req, contract: stock('AAPL') });
    await tick();
    t.lock.locked = true;
    release();
    await expect(p).rejects.toThrow('Tape is locked');
    expect(t.calls.filter((c) => c[0] === 'placeOrder')).toEqual([]);
  });

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
    // Not on Portfolio › Orders: a click opens the instrument.
    expect(t.notices[0].orderDone).toBe(true);
  });

  it('fails when IB sets the order Inactive, with the reason that follows', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await tick();
    // As IB answered an overnight + day iceberg order on the paper account.
    const reason = 'Order rejected - reason:Iceberg orders not supported for this combination of exchange and security type.';
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'Inactive' });
    t.emit('orderStatus', 50, 'Inactive', 0, 100, 0, 9050, 0, 0, CLIENT_ID, '');
    t.error(50, 201, reason);
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'Inactive' });
    await expect(p).rejects.toThrow(`${reason} (201)`);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Buy 100 AAPL rejected', `${reason} (201)`]]);
    expect(t.notices[0].orderDone).toBe(true);
  });

  it('fails an Inactive order without a reason when the wait runs out', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    const settled = p.catch((err: Error) => err);
    await tick();
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'Inactive' });
    await vi.advanceTimersByTimeAsync(1_000);
    // The notice waited for a reason, then went out without one.
    expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Buy 100 AAPL rejected', 'Limit 226.95 · DAY']]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toEqual(new Error('IB did not accept order #50 (Inactive)'));
    expect(t.notices).toHaveLength(1);
  });

  it('announces a rejection once when the reason arrives before the order', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await tick();
    t.error(50, 201, 'Order rejected - reason:Conditional orders not supported for this combination of exchange and security type.');
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'Inactive' });
    await expect(p).rejects.toThrow('(201)');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.notices.map((n) => n.body.en)).toEqual(['Order rejected - reason:Conditional orders not supported for this combination of exchange and security type. (201)']);
  });

  it('announces a rejected bracket child once', async () => {
    const t = await loaded();
    const p = t.svc.place({ ...req, bracket: { takeProfit: 233, stopLoss: 222 } });
    await tick();
    const child = (id: number) => lmt(id, CLIENT_ID, { parentId: 50, action: 'SELL' as never });
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'PreSubmitted' });
    t.emit('openOrder', 51, ibAapl, child(51), { status: 'PreSubmitted' });
    t.emit('openOrder', 52, ibAapl, child(52), { status: 'Inactive' });
    t.error(52, 201, 'Order rejected - reason:This combination of Stop with IOC or FOK is not allowed.');
    await expect(p).rejects.toThrow('This combination of Stop with IOC or FOK is not allowed. (201)');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([
      ['Buy 100 AAPL submitted', 'Limit 226.95 · DAY · awaiting fill'],
      ['Sell 100 AAPL rejected', 'Order rejected - reason:This combination of Stop with IOC or FOK is not allowed. (201)'],
    ]);
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
    expect(t.notices.map((n) => n.orderDone)).toEqual([undefined, true]);
  });

  it('keeps a working order in its trading session', async () => {
    const t = await loaded();
    // IB reports an includeOvernight order with TIF "OVERNIGHT + DAY".
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { tif: 'OVERNIGHT + DAY' as never, includeOvernight: true, outsideRth: true }), { status: 'PreSubmitted' });
    await expect(t.svc.modify(40, { ...req, limitPrice: 225 })).rejects.toThrow('Order #40 cannot move to another trading session (IB refuses it); cancel it and place a new order');
    expect(t.calls).toEqual([]);
    const m = t.svc.modify(40, { ...req, limitPrice: 225, session: 'overnightDay' });
    await tick();
    expect(t.calls[0][0]).toBe('placeOrder');
    expect(t.calls[0][3]).toMatchObject({ lmtPrice: 225, tif: 'DAY', includeOvernight: true, outsideRth: true });
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { lmtPrice: 225, tif: 'OVERNIGHT + DAY' as never, includeOvernight: true, outsideRth: true }), { status: 'PreSubmitted' });
    await expect(m).resolves.toBeUndefined();
    expect(t.svc.getOrders().find((o) => o.orderId === 40)).toMatchObject({ limitPrice: 225, tif: 'DAY', session: 'overnightDay' });
  });

  it('modifies an overnight-only order with an empty TIF', async () => {
    const t = await loaded();
    const ibOvernight: Contract = { ...ibAapl, exchange: 'OVERNIGHT', primaryExch: 'NASDAQ' };
    // IB reports the order's TIF as "OVERNIGHT" and answers 462 to DAY or 10052 to "OVERNIGHT" on modify.
    t.emit('openOrder', 42, ibOvernight, lmt(42, CLIENT_ID, { lmtPrice: 1, tif: 'OVERNIGHT' as never }), { status: 'PreSubmitted' });
    expect(t.svc.getOrders().find((o) => o.orderId === 42)).toMatchObject({ session: 'overnight', tif: 'DAY' });
    const contract = { ...stock('AAPL'), conId: 265598, primaryExchange: 'NASDAQ' };
    const m = t.svc.modify(42, { ...req, contract, limitPrice: 1.01, session: 'overnight' });
    await tick();
    expect(t.calls[0][0]).toBe('placeOrder');
    expect(t.calls[0][2]).toMatchObject({ exchange: 'OVERNIGHT', primaryExch: 'NASDAQ' });
    expect(t.calls[0][3]).toMatchObject({ lmtPrice: 1.01, tif: '' });
    t.emit('openOrder', 42, ibOvernight, lmt(42, CLIENT_ID, { lmtPrice: 1.01, tif: 'OVERNIGHT' as never }), { status: 'PreSubmitted' });
    await expect(m).resolves.toBeUndefined();
  });

  it('changes the TIF of a working order only as IB allows', async () => {
    const t = await loaded();
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { tif: 'GTD' as never, goodTillDate: '20261009 16:00:00 US/Eastern' }), { status: 'PreSubmitted' });
    // IB answers 462 "Cannot change to the new Time in Force".
    await expect(t.svc.modify(40, { ...req, limitPrice: 225 })).rejects.toThrow('Order #40 cannot change its time in force from GTD to DAY (IB refuses it); cancel it and place a new order');
    expect(t.calls).toEqual([]);
    // A new expiry is fine.
    const m = t.svc.modify(40, { ...req, tif: 'GTD', goodTillDate: '20261012 16:00:00 US/Eastern' });
    await tick();
    expect(t.calls[0][3]).toMatchObject({ tif: 'GTD', goodTillDate: '20261012 16:00:00 US/Eastern' });
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { tif: 'GTD' as never, goodTillDate: '20261012 16:00:00 US/Eastern' }), { status: 'PreSubmitted' });
    // The echo cannot show a new expiry apart from IB's unchanged order: a refusal may follow.
    await vi.advanceTimersByTimeAsync(500);
    await expect(m).resolves.toBeUndefined();

    t.emit('openOrder', 41, ibAapl, lmt(41), { status: 'PreSubmitted' });
    const gtc = t.svc.modify(41, { ...req, tif: 'GTC' });
    await tick();
    expect(t.calls.at(-1)?.[3]).toMatchObject({ tif: 'GTC' });
    t.emit('openOrder', 41, ibAapl, lmt(41, CLIENT_ID, { tif: 'GTC' as never }), { status: 'PreSubmitted' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(gtc).resolves.toBeUndefined();
    await expect(t.svc.modify(41, { ...req, tif: 'OPG' })).rejects.toThrow('from GTC to OPG');
  });

  it('looks up the primary exchange the OVERNIGHT venue needs', async () => {
    const t = await loaded();
    const p = t.svc.place({ ...req, session: 'overnight', limitPrice: 1 });
    await tick();
    expect(t.calls[0][0]).toBe('placeOrder');
    // getInfo knows no primary exchange here: the order goes out with the conId alone.
    expect(t.calls[0][2]).toMatchObject({ exchange: 'OVERNIGHT', conId: 265598 });
    t.error(50, 10329, 'This order will be directly routed to OVERNIGHT. Restriction is specified in Precautionary Settings of Global Configuration/API.');
    await expect(p).rejects.toThrow('This order will be directly routed to OVERNIGHT. Restriction is specified in Precautionary Settings of Global Configuration/API. (10329)');
    expect(t.notices.at(-1)?.body.en).toBe('This order will be directly routed to OVERNIGHT. Restriction is specified in Precautionary Settings of Global Configuration/API. (10329)');
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
    const cond = t.svc.getOrders().find((o) => o.orderId === 41)?.conditions?.items[0];
    expect(cond && 'contract' in cond && cond.contract).toMatchObject({ symbol: 'SPY', conId: 756733 });
  });

  it('resolves every condition instrument and sends the conditions', async () => {
    const t = await loaded();
    const p = t.svc.place({
      ...req,
      conditions: {
        items: [
          { kind: 'price', contract: stock('AAPL'), operator: '>=', price: 400, join: 'or' },
          { kind: 'percentChange', contract: stock('MSFT'), operator: '<=', percent: -5 },
          { kind: 'time', time: '20261006 10:00:00 US/Eastern' },
        ],
        outsideRth: false,
      },
    });
    await tick();
    const sent = t.calls.find((c) => c[0] === 'placeOrder')?.[3] as Order;
    expect(sent.conditions?.map((c) => (c as { conId?: number }).conId)).toEqual([265598, 265598, undefined]);
    expect(sent.conditions?.[0].conjunctionConnection).toBe('o');
    t.emit('openOrder', 50, ibAapl, { ...lmt(50), conditions: sent.conditions }, { status: 'PreSubmitted' });
    await expect(p).resolves.toMatchObject({ orderId: 50 });
    expect(t.svc.getOrders().find((o) => o.orderId === 50)?.conditions?.items.map((c) => c.kind)).toEqual(['price', 'percentChange', 'time']);
  });

  it('refuses what IB does not offer for the contract, before sending', async () => {
    const t = await loaded();
    t.setInfo({ orderTypes: ['LMT', 'MKT'], validExchanges: ['SMART', 'NASDAQ'] });
    await expect(t.svc.place({ ...req, allOrNone: true })).rejects.toThrow('IB does not offer this order attribute for this contract');
    await expect(t.svc.place({ ...req, route: 'ARCA' })).rejects.toThrow('The contract cannot be routed to this exchange');
    expect(t.calls.filter((c) => c[0] === 'placeOrder')).toEqual([]);
  });

  describe('modify', () => {
    const attrs = {
      allOrNone: true,
      algoStrategy: 'Adaptive',
      algoParams: [{ tag: 'adaptivePriority', value: 'Normal' }],
      ocaGroup: 'g1',
      ocaType: 1,
      orderRef: 'note',
      conditions: [{ type: 1, conjunctionConnection: 'a', isMore: true, price: 500, conId: 265598, exchange: 'SMART', triggerMethod: 0 } as never],
    };

    it('keeps the attributes the request leaves out', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { ...attrs, allOrNone: true, algoStrategy: undefined, algoParams: undefined }), { status: 'Submitted' });
      const m = t.svc.modify(40, { ...req, limitPrice: 225 });
      await tick();
      const sent = t.calls[0][3] as Order;
      expect(sent).toMatchObject({ lmtPrice: 225, allOrNone: true, ocaGroup: 'g1', ocaType: 1, orderRef: 'note', conditionsCancelOrder: false });
      expect(sent.conditions?.[0]).toMatchObject({ price: 500, conId: 265598 });
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { ...attrs, lmtPrice: 225 }), { status: 'Submitted' });
      await expect(m).resolves.toBeUndefined();
      // false turns all or none off.
      const off = t.svc.modify(40, { ...req, limitPrice: 225, allOrNone: false });
      await tick();
      expect(t.calls.at(-1)?.[3]).not.toHaveProperty('allOrNone');
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { ...attrs, allOrNone: false }), { status: 'Submitted' });
      await vi.advanceTimersByTimeAsync(500);
      await off;
    });

    it("fails when IB answers with the unchanged order and then refuses the change", async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      // Paper: IB echoed #96 at its old price, then answered 201 Invalid Price.
      const m = t.svc.modify(40, { ...req, limitPrice: 1000 });
      const settled = expect(m).rejects.toThrow('Order rejected - reason:Invalid Price (201)');
      await tick();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      t.emit('orderStatus', 40, 'Submitted', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
      t.error(40, 201, 'Order rejected - reason:Invalid Price');
      await settled;
    });

    it('waits a moment for a refusal when the echo cannot show the change', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      const m = t.svc.modify(40, { ...req, orderRef: 'new note' });
      const settled = expect(m).rejects.toThrow('Order rejected - reason:Modify Mismatch on field # 9822 (201)');
      await tick();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      await vi.advanceTimersByTimeAsync(100);
      t.error(40, 201, 'Order rejected - reason:Modify Mismatch on field # 9822');
      await settled;
      // A price change the echo shows is accepted at once.
      const ok = t.svc.modify(40, { ...req, limitPrice: 225 });
      await tick();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { lmtPrice: 225 }), { status: 'Submitted' });
      await expect(ok).resolves.toBeUndefined();
    });

    it('refuses the changes IB refuses or ignores, without sending them', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, attrs), { status: 'Submitted' });
      const msg = (what: string) => `Order #40 ${what} (IB refuses it); cancel it and place a new order`;
      await expect(t.svc.modify(40, { ...req, algo: { strategy: 'Vwap', params: {} } })).rejects.toThrow(msg('cannot add, remove or change its algo (only the algo’s parameters change)'));
      await expect(t.svc.modify(40, { ...req, oca: { group: 'g2', type: 1 } })).rejects.toThrow(msg('cannot join, leave or change a one-cancels-all group'));
      await expect(t.svc.modify(40, { ...req, conditions: { items: [{ kind: 'margin', operator: '<=', percent: 20 }], outsideRth: false } })).rejects.toThrow(/cannot add or remove conditions/);
      await expect(t.svc.modify(40, { ...req, orderType: 'MKT', limitPrice: undefined })).rejects.toThrow(msg('cannot change its order type'));
      await expect(t.svc.modify(40, { ...req, route: 'NASDAQ' })).rejects.toThrow(msg('cannot change its destination'));
      expect(t.calls).toEqual([]);
    });

    it('modifies an order on a stock traded on its own exchange (no directed route)', async () => {
      const t = await loaded();
      // SEHK stocks are not reached through SMART: the venue is the instrument's, not a route.
      const ibHk: Contract = { conId: 265598, symbol: '700', secType: 'STK' as never, exchange: 'SEHK', currency: 'HKD' };
      t.emit('openOrder', 40, ibHk, lmt(40, CLIENT_ID, { action: 'SELL' as never, orderType: 'TRAIL' as never, lmtPrice: undefined, trailingPercent: 2, trailStopPrice: 400 }), { status: 'PreSubmitted' });
      const hk = { symbol: '700', secType: 'STK' as const, exchange: 'SEHK', currency: 'HKD', conId: 265598 };
      const m = t.svc.modify(40, { ...req, contract: hk, action: 'SELL', orderType: 'TRAIL', limitPrice: undefined, trailingPercent: 3, trailStopPrice: 395 });
      await tick();
      expect(t.calls[0][0]).toBe('placeOrder');
      expect(t.calls[0][2]).toMatchObject({ exchange: 'SEHK' });
      expect(t.calls[0][3]).toMatchObject({ orderType: 'TRAIL', trailingPercent: 3, trailStopPrice: 395 });
      t.emit('openOrder', 40, ibHk, lmt(40, CLIENT_ID, { action: 'SELL' as never, orderType: 'TRAIL' as never, lmtPrice: undefined, trailingPercent: 3, trailStopPrice: 395 }), { status: 'PreSubmitted' });
      await vi.advanceTimersByTimeAsync(500);
      await expect(m).resolves.toBeUndefined();
    });

    it('counts a MOC modify without an answer from IB as accepted', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { orderType: 'MOC' as never, lmtPrice: 0 }), { status: 'PreSubmitted' });
      const m = t.svc.modify(40, { ...req, orderType: 'MOC', limitPrice: undefined, quantity: 2 });
      let done = false;
      void m.then(() => (done = true));
      await tick();
      expect(t.calls[0][3]).toMatchObject({ orderType: 'MOC', totalQuantity: 2 });
      await vi.advanceTimersByTimeAsync(1_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await expect(m).resolves.toBeUndefined();
      // IB shows the change in this client's open orders.
      expect(t.calls.at(-1)?.[0]).toBe('reqOpenOrders');
      // A modify IB answered does not ask.
      const m2 = t.svc.modify(40, { ...req, orderType: 'MOC', limitPrice: undefined, quantity: 3 });
      await tick();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { orderType: 'MOC' as never, lmtPrice: 0, totalQuantity: 3 }), { status: 'PreSubmitted' });
      await m2;
      expect(t.calls.at(-1)?.[0]).toBe('placeOrder');
    });
  });

  describe('preview', () => {
    const whatIf = (orderId: number): Order => ({ ...lmt(orderId), whatIf: true });

    it("returns IB's margin and commission estimate; the what-if order never becomes a working order", async () => {
      const t = await loaded();
      const p = t.svc.preview({ ...req, bracket: { takeProfit: 300, stopLoss: 100 } });
      await tick();
      const [name, id, , order] = t.calls[0] as [string, number, Contract, Order];
      expect(name).toBe('placeOrder');
      expect(order).toMatchObject({ whatIf: true, transmit: true, orderType: 'LMT' });
      expect(t.calls).toHaveLength(1); // no bracket children
      t.emit('openOrder', id, ibAapl, whatIf(id), { status: 'PreSubmitted', initMarginChange: 110.06, commission: 1, commissionCurrency: 'USD', warningText: '' });
      await expect(p).resolves.toEqual({ commission: 1, commissionCurrency: 'USD', initMargin: { change: 110.06 } });
      t.emit('orderStatus', id, 'PreSubmitted', 0, 100, 0, 0, 0, 0, CLIENT_ID, '');
      await vi.advanceTimersByTimeAsync(200);
      expect(t.svc.getOrders().map((o) => o.orderId)).toEqual([7]);
      expect(t.notices).toEqual([]);
    });

    it('merges the parts IB sends: commission and notice first, then the margin', async () => {
      const t = await loaded();
      const p = t.svc.preview({ ...req, limitPrice: 4 });
      await tick();
      const id = t.calls[0][1] as number;
      t.emit('openOrder', id, ibAapl, whatIf(id), { status: 'PreSubmitted', commission: 0, commissionCurrency: 'USD', warningText: 'Price band notice' });
      await vi.advanceTimersByTimeAsync(100);
      t.emit('openOrder', id, ibAapl, whatIf(id), { status: 'PreSubmitted', initMarginBefore: 11005.5, initMarginChange: 110.06, initMarginAfter: 11115.56, warningText: '' });
      await expect(p).resolves.toEqual({
        commission: 0,
        commissionCurrency: 'USD',
        warningText: 'Price band notice',
        initMargin: { before: 11005.5, change: 110.06, after: 11115.56 },
      });
    });

    it("takes IB's commission range from the later part over the first part's placeholder 0", async () => {
      const t = await loaded();
      // Paper, BUY 1 AAPL LMT 1: part 1 comm=0 and the notice; part 2 min/max and the margin.
      const p = t.svc.preview({ ...req, limitPrice: 1 });
      await tick();
      const id = t.calls[0][1] as number;
      t.emit('openOrder', id, ibAapl, whatIf(id), { status: 'PreSubmitted', commission: 0, commissionCurrency: 'USD', warningText: 'If your order is not immediately executable' });
      t.emit('openOrder', id, ibAapl, whatIf(id), { status: 'PreSubmitted', minCommission: 0.010003, maxCommission: 0.013003, initMarginBefore: 22011, initMarginChange: 110.06, initMarginAfter: 22121.06, warningText: '' });
      const r = await p;
      expect(r).not.toHaveProperty('commission');
      expect(r).toMatchObject({ minCommission: 0.010003, maxCommission: 0.013003, commissionCurrency: 'USD', warningText: 'If your order is not immediately executable' });
    });

    it("fails with IB's error, or when IB does not answer", async () => {
      const t = await loaded();
      const p = t.svc.preview({ ...req, limitPrice: 2 });
      await tick();
      const id = t.calls[0][1] as number;
      t.error(id, 399, 'Order Message: Warning: Your order will not be placed at the exchange until 2026-10-05 09:30:00 US/Eastern.');
      t.error(id, 387, 'Unsupported order type for this exchange and security type.');
      await expect(p).rejects.toThrow('Unsupported order type for this exchange and security type. (387)');
      expect(t.notices).toEqual([]);
      const slow = t.svc.preview({ ...req, limitPrice: 3 });
      const failed = expect(slow).rejects.toThrow('IB did not answer the margin and commission preview in time');
      await vi.advanceTimersByTimeAsync(8_100);
      await failed;
    });

    it('sends one preview at a time and reuses the answer to the same request', async () => {
      const t = await loaded();
      const a = t.svc.preview(req);
      const again = t.svc.preview(req);
      const b = t.svc.preview({ ...req, limitPrice: 2 });
      await tick();
      expect(t.calls.filter((c) => c[0] === 'placeOrder')).toHaveLength(1);
      const first = t.calls[0][1] as number;
      t.emit('openOrder', first, ibAapl, whatIf(first), { status: 'PreSubmitted', commission: 1 });
      // Without margin the answer waits a moment for IB's next part.
      await vi.advanceTimersByTimeAsync(500);
      await expect(a).resolves.toEqual({ commission: 1 });
      await expect(again).resolves.toEqual({ commission: 1 });
      await tick();
      const sent = t.calls.filter((c) => c[0] === 'placeOrder');
      expect(sent).toHaveLength(2);
      const second = sent[1][1] as number;
      expect(second).not.toBe(first);
      t.emit('openOrder', second, ibAapl, whatIf(second), { status: 'PreSubmitted', commission: 2 });
      await vi.advanceTimersByTimeAsync(500);
      await expect(b).resolves.toEqual({ commission: 2 });
      // Within 10 s the same request is answered without asking IB again.
      await expect(t.svc.preview(req)).resolves.toEqual({ commission: 1 });
      expect(t.calls.filter((c) => c[0] === 'placeOrder')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_100);
      void t.svc.preview(req).catch(() => undefined);
      await tick();
      expect(t.calls.filter((c) => c[0] === 'placeOrder')).toHaveLength(3);
    });

    it('is refused while locked or disconnected, and for invalid requests', async () => {
      const t = await loaded();
      t.lock.locked = true;
      await expect(t.svc.preview(req)).rejects.toThrow('Tape is locked');
      t.lock.locked = false;
      await expect(t.svc.preview({ ...req, limitPrice: undefined })).rejects.toThrow('Limit price is required');
      t.setConnected(false);
      await expect(t.svc.preview(req)).rejects.toThrow('Not connected');
      expect(t.calls).toEqual([]);
    });
  });
});

describe('sameGoodAfter', () => {
  it('keeps IB’s good-after date when a modify leaves the time unchanged', () => {
    expect(sameGoodAfter('20261005 09:35:00 US/Eastern', '09:35')).toBe('20261005 09:35:00 US/Eastern');
    expect(sameGoodAfter('20261005 09:35:00 US/Eastern', '9:35')).toBe('20261005 09:35:00 US/Eastern');
    // UTC form: 13:35 UTC is 09:35 New York time in October.
    expect(sameGoodAfter('20261005-13:35:00', '09:35')).toBe('20261005-13:35:00');
  });

  it('builds a new good-after time when the time changed or none was set', () => {
    expect(sameGoodAfter('20261005 09:35:00 US/Eastern', '10:00')).toBeUndefined();
    expect(sameGoodAfter(undefined, '09:35')).toBeUndefined();
    expect(sameGoodAfter('20261005 09:35:00 US/Eastern', undefined)).toBeUndefined();
    expect(sameGoodAfter('garbage', '09:35')).toBeUndefined();
  });
});
