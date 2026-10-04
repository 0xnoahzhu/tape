import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { Quote } from '@shared/types';
import type { Leg } from './strategies';
import { legDesc, strategyView } from './strategyModel';

const now = Date.parse('2026-10-05T14:00:00Z');
const underlying = stock('AAPL');
const q = (p: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...p });
const key = (k: number, r: 'C' | 'P') => contractKey(option('AAPL', '20261016', k, r));
const quotes: Record<string, Quote> = {
  [key(230, 'C')]: q({ bid: 3.0, ask: 3.2, iv: 0.25, delta: 0.45, gamma: 0.04, theta: -0.1, vega: 0.15 }),
  [key(235, 'C')]: q({ bid: 1.4, ask: 1.6, iv: 0.24, delta: 0.3, gamma: 0.03, theta: -0.08, vega: 0.12 }),
};
const leg = (id: number, side: 'BUY' | 'SELL', strike: number, right: 'C' | 'P' | 'S' = 'C', qty = 1): Leg => ({
  id,
  side,
  right,
  strike: right === 'S' ? 0 : strike,
  expiry: '20261016',
  qty,
  multiplier: 100,
  tradingClass: 'AAPL',
});

describe('strategyView', () => {
  it('prices a single buy at the ask and a single sell at the bid', () => {
    const buy = strategyView([leg(1, 'BUY', 230)], underlying, 228, undefined, quotes, 0.25, now);
    expect(buy.order).toEqual({ single: true, price: 3.2 });
    expect(buy.orderCost).toBeCloseTo(320, 9);
    const sell = strategyView([leg(1, 'SELL', 230)], underlying, 228, undefined, quotes, 0.25, now);
    expect(sell.order).toEqual({ single: true, price: 3.0 });
    expect(sell.orderCost).toBeCloseTo(-300, 9);
  });

  it('prices a vertical at the net mark and analyzes it', () => {
    const v = strategyView([leg(1, 'BUY', 230, 'C', 2), leg(2, 'SELL', 235, 'C', 2)], underlying, 228, undefined, quotes, 0.25, now);
    expect(v.order).toMatchObject({ single: false, terms: { action: 'BUY', quantity: 2, ratios: [1, 1], limitPrice: 1.6 } });
    expect(v.orderCost).toBeCloseTo(320, 9);
    expect(v.analysis!.maxProfit).toBeCloseTo((5 - 1.6) * 200, 6);
    expect(v.greeks!.delta).toBeCloseTo((0.45 - 0.3) * 200, 9);
    expect(v.minDte).toBe(11);
  });

  it('prices a covered call as stock − call per share', () => {
    const uq = q({ last: 228, bid: 227.98, ask: 228.02 });
    const v = strategyView([leg(1, 'BUY', 0, 'S'), leg(2, 'SELL', 235, 'C')], underlying, 228, uq, quotes, 0.25, now);
    expect(v.order).toMatchObject({ single: false, terms: { action: 'BUY', quantity: 1, ratios: [100, 1], legActions: ['BUY', 'SELL'], limitPrice: 226.5 } });
    expect(v.orderCost).toBeCloseTo(22_650, 6);
    expect(v.analysis!.profitUnlimited).toBe(false);
  });

  it('waits for prices', () => {
    const v = strategyView([leg(1, 'BUY', 240), leg(2, 'SELL', 245)], underlying, 228, undefined, quotes, 0.25, now);
    expect(v.payoff).toBeNull();
    expect(v.order).toBeNull();
    expect(v.analysis).toBeNull();
  });

  it('describes legs', () => {
    expect(legDesc(leg(1, 'BUY', 230), 'AAPL')).toBe('10/16 230.00 Call');
    expect(legDesc(leg(1, 'BUY', 0, 'S', 2), 'AAPL')).toBe('200 AAPL');
  });
});
