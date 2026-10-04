import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { PriceAlert } from '@shared/types';
import { alertContracts, alertSignature, alertTexts, evaluateAlert, initiallyArmed, REARM_BAND } from './alertEval';

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  contract: stock('NVDA'),
  condition: 'below',
  price: 120,
  repeat: false,
  createdAt: 0,
  active: true,
  ...over,
});

/** Runs a price path through one alert and returns the indices at which it fired. */
function run(a: PriceAlert, prices: number[], armed = true): number[] {
  const fired: number[] = [];
  let state = armed;
  let current = a;
  prices.forEach((p, i) => {
    const r = evaluateAlert(current, p, state);
    state = r.armed;
    if (r.fire) {
      fired.push(i);
      if (!current.repeat) current = { ...current, active: false };
    }
  });
  return fired;
}

describe('evaluateAlert', () => {
  it('fires a one-shot alert once when the price crosses', () => {
    expect(run(alert({ condition: 'above', price: 235 }), [230, 234.99, 235, 236, 230, 240])).toEqual([2]);
    expect(run(alert({ condition: 'below', price: 120 }), [121, 120.5, 119.9, 125, 110])).toEqual([2]);
  });

  it('fires immediately when the condition is already met at creation', () => {
    expect(run(alert({ condition: 'above', price: 100 }), [118.62])).toEqual([0]);
  });

  it('fires a repeating alert on each crossing and re-arms after moving back', () => {
    const a = alert({ condition: 'above', price: 100, repeat: true });
    expect(run(a, [99, 101, 102, 98, 97, 100.5, 99, 101])).toEqual([1, 5, 7]);
  });

  it('does not re-arm on ticks bouncing at the trigger price', () => {
    const a = alert({ condition: 'below', price: 100, repeat: true });
    const inBand = 100 * (1 + REARM_BAND / 2);
    expect(run(a, [101, 99.99, inBand, 99.99, inBand, 99.98, 101, 99])).toEqual([1, 7]);
  });

  it('ignores inactive alerts and invalid prices', () => {
    expect(evaluateAlert(alert({ active: false }), 1, true)).toEqual({ fire: false, armed: true });
    expect(evaluateAlert(alert(), Number.NaN, true)).toEqual({ fire: false, armed: true });
    expect(evaluateAlert(alert(), 0, true)).toEqual({ fire: false, armed: true });
  });
});

describe('alert state helpers', () => {
  it('keeps a repeating alert that already fired disarmed after a restart', () => {
    expect(initiallyArmed(alert())).toBe(true);
    expect(initiallyArmed(alert({ lastTriggeredAt: 1 }))).toBe(true);
    expect(initiallyArmed(alert({ repeat: true }))).toBe(true);
    expect(initiallyArmed(alert({ repeat: true, lastTriggeredAt: 1 }))).toBe(false);
  });

  it('changes the signature when the trigger is edited', () => {
    const a = alert();
    expect(alertSignature({ ...a, lastTriggeredAt: 5 })).toBe(alertSignature(a));
    expect(alertSignature({ ...a, price: 119 })).not.toBe(alertSignature(a));
    expect(alertSignature({ ...a, active: false })).not.toBe(alertSignature(a));
  });

  it('collects unique contracts of active alerts', () => {
    const list = [alert(), alert({ id: 'a2', price: 110 }), alert({ id: 'a3', contract: stock('AAPL'), active: false })];
    expect(alertContracts(list).map((c) => c.symbol)).toEqual(['NVDA']);
  });
});

describe('alertTexts', () => {
  it('matches the design wording in both languages', () => {
    const t = alertTexts(alert(), 118.62, 118.62 / (1 - 0.0214));
    expect(t.title).toEqual({ en: 'NVDA fell below 120.00', zh: 'NVDA 跌破 120.00' });
    expect(t.body).toEqual({
      en: 'Last 118.62 (−2.14%). Your price alert was triggered.',
      zh: '现价 118.62（−2.14%），触发你设置的价格提醒。',
    });
    const up = alertTexts(alert({ contract: stock('AAPL'), condition: 'above', price: 235 }), 235.4, 230);
    expect(up.title).toEqual({ en: 'AAPL rose above 235.00', zh: 'AAPL 涨破 235.00' });
    expect(up.body.en).toBe('Last 235.40 (+2.35%). Your price alert was triggered.');
  });

  it('omits the change without a previous close and keeps extra price digits', () => {
    const t = alertTexts(alert({ contract: option('AAPL', '20261016', 230, 'C'), condition: 'above', price: 4.125 }), 4.13);
    expect(t.title.en).toBe('AAPL 10/16 230 Call rose above 4.125');
    expect(t.body.en).toBe('Last 4.13. Your price alert was triggered.');
    expect(t.body.zh).toBe('现价 4.13，触发你设置的价格提醒。');
  });
});
