import { describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import type { PriceAlert, Quote, QuoteSubscription } from '@shared/types';
import type { QuoteService } from '../context';
import { createAlertService } from './alerts';
import { createFakeContext, createFakeIb, settle } from './fakeIb';

function setup(initial: PriceAlert[] = []) {
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib);
  f.stored.alerts = initial;
  const listeners = new Set<(q: Quote) => void>();
  const quotes = new Map<string, Quote>();
  const subs = new Map<string, QuoteSubscription[]>();
  f.ctx.quotes = {
    setSubscriptions: (owner: string, s: QuoteSubscription[]) => void subs.set(owner, s),
    getQuote: (key: string) => quotes.get(key),
    onQuote: (l: (q: Quote) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  } as QuoteService;
  const svc = createAlertService(f.ctx);
  const tick = (key: string, last: number, close?: number) => {
    const q: Quote = { key, last, close, updatedAt: Date.now() };
    quotes.set(key, q);
    for (const l of listeners) l(q);
  };
  return { ...f, svc, subs, tick };
}

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  contract: stock('NVDA'),
  condition: 'below',
  price: 120,
  repeat: false,
  createdAt: 1,
  active: true,
  ...over,
});

describe('AlertService', () => {
  it('subscribes the contracts of active alerts at startup', async () => {
    const { subs } = setup([alert(), alert({ id: 'a2', contract: stock('AAPL'), active: false })]);
    await settle();
    expect(subs.get('alerts')?.map((s) => [s.contract.symbol, s.profile])).toEqual([['NVDA', 'basic']]);
  });

  it('fires a one-shot alert, deactivates it and notifies', async () => {
    const { svc, subs, tick, stored, events, notifications } = setup();
    await settle();
    svc.save([alert()]);
    expect(events.at(-1)).toEqual({ type: 'priceAlerts', alerts: [alert()] });
    expect(subs.get('alerts')).toHaveLength(1);
    tick('STK:NVDA', 121.2, 121.21);
    expect(notifications).toHaveLength(0);
    tick('STK:NVDA', 118.62, 118.62 / (1 - 0.0214));
    expect(notifications).toEqual([
      {
        kind: 'price',
        title: { en: 'NVDA fell below 120.00', zh: 'NVDA 跌破 120.00' },
        body: { en: 'Last 118.62 (−2.14%). Your price alert was triggered.', zh: '现价 118.62（−2.14%），触发你设置的价格提醒。' },
        contract: stock('NVDA'),
      },
    ]);
    expect(stored.alerts[0].active).toBe(false);
    expect(stored.alerts[0].lastTriggeredAt).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'priceAlerts', alerts: [{ id: 'a1', active: false }] });
    expect(subs.get('alerts')).toEqual([]);
    tick('STK:NVDA', 110);
    expect(notifications).toHaveLength(1);
  });

  it('fires at once when the condition is already met on save', async () => {
    const { svc, tick, notifications } = setup();
    await settle();
    tick('STK:AAPL', 227.48, 224.52);
    svc.save([alert({ contract: stock('AAPL'), condition: 'above', price: 225 })]);
    expect(notifications.map((n) => n.title.en)).toEqual(['AAPL rose above 225.00']);
  });

  it('repeats on every crossing and stays active', async () => {
    const { svc, tick, notifications, stored } = setup();
    await settle();
    svc.save([alert({ condition: 'above', price: 100, repeat: true })]);
    for (const p of [99, 101, 102, 95, 100.5, 101]) tick('STK:NVDA', p);
    expect(notifications).toHaveLength(2);
    expect(stored.alerts[0].active).toBe(true);
  });

  it('does not repeat a fired repeating alert after a restart until it crosses back', async () => {
    const { tick, notifications } = setup([alert({ condition: 'above', price: 100, repeat: true, lastTriggeredAt: 5 })]);
    await settle();
    tick('STK:NVDA', 101);
    expect(notifications).toHaveLength(0);
    tick('STK:NVDA', 98);
    tick('STK:NVDA', 101);
    expect(notifications).toHaveLength(1);
  });
});
