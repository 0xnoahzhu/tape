import { describe, expect, it } from 'vitest';
import {
  analyzeStrategy,
  asymptoticSlope,
  blackScholes,
  expectedMove,
  expiryCloseMs,
  ivRank,
  netCost,
  netGreeks,
  normCdf,
  payoffCurve,
  probBelow,
  strategyPnl,
  yearsToExpiry,
  type PayoffLeg,
} from './math';

const call = (strike: number, price: number, sign: 1 | -1 = 1, qty = 1, t = 0.1, iv = 0.3): PayoffLeg => ({ kind: 'C', strike, sign, qty, multiplier: 100, price, t, iv });
const put = (strike: number, price: number, sign: 1 | -1 = 1, qty = 1, t = 0.1, iv = 0.3): PayoffLeg => ({ kind: 'P', strike, sign, qty, multiplier: 100, price, t, iv });

describe('normCdf', () => {
  it('matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normCdf(-1)).toBeCloseTo(0.1586553, 6);
  });
});

describe('blackScholes', () => {
  // Hull's textbook case: S=100 K=100 T=1 σ=20% r=5%.
  const c = blackScholes(100, 100, 1, 0.2, 'C', 0.05);
  const p = blackScholes(100, 100, 1, 0.2, 'P', 0.05);

  it('prices calls and puts', () => {
    expect(c.price).toBeCloseTo(10.4506, 3);
    expect(p.price).toBeCloseTo(5.5735, 3);
  });

  it('satisfies put–call parity', () => {
    expect(c.price - p.price).toBeCloseTo(100 - 100 * Math.exp(-0.05), 6);
  });

  it('computes greeks in desk units', () => {
    expect(c.delta).toBeCloseTo(0.6368, 4);
    expect(p.delta).toBeCloseTo(-0.3632, 4);
    expect(c.gamma).toBeCloseTo(0.018762, 5);
    expect(c.vega).toBeCloseTo(0.37524, 4); // per vol point
    expect(c.theta).toBeCloseTo(-6.414 / 365, 4); // per day
    expect(c.itm).toBeCloseTo(normCdf(0.15), 6); // d2 = 0.15
  });

  it('falls back to intrinsic value at expiry', () => {
    expect(blackScholes(110, 100, 0, 0.3, 'C')).toMatchObject({ price: 10, delta: 1, itm: 1 });
    expect(blackScholes(90, 100, 0, 0.3, 'C')).toMatchObject({ price: 0, delta: 0, itm: 0 });
    expect(blackScholes(90, 100, 0, 0.3, 'P')).toMatchObject({ price: 10, delta: -1 });
  });
});

describe('time to expiry', () => {
  it('uses the 16:00 New York close', () => {
    // 2026-10-16 is in EDT (UTC-4) → 20:00 UTC; 2026-12-18 is EST (UTC-5) → 21:00 UTC.
    expect(new Date(expiryCloseMs('20261016')).toISOString()).toBe('2026-10-16T20:00:00.000Z');
    expect(new Date(expiryCloseMs('20261218')).toISOString()).toBe('2026-12-18T21:00:00.000Z');
  });

  it('counts years and never goes negative', () => {
    const now = Date.parse('2026-10-15T20:00:00Z');
    expect(yearsToExpiry('20261016', now)).toBeCloseTo(1 / 365, 8);
    expect(yearsToExpiry('20261009', now)).toBe(0);
  });

  it('expected move scales with sqrt(t)', () => {
    expect(expectedMove(100, 0.2, 1)).toBeCloseTo(20, 9);
    expect(expectedMove(100, 0.2, 0.25)).toBeCloseTo(10, 9);
  });
});

describe('strategy payoff', () => {
  it('long call: debit, unlimited profit, breakeven at K + premium', () => {
    const legs = [call(100, 2.5)];
    expect(netCost(legs)).toBe(250);
    expect(strategyPnl(legs, 110, 0.1)).toBeCloseTo(750, 9);
    const a = analyzeStrategy(legs, 100, 0.3)!;
    expect(a.profitUnlimited).toBe(true);
    expect(a.lossUnlimited).toBe(false);
    expect(a.maxLoss).toBeCloseTo(-250, 6);
    expect(a.breakevens).toHaveLength(1);
    expect(a.breakevens[0]).toBeCloseTo(102.5, 3);
    expect(a.margin).toBeCloseTo(250, 6);
  });

  it('bull call vertical: bounded profit and loss', () => {
    const legs = [call(100, 3), call(105, 1, -1)];
    const a = analyzeStrategy(legs, 100, 0.3)!;
    expect(a.cost).toBeCloseTo(200, 9);
    expect(a.profitUnlimited || a.lossUnlimited).toBe(false);
    expect(a.maxProfit).toBeCloseTo(300, 6);
    expect(a.maxLoss).toBeCloseTo(-200, 6);
    expect(a.breakevens[0]).toBeCloseTo(102, 3);
  });

  it('short put: credit, loss bounded at zero', () => {
    const legs = [put(100, 4, -1)];
    const a = analyzeStrategy(legs, 105, 0.3)!;
    expect(a.cost).toBe(-400);
    expect(a.lossUnlimited).toBe(false);
    expect(a.maxProfit).toBeCloseTo(400, 6);
    expect(a.maxLoss).toBeCloseTo(-9600, 6);
    expect(a.breakevens[0]).toBeCloseTo(96, 3);
  });

  it('short call: unlimited loss with a 20% margin estimate', () => {
    const a = analyzeStrategy([call(100, 2, -1)], 100, 0.3)!;
    expect(a.lossUnlimited).toBe(true);
    expect(a.margin).toBeCloseTo(0.2 * 100 * 100, 6);
  });

  it('iron condor: two breakevens around the body', () => {
    const legs = [put(95, 1.2, -1), put(90, 0.4), call(105, 1.1, -1), call(110, 0.3)];
    const a = analyzeStrategy(legs, 100, 0.25)!;
    const credit = 1.2 - 0.4 + 1.1 - 0.3;
    expect(a.cost).toBeCloseTo(-credit * 100, 9);
    expect(a.breakevens).toHaveLength(2);
    expect(a.breakevens[0]).toBeCloseTo(95 - credit, 3);
    expect(a.breakevens[1]).toBeCloseTo(105 + credit, 3);
    expect(a.maxProfit).toBeCloseTo(credit * 100, 6);
    expect(a.maxLoss).toBeCloseTo(-(5 - credit) * 100, 6);
    expect(a.pop!).toBeGreaterThan(0.3);
    expect(a.pop!).toBeLessThan(0.9);
  });

  it('covered stock has no unlimited side', () => {
    const legs: PayoffLeg[] = [{ kind: 'S', strike: 0, sign: 1, qty: 1, multiplier: 100, price: 100, t: 0 }, call(105, 2, -1)];
    expect(asymptoticSlope(legs)).toBe(0);
    const a = analyzeStrategy(legs, 100, 0.3)!;
    expect(a.profitUnlimited || a.lossUnlimited).toBe(false);
    expect(a.maxProfit).toBeCloseTo(700, 6);
  });

  it('calendar: values the back month with its IV at the front expiry', () => {
    const legs = [call(100, 2, -1, 1, 0.05, 0.3), call(100, 3.5, 1, 1, 0.15, 0.3)];
    const a = analyzeStrategy(legs, 100, 0.3)!;
    expect(a.horizon).toBeCloseTo(0.05, 9);
    expect(a.profitUnlimited || a.lossUnlimited).toBe(false);
    // Peak at the strike, losses away from it.
    expect(strategyPnl(legs, 100, 0.05)).toBeGreaterThan(0);
    expect(strategyPnl(legs, 70, 0.05)).toBeLessThan(0);
  });

  it('cannot analyze a back-month leg without IV', () => {
    const legs = [call(100, 2, -1, 1, 0.05), { ...call(100, 3.5, 1, 1, 0.15), iv: undefined }];
    expect(analyzeStrategy(legs, 100, 0.3)).toBeNull();
  });

  it('probability of profit of long stock ≈ P(S_T > S0)', () => {
    const legs: PayoffLeg[] = [{ kind: 'S', strike: 0, sign: 1, qty: 1, multiplier: 100, price: 100, t: 0 }, call(1000, 0.0, 1, 1, 0.5, 0.3)];
    const a = analyzeStrategy(legs, 100, 0.3)!;
    expect(a.pop!).toBeCloseTo(1 - probBelow(100, 100, 0.3, 0.5), 3);
  });

  it('samples curves', () => {
    const pts = payoffCurve([call(100, 2)], 90, 110, 4, 0.1);
    expect(pts.map((p) => p.x)).toEqual([90, 95, 100, 105, 110]);
    expect(pts[4].y).toBeCloseTo(800, 9);
  });
});

describe('netGreeks', () => {
  it('sums signed position greeks', () => {
    const g = netGreeks([
      { sign: 1, qty: 1, multiplier: 100, greeks: { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1 } },
      { sign: -1, qty: 2, multiplier: 100, greeks: { delta: 0.3, gamma: 0.01, theta: -0.03, vega: 0.08 } },
    ])!;
    expect(g.delta).toBeCloseTo(-10, 9);
    expect(g.gamma).toBeCloseTo(0, 9);
    expect(g.theta).toBeCloseTo(1, 9);
    expect(g.vega).toBeCloseTo(-6, 9);
    expect(netGreeks([{ sign: 1, qty: 1, multiplier: 100, greeks: null }])).toBeNull();
  });
});

describe('ivRank', () => {
  it('computes rank and percentile', () => {
    const r = ivRank([0.2, 0.3, 0.4, 0.5, 0.6], 0.4)!;
    expect(r.rank).toBeCloseTo(0.5, 9);
    expect(r.percentile).toBeCloseTo(0.4, 9);
    expect(ivRank([0.2], 0.3)).toBeNull();
  });
});
