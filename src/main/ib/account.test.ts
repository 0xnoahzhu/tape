import type { Contract, IBApi } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TapeEvent } from '@shared/ipc';
import type { IbConnection, IbListener, MainContext, SessionChangeReason } from '../context';
import { createAccountService } from './account';

/** A connection stub: tests emit IB callbacks; requests and emitted events are recorded. */
function setup() {
  const listeners = new Map<string, Set<IbListener>>();
  const ready = new Set<(api: IBApi) => void>();
  const closed = new Set<() => void>();
  const sessionChanged = new Set<(reason: SessionChangeReason) => void>();
  const calls: Array<[string, ...unknown[]]> = [];
  const events: TapeEvent[] = [];
  const api = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        (...args: unknown[]) =>
          void calls.push([name, ...args]),
    },
  ) as unknown as IBApi;
  let reqId = 500;
  let account = 'DU1';
  let session = 0;
  const ib = {
    api,
    getState: () => ({ status: 'connected', host: 'h', port: 1, clientId: 1, session, accounts: [account], account, isPaper: account.startsWith('D'), farms: {} }),
    nextReqId: () => reqId++,
    on(event: string, l: IbListener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(l);
      return () => listeners.get(event)!.delete(l);
    },
    onReady: (l: (api: IBApi) => void) => (ready.add(l), () => ready.delete(l)),
    onClosed: (l: () => void) => (closed.add(l), () => closed.delete(l)),
    onSessionChange: (l: (reason: SessionChangeReason) => void) => (sessionChanged.add(l), () => sessionChanged.delete(l)),
  } as unknown as IbConnection;
  const ctx = { ib, emit: (e: TapeEvent) => events.push(e), contracts: { getInfo: async () => null } } as unknown as MainContext;
  const svc = createAccountService(ctx);
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => l(...args));
  return {
    svc,
    emit,
    calls,
    events,
    ready: () => ready.forEach((l) => l(api)),
    close: () => closed.forEach((l) => l()),
    /** The connected account changes without a session event (as a late managedAccounts once could). */
    setAccount: (a: string) => void (account = a),
    /** Tape moves to another account, as connection.ts does it: close, new session, (ready by the test). */
    switchSession: (to: string) => {
      closed.forEach((l) => l());
      account = to;
      session++;
      sessionChanged.forEach((l) => l('params'));
    },
  };
}

const aapl: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK' as never, exchange: 'NASDAQ', primaryExch: 'NASDAQ', currency: 'USD' };
const call: Contract = {
  conId: 7001,
  symbol: 'AAPL',
  secType: 'OPT' as never,
  lastTradeDateOrContractMonth: '20261016',
  strike: 230,
  right: 'C' as never,
  multiplier: 100,
  exchange: 'AMEX',
  currency: 'USD',
};

describe('account service', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps IB’s average cost as sent next to the per-unit price', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.emit('updatePortfolio', aapl, 100, 227.5, 22_750, 200.5, 2_700, 0, 'DU1');
    t.emit('updatePortfolio', call, 10, 3.2, 3_200, 310, 100, 0, 'DU1');
    const [stk, opt] = t.svc.getPositions();
    expect(stk).toMatchObject({ avgPrice: 200.5, averageCost: 200.5, marketPrice: 227.5 });
    expect(opt).toMatchObject({ avgPrice: 3.1, averageCost: 310, multiplier: 100 });
    // A position message without a cost keeps the last one.
    t.emit('position', 'DU1', aapl, 100, undefined);
    expect(t.svc.getPositions()[0].averageCost).toBe(200.5);
  });

  it('keeps reqPnLSingle’s unrealized and realized P&L', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.emit('updatePortfolio', aapl, 100, 227.5, 22_750, 200.5, 2_700, 0, 'DU1');
    // The positions are emitted after a short delay, which requests one reqPnLSingle per conId.
    await vi.advanceTimersByTimeAsync(300);
    const req = t.calls.find((c) => c[0] === 'reqPnLSingle');
    expect(req).toEqual(['reqPnLSingle', expect.any(Number), 'DU1', null, 265598]);
    const reqId = req![1];
    t.emit('pnlSingle', reqId, 100, 150, 2_705, 12.5, 22_755);
    expect(t.svc.getPositions()[0]).toMatchObject({ dailyPnL: 150, pnlUnrealized: 2_705, pnlRealized: 12.5, pnlValue: 22_755 });
    // A portfolio update keeps them.
    t.emit('updatePortfolio', aapl, 100, 227.6, 22_760, 200.5, 2_710, 0, 'DU1');
    expect(t.svc.getPositions()[0]).toMatchObject({ pnlUnrealized: 2_705, pnlRealized: 12.5 });
    // IB's "no value" (Double.MAX) clears them: an older figure is never shown as IB's current one.
    t.emit('pnlSingle', reqId, 100, 160, 1.7976931348623157e308, 1.7976931348623157e308, 22_765);
    const after = t.svc.getPositions()[0];
    expect(after).toMatchObject({ dailyPnL: 160, pnlValue: 22_765 });
    expect(after.pnlUnrealized).toBeUndefined();
    expect(after.pnlRealized).toBeUndefined();
  });

  describe('when the account changes', () => {
    async function loaded() {
      const t = setup();
      await vi.advanceTimersByTimeAsync(0);
      t.ready();
      t.emit('accountSummary', t.calls.find((c) => c[0] === 'reqAccountSummary')![1], 'DU1', 'NetLiquidation', '100000', 'USD');
      t.emit('updatePortfolio', aapl, 100, 227.5, 22_750, 200.5, 2_700, 0, 'DU1');
      await vi.advanceTimersByTimeAsync(300);
      expect(t.svc.getSummary()).toMatchObject({ account: 'DU1', netLiquidation: 100_000 });
      expect(t.svc.getPositions()).toHaveLength(1);
      t.events.length = 0;
      return t;
    }

    it('empties the summary and positions at once when the session changes', async () => {
      const t = await loaded();
      t.switchSession('U1');
      // At once, not with the next batch: the renderer never shows DU1's values under U1.
      expect(t.events).toEqual([
        { type: 'account', summary: null },
        { type: 'positions', positions: [], loaded: false },
      ]);
      expect(t.svc.getSummary()).toBeNull();
      expect(t.svc.getPositions()).toEqual([]);
      // The new account loads as on a first connect.
      t.calls.length = 0;
      t.ready();
      expect(t.calls.find((c) => c[0] === 'reqAccountUpdates')).toEqual(['reqAccountUpdates', true, 'U1']);
      t.emit('updatePortfolio', aapl, 5, 227.5, 1_137.5, 210, 87.5, 0, 'U1');
      expect(t.svc.getPositions().map((p) => [p.account, p.quantity])).toEqual([['U1', 5]]);
    });

    it('keeps the values across a plain reconnect to the same account', async () => {
      const t = await loaded();
      t.close();
      t.ready();
      await vi.advanceTimersByTimeAsync(300);
      expect(t.svc.getSummary()).toMatchObject({ account: 'DU1', netLiquidation: 100_000 });
      expect(t.svc.getPositions()).toHaveLength(1);
      expect(t.events.filter((e) => e.type === 'account' && e.summary == null)).toEqual([]);
    });

    it('drops another account’s values at the handshake even without a session event, telling the renderer', async () => {
      const t = await loaded();
      t.close();
      t.setAccount('U1');
      t.ready();
      expect(t.events).toEqual([
        { type: 'account', summary: null },
        { type: 'positions', positions: [], loaded: false },
      ]);
      expect(t.svc.getPositions()).toEqual([]);
    });

    it('drops another account’s positions at the handshake when no summary came', async () => {
      const t = setup();
      await vi.advanceTimersByTimeAsync(0);
      t.ready();
      t.emit('position', 'DU1', aapl, 100, 200.5);
      expect(t.svc.getSummary()).toBeNull();
      t.close();
      t.setAccount('U1');
      t.ready();
      expect(t.svc.getPositions()).toEqual([]);
      expect(t.events).toContainEqual({ type: 'positions', positions: [], loaded: false });
    });
  });

  it('says when IB has listed the positions: at positionEnd, again after each handshake', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.ready();
    expect(t.svc.positionsLoaded()).toBe(false);
    t.emit('position', 'DU1', aapl, 100, 200.5);
    await vi.advanceTimersByTimeAsync(300);
    // Listed so far, not complete: an instrument missing from the list may still be held.
    expect(t.events.at(-1)).toMatchObject({ type: 'positions', loaded: false });
    t.emit('positionEnd');
    expect(t.svc.positionsLoaded()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.events.at(-1)).toMatchObject({ type: 'positions', loaded: true, positions: [{ account: 'DU1', quantity: 100 }] });
    // An account with no positions at all is complete too: positionEnd is sent although nothing changed.
    const empty = setup();
    await vi.advanceTimersByTimeAsync(0);
    empty.ready();
    empty.emit('positionEnd');
    await vi.advanceTimersByTimeAsync(300);
    expect(empty.events).toContainEqual({ type: 'positions', positions: [], loaded: true });
    // A reconnect lists them again (they may have changed meanwhile); a new session starts unlisted.
    t.close();
    t.ready();
    expect(t.svc.positionsLoaded()).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.events.at(-1)).toMatchObject({ type: 'positions', loaded: false });
    t.emit('positionEnd');
    expect(t.svc.positionsLoaded()).toBe(true);
    t.switchSession('U1');
    expect(t.svc.positionsLoaded()).toBe(false);
    expect(t.events.at(-1)).toEqual({ type: 'positions', positions: [], loaded: false });
  });

  it('keeps IB’s exchange rates by currency', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.emit('updateAccountValue', '$LEDGER-ExchangeRate', '1.00', 'BASE', 'DU1');
    t.emit('updateAccountValue', '$LEDGER-ExchangeRate', '1.0812', 'EUR', 'DU1');
    t.emit('updateAccountValue', '$LEDGER-ExchangeRate', '1.00', 'USD', 'DU1');
    t.emit('updateAccountValue', 'ExchangeRate', '0.0067', 'JPY', 'DU1');
    // Another account's rows and unusable values are ignored.
    t.emit('updateAccountValue', 'ExchangeRate', '1.30', 'GBP', 'DU2');
    t.emit('updateAccountValue', 'ExchangeRate', '', 'CHF', 'DU1');
    expect(t.svc.getSummary()?.exchangeRates).toEqual({ EUR: 1.0812, USD: 1, JPY: 0.0067 });
  });
});
