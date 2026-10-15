import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { Position, Quote } from '@shared/types';
import { useM } from './messages';
import { computeRiskAlerts } from './risk';
import { dueRiskNotices, riskNotifTitle } from './riskWatcher';

const now = new Date(2026, 9, 5);

/** An option position; `premium` per share (IB's average cost is per contract: × 100). */
const pos = (expiry: string, strike: number, right: 'C' | 'P', quantity: number, premium = 2, extra: Partial<Position> = {}): Position => {
  const contract = option('AAPL', expiry, strike, right);
  return { account: 'DU1', key: contractKey(contract), contract, quantity, averageCost: premium * 100, multiplier: 100, updatedAt: 0, ...extra };
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

  it('measures the loss with IB’s unrealized P&L, like the positions table: real time first', () => {
    const loss = (p: Position, q: Partial<Quote> = {}) => computeRiskAlerts([p], { [p.key]: quote(q) }, () => undefined, now).find((x) => x.rule === 'loss');
    // reqPnLSingle's −110 against 200 paid is a 55% loss; the portfolio update's older −20 does not count.
    expect(loss(pos('20261120', 300, 'C', 1, 2, { unrealizedPnL: -20, pnlUnrealized: -110 }))).toMatchObject({ lossPct: expect.closeTo(55, 9), severity: 'info' });
    // reqPnLSingle says −25%, the portfolio update −75%: no alert.
    expect(loss(pos('20261120', 300, 'C', 1, 2, { unrealizedPnL: -150, pnlUnrealized: -50 }))).toBeUndefined();
    // No reqPnLSingle figure yet: the portfolio update's. Quotes play no part (Tape re-prices nothing).
    expect(loss(pos('20261120', 300, 'C', 1, 2, { unrealizedPnL: -150 }), { mark: 1.9, bid: 1.8, ask: 2 })).toMatchObject({ lossPct: expect.closeTo(75, 9) });
    // A short call 300 behind against 200 received: 150% of the premium.
    expect(loss(pos('20261120', 300, 'C', -1, 2, { pnlUnrealized: -300 }))).toMatchObject({ lossPct: expect.closeTo(150, 9), severity: 'warn' });
    // Without IB's average cost there is no premium to measure against.
    expect(loss(pos('20261120', 300, 'C', 1, 2, { pnlUnrealized: -300, averageCost: undefined }))).toBeUndefined();
  });

  it('sorts high severity first and ignores non-options', () => {
    const stk: Position = { account: 'DU1', key: 'STK:AAPL', contract: stock('AAPL'), quantity: 100, multiplier: 1, updatedAt: 0 };
    const e = pos('20261009', 250, 'C', 1);
    const s = pos('20261120', 230, 'P', -1);
    const alerts = computeRiskAlerts([stk, e, s], { [s.key]: quote({ delta: -0.6 }) }, () => undefined, now);
    expect(alerts.map((x) => x.rule)).toEqual(['asg', 'exp']);
  });
});

describe('risk alerts per account', () => {
  it('gives the same contract in two accounts its own alert ids, so one account’s notice never silences the other’s', () => {
    const paper = pos('20261009', 230, 'C', -1, 2, { account: 'DUP899854' });
    const live = pos('20261009', 230, 'C', -1, 2, { account: 'U18630011' });
    const ids = (p: Position) => computeRiskAlerts([p], {}, () => quote({ last: 235 }), now).map((a) => a.id);
    expect(ids(paper)).toEqual([`asg:DUP899854:${paper.key}`, `exp:DUP899854:${paper.key}`]);
    expect(ids(live).filter((id) => ids(paper).includes(id))).toEqual([]);
  });

  it('names the account in the notification, paper or live, without its id when ids are hidden', () => {
    const [a] = computeRiskAlerts([pos('20261009', 250, 'C', 1, 2, { account: 'U18630011' })], {}, () => undefined, now);
    expect(riskNotifTitle(a, useM.for('en'), false, true)).toBe('Option risk · AAPL 10/09 250 Call · LIVE U18630011');
    expect(riskNotifTitle(a, useM.for('en'), true, false)).toBe('Option risk · AAPL 10/09 250 Call · PAPER');
    expect(riskNotifTitle(a, useM.for('zh'), false, true)).toBe('期权风险 · AAPL 10/09 250 Call · 实盘 U18630011');
  });

  it('counts a notice given before ids named the account as given, once per stamp, and forgets the old id', () => {
    const paper = pos('20261009', 230, 'C', -1, 2, { account: 'DUP899854' });
    const live = pos('20261009', 230, 'C', -1, 2, { account: 'U18630011' });
    const alerts = computeRiskAlerts([paper, live], {}, () => quote({ last: 235 }), now);
    // Stored by an earlier Tape: the expiry reminder (once) and today's assignment notice, per contract.
    const stored: Record<string, string> = { [`exp:${paper.key}`]: 'once', [`asg:${paper.key}`]: '2026-10-05' };
    const first = dueRiskNotices(alerts, stored, '2026-10-05');
    expect(first.notify).toEqual([]);
    expect(first.changed).toBe(true);
    expect(stored).toEqual({
      [`exp:DUP899854:${paper.key}`]: 'once',
      [`asg:DUP899854:${paper.key}`]: '2026-10-05',
      [`exp:U18630011:${live.key}`]: 'once',
      [`asg:U18630011:${live.key}`]: '2026-10-05',
    });
    // Nothing repeats; the next day's assignment notice is given for each account.
    expect(dueRiskNotices(alerts, stored, '2026-10-05')).toEqual({ notify: [], changed: false });
    expect(dueRiskNotices(alerts, stored, '2026-10-06').notify.map((a) => a.id)).toEqual([`asg:DUP899854:${paper.key}`, `asg:U18630011:${live.key}`]);
    // Without an earlier notice, each is given.
    expect(dueRiskNotices(alerts, {}, '2026-10-05').notify).toHaveLength(4);
  });
});
