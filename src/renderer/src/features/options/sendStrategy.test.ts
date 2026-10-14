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
  [contractKey(option('AAPL', '20261016', 230, 'P'))]: q({ bid: 2.4, ask: 2.6, iv: 0.25, marketDataType: 1 }),
  [contractKey(option('AAPL', '20261016', 225, 'P'))]: q({ bid: 1.0, ask: 1.2, iv: 0.26, marketDataType: 1 }),
};
const leg = (id: number, side: 'BUY' | 'SELL', strike: number): Leg => ({ id, side, right: 'P', strike, expiry: '20261016', qty: 1, multiplier: 100, tradingClass: 'AAPL' });

describe('sendStrategy', () => {
  beforeEach(() => {
    getContractInfo.mockClear();
    useStore.setState((s) => ({
      pendingOrder: null,
      toast: null,
      quotes,
      account: { account: 'U18630011', currency: 'USD', netLiquidation: 1_000_000, buyingPower: 2_000_000, updatedAt: 0 },
      positions: [],
      positionsLoaded: true,
      connection: { ...s.connection, status: 'connected', accounts: ['U18630011'], account: 'U18630011', isPaper: false },
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
    // Every leg as built (the wire's reversed actions would mislead), and the net credit in words.
    expect(p.rows.map((r) => r.value)).toEqual([
      'AAPL 2-leg Vertical spread',
      'Sell',
      '1',
      'Sell 1 × AAPL 10/16 230 Put',
      'Buy 1 × AAPL 10/16 225 Put',
      'Limit 1.40 · Net credit',
      'DAY · conditional',
      'AAPL ≤ 228.50',
      'Net credit $140.00',
    ]);
    expect(p.rows.filter((r) => r.label.startsWith('Leg')).map((r) => [r.label, r.color])).toEqual([
      ['Leg 1', 'var(--dn)'],
      ['Leg 2', 'var(--up)'],
    ]);
    // Reviewed for the live account it was built on; live quotes, nothing to acknowledge.
    expect(p).toMatchObject({ account: 'U18630011', isPaper: false, marketData: 'live' });
    expect(p.risks).toBeUndefined();
  });

  it('says a debit is a debit, and repeats the market warning for a combo at market', async () => {
    const view = strategyView([leg(1, 'BUY', 230), leg(2, 'SELL', 225)], underlying, 232, undefined, quotes, 0.25, now);
    await sendStrategy({ view, underlying, tmpl: 'vertical', cond: { on: false, op: '>=', px: '' }, order: { type: 'MKT', tif: 'DAY' } });
    const p = useStore.getState().pendingOrder!;
    const row = (label: string) => p.rows.find((r) => r.label === label);
    expect(row('Type / Price')?.value).toBe('Market');
    expect(row('Est. amount')?.value).toBe('Net debit $140.00');
    expect(row('Market')).toEqual({ label: 'Market', value: 'At market: the legs fill at the prices available, which can be far from the marks', color: 'var(--r)', prose: true });
  });

  it('warns about legs whose prices are not live, and about a combo too large for the account', async () => {
    useStore.setState({
      quotes: { ...quotes, [contractKey(option('AAPL', '20261016', 225, 'P'))]: q({ bid: 1.0, ask: 1.2, iv: 0.26, marketDataType: 3 }) },
      account: { account: 'U18630011', currency: 'USD', netLiquidation: 400, buyingPower: 100, updatedAt: 0 },
    });
    const view = strategyView([leg(1, 'BUY', 230), leg(2, 'SELL', 225)], underlying, 232, undefined, quotes, 0.25, now);
    await sendStrategy({ view, underlying, tmpl: 'vertical', cond: { on: false, op: '>=', px: '' } });
    const p = useStore.getState().pendingOrder!;
    expect(p.marketData).toBe('delayed');
    expect(p.risks?.map((r) => r.kind)).toEqual(['largeNotional', 'overBuyingPower', 'marketOnStaleData']);
  });

  it('sends a single leg at the ask without resolving contracts', async () => {
    const view = strategyView([leg(1, 'BUY', 225)], underlying, 232, undefined, quotes, 0.25, now);
    await sendStrategy({ view, underlying, tmpl: null, cond: { on: false, op: '>=', px: '' } });
    const p = useStore.getState().pendingOrder!;
    expect(getContractInfo).not.toHaveBeenCalled();
    expect(p.request).toMatchObject({ action: 'BUY', quantity: 1, limitPrice: 1.2, contract: { secType: 'OPT', strike: 225, right: 'P' } });
    expect(p.request.condition).toBeUndefined();
  });

  it('sends a single stock leg as the shares the builder shows (it counts 100-share lots)', async () => {
    useStore.setState({ quotes: { ...quotes, [contractKey(underlying)]: q({ bid: 227.48, ask: 227.49, marketDataType: 1 }) } });
    // A covered call with its call removed: "1 | 100 AAPL" in the builder.
    const stockLeg: Leg = { id: 3, side: 'BUY', right: 'S', strike: 0, expiry: '20261016', qty: 1, multiplier: 100 };
    const view = strategyView([stockLeg], underlying, 227.49, q({ bid: 227.48, ask: 227.49 }), quotes, 0.25, now);
    expect(view.legs[0].desc).toBe('100 AAPL');
    await sendStrategy({ view, underlying, tmpl: null, cond: { on: false, op: '>=', px: '' } });
    const p = useStore.getState().pendingOrder!;
    expect(p.request).toMatchObject({ action: 'BUY', quantity: 100, limitPrice: 227.49, contract: { secType: 'STK', symbol: 'AAPL' } });
    expect(p.summary).toBe('Buy 100 AAPL');
    const row = (label: string) => p.rows.find((r) => r.label === label)?.value;
    // The quantity, the price and the amount describe the same order.
    expect([row('Qty'), row('Type / Price'), row('Est. amount')]).toEqual(['100', 'Limit 227.49', 'Net debit $22,749.00']);
    expect(p.risks).toBeUndefined();
  });

  it('says what it could not check before the account’s values are in', async () => {
    useStore.setState({ account: null, positionsLoaded: false });
    const view = strategyView([leg(1, 'BUY', 225)], underlying, 232, undefined, quotes, 0.25, now);
    await sendStrategy({ view, underlying, tmpl: null, cond: { on: false, op: '>=', px: '' } });
    expect(useStore.getState().pendingOrder!.risks).toEqual([{ kind: 'unchecked', missing: ['positions', 'account'] }]);
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
