import { describe, expect, it, vi } from 'vitest';
import { INVOKE_METHODS, LOCK_POLICY, LOCKED_MESSAGE, type TapeHandlers, type TapeInvokeMethod } from '@shared/ipc';
import { createDispatch } from './ipcDispatch';

function fakeHandlers() {
  const calls: Array<[TapeInvokeMethod, unknown, unknown[]]> = [];
  const handlers = Object.fromEntries(
    INVOKE_METHODS.map((m) => [
      m,
      vi.fn(function (this: unknown, ...args: unknown[]) {
        calls.push([m, this, args]);
        return Promise.resolve(`${m} done`);
      }),
    ]),
  ) as unknown as TapeHandlers;
  return { handlers, calls };
}

const allowed = INVOKE_METHODS.filter((m) => LOCK_POLICY[m] === 'allow');
const denied = INVOKE_METHODS.filter((m) => LOCK_POLICY[m] === 'deny');

describe('IPC dispatch while locked', () => {
  it('has exactly this allow-list', () => {
    expect(allowed.sort()).toEqual(
      [
        'getSnapshot',
        'setQuoteSubscriptions',
        'getHistory',
        'getOlderBars',
        'getContractInfo',
        'setDepthSubscription',
        'getOptionChainParams',
        'getEarnings',
        'getCacheStats',
        'refreshExecutions',
        'notify',
        'setApiLogStreaming',
        'getLockState',
        'lock',
        'unlockWithPin',
        'unlockWithBiometrics',
        'resetApp',
      ].sort(),
    );
    for (const m of ['placeOrder', 'modifyOrder', 'cancelOrder', 'cancelAllOrders', 'updateSettings', 'saveWatchlists', 'savePriceAlerts', 'clearMarketDataCache', 'exportApiLog', 'connect', 'disconnect', 'setLockPin', 'removeLockPin', 'verifyLockPin'] as const)
      expect(denied).toContain(m);
  });

  it('refuses every other method without calling its handler', async () => {
    const { handlers, calls } = fakeHandlers();
    for (const m of denied) {
      expect(await createDispatch(m, handlers, () => true)({}, [])).toEqual({ ok: false, message: LOCKED_MESSAGE });
    }
    expect(calls).toEqual([]);
  });

  it('refuses an order while locked and sends it once unlocked', async () => {
    const { handlers, calls } = fakeHandlers();
    let locked = true;
    const place = createDispatch('placeOrder', handlers, () => locked);
    expect(await place({}, [{ symbol: 'AAPL' }])).toEqual({ ok: false, message: 'Tape is locked' });
    expect(handlers.placeOrder).not.toHaveBeenCalled();
    locked = false;
    expect(await place({}, [{ symbol: 'AAPL' }])).toEqual({ ok: true, value: 'placeOrder done' });
    expect(calls.map((c) => c[0])).toEqual(['placeOrder']);
  });

  it('keeps the allowed methods working, with the sender as `this`', async () => {
    const { handlers, calls } = fakeHandlers();
    const sender = { id: 1 };
    for (const m of allowed) expect(await createDispatch(m, handlers, () => true)(sender, ['a'])).toEqual({ ok: true, value: `${m} done` });
    expect(calls.map((c) => c[0])).toEqual(allowed);
    expect(calls.every((c) => c[1] === sender)).toBe(true);
  });

  it('wraps handler errors in the envelope', async () => {
    const { handlers } = fakeHandlers();
    handlers.connect = () => Promise.reject(new Error('refused'));
    expect(await createDispatch('connect', handlers, () => false)({}, [])).toEqual({ ok: false, message: 'refused' });
  });
});
