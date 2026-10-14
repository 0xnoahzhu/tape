import type { Contract, IBApi, Order } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import type { NewNotification, TapeEvent } from '@shared/ipc';
import type { ConnectionState, OrderRequest } from '@shared/types';
import type { IbConnection, IbListener, MainContext, SessionChangeReason } from '../context';
import { ORDER_UNCONFIRMED_MESSAGE } from '@shared/ipc';
import {
  CANCEL_ALL_NO_LIST_MESSAGE,
  CONNECTION_CHANGED_MESSAGE,
  createOrderService,
  GATEWAY_UNRESPONSIVE_MESSAGE,
  IB_LINK_LOST_MESSAGE,
  ORDER_LIST_CHANGED_MESSAGE,
  ORDER_NOT_SENT_MESSAGE,
  sameGoodAfter,
  SESSION_CHANGED_MESSAGE,
  STALE_ORDER_MESSAGE,
} from './orders';

const CLIENT_ID = 101;

/** Lets a test hand sendPreview an order that is not a what-if one (its fail-closed guard). */
const previewBuild = vi.hoisted(() => ({ dropWhatIf: false }));
vi.mock('./orderBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orderBuilder')>();
  return {
    ...actual,
    buildPreviewOrder: (...args: Parameters<typeof actual.buildPreviewOrder>) => {
      const built = actual.buildPreviewOrder(...args);
      return previewBuild.dropWhatIf ? { ...built, order: { ...built.order, whatIf: false } } : built;
    },
  };
});

/** A connection stub: tests emit IB callbacks; requests are recorded. */
function fakeIb() {
  const listeners = new Map<string, Set<IbListener>>();
  const ready = new Set<(api: IBApi) => void>();
  const closed = new Set<() => void>();
  const sessionChanged = new Set<(reason: SessionChangeReason) => void>();
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
  let account = 'DU1';
  let session = 0;
  let orderId = 50;
  let reqId = 1000;
  /** The connection's health flags (1100, an unanswered heartbeat) and IB's Read-Only API refusals. */
  let health: Pick<ConnectionState, 'ibLinkLost' | 'unresponsive' | 'readOnlyApi'> = {};
  /** How often the service told the connection IB accepted an order request (Read-Only API is off). */
  const accepted = { count: 0 };
  const ib: IbConnection = {
    get api() {
      return connected ? api : null;
    },
    getState: () => ({ status: connected ? 'connected' : 'disconnected', host: 'h', port: 1, clientId, session, accounts: [account], account, isPaper: account.startsWith('D'), farms: {}, ...health }),
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
    onSessionChange: (l) => (sessionChanged.add(l), () => sessionChanged.delete(l)),
    onRequestError: (l) => (reqErrors.add(l), () => reqErrors.delete(l)),
    noteOrderAccepted: () => void accepted.count++,
  };
  /** The socket closes (the services' onClosed). */
  const close = () => {
    connected = false;
    closed.forEach((l) => l());
  };
  return {
    ib,
    calls,
    accepted,
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => l(...args)),
    /** The TWS client wrote a frame to the socket ('sent': its tokens, as strings). */
    written: (...tokens: Array<string | number>) => listeners.get('sent')?.forEach((l) => l(tokens.map(String), tokens.join('\0'))),
    error: (reqId: number, code: number, message: string) => reqErrors.forEach((l) => l({ reqId, code, message })),
    ready: () => ready.forEach((l) => l(api)),
    setConnected: (v: boolean) => void (connected = v),
    setClientId: (v: number) => void (clientId = v),
    setHealth: (v: Pick<ConnectionState, 'ibLinkLost' | 'unresponsive' | 'readOnlyApi'>) => void (health = v),
    /** A new IBApi instance, as after a host / port / client id change. */
    replaceApi: () => void (api = newApi()),
    close,
    /** A new session epoch without its event (another login on the same instance, mid-request). */
    setSession: (v: number) => void (session = v),
    /**
     * Tape moves to another account or Gateway, as connection.ts does it: the socket closes, the
     * session changes (epoch, event), then a new instance connects (ready() is up to the test).
     */
    switchSession: (to: string, reason: SessionChangeReason = 'params') => {
      if (connected) close();
      account = to;
      session++;
      sessionChanged.forEach((l) => l(reason));
      api = newApi();
      connected = true;
    },
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
  const settings = defaultSettings();
  const ctx = {
    lock: { isLocked: () => lock.locked },
    store: { getSettings: () => settings },
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
  return { ...f, svc, notices, events, holdLookups, lock, setInfo, settings };
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
    await expect(t.svc.cancel({ orderId: 7, clientId: 0 })).rejects.toThrow('Tape is locked');
    await expect(t.svc.cancelAll({ account: 'DU1', permIds: [9007], session: 0 })).rejects.toThrow('Tape is locked');
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
    await expect(p).resolves.toEqual({ orderId: 50, childOrderIds: [], confirmed: true });
    expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL submitted · PAPER DU1']);
    // IB took it: Read-Only API is off.
    expect(t.accepted.count).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    const orders = t.events.filter((e) => e.type === 'orders').at(-1);
    expect(orders && orders.type === 'orders' && orders.orders.map((o) => [o.orderId, o.status])).toEqual([
      [50, 'Submitted'],
      [7, 'Submitted'],
    ]);
  });

  it('names the account in its notices: PAPER / LIVE always, the id unless Settings › Privacy hides it', async () => {
    const t = await loaded();
    t.notices.length = 0;
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'PreSubmitted' });
    // An advisor login's live account: the order's own account, not the connected one.
    t.emit('openOrder', 41, ibAapl, lmt(41, CLIENT_ID, { account: 'U18630011' }), { status: 'PreSubmitted' });
    t.settings.appearance.showAccountId = false;
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
    t.emit('orderStatus', 41, 'Cancelled', 0, 100, 0, 9041, 0, 0, CLIENT_ID, '');
    expect(t.notices.map((n) => n.title.en)).toEqual([
      'Buy 100 AAPL submitted · PAPER DU1',
      'Buy 100 AAPL submitted · LIVE U18630011',
      'Buy 100 AAPL cancelled · PAPER',
      'Buy 100 AAPL cancelled · LIVE',
    ]);
    expect(t.notices.map((n) => n.title.zh)).toEqual(['买入 100 AAPL 已提交 · 模拟 DU1', '买入 100 AAPL 已提交 · 实盘 U18630011', '买入 100 AAPL 已撤销 · 模拟', '买入 100 AAPL 已撤销 · 实盘']);
  });

  it('throws the IB message when the order is rejected', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await tick();
    t.error(50, 321, "Error validating request.-'bC' : cause - The API interface is currently in Read-Only mode.");
    await expect(p).rejects.toThrow('The API interface is currently in Read-Only mode. (321)');
    expect(t.notices.map((n) => [n.kind, n.title.en, n.body.en])).toEqual([['order', 'Buy 100 AAPL rejected · PAPER DU1', 'The API interface is currently in Read-Only mode. (321)']]);
    // Not on Portfolio › Orders: a click opens the instrument.
    expect(t.notices[0].orderDone).toBe(true);
    // A rejection comes through do-not-disturb.
    expect(t.notices[0].critical).toBe(true);
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
    expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Buy 100 AAPL rejected · PAPER DU1', `${reason} (201)`]]);
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
    expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Buy 100 AAPL rejected · PAPER DU1', 'Limit 226.95 · DAY']]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toMatchObject({ message: 'IB did not accept order #50 (Inactive)' });
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
    await expect(p).rejects.toThrow(
      'Stop-loss #52 rejected: Order rejected - reason:This combination of Stop with IOC or FOK is not allowed. (201). Cancel sent for the rest of the bracket: entry #50 and take-profit #51',
    );
    // The entry and its take-profit IB took are withdrawn: no entry works without its stop-loss.
    expect(t.calls.filter((c) => c[0] === 'cancelOrder')).toEqual([
      ['cancelOrder', 50],
      ['cancelOrder', 51],
    ]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([
      ['Buy 100 AAPL submitted · PAPER DU1', 'Limit 226.95 · DAY · awaiting fill'],
      [
        'Sell 100 AAPL rejected · PAPER DU1',
        'Order rejected - reason:This combination of Stop with IOC or FOK is not allowed. (201) · Cancel sent for the rest of the bracket: entry #50 and take-profit #51',
      ],
    ]);
    expect(t.notices[1].body.zh).toContain('已对括号单的其余订单发送撤单：主单 #50、止盈单 #51');
  });

  it('ignores order warnings while waiting', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await tick();
    t.error(50, 399, 'Order Message: BUY 100 AAPL Warning: your order will not be placed at the exchange until 09:30');
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'PreSubmitted' });
    await expect(p).resolves.toMatchObject({ orderId: 50 });
  });

  it('resolves after 2 s without an answer, as not confirmed', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({ orderId: 50, childOrderIds: [], confirmed: false });
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
    await expect(p).resolves.toEqual({ orderId: 50, childOrderIds: [51, 52], confirmed: true });
    // one notice for the group, not one per child
    expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL submitted · PAPER DU1']);
  });

  it('refuses orders when disconnected', async () => {
    const t = await loaded();
    t.setConnected(false);
    await expect(t.svc.place(req)).rejects.toThrow('Not connected');
    expect(t.calls).toEqual([]);
  });

  it('sends no order or modify while IB Gateway has lost IB (1100) or does not answer, but still a cancel', async () => {
    const t = await loaded();
    t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
    t.calls.length = 0;
    t.setHealth({ ibLinkLost: true });
    await expect(t.svc.place(req)).rejects.toThrow(IB_LINK_LOST_MESSAGE);
    await expect(t.svc.modify(40, { ...req, limitPrice: 225 })).rejects.toThrow(IB_LINK_LOST_MESSAGE);
    t.setHealth({ unresponsive: true });
    await expect(t.svc.place(req)).rejects.toThrow(GATEWAY_UNRESPONSIVE_MESSAGE);
    await expect(t.svc.modify(40, { ...req, limitPrice: 225 })).rejects.toThrow(GATEWAY_UNRESPONSIVE_MESSAGE);
    expect(t.calls).toEqual([]);
    // Getting out stays possible.
    const c = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 9040 });
    expect(t.calls.map((x) => x[0])).toEqual(['cancelOrder']);
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
    await expect(c).resolves.toEqual({ status: 'Cancelled' });
  });

  it('does not send an order whose IB link drops while its contract is being resolved', async () => {
    const t = await loaded();
    const release = t.holdLookups();
    const p = t.svc.place({ ...req, contract: stock('AAPL') });
    await tick();
    t.setHealth({ ibLinkLost: true });
    release();
    await expect(p).rejects.toThrow(IB_LINK_LOST_MESSAGE);
    expect(t.calls.filter((c) => c[0] === 'placeOrder')).toEqual([]);
  });

  it('only modifies and cancels orders of this client', async () => {
    const t = await loaded();
    await expect(t.svc.modify(7, req)).rejects.toThrow('Order #7 belongs to client 0 (TWS): only client id 0 can modify it');
    await expect(t.svc.cancel({ orderId: 7, clientId: 0, permId: 9007 })).rejects.toThrow('Order #7 was placed outside Tape (IBKR Mobile, TWS or the web); cancel it there or use Cancel all orders…');
    t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
    const m = t.svc.modify(40, { ...req, limitPrice: 225 });
    await tick();
    expect(t.calls[0][0]).toBe('placeOrder');
    expect(t.calls[0][1]).toBe(40);
    expect((t.calls[0][3] as Order).lmtPrice).toBe(225);
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { lmtPrice: 225 }), { status: 'Submitted' });
    await expect(m).resolves.toEqual({ confirmed: true });

    const c = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 9040 });
    expect(t.calls.at(-1)?.[0]).toBe('cancelOrder');
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
    await expect(c).resolves.toEqual({ status: 'Cancelled' });
    expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL submitted · PAPER DU1', 'Buy 100 AAPL cancelled · PAPER DU1']);
    expect(t.notices.map((n) => n.orderDone)).toEqual([undefined, true]);
    // Neither is critical: do-not-disturb holds them back.
    expect(t.notices.map((n) => n.critical)).toEqual([undefined, undefined]);
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
    await expect(m).resolves.toEqual({ confirmed: true });
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
    await expect(m).resolves.toEqual({ confirmed: true });
  });

  it('changes the TIF of a working order only as IB allows', async () => {
    // GTD expiries must lie ahead: the test runs on a fixed day (Mon 5 Oct 2026, 10:00 New York).
    vi.setSystemTime(new Date('2026-10-05T14:00:00Z'));
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
    await expect(m).resolves.toEqual({ confirmed: true });

    t.emit('openOrder', 41, ibAapl, lmt(41), { status: 'PreSubmitted' });
    const gtc = t.svc.modify(41, { ...req, tif: 'GTC' });
    await tick();
    expect(t.calls.at(-1)?.[3]).toMatchObject({ tif: 'GTC' });
    t.emit('openOrder', 41, ibAapl, lmt(41, CLIENT_ID, { tif: 'GTC' as never }), { status: 'PreSubmitted' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(gtc).resolves.toEqual({ confirmed: true });
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
    await expect(t.svc.cancel({ orderId: 40, clientId: 12, permId: 9040 })).rejects.toThrow('Order #40 belongs to API client 12: only that client can cancel it, or use Cancel all orders…');
    // A list that showed it as this client's is out of date.
    await expect(t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 9040 })).rejects.toThrow(STALE_ORDER_MESSAGE);
    await expect(t.svc.modify(40, req)).rejects.toThrow('Order #40 belongs to API client 12');
    expect(t.calls).toEqual([]);

    // Once this client has its own #40, the id means that order.
    t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { permId: 7040 }), { status: 'Submitted' });
    const c = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 7040 });
    expect(t.calls).toEqual([['cancelOrder', 40]]);
    // Client 12's order with the same id does not settle the wait.
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, 12, '');
    let settled = false;
    void c.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 7040, 0, 0, CLIENT_ID, '');
    await expect(c).resolves.toEqual({ status: 'Cancelled' });
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
      await expect(m).resolves.toEqual({ confirmed: true });
    });
  });

  it('refuses unknown order ids and id 0 without sending anything', async () => {
    const t = await loaded();
    await expect(t.svc.cancel({ orderId: 99, clientId: CLIENT_ID })).rejects.toThrow('Order #99 was not found');
    await expect(t.svc.modify(99, req)).rejects.toThrow('Order #99 was not found');
    await expect(t.svc.cancel({ orderId: 0, clientId: 0 })).rejects.toThrow('This order was placed outside Tape (IBKR Mobile, TWS or the web)');
    await expect(t.svc.cancel({ orderId: 1.5, clientId: CLIENT_ID })).rejects.toThrow('cannot be cancelled');
    expect(t.calls).toEqual([]);
  });

  it('cancels an order it sent before IB reported it back', async () => {
    const t = await loaded();
    const p = t.svc.place(req);
    await vi.advanceTimersByTimeAsync(2_000); // no answer: sent, not confirmed
    await expect(p).resolves.toMatchObject({ orderId: 50, confirmed: false });
    await expect(t.svc.modify(50, req)).rejects.toThrow('Order #50 has not been confirmed by IB yet');
    const c = t.svc.cancel({ orderId: 50, clientId: CLIENT_ID });
    expect(t.calls.at(-1)).toEqual(['cancelOrder', 50]);
    // The status is held until the order itself arrives.
    t.emit('orderStatus', 50, 'Cancelled', 0, 100, 0, 9050, 0, 0, CLIENT_ID, '');
    t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'Cancelled' });
    await expect(c).resolves.toEqual({ status: 'Cancelled' });
    expect(t.svc.getOrders().find((o) => o.orderId === 50)?.status).toBe('Cancelled');
  });

  it('treats orders of a previous client id as another client', async () => {
    const t = await loaded();
    t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
    t.setClientId(102);
    await expect(t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 9040 })).rejects.toThrow(`Order #40 belongs to API client ${CLIENT_ID}`);
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
    expect(t.notices.map((n) => [n.kind, n.title.en, n.body.en])).toEqual([['fill', 'AAPL: bought 40 shares · PAPER DU1', 'Avg 226.95 · Commission 1.00 · Order #50']]);
    expect(t.notices[0].critical).toBeUndefined();
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

  describe('cancel', () => {
    /** An order IBKR Mobile / TWS placed (order id 0, client 0). */
    const manual = (permId: number): Order => ({ ...lmt(0, 0, { tif: 'GTC' as never }), orderId: 0, permId });

    async function withOrder(status = 'Submitted') {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status });
      t.notices.length = 0;
      return t;
    }

    it('resolves Cancelled on IB’s 202 alone', async () => {
      const t = await withOrder();
      const c = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 9040, account: 'DU1' });
      expect(t.calls).toEqual([['cancelOrder', 40]]);
      t.error(40, 202, 'Order Canceled - reason:');
      await expect(c).resolves.toEqual({ status: 'Cancelled' });
      // IB took the cancel: Read-Only API is off.
      expect(t.accepted.count).toBe(1);
    });

    it('says PendingCancel or sent when IB has not cancelled the order within the wait, never a silent success', async () => {
      const t = await withOrder();
      t.emit('openOrder', 41, ibAapl, lmt(41, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      const pending = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID });
      t.emit('orderStatus', 40, 'PendingCancel', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
      const silent = t.svc.cancel({ orderId: 41, clientId: CLIENT_ID });
      let settled = false;
      void Promise.all([pending, silent]).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(3_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({ status: 'PendingCancel' });
      await expect(silent).resolves.toEqual({ status: 'sent' });
      // The order IB is cancelling is not cancelled twice.
      await expect(t.svc.cancel({ orderId: 40, clientId: CLIENT_ID })).rejects.toThrow('Order #40 is already being cancelled; nothing was sent');
    });

    it('fails with IB’s refusal within the wait and announces one that comes after it, once', async () => {
      const t = await withOrder();
      const refused = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID });
      t.error(40, 10147, 'OrderId 40 that needs to be cancelled is not found.');
      await expect(refused).rejects.toThrow('OrderId 40 that needs to be cancelled is not found. (10147)');
      // The caller shows that one.
      expect(t.notices).toEqual([]);
      const late = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(late).resolves.toEqual({ status: 'sent' });
      t.error(40, 10148, 'OrderId 40 that needs to be cancelled cannot be cancelled, state: Filled.');
      t.error(40, 10148, 'OrderId 40 that needs to be cancelled cannot be cancelled, state: Filled.');
      expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Cancel of Buy 100 AAPL refused · PAPER DU1', 'OrderId 40 that needs to be cancelled cannot be cancelled, state: Filled. (10148)']]);
      expect(t.notices[0].title.zh).toBe('买入 100 AAPL 撤单被拒绝 · 模拟 DU1');
      // The order still works although the user believes it cancelled: critical, not done.
      expect(t.notices[0]).toMatchObject({ critical: true });
      expect(t.notices[0].orderDone).toBeUndefined();
    });

    it('stops watching for a refusal once IB has ended the order', async () => {
      const t = await withOrder();
      const c = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(c).resolves.toEqual({ status: 'sent' });
      t.emit('orderStatus', 40, 'Filled', 100, 0, 226.95, 9040, 0, 226.95, CLIENT_ID, '');
      t.error(40, 10148, 'OrderId 40 that needs to be cancelled cannot be cancelled, state: Filled.');
      expect(t.notices.filter((n) => n.title.en.startsWith('Cancel of'))).toEqual([]);
    });

    it('refuses what IB would not let Tape cancel, sending nothing', async () => {
      const t = await withOrder('PendingCancel');
      t.emit('openOrder', 0, ibAapl, manual(780760062), { status: 'PreSubmitted' });
      t.emit('openOrder', 41, ibAapl, lmt(41), { status: 'Filled' });
      await expect(t.svc.cancel({ orderId: 0, clientId: 0, permId: 780760062 })).rejects.toThrow(
        'The order with permId 780760062 was placed outside Tape (IBKR Mobile, TWS or the web); cancel it there or use Cancel all orders…',
      );
      await expect(t.svc.cancel({ orderId: 40, clientId: CLIENT_ID })).rejects.toThrow('Order #40 is already being cancelled; nothing was sent');
      await expect(t.svc.cancel({ orderId: 41, clientId: CLIENT_ID })).rejects.toThrow('Order #41 is already Filled');
      // Connected as client 0: an order IBKR Mobile placed is still bound to no client (order id 0) …
      t.setClientId(0);
      await expect(t.svc.cancel({ orderId: 0, clientId: 0, permId: 780760062 })).rejects.toThrow('was placed outside Tape');
      expect(t.calls).toEqual([]);
      // … while a TWS order bound to client 0 is its own.
      const c = t.svc.cancel({ orderId: 7, clientId: 0, permId: 9007 });
      expect(t.calls).toEqual([['cancelOrder', 7]]);
      t.emit('orderStatus', 7, 'Cancelled', 0, 100, 0, 9007, 0, 0, 0, '');
      await expect(c).resolves.toEqual({ status: 'Cancelled' });
    });

    it('cancels by permId the order the list showed, and refuses a list that is out of date', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, 12, { permId: 1240, account: 'DU1' }), { status: 'Submitted' });
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { permId: 7040, account: 'DU1' }), { status: 'Submitted' });
      // The list showed client 12's #40: refused, and this client's #40 is not cancelled instead.
      await expect(t.svc.cancel({ orderId: 40, clientId: 12, permId: 1240 })).rejects.toThrow('Order #40 belongs to API client 12');
      // Its permId or account names another order now.
      await expect(t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 1240 })).rejects.toThrow(STALE_ORDER_MESSAGE);
      await expect(t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 7040, account: 'U9' })).rejects.toThrow(STALE_ORDER_MESSAGE);
      expect(t.calls).toEqual([]);
      void t.svc.cancel({ orderId: 40, clientId: CLIENT_ID, permId: 7040, account: 'DU1' }).catch(() => undefined);
      expect(t.calls).toEqual([['cancelOrder', 40]]);
    });

    it('says what a closing socket did to the cancel', async () => {
      const t = await withOrder();
      const held = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID });
      const failed = expect(held).rejects.toThrow('The connection closed before the cancel was sent; nothing reached IB');
      t.close();
      await failed;
      t.setConnected(true);
      const written = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID });
      t.written(4, 40, '');
      t.close();
      // IB may have it: sent, not cancelled.
      await expect(written).resolves.toEqual({ status: 'sent' });
    });
  });

  describe('cancel all', () => {
    const mobile = (permId: number): Order => ({ ...lmt(0, 0, { account: 'DU1', tif: 'GTC' as never }), orderId: 0, permId });
    /** TWS's #7 (permId 9007), this client's #40 and an IBKR Mobile GTC order. */
    const listed = [9007, 9040, 780760062];

    async function withOrders() {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      t.emit('openOrder', 0, ibAapl, mobile(780760062), { status: 'PreSubmitted' });
      t.notices.length = 0;
      t.calls.length = 0;
      return t;
    }

    it('is refused unless the account and the orders are the ones the confirmation listed', async () => {
      const t = await withOrders();
      await expect(t.svc.cancelAll({ account: 'U9', permIds: listed, session: 0 })).rejects.toThrow('Account U9 is not connected; nothing was sent');
      await expect(t.svc.cancelAll({ account: 'DU1', permIds: [9007, 9040], session: 0 })).rejects.toThrow(ORDER_LIST_CHANGED_MESSAGE);
      await expect(t.svc.cancelAll({ account: 'DU1', permIds: [...listed, 1], session: 0 })).rejects.toThrow(ORDER_LIST_CHANGED_MESSAGE);
      await expect(t.svc.cancelAll({ account: 'DU1', permIds: [9007, 9040, 9040], session: 0 })).rejects.toThrow(ORDER_LIST_CHANGED_MESSAGE);
      t.setConnected(false);
      await expect(t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 })).rejects.toThrow('Not connected');
      expect(t.calls).toEqual([]);
    });

    /** IB's full list of open orders as the dialog showed them (the check before the global cancel). */
    function listAsShown(t: ReturnType<typeof setup>) {
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      t.emit('openOrder', 0, ibAapl, mobile(780760062), { status: 'PreSubmitted' });
      t.emit('openOrderEnd');
    }

    it('checks the confirmation against IB’s list asked right before the global cancel', async () => {
      const t = await withOrders();
      const p = t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 });
      const refused = expect(p).rejects.toThrow(ORDER_LIST_CHANGED_MESSAGE);
      // Nothing goes out before IB has listed its orders.
      expect(t.calls).toEqual([['reqAllOpenOrders'], ['reqCompletedOrders', false]]);
      // A stop-loss placed in IBKR Mobile since Tape last asked: the dialog never showed it.
      t.emit('openOrder', 0, ibAapl, { ...mobile(780760099), orderType: 'STP' as never, auxPrice: 220, action: 'SELL' as never }, { status: 'PreSubmitted' });
      listAsShown(t);
      await refused;
      expect(t.calls.map((c) => c[0])).not.toContain('reqGlobalCancel');
      // It is listed now: the dialog shows it, and a confirmation that names it goes out.
      expect(t.svc.getOrders().some((o) => o.permId === 780760099)).toBe(true);
      // An order cancelled elsewhere meanwhile: IB's list leaves it out.
      const q = t.svc.cancelAll({ account: 'DU1', permIds: [...listed, 780760099], session: 0 });
      const refusedAgain = expect(q).rejects.toThrow(ORDER_LIST_CHANGED_MESSAGE);
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      t.emit('openOrder', 0, ibAapl, mobile(780760062), { status: 'PreSubmitted' });
      t.emit('openOrderEnd');
      await refusedAgain;
      expect(t.calls.map((c) => c[0])).not.toContain('reqGlobalCancel');
    });

    it('sends nothing when the connection closes before IB lists its orders', async () => {
      const t = await withOrders();
      const p = t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 });
      const failed = expect(p).rejects.toThrow(CANCEL_ALL_NO_LIST_MESSAGE);
      t.close();
      await failed;
      expect(t.calls.map((c) => c[0])).not.toContain('reqGlobalCancel');
    });

    it('sends IB’s global cancel, asks for the orders again and reports what ended once IB says how', async () => {
      const t = await withOrders();
      const p = t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 });
      listAsShown(t);
      await tick();
      expect(t.calls.map((c) => c[0])).toEqual(['reqAllOpenOrders', 'reqCompletedOrders', 'reqGlobalCancel']);
      t.calls.length = 0;
      // This client hears of its own order at once; of the others only from IB's lists.
      t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(t.calls.map((c) => c[0])).toEqual(['reqAllOpenOrders', 'reqCompletedOrders']);
      // IBKR Mobile's order still works; TWS's #7 is no longer listed.
      t.emit('openOrder', 0, ibAapl, mobile(780760062), { status: 'PreSubmitted' });
      t.emit('openOrderEnd');
      let settled = false;
      void p.then(() => (settled = true));
      await tick();
      expect(t.svc.getOrders().find((o) => o.orderId === 7)).toMatchObject({ notReported: true });
      // Gone from the list is not cancelled: the result waits for how #7 ended.
      expect(settled).toBe(false);
      t.emit('completedOrder', ibAapl, { ...lmt(7, 0), filledQuantity: 0 }, { status: 'Cancelled', completedStatus: 'Cancelled by Trader' });
      t.emit('completedOrdersEnd');
      await expect(p).resolves.toEqual({ requested: 3, cancelled: 2, filled: 0, unknown: 0, stillWorking: 1 });
      expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL cancelled · PAPER DU1', 'Buy 100 AAPL cancelled · PAPER DU1']);
      // One still works: IB's lists are asked once more a moment later (no update of it comes otherwise).
      t.calls.length = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(t.calls.map((c) => c[0])).toEqual(['reqAllOpenOrders', 'reqCompletedOrders']);
    });

    it('reports another app’s order that filled as filled, with a fill notice, never as cancelled', async () => {
      const t = await withOrders();
      const p = t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 });
      listAsShown(t);
      await tick();
      t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
      await vi.advanceTimersByTimeAsync(1_000);
      // Neither #7 nor IBKR Mobile's order is listed: one was cancelled, the other had filled.
      t.emit('openOrderEnd');
      t.emit('completedOrder', ibAapl, { ...lmt(7, 0), filledQuantity: 0 }, { status: 'Cancelled', completedStatus: 'Cancelled by Trader' });
      t.emit('completedOrder', ibAapl, { ...mobile(780760062), filledQuantity: 100 }, { status: 'Filled', completedStatus: 'Filled' });
      t.emit('completedOrdersEnd');
      await expect(p).resolves.toEqual({ requested: 3, cancelled: 2, filled: 1, unknown: 0, stillWorking: 0 });
      // No execution of another app's order reaches this client: the fill is announced from IB's completed orders.
      expect(t.notices.map((n) => [n.kind, n.title.en])).toEqual([
        ['order', 'Buy 100 AAPL cancelled · PAPER DU1'],
        ['order', 'Buy 100 AAPL cancelled · PAPER DU1'],
        ['fill', 'Buy 100 AAPL filled · PAPER DU1'],
      ]);
      expect(t.notices[2].title.zh).toBe('买入 100 AAPL 已成交 · 模拟 DU1');
    });

    it('counts an order IB no longer lists without saying how as unknown, never as cancelled', async () => {
      const t = await withOrders();
      const p = t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 });
      listAsShown(t);
      await tick();
      t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
      await vi.advanceTimersByTimeAsync(1_000);
      t.emit('openOrder', 0, ibAapl, mobile(780760062), { status: 'PreSubmitted' });
      // Read-Only API: IB refuses the completed orders and never ends them.
      t.emit('openOrderEnd');
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(p).resolves.toEqual({ requested: 3, cancelled: 1, filled: 0, unknown: 1, stillWorking: 1 });
    });

    it('reports from the order list after 6 s when IB has not ended its list', async () => {
      const t = await withOrders();
      const p = t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 });
      listAsShown(t);
      await tick();
      t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(p).resolves.toEqual({ requested: 3, cancelled: 1, filled: 0, unknown: 0, stillWorking: 2 });
    });

    it('does not claim a result when the connection closes before IB lists the orders again', async () => {
      const t = await withOrders();
      const p = t.svc.cancelAll({ account: 'DU1', permIds: listed, session: 0 });
      const failed = expect(p).rejects.toThrow('The connection closed after the global cancel was sent');
      listAsShown(t);
      await tick();
      expect(t.calls.at(-1)).toEqual(['reqGlobalCancel']);
      t.close();
      await vi.advanceTimersByTimeAsync(6_000);
      await failed;
    });
  });

  describe('reconciliation with IB’s lists of open orders', () => {
    /** Tape reconnects to the same account (same session): IB lists the open orders again. */
    function reconnect(t: ReturnType<typeof setup>) {
      t.close();
      t.setConnected(true);
      t.calls.length = 0;
      t.notices.length = 0;
      t.ready();
    }

    it('marks an order IB no longer lists as not reported, and announces how it ended once IB says', async () => {
      const t = await loaded();
      t.emit('openOrder', 60, ibAapl, lmt(60, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      reconnect(t);
      // #60 expired while Tape was offline: the list leaves it out.
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrderEnd');
      expect(t.svc.getOrders().find((o) => o.orderId === 60)).toMatchObject({ status: 'Submitted', notReported: true });
      expect(t.svc.getOrders().find((o) => o.orderId === 7)).not.toHaveProperty('notReported');
      await expect(t.svc.cancel({ orderId: 60, clientId: CLIENT_ID })).rejects.toThrow('Order #60 is no longer listed by IB as working; nothing was sent');
      const completed = () => t.emit('completedOrder', ibAapl, { ...lmt(60), filledQuantity: 0 }, { status: 'Cancelled', completedStatus: 'Cancelled by System' });
      completed();
      expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL cancelled · PAPER DU1']);
      const o = t.svc.getOrders().find((x) => x.orderId === 60);
      expect(o).toMatchObject({ status: 'Cancelled', message: 'Cancelled by System' });
      expect(o).not.toHaveProperty('notReported');
      t.emit('completedOrdersEnd');
      completed();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(t.notices).toHaveLength(1);
    });

    it('announces an order nothing accounts for as no longer working when IB refuses the completed orders', async () => {
      const t = await loaded();
      reconnect(t);
      // Read-Only API: IB answers reqCompletedOrders with 321 and never ends it.
      t.emit('openOrderEnd');
      expect(t.svc.getOrders()).toEqual([expect.objectContaining({ orderId: 7, notReported: true })]);
      await vi.advanceTimersByTimeAsync(2_900);
      expect(t.notices).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Buy 100 AAPL no longer working · PAPER DU1', 'IB no longer lists it as working: it ended while Tape was disconnected']]);
      expect(t.notices[0].title.zh).toBe('买入 100 AAPL 已不在挂单中 · 模拟 DU1');
      expect(t.notices[0].orderDone).toBe(true);
      expect(t.svc.getOrders()).toEqual([]);
    });

    it('forgets the orders a list left out without a word when Tape moves to another account', async () => {
      const t = await loaded();
      reconnect(t);
      t.emit('openOrderEnd');
      t.switchSession('U1');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(t.notices).toEqual([]);
    });

    it('sweeps only at the end of a full list, never at the end of a modify’s own-orders list', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { orderType: 'MOC' as never, lmtPrice: 0 }), { status: 'PreSubmitted' });
      const m = t.svc.modify(40, { ...req, orderType: 'MOC', limitPrice: undefined, quantity: 2 });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(m).resolves.toEqual({ confirmed: false });
      expect(t.calls.at(-1)?.[0]).toBe('reqOpenOrders');
      // reqOpenOrders lists this client's orders only: TWS's #7 stays.
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { orderType: 'MOC' as never, lmtPrice: 0, totalQuantity: 2 }), { status: 'PreSubmitted' });
      t.emit('openOrderEnd');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(t.svc.getOrders().find((o) => o.orderId === 7)).not.toHaveProperty('notReported');
      expect(t.notices.filter((n) => n.title.en.includes('no longer working'))).toEqual([]);
    });

    it('does not take an unchanged order in a list for the answer to a modify', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      // A reconnect's list is on its way when the modify (of an attribute the echo cannot show) goes out.
      reconnect(t);
      const m = t.svc.modify(40, { ...req, orderRef: 'note' });
      await tick();
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      t.emit('openOrderEnd');
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(m).resolves.toEqual({ confirmed: false });
      // No answer of IB's own: this client's orders are asked for.
      expect(t.calls.at(-1)?.[0]).toBe('reqOpenOrders');
    });

    it('never modifies an order IB no longer lists', async () => {
      const t = await loaded();
      t.emit('openOrder', 60, ibAapl, lmt(60, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      reconnect(t);
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrderEnd');
      t.calls.length = 0;
      await expect(t.svc.modify(60, { ...req, limitPrice: 225 })).rejects.toThrow('Order #60 is no longer listed by IB as working; nothing was sent');
      expect(t.calls).toEqual([]);
    });

    it('asks IB’s lists again every 30 s while connected: another app’s order that ended is announced', async () => {
      const t = await loaded();
      t.notices.length = 0;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(t.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.calls).toEqual([['reqAllOpenOrders'], ['reqCompletedOrders', false]]);
      // TWS's #7 was cancelled in TWS: this client heard nothing; the list leaves it out, the completed orders say how.
      t.emit('openOrderEnd');
      expect(t.svc.getOrders()).toEqual([expect.objectContaining({ orderId: 7, notReported: true })]);
      t.emit('completedOrder', ibAapl, { ...lmt(7, 0), filledQuantity: 0 }, { status: 'Cancelled', completedStatus: 'Cancelled by Trader' });
      t.emit('completedOrdersEnd');
      expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL cancelled · PAPER DU1']);
      expect(t.svc.getOrders()).toEqual([expect.objectContaining({ orderId: 7, status: 'Cancelled' })]);
    });

    it('announces another app’s order that filled once, from IB’s completed orders', async () => {
      const t = await loaded();
      t.notices.length = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      t.emit('openOrderEnd');
      t.emit('completedOrder', ibAapl, { ...lmt(7, 0), filledQuantity: 100 }, { status: 'Filled', completedStatus: 'Filled' });
      t.emit('completedOrdersEnd');
      // Its execution, should IB report it to this client later, is not announced again.
      t.emit('execDetails', -1, ibAapl, { execId: 'e.07.01', orderId: 7, permId: 9007, acctNumber: 'DU1', side: 'BOT', shares: 100, price: 226.95, avgPrice: 226.95, time: '20261004 10:31:44 US/Eastern' });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(t.notices.map((n) => [n.kind, n.title.en, n.body.en])).toEqual([['fill', 'Buy 100 AAPL filled · PAPER DU1', 'Limit 226.95 · DAY']]);
    });

    it('sends no second list while one is asked, none while IB Gateway does not answer, none once the socket closed', async () => {
      const t = await loaded();
      await t.svc.refreshOrders();
      await t.svc.refreshOrders();
      expect(t.calls).toEqual([['reqAllOpenOrders'], ['reqCompletedOrders', false]]);
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrderEnd');
      t.calls.length = 0;
      // Read-Only API: IB would refuse the completed orders (321) every time.
      t.setHealth({ readOnlyApi: true });
      await t.svc.refreshOrders();
      expect(t.calls).toEqual([['reqAllOpenOrders']]);
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrderEnd');
      t.calls.length = 0;
      t.setHealth({ unresponsive: true });
      await vi.advanceTimersByTimeAsync(30_000);
      await t.svc.refreshOrders();
      expect(t.calls).toEqual([]);
      t.setHealth({});
      t.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.calls).toEqual([]);
      await expect(t.svc.refreshOrders()).rejects.toThrow('Not connected');
    });

    it('does not take an unchanged order in a periodic list for the answer to a modify', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      await vi.advanceTimersByTimeAsync(30_000);
      const m = t.svc.modify(40, { ...req, orderRef: 'note' });
      await tick();
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      t.emit('openOrderEnd');
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(m).resolves.toEqual({ confirmed: false });
    });

    it('asks client 0 for every client’s orders after a modify (its reqOpenOrders would bind TWS orders)', async () => {
      const t = await loaded();
      t.setClientId(0);
      t.emit('openOrder', 7, ibAapl, lmt(7, 0, { orderType: 'MOC' as never, lmtPrice: 0 }), { status: 'Submitted' });
      const m = t.svc.modify(7, { ...req, orderType: 'MOC', limitPrice: undefined, quantity: 2 });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(m).resolves.toEqual({ confirmed: false });
      expect(t.calls.at(-1)?.[0]).toBe('reqAllOpenOrders');
    });
  });

  describe('answers after the wait', () => {
    it('announces a rejection IB sends after the order’s wait, once', async () => {
      const t = await loaded();
      const p = t.svc.place(req);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toMatchObject({ confirmed: false });
      t.error(50, 201, 'Order rejected - reason: no permissions');
      t.error(50, 201, 'Order rejected - reason: no permissions');
      expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Buy 100 AAPL rejected · PAPER DU1', 'Order rejected - reason: no permissions (201)']]);
    });

    it('stops watching once IB reports the order, and after a minute', async () => {
      const t = await loaded();
      const p = t.svc.place(req);
      await vi.advanceTimersByTimeAsync(2_000);
      await p;
      t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'PreSubmitted' });
      expect(t.accepted.count).toBe(1);
      t.error(50, 201, 'Order rejected - reason: margin');
      expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL submitted · PAPER DU1']);
      const q = t.svc.place(req);
      await vi.advanceTimersByTimeAsync(2_000);
      await q;
      await vi.advanceTimersByTimeAsync(60_000);
      t.error(51, 201, 'Order rejected - reason: margin');
      expect(t.notices).toHaveLength(1);
    });

    it('announces a modify IB refuses after its wait: the order is unchanged', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      t.notices.length = 0;
      const m = t.svc.modify(40, { ...req, limitPrice: 225 });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(m).resolves.toEqual({ confirmed: false });
      t.error(40, 201, 'Order rejected - reason:Invalid Price');
      expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([['Modify of Buy 100 AAPL refused – order unchanged · PAPER DU1', 'Order rejected - reason:Invalid Price (201)']]);
      expect(t.notices[0].title.zh).toBe('买入 100 AAPL 改单被拒绝，订单未变 · 模拟 DU1');
      expect(t.notices[0].critical).toBe(true);
    });
  });

  describe('when the socket closes before IB answers an order', () => {
    it('says nothing was sent when the client had not written it, and forgets it', async () => {
      const t = await loaded();
      const p = t.svc.place(req);
      const failed = expect(p).rejects.toThrow(ORDER_NOT_SENT_MESSAGE);
      await tick();
      t.close();
      await failed;
      expect(t.notices).toEqual([]);
      t.setConnected(true);
      await expect(t.svc.cancel({ orderId: 50, clientId: CLIENT_ID })).rejects.toThrow('Order #50 was not found');
    });

    it('never calls an order IB may have rejected: it is not confirmed, and a reconnect lists it', async () => {
      const t = await loaded();
      const p = t.svc.place(req);
      const failed = expect(p).rejects.toThrow(ORDER_UNCONFIRMED_MESSAGE);
      await tick();
      t.written(3, 50);
      t.close();
      await failed;
      expect(t.notices.map((n) => [n.title.en, n.body.en])).toEqual([
        ['Buy 100 AAPL not confirmed · PAPER DU1', 'The connection closed after the order was sent, before IB confirmed it: IB may have it. Check Orders after reconnecting before sending it again'],
      ]);
      expect(t.notices[0].orderDone).toBeUndefined();
      // Comes through do-not-disturb: sending it again could double the order.
      expect(t.notices[0].critical).toBe(true);
      // The same account again: IB has it.
      t.setConnected(true);
      t.ready();
      t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
      t.emit('openOrder', 50, ibAapl, lmt(50), { status: 'Submitted' });
      t.emit('openOrderEnd');
      expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL not confirmed · PAPER DU1', 'Buy 100 AAPL submitted · PAPER DU1']);
      expect(t.svc.getOrders().find((o) => o.orderId === 50)?.status).toBe('Submitted');
    });

    it('says a modify may have changed the order only when it was written', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      const held = t.svc.modify(40, { ...req, limitPrice: 225 });
      const unchanged = expect(held).rejects.toThrow('The connection closed before the modify was sent; order #40 is unchanged');
      await tick();
      t.close();
      await unchanged;
      t.setConnected(true);
      const sent = t.svc.modify(40, { ...req, limitPrice: 225 });
      const unknown = expect(sent).rejects.toThrow('The connection closed before IB confirmed the modify of order #40');
      await tick();
      t.written(3, 40);
      t.close();
      await unknown;
    });
  });

  describe('brackets with a failed leg', () => {
    const child = (id: number) => lmt(id, CLIENT_ID, { parentId: 50, action: 'SELL' as never });
    async function placed() {
      const t = await loaded();
      const p = t.svc.place({ ...req, bracket: { takeProfit: 233, stopLoss: 222 } });
      await tick();
      for (const id of [50, 51, 52]) t.emit('openOrder', id, ibAapl, id === 50 ? lmt(50) : child(id), { status: 'PreSubmitted' });
      await expect(p).resolves.toMatchObject({ confirmed: true });
      t.calls.length = 0;
      return t;
    }

    it('withdraws the rest when IB rejects a leg it had accepted', async () => {
      const t = await placed();
      t.emit('openOrder', 52, ibAapl, child(52), { status: 'Inactive' });
      t.error(52, 201, 'Order rejected - reason: stop price');
      expect(t.calls).toEqual([
        ['cancelOrder', 50],
        ['cancelOrder', 51],
      ]);
      expect(t.notices.at(-1)?.body.en).toBe('Order rejected - reason: stop price (201) · Cancel sent for the rest of the bracket: entry #50 and take-profit #51');
    });

    it('keeps the exit that protects a filled entry and says the other one is missing', async () => {
      const t = await placed();
      t.emit('orderStatus', 50, 'Filled', 100, 0, 226.95, 9050, 0, 226.95, CLIENT_ID, '');
      t.emit('openOrder', 51, ibAapl, child(51), { status: 'Inactive' });
      t.error(51, 201, 'Order rejected - reason: price');
      expect(t.calls).toEqual([]);
      expect(t.notices.at(-1)).toMatchObject({
        title: { en: 'Sell 100 AAPL rejected · PAPER DU1' },
        body: { en: 'Order rejected - reason: price (201) · Entry #50 has filled 100: the other exit order keeps working, the position has no take-profit' },
      });
    });
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
      await expect(m).resolves.toEqual({ confirmed: true });
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
      await expect(ok).resolves.toEqual({ confirmed: true });
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
      await expect(m).resolves.toEqual({ confirmed: true });
    });

    it('reports a MOC modify without an answer from IB as sent, not confirmed, and asks for the open orders', async () => {
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
      await expect(m).resolves.toEqual({ confirmed: false });
      // IB shows the change in this client's open orders.
      expect(t.calls.at(-1)?.[0]).toBe('reqOpenOrders');
      // A modify IB answered does not ask.
      const m2 = t.svc.modify(40, { ...req, orderType: 'MOC', limitPrice: undefined, quantity: 3 });
      await tick();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { orderType: 'MOC' as never, lmtPrice: 0, totalQuantity: 3 }), { status: 'PreSubmitted' });
      await expect(m2).resolves.toEqual({ confirmed: true });
      expect(t.calls.at(-1)?.[0]).toBe('placeOrder');
    });
  });

  describe('when Tape moves to another account or Gateway', () => {
    const exec = (id: string, extra: object = {}) => ({
      execId: id,
      orderId: 40,
      permId: 9040,
      acctNumber: 'DU1',
      side: 'BOT',
      shares: 10,
      price: 226.95,
      avgPrice: 226.95,
      time: '20261004 10:31:44 US/Eastern',
      ...extra,
    });
    /** An order IBKR Mobile / TWS placed (order id 0, client 0) on the live account. */
    const mobileGtc = (permId: number): Order => ({ ...lmt(0, 0, { account: 'U1', tif: 'GTC' as never }), orderId: 0, permId });
    const listed = (t: ReturnType<typeof setup>) => t.svc.getOrders().map((o) => [o.clientId, o.orderId, o.account]);

    /** The new session's handshake and first load (snapshot ends included). */
    function loadNew(t: ReturnType<typeof setup>, load: () => void = () => undefined) {
      t.calls.length = 0;
      t.ready();
      const execReqId = t.calls.find((c) => c[0] === 'reqExecutions')![1] as number;
      load();
      t.emit('openOrderEnd');
      t.emit('execDetailsEnd', execReqId);
      return execReqId;
    }

    it('forgets the previous account’s orders and fills at once, and lists only the new one’s', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      t.emit('execDetails', -1, ibAapl, exec('e.01.01'));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(t.svc.getOrders()).toHaveLength(2);
      expect(t.svc.getExecutions()).toHaveLength(1);
      t.events.length = 0;
      t.switchSession('U1');
      // Before any timer runs: the renderer drops the paper rows before anything of the new session.
      expect(t.events).toEqual([
        { type: 'orders', orders: [] },
        { type: 'executions', executions: [] },
      ]);
      expect(t.svc.getOrders()).toEqual([]);
      expect(t.svc.getExecutions()).toEqual([]);
      loadNew(t, () => t.emit('openOrder', 0, ibAapl, mobileGtc(1620569957), { status: 'PreSubmitted' }));
      expect(listed(t)).toEqual([[0, 0, 'U1']]);
    });

    it('does not announce the new account’s open orders and fills as new', async () => {
      const t = await loaded();
      t.notices.length = 0;
      t.switchSession('U1');
      loadNew(t, () => {
        // As on 10-13 19:08: four GTC orders from IBKR Mobile, and a fill from earlier in the day.
        for (const permId of [1620569957, 2124812801, 780760062, 780759989]) t.emit('openOrder', 0, ibAapl, mobileGtc(permId), { status: 'PreSubmitted' });
        t.emit('execDetails', t.calls.find((c) => c[0] === 'reqExecutions')![1], ibAapl, exec('e.09.01', { acctNumber: 'U1' }));
      });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(t.notices).toEqual([]);
      // What happens from now on is news.
      t.emit('openOrder', 0, ibAapl, mobileGtc(780760062), { status: 'Cancelled' });
      expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL cancelled · LIVE U1']);
    });

    it('names a notice owed to the previous account by that account, never the new one', async () => {
      const t = await loaded();
      t.notices.length = 0;
      // Rejected on paper; IB's reason has not come when Tape moves to the live account.
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Inactive' });
      // One IB reported without its account: unknown, so no account at all rather than the live one.
      t.emit('openOrder', 41, ibAapl, lmt(41), { status: 'Inactive' });
      expect(t.notices).toEqual([]);
      t.switchSession('U1');
      expect(t.notices.map((n) => [n.title.en, n.account])).toEqual([
        ['Buy 100 AAPL rejected · PAPER DU1', 'DU1'],
        ['Buy 100 AAPL rejected', undefined],
      ]);
      // The new session's own notices name it.
      loadNew(t);
      t.emit('openOrder', 0, ibAapl, mobileGtc(780760062), { status: 'PreSubmitted' });
      t.emit('openOrder', 0, ibAapl, mobileGtc(780760062), { status: 'Cancelled' });
      expect(t.notices.at(-1)).toMatchObject({ title: { en: 'Buy 100 AAPL cancelled · LIVE U1' }, account: 'U1' });
    });

    it('keeps orders and notice state across a plain reconnect, and announces fills found on it', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
      t.notices.length = 0;
      t.events.length = 0;
      t.close();
      t.setConnected(true);
      const execReqId = loadNew(t, () => {
        t.emit('openOrder', 7, ibAapl, lmt(7, 0), { status: 'Submitted' });
        t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'DU1' }), { status: 'Submitted' });
        // Filled while Tape was offline.
        t.emit('execDetails', t.calls.find((c) => c[0] === 'reqExecutions')![1], ibAapl, exec('e.02.01'));
      });
      expect(execReqId).toBeGreaterThan(0);
      expect(t.events.filter((e) => e.type === 'orders' && e.orders.length === 0)).toEqual([]);
      expect(t.svc.getOrders().map((o) => o.orderId)).toEqual(expect.arrayContaining([7, 40]));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(t.notices.map((n) => n.kind)).toEqual(['fill']);
    });

    it('refuses an order id the previous session sent, without sending anything', async () => {
      const t = await loaded();
      const p = t.svc.place(req);
      await vi.advanceTimersByTimeAsync(2_000); // IB never answered: #50 counts as sent
      await expect(p).resolves.toMatchObject({ orderId: 50 });
      t.switchSession('U1');
      loadNew(t);
      t.calls.length = 0;
      // On the new login, #50 is whatever order this client has with that id there.
      await expect(t.svc.cancel({ orderId: 50, clientId: CLIENT_ID })).rejects.toThrow('Order #50 was not found');
      await expect(t.svc.modify(50, req)).rejects.toThrow('Order #50 was not found');
      expect(t.calls).toEqual([]);
    });

    it('announces the rejection of an order whose id the previous account used, with its own state', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      t.emit('orderStatus', 40, 'Submitted', 30, 70, 226.95, 9040, 0, 226.95, CLIENT_ID, '');
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Inactive' });
      t.error(40, 201, 'Order rejected - reason: margin');
      const rejection = (n: NewNotification) => n.title.en.includes(' rejected');
      expect(t.notices.filter(rejection)).toHaveLength(1);
      t.switchSession('U1');
      loadNew(t);
      vi.setSystemTime(Date.now() + 60_000);
      t.emit('openOrder', 40, ibAapl, lmt(40, CLIENT_ID, { account: 'U1', permId: 777 }), { status: 'Inactive' });
      t.error(40, 201, 'Order rejected - reason: no permissions');
      const rejections = t.notices.filter(rejection).map((n) => n.body.en);
      expect(rejections).toHaveLength(2);
      expect(rejections[1]).toContain('no permissions');
      // Nothing of the paper #40 carries over (its fills, its first-seen time).
      expect(t.svc.getOrders().find((o) => o.orderId === 40)).toMatchObject({ account: 'U1', filled: 0, createdAt: Date.now() });
    });

    it('does not let a request the switch failed silence the new account’s notices for its ids', async () => {
      const t = await loaded();
      const p = t.svc.place(req);
      // The client had not written it when the socket closed: nothing reached IB.
      const failed = expect(p).rejects.toThrow(ORDER_NOT_SENT_MESSAGE);
      await tick();
      t.switchSession('U1');
      await failed;
      t.notices.length = 0;
      loadNew(t);
      t.emit('openOrder', 50, ibAapl, lmt(50, CLIENT_ID, { account: 'U1' }), { status: 'Inactive' });
      t.error(50, 201, 'Order rejected - reason: margin');
      expect(t.notices.map((n) => n.title.en)).toEqual(['Buy 100 AAPL rejected · LIVE U1']);
    });

    it('does not reuse the previous account’s preview', async () => {
      const t = await loaded();
      const a = t.svc.preview(req);
      await tick();
      const id = t.calls[0][1] as number;
      t.emit('openOrder', id, ibAapl, { ...lmt(id), whatIf: true }, { status: 'PreSubmitted', initMarginChange: 4000, commission: 1 });
      await expect(a).resolves.toMatchObject({ initMargin: { change: 4000 } });
      t.switchSession('U1');
      loadNew(t);
      t.calls.length = 0;
      const b = t.svc.preview(req);
      await tick();
      const sent = t.calls.filter((c) => c[0] === 'placeOrder');
      expect(sent).toHaveLength(1);
      expect(sent[0][3]).toMatchObject({ whatIf: true, account: 'U1' });
      t.emit('openOrder', sent[0][1], ibAapl, { ...lmt(sent[0][1] as number), whatIf: true }, { status: 'PreSubmitted', initMarginChange: 15000, commission: 1 });
      await expect(b).resolves.toMatchObject({ initMargin: { change: 15000 } });
    });

    it('gives the previous session’s pending fill notice before forgetting it', async () => {
      const t = await loaded();
      t.emit('execDetails', -1, ibAapl, exec('e.03.01'));
      expect(t.notices).toEqual([]);
      t.switchSession('U1');
      // Within the 3 s wait for its commission: announced now, as the fill it is.
      expect(t.notices.map((n) => [n.kind, n.title.en, n.body.en])).toEqual([['fill', 'AAPL: bought 10 shares · PAPER DU1', 'Avg 226.95 · Commission — · Order #40']]);
      await vi.advanceTimersByTimeAsync(3_100);
      expect(t.notices).toHaveLength(1);
    });

    it('refuses requests made for another session before sending anything', async () => {
      const t = await loaded();
      t.emit('openOrder', 40, ibAapl, lmt(40), { status: 'Submitted' });
      t.setSession(2);
      await expect(t.svc.place(req, 1)).rejects.toThrow(SESSION_CHANGED_MESSAGE);
      await expect(t.svc.modify(40, req, 1)).rejects.toThrow(SESSION_CHANGED_MESSAGE);
      await expect(t.svc.cancel({ orderId: 40, clientId: CLIENT_ID }, 1)).rejects.toThrow(SESSION_CHANGED_MESSAGE);
      await expect(t.svc.preview(req, 1)).rejects.toThrow(SESSION_CHANGED_MESSAGE);
      await expect(t.svc.cancelAll({ account: 'DU1', permIds: [9007, 9040], session: 1 })).rejects.toThrow(SESSION_CHANGED_MESSAGE);
      expect(t.calls).toEqual([]);
      // The current session's requests go out.
      const c = t.svc.cancel({ orderId: 40, clientId: CLIENT_ID }, 2);
      expect(t.calls).toEqual([['cancelOrder', 40]]);
      t.emit('orderStatus', 40, 'Cancelled', 0, 100, 0, 9040, 0, 0, CLIENT_ID, '');
      await expect(c).resolves.toEqual({ status: 'Cancelled' });
    });

    it('does not send an order when the login changes on the same instance while its contract is resolved', async () => {
      const t = await loaded();
      const release = t.holdLookups();
      const p = t.svc.place({ ...req, contract: stock('AAPL') });
      await tick();
      t.setSession(1); // same IBApi instance and client id, another account
      release();
      await expect(p).rejects.toThrow(CONNECTION_CHANGED_MESSAGE);
      expect(t.calls).toEqual([]);
    });

    it('never cancels or modifies an order of an account the login does not manage', async () => {
      const t = await loaded();
      t.emit('openOrder', 41, ibAapl, lmt(41, CLIENT_ID, { account: 'U9' }), { status: 'Submitted' });
      const refused = 'Order #41 belongs to account U9, which is not connected; nothing was sent';
      await expect(t.svc.cancel({ orderId: 41, clientId: CLIENT_ID, account: 'U9' })).rejects.toThrow(refused);
      await expect(t.svc.modify(41, req)).rejects.toThrow(refused);
      expect(t.calls).toEqual([]);
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

    it('never sends a preview that is not a what-if order', async () => {
      const t = await loaded();
      previewBuild.dropWhatIf = true;
      try {
        await expect(t.svc.preview(req)).rejects.toThrow('Internal error: a preview must be a what-if order; nothing was sent');
      } finally {
        previewBuild.dropWhatIf = false;
      }
      expect(t.calls).toEqual([]);
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
