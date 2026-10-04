import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { ContractRef, Quote } from '@shared/types';
import { useStore } from '../../state/store';
import { sendStrategy } from './sendStrategy';
import type { Leg } from './strategies';
import { strategyView } from './strategyModel';

const getContractInfo = vi.fn(async (c: ContractRef) => ({ contract: { ...c, conId: c.strike ? c.strike * 10 : 265598 }, longName: '', minTick: 0.01 }));
(globalThis as unknown as { window: unknown }).window = { tape: { getContractInfo } };

const underlying = stock('AAPL');
const now = Date.parse('2026-10-05T14:00:00Z');
const q = (p: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...p });
const quotes: Record<string, Quote> = {
  [contractKey(option('AAPL', '20261016', 230, 'P'))]: q({ bid: 2.4, ask: 2.6, iv: 0.25 }),
  [contractKey(option('AAPL', '20261016', 225, 'P'))]: q({ bid: 1.0, ask: 1.2, iv: 0.26 }),
};
const leg = (id: number, side: 'BUY' | 'SELL', strike: number): Leg => ({ id, side, right: 'P', strike, expiry: '20261016', qty: 1, multiplier: 100, tradingClass: 'AAPL' });

describe('sendStrategy', () => {
  beforeEach(() => {
    getContractInfo.mockClear();
    useStore.setState((s) => ({
      pendingOrder: null,
      toast: null,
      connection: { ...s.connection, status: 'connected' },
      settings: { ...s.settings, trading: { ...s.settings.trading, confirmOrders: true } },
    }));
  });

  it('sends a credit spread as a SELL combo with reversed legs', async () => {
    const view = strategyView([leg(1, 'SELL', 230), leg(2, 'BUY', 225)], underlying, 232, undefined, quotes, 0.25, now);
    await sendStrategy({ view, underlying, tmpl: 'vertical', cond: { on: true, op: '<=', px: '228.50' } });
    const p = useStore.getState().pendingOrder!;
    expect(getContractInfo).toHaveBeenCalledTimes(2);
    expect(p.request).toMatchObject({
      action: 'SELL',
      orderType: 'LMT',
      quantity: 1,
      limitPrice: 1.4,
      tif: 'DAY',
      contract: {
        symbol: 'AAPL',
        secType: 'BAG',
        comboLegs: [
          { conId: 2300, ratio: 1, action: 'BUY', exchange: 'SMART' },
          { conId: 2250, ratio: 1, action: 'SELL', exchange: 'SMART' },
        ],
      },
      condition: { contract: underlying, operator: '<=', price: 228.5, outsideRth: false },
    });
    expect(p.rows.map((r) => r.value)).toEqual(['AAPL 2-leg Vertical spread', 'Sell', '1', 'Limit 1.40', 'DAY · conditional', 'AAPL ≤ 228.50', '$140.00']);
  });

  it('sends a single leg at the ask without resolving contracts', async () => {
    const view = strategyView([leg(1, 'BUY', 225)], underlying, 232, undefined, quotes, 0.25, now);
    await sendStrategy({ view, underlying, tmpl: null, cond: { on: false, op: '>=', px: '' } });
    const p = useStore.getState().pendingOrder!;
    expect(getContractInfo).not.toHaveBeenCalled();
    expect(p.request).toMatchObject({ action: 'BUY', quantity: 1, limitPrice: 1.2, contract: { secType: 'OPT', strike: 225, right: 'P' } });
    expect(p.request.condition).toBeUndefined();
  });

  it('refuses combos while disconnected and stock legs on an index', async () => {
    useStore.setState((s) => ({ connection: { ...s.connection, status: 'disconnected' } }));
    const view = strategyView([leg(1, 'SELL', 230), leg(2, 'BUY', 225)], underlying, 232, undefined, quotes, 0.25, now);
    await sendStrategy({ view, underlying, tmpl: null, cond: { on: false, op: '>=', px: '' } });
    expect(useStore.getState().pendingOrder).toBeNull();
    expect(useStore.getState().toast?.tone).toBe('error');

    const spx: ContractRef = { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' };
    const stockLeg: Leg = { id: 3, side: 'BUY', right: 'S', strike: 0, expiry: '20261016', qty: 1, multiplier: 100 };
    const v2 = strategyView([stockLeg], spx, 5800, q({ bid: 5799, ask: 5801 }), {}, 0.2, now);
    await sendStrategy({ view: v2, underlying: spx, tmpl: null, cond: { on: false, op: '>=', px: '' } });
    expect(useStore.getState().pendingOrder).toBeNull();
  });
});
