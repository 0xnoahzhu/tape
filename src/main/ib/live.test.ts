// Integration check against a running TWS / IB Gateway (paper account). Skipped unless
// TAPE_LIVE_IB is set, e.g.:
//
//   TAPE_LIVE_IB=127.0.0.1:4002 TAPE_CLIENT_ID=165 pnpm vitest run src/main/ib/live.test.ts
//
// It connects, loads account / positions / orders / executions and the NAV history (through an
// in-memory ctx.db), checks the API log and its on-demand streaming, tries to place a GTC limit
// order far below the market (rejected when the API is read-only; otherwise cancelled right
// away and checked to be gone), and lets a settings change fail its first attempt (closed port)
// to check that it retries. Use a client id no other program uses.
//
// Every order id it uses is recorded. Whatever fails (a cancel without answer, place() throwing
// after IB took the order, a lost connection), the orders it sent are cancelled again, after a
// reconnect with the same client id if needed (order ids are per client), and reqAllOpenOrders
// must then list no working order of this client id. A run killed before that cleanup (Ctrl+C, a
// crash, a hook timeout) leaves its order working: the next run cancels every working order of
// this client id that has the test order's shape, before placing its own and after it.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import type { NewNotification, TapeEvent } from '@shared/ipc';
import { isOrderActive, type OrderStatus, type Settings } from '@shared/types';
import type { MainContext } from '../context';
import { createMemoryDatabase } from '../db/memory';
import type { Contract, Order, OrderState } from './tws';

const live = process.env.TAPE_LIVE_IB;
const logDir = mkdtempSync(join(tmpdir(), 'tape-live-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => logDir,
    whenReady: () => Promise.resolve(),
    on: () => undefined,
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)('live IB Gateway', async () => {
  const { createApiLog } = await import('./apiLog');
  const { createConnection } = await import('./connection');
  const { createAccountService } = await import('./account');
  const { createOrderService } = await import('./orders');

  const [host, portText] = (live ?? '127.0.0.1:4002').split(':');
  const port = Number(portText);
  let settings: Settings = defaultSettings();
  settings = { ...settings, connection: { ...settings.connection, host, port } };
  const settingsListeners: Array<(next: Settings, prev: Settings) => void> = [];
  const changeConnection = (patch: Partial<Settings['connection']>) => {
    const prev = settings;
    settings = { ...settings, connection: { ...settings.connection, ...patch } };
    for (const l of settingsListeners) l(settings, prev);
  };
  const events: TapeEvent[] = [];
  const notices: NewNotification[] = [];
  const ctx = {
    demo: false,
    isDev: true,
    emit: (e: TapeEvent) => events.push(e),
    store: {
      getSettings: () => settings,
      onSettingsChanged: (l: (next: Settings, prev: Settings) => void) => {
        settingsListeners.push(l);
        return () => undefined;
      },
      // No legacy nav.json to import: NAV goes to ctx.db.nav only.
      getNav: () => [],
      setNav: () => undefined,
    },
    notifier: { notify: (n: NewNotification) => (notices.push(n), n) },
    contracts: { getInfo: async () => null, resolve: async (c: unknown) => c },
    db: createMemoryDatabase(),
  } as unknown as MainContext;
  ctx.apiLog = createApiLog(ctx);
  ctx.ib = createConnection(ctx);
  ctx.account = createAccountService(ctx);
  ctx.orders = createOrderService(ctx);
  await sleep(10); // deferred subscriptions

  /** The order the test places: far below the market, so it never fills. */
  const testOrder = { contract: stock('AAPL'), action: 'BUY' as const, orderType: 'LMT' as const, quantity: 1, limitPrice: 1, tif: 'GTC' as const, outsideRth: false };
  const hasTestOrderShape = (contract: Contract, order: Order) =>
    contract?.symbol === testOrder.contract.symbol &&
    order.action === testOrder.action &&
    order.orderType === testOrder.orderType &&
    Number(order.totalQuantity) === testOrder.quantity &&
    order.lmtPrice === testOrder.limitPrice &&
    order.tif === testOrder.tif;

  /** Order ids this run used (bracket children included) that are not known to be done. */
  const sentOrderIds = new Set<number>();
  const nextOrderId = ctx.ib.nextOrderId;
  ctx.ib.nextOrderId = () => {
    const id = nextOrderId();
    sentOrderIds.add(id);
    return id;
  };

  /** A working order of this client id as reqAllOpenOrders lists it. */
  interface ListedOrder {
    orderId: number;
    status: string;
    /** It has the test order's shape (perhaps left by a killed run). */
    testShaped: boolean;
  }

  /** This client's working orders as IB lists them now (reqAllOpenOrders: every client's). */
  async function workingOrdersOfThisClient(): Promise<ListedOrder[]> {
    const api = ctx.ib.api;
    if (!api) throw new Error('Not connected: cannot list the open orders');
    const me = ctx.ib.getState().clientId;
    const working = new Map<number, ListedOrder>();
    const offs = [
      ctx.ib.on('openOrder', (orderId: number, contract: Contract, order: Order, state: OrderState) => {
        if (order.clientId !== me) return;
        const status = String(state?.status ?? '');
        if (isOrderActive(status as OrderStatus)) working.set(orderId, { orderId, status, testShaped: hasTestOrderShape(contract, order) });
        else working.delete(orderId);
      }),
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No openOrderEnd within 5 s')), 5000);
        offs.push(
          ctx.ib.on('openOrderEnd', () => {
            clearTimeout(timer);
            resolve();
          }),
        );
        api.reqAllOpenOrders();
      });
    } finally {
      for (const off of offs) off();
    }
    return [...working.values()];
  }

  /** Back on the real Gateway with this client id (a failed test may have left it elsewhere). */
  async function reconnect(): Promise<void> {
    if (settings.connection.host !== host || settings.connection.port !== port) {
      changeConnection({ host, port });
      await sleep(1500); // the change closes the old socket and reconnects if a connection was wanted
    }
    if (!ctx.ib.isConnected()) await ctx.ib.connect();
    await sleep(1000); // the initial order lists
  }

  /**
   * Cancels the working orders of this client id that this run sent or that have the test order's
   * shape (on a paper account), until none is, and returns the working orders of this client id
   * that are left (none expected: the client id is this test's).
   */
  async function cancelTestOrders(): Promise<ListedOrder[]> {
    if (!ctx.ib.isConnected()) await reconnect();
    const ours = (o: ListedOrder) => sentOrderIds.has(o.orderId) || (o.testShaped && ctx.ib.getState().isPaper);
    let working = await workingOrdersOfThisClient();
    for (let i = 0; i < 3 && working.some(ours); i++) {
      for (const o of working) if (ours(o)) ctx.ib.api?.cancelOrder(o.orderId);
      await sleep(2000);
      working = await workingOrdersOfThisClient();
    }
    for (const id of [...sentOrderIds]) if (!working.some((o) => o.orderId === id)) sentOrderIds.delete(id);
    if (working.length) console.error('still working:', JSON.stringify(working));
    return working;
  }

  afterAll(async () => {
    try {
      // Only when an earlier cleanup could not confirm that every order this run sent is done.
      if (sentOrderIds.size) {
        console.log('cleaning up orders', [...sentOrderIds].join(', '));
        const left = await cancelTestOrders();
        if (left.length) throw new Error(`Orders of client ${ctx.ib.getState().clientId} still working: ${JSON.stringify(left)}`);
      }
    } finally {
      await ctx.ib.disconnect();
    }
  }, 60_000);

  it('connects and loads the account', async () => {
    await ctx.ib.connect();
    await sleep(3000);
    const state = ctx.ib.getState();
    console.log('connection', JSON.stringify(state));
    expect(state.status).toBe('connected');
    expect(state.account).toBeTruthy();
    expect(state.serverVersion).toBeGreaterThanOrEqual(176);
    const summary = ctx.account.getSummary();
    console.log('summary', JSON.stringify(summary));
    expect(summary?.netLiquidation).toBeGreaterThan(0);
    console.log('positions', ctx.account.getPositions().length, 'orders', ctx.orders.getOrders().length, 'executions', ctx.orders.getExecutions().length);
    for (const o of ctx.orders.getOrders()) console.log('order', o.clientId, o.orderId, o.permId, o.action, o.totalQuantity, o.contract.symbol, o.orderType, o.status, o.message ?? '');
    const nav = await ctx.db.nav.all();
    console.log('nav', JSON.stringify(nav));
    expect(nav.length).toBeGreaterThan(0);
  });

  it('records and names the frames', () => {
    const entries = ctx.apiLog.getEntries();
    const names = new Set(entries.map((e) => e.name));
    for (const n of ['API handshake', 'serverVersion', 'startApi', 'managedAccounts', 'nextValidId', 'reqAccountSummary', 'accountSummary', 'reqPositions', 'reqAllOpenOrders', 'openOrderEnd', 'reqExecutions', 'execDetailsEnd', 'reqCurrentTime', 'currentTime']) {
      expect(names, n).toContain(n);
    }
    const unnamed = entries.filter((e) => e.fields.some(([k]) => /^f\d+$/.test(k)));
    console.log('entries', entries.length, 'with unnamed fields:', [...new Set(unnamed.map((e) => e.name))].join(', ') || 'none');
    for (const e of entries.slice(0, 12)) console.log(e.dir, e.name, e.reqId ?? '-', e.fields.map(([k, v]) => `${k}=${v}`).join('  ').slice(0, 160));
    console.log('farms', JSON.stringify(ctx.ib.getState().farms), 'latency', ctx.ib.getState().latencyMs, 'lastError', JSON.stringify(ctx.ib.getState().lastError));
  });

  it('streams the API log only while a view asks for it', async () => {
    const batches = () => events.filter((e) => e.type === 'apiLog');
    expect(batches()).toEqual([]);
    ctx.apiLog.setStreaming(true);
    await sleep(1500);
    const sent = batches();
    console.log('apiLog batches', sent.length, 'entries', sent.reduce((n, e) => n + (e.type === 'apiLog' ? e.entries.length : 0), 0));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].type === 'apiLog' && sent[0].logFilePath).toBe(ctx.apiLog.filePath());
    ctx.apiLog.setStreaming(false);
    await sleep(300);
    const count = batches().length;
    await sleep(1500);
    expect(batches().length).toBe(count);
  });

  it('places a far-from-market order (rejected when the API is read-only)', async () => {
    const mine = () => ctx.orders.getOrders().filter((o) => o.clientId === ctx.ib.getState().clientId);
    // Paper accounts only.
    expect(ctx.ib.getState().isPaper).toBe(true);
    // What an earlier run could not cancel goes first; any other working order of this client id
    // means another program uses it.
    expect(await cancelTestOrders()).toEqual([]);
    let left: ListedOrder[] = [];
    try {
      const res = await ctx.orders.place(testOrder);
      console.log('placed', JSON.stringify(res));
      await sleep(1500);
      console.log('order', JSON.stringify(ctx.orders.getOrders().find((o) => o.orderId === res.orderId)));
      await ctx.orders.cancel(res.orderId);
      await sleep(1500);
      console.log('after cancel', JSON.stringify(ctx.orders.getOrders().find((o) => o.orderId === res.orderId)));
    } catch (err) {
      console.log('place failed:', (err as Error).message);
      expect((err as Error).message).toMatch(/Read-Only|\(\d+\)/);
    } finally {
      // Also after a failure above: nothing this run sent may stay working (IB's own list).
      left = await cancelTestOrders();
    }
    expect(left).toEqual([]);
    expect(sentOrderIds.size).toBe(0);
    // Nothing of this client may stay working.
    expect(mine().filter((o) => isOrderActive(o.status)).map((o) => [o.orderId, o.status])).toEqual([]);
    console.log('notices', JSON.stringify(notices.map((n) => [n.kind, n.title.en, n.body.en])));
  }, 30_000);

  it('refuses to cancel orders of other clients and unknown ids', async () => {
    const me = ctx.ib.getState().clientId;
    const own = new Set(ctx.orders.getOrders().filter((o) => o.clientId === me).map((o) => o.orderId));
    const foreign = ctx.orders.getOrders().find((o) => o.clientId !== me && o.orderId !== 0 && !own.has(o.orderId) && isOrderActive(o.status));
    if (foreign) {
      await expect(ctx.orders.cancel(foreign.orderId)).rejects.toThrow(`belongs to`);
      console.log('foreign order refused:', foreign.clientId, foreign.orderId);
    } else {
      console.log('no working order of another client to check');
    }
    await expect(ctx.orders.cancel(2_000_000_000)).rejects.toThrow('was not found');
  });

  it('retries when the first attempt after a settings change fails', async () => {
    // Nothing listens on port 1 of the local host: ECONNREFUSED.
    changeConnection({ host: '127.0.0.1', port: 1 });
    await sleep(2500);
    const failed = ctx.ib.getState();
    console.log('after the change', failed.status, failed.reconnectAttempt, JSON.stringify(failed.lastError));
    expect(failed).toMatchObject({ status: 'reconnecting', reconnectAttempt: 1, port: 1, lastError: { code: 502 } });
    changeConnection({ host, port });
    for (let i = 0; i < 50 && ctx.ib.getState().status !== 'connected'; i++) await sleep(200);
    expect(ctx.ib.getState()).toMatchObject({ status: 'connected', port });
    await sleep(1500);
  });

  it('refuses orders when disconnected', async () => {
    const req = { contract: stock('AAPL'), action: 'BUY' as const, orderType: 'LMT' as const, quantity: 1, limitPrice: 1, tif: 'DAY' as const, outsideRth: false };
    await ctx.ib.disconnect();
    expect(ctx.ib.getState().status).toBe('disconnected');
    await expect(ctx.orders.place(req)).rejects.toThrow('Not connected');
    const last = ctx.apiLog.getEntries().at(-1);
    expect(last?.name).toBe('socket close');
  });
});
