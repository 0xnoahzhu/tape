import type { Contract, IBApi } from './tws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IbConnection, IbListener, MainContext } from '../context';
import { createAccountService } from './account';

/** A connection stub: tests emit IB callbacks; requests are recorded. */
function setup() {
  const listeners = new Map<string, Set<IbListener>>();
  const calls: Array<[string, ...unknown[]]> = [];
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
  const ib = {
    api,
    getState: () => ({ status: 'connected', host: 'h', port: 1, clientId: 1, accounts: ['DU1'], account: 'DU1', isPaper: true, farms: {} }),
    nextReqId: () => reqId++,
    on(event: string, l: IbListener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(l);
      return () => listeners.get(event)!.delete(l);
    },
    onReady: () => () => undefined,
    onClosed: () => () => undefined,
  } as unknown as IbConnection;
  const ctx = { ib, emit: () => undefined, contracts: { getInfo: async () => null } } as unknown as MainContext;
  const svc = createAccountService(ctx);
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => l(...args));
  return { svc, emit, calls };
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
