import { describe, expect, it } from 'vitest';
import { blackScholes, normCdf, RISK_FREE, smileVol } from './blackScholes';

describe('blackScholes', () => {
  it('matches a textbook value', () => {
    // S=100, K=100, T=1, r=5%, vol=20%: call 10.4506, put 5.5735.
    expect(blackScholes(100, 100, 1, 0.2, 'C', 0.05).price).toBeCloseTo(10.4506, 3);
    expect(blackScholes(100, 100, 1, 0.2, 'P', 0.05).price).toBeCloseTo(5.5735, 3);
  });

  it('satisfies put–call parity', () => {
    const S = 227.48;
    const K = 230;
    const T = 15 / 365;
    const c = blackScholes(S, K, T, 0.26, 'C');
    const p = blackScholes(S, K, T, 0.26, 'P');
    expect(c.price - p.price).toBeCloseTo(S - K * Math.exp(-RISK_FREE * T), 6);
    expect(c.delta - p.delta).toBeCloseTo(1, 6);
    expect(c.gamma).toBeCloseTo(p.gamma, 10);
    expect(c.vega).toBeCloseTo(p.vega, 10);
  });

  it('has sensible greeks', () => {
    const c = blackScholes(100, 100, 30 / 365, 0.3, 'C');
    expect(c.delta).toBeGreaterThan(0.5);
    expect(c.delta).toBeLessThan(0.6);
    expect(c.gamma).toBeGreaterThan(0);
    expect(c.theta).toBeLessThan(0);
    // Vega per vol point ≈ price change for +1 point of vol.
    const bumped = blackScholes(100, 100, 30 / 365, 0.31, 'C');
    expect(bumped.price - c.price).toBeCloseTo(c.vega, 2);
  });

  it('returns intrinsic value at expiry', () => {
    expect(blackScholes(110, 100, 0, 0.3, 'C')).toMatchObject({ price: 10, delta: 1, gamma: 0 });
    expect(blackScholes(90, 100, 0, 0.3, 'P')).toMatchObject({ price: 10, delta: -1 });
  });
});

describe('normCdf and smile', () => {
  it('approximates the normal CDF', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('skews toward downside strikes', () => {
    const atm = smileVol(0.3, 100, 100, 30);
    expect(atm).toBeCloseTo(0.3, 6);
    expect(smileVol(0.3, 100, 90, 30)).toBeGreaterThan(smileVol(0.3, 100, 110, 30));
    expect(smileVol(0.3, 100, 90, 30)).toBeGreaterThan(atm);
  });
});
