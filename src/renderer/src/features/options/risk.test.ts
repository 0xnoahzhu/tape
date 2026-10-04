import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { Position, Quote } from '@shared/types';
import { computeRiskAlerts } from './risk';
import { chainTotals, flowSide, unusualActivity, type FlowInput } from './flow';

const now = new Date(2026, 9, 5);

const pos = (expiry: string, strike: number, right: 'C' | 'P', quantity: number, avgPrice = 2, extra: Partial<Position> = {}): Position => {
  const contract = option('AAPL', expiry, strike, right);
  return { account: 'DU1', key: contractKey(contract), contract, quantity, avgPrice, multiplier: 100, updatedAt: 0, ...extra };
};
const quote = (q: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...q });

describe('computeRiskAlerts', () => {
  it('flags expiries within 7 days', () => {
    const p = pos('20261009', 250, 'C', 1);
    const alerts = computeRiskAlerts([p], {}, () => undefined, now);
    expect(alerts).toEqual([expect.objectContaining({ rule: 'exp', days: 4, severity: 'warn' })]);
    expect(computeRiskAlerts([pos('20261120', 250, 'C', 1)], {}, () => undefined, now)).toEqual([]);
  });

  it('flags short options by delta', () => {
    const p = pos('20261120', 230, 'P', -2);
    const quotes = { [p.key]: quote({ delta: -0.45 }) };
    const alerts = computeRiskAlerts([p], quotes, () => quote({ last: 232 }), now);
    expect(alerts).toEqual([expect.objectContaining({ rule: 'asg', severity: 'high', itm: false })]);
    // Long options never carry assignment risk.
    expect(computeRiskAlerts([pos('20261120', 230, 'P', 2)], quotes, () => quote({ last: 232 }), now)).toEqual([]);
  });

  it('falls back to moneyness without greeks', () => {
    const p = pos('20261120', 230, 'C', -1);
    const alerts = computeRiskAlerts([p], {}, () => quote({ last: 235 }), now);
    expect(alerts[0]).toMatchObject({ rule: 'asg', itm: true });
    expect(computeRiskAlerts([p], {}, () => quote({ last: 200 }), now)).toEqual([]);
  });

  it('reports big underlying moves once per symbol and large losses', () => {
    const a = pos('20261120', 300, 'C', 1, 2, { unrealizedPnL: -150 });
    const b = pos('20261120', 310, 'C', 1, 2);
    const alerts = computeRiskAlerts([a, b], {}, () => quote({ last: 210, close: 200 }), now);
    expect(alerts.filter((x) => x.rule === 'move')).toHaveLength(1);
    expect(alerts.find((x) => x.rule === 'move')!.movePct).toBeCloseTo(5, 9);
    expect(alerts.find((x) => x.rule === 'loss')).toMatchObject({ lossPct: 75, severity: 'info' });
  });

  it('sorts high severity first and ignores non-options', () => {
    const stk: Position = { account: 'DU1', key: 'STK:AAPL', contract: stock('AAPL'), quantity: 100, avgPrice: 1, multiplier: 1, updatedAt: 0 };
    const e = pos('20261009', 250, 'C', 1);
    const s = pos('20261120', 230, 'P', -1);
    const alerts = computeRiskAlerts([stk, e, s], { [s.key]: quote({ delta: -0.6 }) }, () => undefined, now);
    expect(alerts.map((x) => x.rule)).toEqual(['asg', 'exp']);
  });
});

describe('unusual activity', () => {
  const item = (strike: number, right: 'C' | 'P', q: Partial<Quote> | undefined): FlowInput => ({
    contract: option('AAPL', '20261016', strike, right),
    right,
    strike,
    expiry: '20261016',
    multiplier: 100,
    quote: q ? quote(q) : undefined,
  });

  it('flags volume above open interest and large premium', () => {
    const rows = unusualActivity([
      item(230, 'C', { volume: 3000, openInterest: 1000, last: 4, bid: 3.9, ask: 4 }),
      item(235, 'C', { volume: 600, openInterest: 1000, last: 1, bid: 1, ask: 1.1 }),
      item(240, 'C', { volume: 100, openInterest: 5000, last: 1 }),
      item(220, 'P', { volume: 20, openInterest: 0 }),
      item(210, 'P', { volume: 400, openInterest: 50000, last: 30 }),
    ]);
    expect(rows.map((r) => [r.strike, r.tags])).toEqual([
      [230, ['voi', 'large']],
      [235, ['elevated']],
      [210, ['large']],
    ]);
    expect(rows[0]).toMatchObject({ voi: 3, premium: 1_200_000, side: 'ask' });
    expect(rows[1].side).toBe('bid');
  });

  it('derives the side of the last trade', () => {
    expect(flowSide(quote({ last: 1.05, bid: 1, ask: 1.1 }))).toBe('mid');
    expect(flowSide(quote({ last: 1.05 }))).toBeUndefined();
  });

  it('totals volume and open interest', () => {
    const t = chainTotals([item(230, 'C', { volume: 10, openInterest: 100 }), item(230, 'P', { volume: 5, openInterest: 50 }), item(235, 'C', undefined)]);
    expect(t).toEqual({ callVol: 10, putVol: 5, callOi: 100, putOi: 50, quoted: 2 });
  });
});
