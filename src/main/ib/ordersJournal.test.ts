import type { Contract, IBApi } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { NewNotification, TapeEvent } from '@shared/ipc';
import type { Execution } from '@shared/types';
import type { IbConnection, IbListener, MainContext } from '../context';
import { createMemoryDatabase } from '../db/memory';
import type { Database } from '../db/types';
import { createOrderService } from './orders';

const ibAapl: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK' as never, exchange: 'SMART', currency: 'USD' };
const ibExec = (execId: string, time = '20261005 10:31:44 US/Eastern', price = 226.95) => ({
  execId,
  orderId: 50,
  permId: 9050,
  acctNumber: 'DU1',
  side: 'BOT',
  shares: 10,
  price,
  avgPrice: price,
  time,
});
const journaled = (execId: string, time: number, extra: Partial<Execution> = {}): Execution => ({
  execId,
  orderId: 50,
  key: 'AAPL',
  contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: 265598 },
  side: 'BUY',
  shares: 10,
  price: 226.95,
  time,
  ...extra,
});

/** 2026-10-05 11:00 New York. */
const NOW = Date.UTC(2026, 9, 5, 15, 0);
const TODAY_0931 = Date.UTC(2026, 9, 5, 13, 31);
const YESTERDAY = Date.UTC(2026, 9, 4, 19, 0);

function setup(db: Database, login: { accounts: string[]; account?: string } = { accounts: ['DU1'], account: 'DU1' }) {
  const listeners = new Map<string, Set<IbListener>>();
  const ready = new Set<(api: IBApi) => void>();
  const api = new Proxy({}, { get: () => () => undefined }) as unknown as IBApi;
  const ib = {
    get api() {
      return api;
    },
    getState: () => ({ status: 'connected', host: 'h', port: 1, clientId: 141, isPaper: true, farms: {}, ...login }),
    isConnected: () => true,
    nextReqId: (() => {
      let id = 1000;
      return () => id++;
    })(),
    nextOrderId: () => 50,
    on(event: string, l: IbListener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(l);
      return () => listeners.get(event)!.delete(l);
    },
    onReady: (l: (api: IBApi) => void) => (ready.add(l), () => ready.delete(l)),
    onClosed: () => () => undefined,
    onRequestError: () => () => undefined,
  } as unknown as IbConnection;
  const events: TapeEvent[] = [];
  const notices: NewNotification[] = [];
  const ctx = {
    emit: (e: TapeEvent) => events.push(e),
    store: { getSettings: () => defaultSettings() },
    notifier: { notify: (n: NewNotification) => (notices.push(n), n) },
    contracts: { resolve: async (c: unknown) => c, getInfo: async () => null },
    account: { getPositions: () => [] },
    ib,
    db,
  } as unknown as MainContext;
  const svc = createOrderService(ctx);
  return {
    svc,
    events,
    notices,
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => l(...args)),
    ready: () => ready.forEach((l) => l(api)),
    /** The handshake of another login (accounts named by managedAccounts, then ready). */
    login(accounts: string[]) {
      login.accounts = accounts;
      login.account = accounts[0];
      ready.forEach((l) => l(api));
    },
  };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('execution journal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('writes every execution with its commission, once per change', async () => {
    const db = createMemoryDatabase();
    const put = vi.spyOn(db.executions, 'put');
    const t = setup(db);
    await tick();
    t.ready();
    t.emit('execDetails', 1000, ibAapl, ibExec('e.01.01'));
    t.emit('commissionReport', { execId: 'e.01.01', commission: 1.25, currency: 'USD', realizedPNL: 1.7976931348623157e308 });
    t.emit('execDetailsEnd', 1000);
    await tick(100);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0].map((e) => [e.execId, e.commission])).toEqual([['e.01.01', 1.25]]);

    // A reconnect resends the day: unchanged executions are not written again.
    t.emit('execDetails', 1001, ibAapl, ibExec('e.01.01'));
    t.emit('commissionReport', { execId: 'e.01.01', commission: 1.25, currency: 'USD', realizedPNL: 1.7976931348623157e308 });
    await tick(100);
    expect(put).toHaveBeenCalledTimes(1);

    // A correction is written under its own id; the journal keeps the latest per base id on restore.
    t.emit('execDetails', -1, ibAapl, ibExec('e.01.02', undefined, 226.9));
    await tick(100);
    expect(put).toHaveBeenCalledTimes(2);
    const rows = (await db.executions.since(0)).map((e) => [e.execId, e.price, e.commission]);
    expect(rows.sort()).toEqual([
      ['e.01.01', 226.95, 1.25],
      ['e.01.02', 226.9, 1.25],
    ]);
  });

  it("restores today's fills after a restart; IB's data wins and nothing is announced again", async () => {
    const db = createMemoryDatabase();
    await db.executions.put([
      journaled('a.01.01', TODAY_0931),
      journaled('a.01.02', TODAY_0931, { price: 226.5 }), // correction
      journaled('b.01.01', TODAY_0931 + 60_000, { commission: 1 }),
      journaled('y.01.01', YESTERDAY),
    ]);
    const t = setup(db);
    await tick(100);
    expect(t.svc.getExecutions().map((e) => [e.execId, e.price])).toEqual([
      ['b.01.01', 226.95],
      ['a.01.02', 226.5],
    ]);
    expect(t.events.filter((e) => e.type === 'executions')).toHaveLength(1);

    // After the Gateway comes back, IB sends one of them again (and a new fill).
    t.ready();
    t.emit('execDetails', 1000, ibAapl, ibExec('b.01.01', '20261005 09:32:44 US/Eastern', 227));
    t.emit('execDetailsEnd', 1000);
    t.emit('execDetails', -1, ibAapl, ibExec('a.01.02', '20261005 09:31:00 US/Eastern', 226.5));
    await tick(3_000);
    const b = t.svc.getExecutions().find((e) => e.execId === 'b.01.01');
    expect([b?.price, b?.commission]).toEqual([227, 1]);
    expect(t.svc.getExecutions()).toHaveLength(2);
    expect(t.notices).toEqual([]);
  });

  it('drops restored fills of accounts the connected login does not have', async () => {
    const db = createMemoryDatabase();
    await db.executions.put([
      journaled('p.01.01', TODAY_0931, { account: 'DU1' }), // paper, earlier today
      journaled('l.01.01', TODAY_0931 + 60_000, { account: 'U2' }),
      journaled('n.01.01', TODAY_0931 + 120_000), // no account recorded: kept
    ]);
    // Before the first handshake the accounts are unknown: everything is shown.
    const t = setup(db, { accounts: [] });
    await tick(100);
    expect(t.svc.getExecutions().map((e) => e.execId)).toEqual(['n.01.01', 'l.01.01', 'p.01.01']);

    // The live login names its accounts: the paper fill goes, and stays gone on reconnects.
    t.login(['U2']);
    await tick(100);
    expect(t.svc.getExecutions().map((e) => e.execId)).toEqual(['n.01.01', 'l.01.01']);
    const last = t.events.filter((e) => e.type === 'executions').at(-1);
    expect(last?.type === 'executions' && last.executions.map((e) => e.execId)).toEqual(['n.01.01', 'l.01.01']);
    t.login(['U2']);
    await tick(100);
    expect(t.svc.getExecutions()).toHaveLength(2);
  });

  it("restores only the login's accounts when they are known before the journal is read", async () => {
    const db = createMemoryDatabase();
    await db.executions.put([journaled('p.01.01', TODAY_0931, { account: 'DU1' }), journaled('l.01.01', TODAY_0931, { account: 'U2' })]);
    const t = setup(db, { accounts: ['U2'], account: 'U2' });
    await tick(100);
    expect(t.svc.getExecutions().map((e) => e.execId)).toEqual(['l.01.01']);
    expect(t.events.filter((e) => e.type === 'executions').flatMap((e) => (e.type === 'executions' ? e.executions : [])).map((e) => e.execId)).not.toContain('p.01.01');
  });

  it('IB executions received before the journal is read are kept as they are', async () => {
    const db = createMemoryDatabase();
    await db.executions.put([journaled('a.01.01', TODAY_0931, { price: 1 })]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const since = db.executions.since;
    db.executions.since = async (t) => (await gate, since(t));
    const s = setup(db);
    await tick();
    s.ready();
    s.emit('execDetails', 1000, ibAapl, ibExec('a.01.01', '20261005 09:31:00 US/Eastern', 226.95));
    release();
    await tick(100);
    expect(s.svc.getExecutions().map((e) => e.price)).toEqual([226.95]);
  });
});
