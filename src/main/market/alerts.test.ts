import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { AlertStatus, Bar, ContractInfo, ContractRef, HistoryRequest, PriceAlert, Quote, QuoteSubscription } from '@shared/types';
import type { MainContext, QuoteService } from '../context';
import { sanitizeAlerts } from '../storeSchema';
import { createAlertService, SETTLE_MS, STORM_MAX } from './alerts';
import { createFakeContext, createFakeIb, fakeNews, settle } from './fakeIb';
import { createNewsService } from './news';
import { LINE_LIMIT_ERROR } from './subscriptions';

/** Tuesday 2026-10-13, 11:00 New York (regular session). */
const T0 = Date.parse('2026-10-13T11:00:00-04:00');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  contract: stock('NVDA'),
  rule: { type: 'priceBelow', value: 120 },
  frequency: 'once',
  createdAt: 1,
  active: true,
  ...over,
});

/**
 * The alert service on a fake connection (connected unless `offline`), quotes and store. The store
 * validates like the real one (store.ts → sanitizeAlerts), so the file's alerts are migrated.
 */
async function setup(
  initial: unknown[] = [],
  opts: { offline?: boolean; history?: (req: HistoryRequest) => Promise<Bar[]>; info?: Partial<ContractInfo>; news?: boolean } = {},
) {
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib);
  let stored = sanitizeAlerts(initial) ?? [];
  f.ctx.store.getPriceAlerts = () => stored;
  f.ctx.store.setPriceAlerts = (list: PriceAlert[]) => void (stored = sanitizeAlerts(list) ?? stored);
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
  f.ctx.contracts = {
    getInfo: async () => (opts.info ? (opts.info as ContractInfo) : null),
    resolve: async (c: ContractRef) => ({ ...c, conId: c.symbol === 'NVDA' ? 4815747 : 265598 }),
  } as unknown as MainContext['contracts'];
  const history: HistoryRequest[] = [];
  f.ctx.history = {
    get: (req: HistoryRequest) => {
      history.push(req);
      return opts.history ? opts.history(req) : Promise.resolve([]);
    },
  } as unknown as MainContext['history'];
  if (!opts.offline) fake.ready();
  if (opts.news) f.ctx.news = createNewsService(f.ctx);
  const svc = createAlertService(f.ctx);
  await settle();

  /** IB sends changes of a quote (live by default); the quote keeps what it had, as in market/quotes.ts. */
  const tick = (key: string, fields: Partial<Quote>) => {
    const q: Quote = Object.assign(quotes.get(key) ?? { key, updatedAt: 0, marketDataType: 1 }, fields, { updatedAt: Date.now() });
    quotes.set(key, q);
    for (const l of listeners) l(q);
  };
  /** A first quote, then the time it takes to count (SETTLE_MS). */
  const prime = async (key: string, fields: Partial<Quote>) => {
    tick(key, fields);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
  };
  const statusOf = (id: string): AlertStatus | undefined => svc.statuses().find((s) => s.id === id);
  return { ...f, fake, svc, subs, history, tick, prime, statusOf, stored: () => stored };
}

const titles = (list: Array<{ title: { en: string } }>) => list.map((n) => n.title.en);

describe('AlertService: the list', () => {
  it('subscribes the instruments of active alerts, with the VWAP for a stock turnover alert', async () => {
    const { subs } = await setup([
      alert(),
      alert({ id: 'a2', contract: stock('AAPL'), active: false }),
      alert({ id: 'a3', contract: stock('TSLA'), rule: { type: 'turnoverAbove', amount: 1e9 } }),
    ]);
    expect(subs.get('alerts')?.map((s) => [s.contract.symbol, s.profile])).toEqual([
      ['NVDA', 'basic'],
      ['TSLA', 'vwap'],
    ]);
  });

  it('migrates an alerts file of Tape 0.12 and evaluates it', async () => {
    const t = await setup([{ id: 'old', contract: stock('NVDA'), condition: 'below', price: 120, repeat: false, createdAt: 1, active: true }]);
    expect(t.svc.list()[0]).toMatchObject({ rule: { type: 'priceBelow', value: 120 }, frequency: 'once', condition: 'below', price: 120 });
    await t.prime('STK:NVDA', { last: 121 });
    t.tick('STK:NVDA', { last: 119 });
    expect(titles(t.notifications)).toEqual(['NVDA fell below 120.00']);
  });

  it('refuses invalid alerts, rules that do not fit the instrument and alerts over the limits', async () => {
    const { svc } = await setup();
    expect(() => svc.upsert({ ...alert(), rule: { type: 'priceBelow', value: -1 } })).toThrow('The alert is not valid');
    expect(() => svc.upsert({ id: 'x', contract: stock('NVDA'), condition: 'above', price: 1, createdAt: 1 } as unknown as PriceAlert)).toThrow('not valid');
    expect(() => svc.upsert(alert({ contract: { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' }, rule: { type: 'volumeAbove', shares: 1e6 } }))).toThrow('IB reports no volume');
    expect(() => svc.upsert(alert({ contract: { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' }, rule: { type: 'news', providers: ['BRFG'] } }))).toThrow('for stocks only');
    expect(() => svc.upsert(alert({ rule: { type: 'news', providers: [] } }))).toThrow('not valid');
    for (let i = 0; i < 10; i++) svc.upsert(alert({ id: `p${i}`, rule: { type: 'priceBelow', value: 100 + i } }));
    expect(() => svc.upsert(alert({ id: 'p10', rule: { type: 'priceBelow', value: 90 } }))).toThrow('At most 10 alerts of one type');
    // Editing one of the ten is fine.
    svc.upsert(alert({ id: 'p3', rule: { type: 'priceBelow', value: 50 } }));
    expect(svc.list()).toHaveLength(10);
  });

  it('keeps what only main writes when an alert is edited', async () => {
    const t = await setup([alert({ lastTriggeredAt: 50, lastValue: 119, active: false, createdAt: 7, updatedAt: 40 })]);
    t.svc.upsert(alert({ note: 'May', active: true, createdAt: 99, lastTriggeredAt: 1, lastValue: 1 }));
    expect(t.stored()[0]).toMatchObject({ note: 'May', active: false, createdAt: 7, lastTriggeredAt: 50, lastValue: 119, updatedAt: 40 });
    // A changed trigger counts as the user's change; the alert stays off until resumed.
    t.svc.upsert(alert({ rule: { type: 'priceBelow', value: 110 } }));
    expect(t.stored()[0]).toMatchObject({ active: false, updatedAt: T0 });
    expect(t.events.at(-1)).toMatchObject({ type: 'priceAlerts', alerts: [{ id: 'a1', rule: { value: 110 } }] });
  });
});

describe('AlertService: firing', () => {
  it('fires a one-shot alert, turns it off, releases its line and notifies', async () => {
    const t = await setup();
    await t.prime('STK:NVDA', { last: 121.2, close: 121.21 });
    t.svc.upsert(alert());
    expect(t.subs.get('alerts')).toHaveLength(1);
    expect(t.notifications).toHaveLength(0);
    t.tick('STK:NVDA', { last: 118.62, close: 118.62 / (1 - 0.0214) });
    expect(t.notifications).toEqual([
      {
        kind: 'price',
        title: { en: 'NVDA fell below 120.00', zh: 'NVDA 跌破 120.00' },
        body: { en: 'Last 118.62 (−2.14%)', zh: '现价 118.62（−2.14%）' },
        contract: stock('NVDA'),
      },
    ]);
    expect(t.stored()[0]).toMatchObject({ active: false, lastTriggeredAt: T0 + SETTLE_MS, lastValue: 118.62 });
    expect(t.events.at(-1)).toMatchObject({ type: 'priceAlerts', alerts: [{ id: 'a1', active: false }] });
    expect(t.subs.get('alerts')).toEqual([]);
    expect(t.statusOf('a1')?.state).toBe('triggered');
    t.tick('STK:NVDA', { last: 110 });
    expect(t.notifications).toHaveLength(1);
  });

  it('fires at once when an alert is created or resumed with its condition already met', async () => {
    const t = await setup();
    await t.prime('STK:AAPL', { last: 227.48, close: 224.52 });
    t.svc.upsert(alert({ contract: stock('AAPL'), rule: { type: 'priceAbove', value: 225 } }));
    expect(titles(t.notifications)).toEqual(['AAPL rose above 225.00']);
    t.svc.setActive(['a1'], true);
    expect(titles(t.notifications)).toEqual(['AAPL rose above 225.00', 'AAPL rose above 225.00']);
  });

  it('keeps a fired alert off when the renderer saves a stale copy of it', async () => {
    const t = await setup([alert()]);
    await t.prime('STK:NVDA', { last: 121 });
    const stale = t.svc.list()[0];
    t.tick('STK:NVDA', { last: 119 });
    expect(t.notifications).toHaveLength(1);
    t.svc.upsert({ ...stale, note: 'edited' });
    t.tick('STK:NVDA', { last: 118 });
    expect(t.stored()[0]).toMatchObject({ active: false, note: 'edited', lastTriggeredAt: T0 + SETTLE_MS });
    expect(t.notifications).toHaveLength(1);
  });

  it('keeps a deleted alert deleted when it fires around the delete', async () => {
    const t = await setup([alert({ frequency: 'always' }), alert({ id: 'a2', rule: { type: 'priceBelow', value: 100 } })]);
    await t.prime('STK:NVDA', { last: 121 });
    t.tick('STK:NVDA', { last: 119 });
    t.svc.remove(['a1']);
    await vi.advanceTimersByTimeAsync(120_000);
    t.tick('STK:NVDA', { last: 125 });
    t.tick('STK:NVDA', { last: 119 });
    expect(t.svc.list().map((a) => a.id)).toEqual(['a2']);
    expect(t.notifications).toHaveLength(1);
    expect(t.statusOf('a1')).toBeUndefined();
  });

  it('repeats an always-on alert once the price went back, at most once a minute', async () => {
    const t = await setup([alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'always' })]);
    await t.prime('STK:NVDA', { last: 99 });
    t.tick('STK:NVDA', { last: 101 });
    t.tick('STK:NVDA', { last: 98 });
    t.tick('STK:NVDA', { last: 101 });
    expect(t.notifications).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    t.tick('STK:NVDA', { last: 101.5 });
    expect(t.notifications).toHaveLength(2);
    expect(t.stored()[0].active).toBe(true);
  });

  it('does not repeat an always-on alert after a restart until it went back', async () => {
    const t = await setup([alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'always', lastTriggeredAt: 5 })]);
    await t.prime('STK:NVDA', { last: 101 });
    expect(t.notifications).toHaveLength(0);
    t.tick('STK:NVDA', { last: 98 });
    t.tick('STK:NVDA', { last: 101 });
    expect(t.notifications).toHaveLength(1);
  });

  it('fires a daily alert once per New York trading day, not at midnight in China', async () => {
    // Regular hours only: it fires again at Wednesday's open, not at 00:00 in Shanghai (noon in New York).
    const t = await setup([alert({ rule: { type: 'priceAbove', value: 100 }, frequency: 'daily', sessions: ['regular'] })]);
    await t.prime('STK:NVDA', { last: 101 });
    expect(t.notifications).toHaveLength(1);
    vi.setSystemTime(Date.parse('2026-10-14T00:00:00+08:00'));
    t.tick('STK:NVDA', { last: 101.2 });
    vi.setSystemTime(Date.parse('2026-10-14T09:29:00-04:00'));
    t.tick('STK:NVDA', { last: 101.3 });
    expect(t.notifications).toHaveLength(1);
    expect(t.statusOf('a1')?.state).toBe('outOfSession');
    vi.setSystemTime(Date.parse('2026-10-14T09:30:00-04:00'));
    t.tick('STK:NVDA', { last: 101.4 });
    expect(t.notifications).toHaveLength(2);
    expect(t.statusOf('a1')?.state).toBe('triggered');
  });

  it('fires nothing outside the alert sessions of a US stock', async () => {
    vi.setSystemTime(Date.parse('2026-10-13T21:00:00-04:00'));
    const t = await setup([alert({ rule: { type: 'priceAbove', value: 100 } }), alert({ id: 'night', rule: { type: 'priceAbove', value: 100 }, sessions: ['overnight'] })]);
    await t.prime('STK:NVDA', { last: 101 });
    expect(t.notifications).toHaveLength(1);
    expect(t.stored().find((a) => a.id === 'night')?.active).toBe(false);
    expect(t.statusOf('a1')?.state).toBe('outOfSession');
  });

  it('never fires on the quote it held before a disconnect', async () => {
    const t = await setup();
    await t.prime('STK:NVDA', { last: 118 });
    t.fake.close();
    t.svc.upsert(alert());
    expect(t.statusOf('a1')).toMatchObject({ state: 'offline' });
    t.fake.ready();
    expect(t.statusOf('a1')).toMatchObject({ state: 'waiting', reason: 'noQuote' });
    // The line's first answer, then its current price.
    t.tick('STK:NVDA', { marketDataType: 1 });
    t.tick('STK:NVDA', { last: 125 });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(t.notifications).toHaveLength(0);
    t.tick('STK:NVDA', { last: 119 });
    expect(t.notifications).toHaveLength(1);
  });

  it('fires a halt alert on a halt, and a resumption alert when trading resumes', async () => {
    const t = await setup([alert({ rule: { type: 'halt', dir: 'halted' } }), alert({ id: 'r', rule: { type: 'halt', dir: 'resumed' } })]);
    await t.prime('STK:NVDA', { last: 100, haltCode: 0 });
    t.tick('STK:NVDA', { haltCode: 2 });
    t.tick('STK:NVDA', { haltCode: 0 });
    expect(titles(t.notifications)).toEqual(['NVDA trading halted (volatility pause)', 'NVDA trading resumed']);
  });
});

describe('AlertService: market data', () => {
  it('fires price alerts on delayed data marked as delayed, and holds the rules that need live data', async () => {
    const t = await setup([alert(), alert({ id: 'w', rule: { type: 'windowFall', minutes: 3, pct: 1 } })]);
    await t.prime('STK:NVDA', { last: 121, close: 122, marketDataType: 3 });
    expect(t.statusOf('w')).toMatchObject({ state: 'delayed', needsLive: true });
    expect(t.statusOf('a1')).toMatchObject({ state: 'delayed' });
    t.tick('STK:NVDA', { last: 119 });
    expect(t.notifications.map((n) => n.body.en)).toEqual(['Last 119.00 (−2.46%) · Delayed 15 min']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    t.tick('STK:NVDA', { last: 100 });
    expect(t.notifications).toHaveLength(1);
  });

  it('fires nothing on frozen data', async () => {
    const t = await setup([alert()]);
    await t.prime('STK:NVDA', { last: 119, marketDataType: 2 });
    t.tick('STK:NVDA', { last: 110, marketDataType: 4 });
    expect(t.notifications).toHaveLength(0);
    expect(t.statusOf('a1')?.state).toBe('frozen');
  });

  it('waits for 3 minutes of continuous live prices before a 3-minute alert can fire', async () => {
    const t = await setup([alert({ rule: { type: 'windowRise', minutes: 3, pct: 2 } })]);
    await t.prime('STK:NVDA', { last: 100 });
    expect(t.statusOf('a1')).toMatchObject({ state: 'waiting', reason: 'window', readyIn: 179_000 });
    t.tick('STK:NVDA', { last: 103 });
    await vi.advanceTimersByTimeAsync(170_000);
    expect(t.notifications).toHaveLength(0);
    // The price 3 minutes ago is the first sample (100): +3% once the window covers 3 minutes.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(titles(t.notifications)).toEqual(['NVDA rose more than 2% in 3 min (+3.00%)']);
  });

  it('starts the window over after a delayed quote or a disconnect', async () => {
    const t = await setup([alert({ rule: { type: 'windowRise', minutes: 3, pct: 2 } })]);
    await t.prime('STK:NVDA', { last: 100 });
    await vi.advanceTimersByTimeAsync(100_000);
    t.tick('STK:NVDA', { last: 100.5, marketDataType: 3 });
    t.tick('STK:NVDA', { last: 103, marketDataType: 1 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.notifications).toHaveLength(0);
    t.fake.close();
    t.fake.ready();
    t.tick('STK:NVDA', { last: 106 });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(t.notifications).toHaveLength(0);
    expect(t.statusOf('a1')).toMatchObject({ state: 'waiting', reason: 'window' });
  });

  it('says when no market data line is free, once per alert', async () => {
    const t = await setup([alert(), alert({ id: 'a2', rule: { type: 'priceAbove', value: 200 } })]);
    await t.prime('STK:NVDA', { error: { ...LINE_LIMIT_ERROR, final: true } });
    expect(t.statusOf('a1')).toMatchObject({ state: 'noLine', message: 'Market data line limit reached' });
    expect(t.notifications.map((n) => [n.kind, n.title.en])).toEqual([['sys', '2 alerts on NVDA are not being watched']]);
    t.tick('STK:NVDA', { error: undefined, last: 150 });
    t.tick('STK:NVDA', { error: { ...LINE_LIMIT_ERROR, final: true } });
    expect(t.notifications).toHaveLength(1);
  });

  it('does not fire on the values a quote kept through a line error', async () => {
    const t = await setup();
    await t.prime('STK:NVDA', { last: 125 });
    t.tick('STK:NVDA', { error: { ...LINE_LIMIT_ERROR, final: true } });
    t.svc.upsert(alert({ rule: { type: 'priceAbove', value: 120 } }));
    expect(t.statusOf('a1')?.state).toBe('noLine');
    // A line is free again: the error goes first, then IB sends the price now.
    t.tick('STK:NVDA', { error: undefined });
    t.tick('STK:NVDA', { last: 118 });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(t.notifications.filter((n) => n.kind === 'price')).toHaveLength(0);
    t.tick('STK:NVDA', { last: 121 });
    expect(titles(t.notifications.filter((n) => n.kind === 'price'))).toEqual(['NVDA rose above 120.00']);
  });

  it('folds alert notifications beyond the per-minute limit into one', async () => {
    const symbols = Array.from({ length: STORM_MAX + 5 }, (_, i) => `S${i}`);
    const t = await setup(symbols.map((s, i) => alert({ id: s, contract: stock(s), rule: { type: 'priceAbove', value: 10 }, createdAt: i })));
    for (const s of symbols) t.tick(`STK:${s}`, { last: 9 });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    for (const s of symbols) t.tick(`STK:${s}`, { last: 11 });
    expect(t.notifications).toHaveLength(STORM_MAX);
    expect(t.stored().every((a) => !a.active)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.notifications).toHaveLength(STORM_MAX + 1);
    expect(t.notifications.at(-1)!.title).toEqual({ en: '5 more alerts triggered', zh: '另有 5 个提醒触发' });
    expect(t.notifications.at(-1)!.body.en).toBe('S20 rose above 10.00; S21 rose above 10.00; S22 rose above 10.00; S23 rose above 10.00; S24 rose above 10.00');
  });

  it('sends the statuses when what the list shows changes', async () => {
    const t = await setup([alert()]);
    t.tick('STK:NVDA', { last: 125 });
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 300);
    expect(t.events.filter((e) => e.type === 'alertStatuses').at(-1)).toEqual({ type: 'alertStatuses', statuses: [{ id: 'a1', state: 'ok', value: 125 }] });
    const sent = t.events.length;
    t.tick('STK:NVDA', { last: 126 });
    await vi.advanceTimersByTimeAsync(300);
    // Only the value moved: the views poll for it.
    expect(t.events.length).toBe(sent);
    t.svc.setActive(['a1'], false);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.events.filter((e) => e.type === 'alertStatuses').at(-1)).toEqual({ type: 'alertStatuses', statuses: [{ id: 'a1', state: 'paused' }] });
    expect(t.subs.get('alerts')).toEqual([]);
  });

  it('lists a newer version’s alert as unsupported, never evaluates it and keeps it as written', async () => {
    const t = await setup([{ id: 'f', contract: stock('NVDA'), rule: { type: 'turnoverRatioAbove', pct: 3 }, frequency: 'once', createdAt: 1, active: true }]);
    expect(t.statusOf('f')).toEqual({ id: 'f', state: 'unsupported', reason: 'newerVersion' });
    expect(() => t.svc.upsert({ ...t.svc.list()[0], unsupported: undefined, rule: { type: 'priceAbove', value: 1 } })).toThrow('newer version');
    t.svc.setActive(['f'], false);
    expect(t.subs.get('alerts')).toEqual([]);
    // Another alert's fire writes the list: the newer Tape's alert stays on for when it runs again.
    await t.prime('STK:AAPL', { last: 121 });
    t.svc.upsert(alert({ id: 'p', contract: stock('AAPL') }));
    t.tick('STK:AAPL', { last: 119 });
    expect(titles(t.notifications)).toEqual(['AAPL fell below 120.00']);
    expect(t.stored().find((a) => a.id === 'f')).toMatchObject({ active: true, unsupported: true });
    expect(t.statusOf('f')?.state).toBe('unsupported');
  });
});

describe('AlertService: indicators', () => {
  // One-minute bars from 10:40 to the forming 11:00 bar, all closing at 100.
  const minute = (hhmm: string) => Date.parse(`2026-10-13T${hhmm}:00-04:00`) / 1000;
  const flat: Bar[] = Array.from({ length: 21 }, (_, i) => ({ time: minute('10:40') + i * 60, open: 100, high: 100, low: 100, close: 100, volume: 10 }));
  const maCross = alert({ rule: { type: 'indicator', timeframe: '1m', on: 'live', signal: { ind: 'ma', kind: 'price', period: 5, cross: 'up' } }, frequency: 'always' });

  it("loads the chart's bars at background priority and fires on a cross the live price makes, once per bar", async () => {
    const t = await setup([maCross], { history: async () => flat });
    expect(t.history).toEqual([{ contract: stock('NVDA'), timeframe: '1m', outsideRth: true, slot: 'alerts:STK:NVDA|1m', background: true }]);
    await t.prime('STK:NVDA', { last: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.statusOf('a1')).toMatchObject({ state: 'ok', value: 100, detail: { close: 100, MA5: 100 } });
    t.tick('STK:NVDA', { last: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(titles(t.notifications)).toEqual(['NVDA crossed above MA5 · 1m']);
    t.tick('STK:NVDA', { last: 99 });
    await vi.advanceTimersByTimeAsync(1000);
    t.tick('STK:NVDA', { last: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.notifications).toHaveLength(1);
  });

  it('says when the bars cannot be loaded or are too few', async () => {
    const t = await setup([maCross], { history: async () => flat.slice(0, 3) });
    await t.prime('STK:NVDA', { last: 100 });
    expect(t.statusOf('a1')).toMatchObject({ state: 'noData', reason: 'tooFewBars' });
    const u = await setup([maCross], { history: async () => Promise.reject(new Error('No market data permissions')) });
    await u.prime('STK:NVDA', { last: 100 });
    expect(u.statusOf('a1')).toMatchObject({ state: 'noData', reason: 'barsError', message: 'No market data permissions' });
  });

  /** A one-time MA cross-up alert on bars of `timeframe`, tested when a bar closes. */
  const closeCross = (timeframe: '1h' | '1D' | '1W', period: number, over: Partial<PriceAlert> = {}) =>
    alert({ rule: { type: 'indicator', timeframe, on: 'close', signal: { ind: 'ma', kind: 'price', period, cross: 'up' } }, ...over });
  const at = (s: string) => vi.setSystemTime(Date.parse(`${s}-04:00`));

  it("fires a weekly on-close cross when the week closes, not at a weekday's close", async () => {
    const weeks = ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'];
    const closes = [10, 10, 9, 8, 12];
    const weekly: Bar[] = weeks.map((d, i) => ({ time: Date.parse(`${d}T00:00:00Z`) / 1000, open: 10, high: 13, low: 7, close: closes[i], volume: 100 }));
    const t = await setup([closeCross('1W', 2)], { history: async () => weekly });
    await t.prime('STK:NVDA', { last: 12 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.statusOf('a1')?.state).toBe('ok');
    // The week that began on Monday is still trading after Tuesday's close and in Wednesday's pre-market.
    for (const time of ['2026-10-13T16:01:00', '2026-10-14T08:00:00', '2026-10-16T15:59:00']) {
      at(time);
      t.tick('STK:NVDA', { last: 12 });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(t.notifications).toHaveLength(0);
    at('2026-10-16T16:00:00');
    t.tick('STK:NVDA', { last: 12 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(titles(t.notifications)).toEqual(['NVDA crossed above MA2 · W']);
  });

  it("fires a daily on-close cross at the close for an alert limited to regular hours, not again at the next open", async () => {
    // Daily bars: flat at 100, today's moves to 101 before the close.
    const day = (d: number) => Date.UTC(2026, 9, d) / 1000;
    const daily: Bar[] = [5, 6, 7, 8, 9, 12, 13].map((d) => ({ time: day(d), open: 100, high: 100, low: 100, close: 100, volume: 10 }));
    const t = await setup([closeCross('1D', 5, { frequency: 'daily', sessions: ['regular'] })], { history: async () => daily });
    await t.prime('STK:NVDA', { last: 100 });
    at('2026-10-13T15:50:00');
    t.tick('STK:NVDA', { last: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.notifications).toHaveLength(0);
    // Read at 16:00 in the post-market, but the day's bar is a regular-session bar.
    at('2026-10-13T16:00:00');
    t.tick('STK:NVDA', { last: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(titles(t.notifications)).toEqual(['NVDA crossed above MA5 · D']);
    // Not again at the next open, when yesterday's bar is still the newest.
    at('2026-10-14T09:30:00');
    t.tick('STK:NVDA', { last: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.notifications).toHaveLength(1);
  });

  it('fires the on-close cross of the last regular-hours bar for an alert limited to regular hours', async () => {
    // Hourly bars from 04:00 to the one forming now, flat at 100.
    const hourly = async () => {
      const now = Date.now() / 1000;
      const out: Bar[] = [];
      for (let time = Date.parse('2026-10-13T04:00:00-04:00') / 1000; time <= now; time += 3600) out.push({ time, open: 100, high: 100, low: 100, close: 100, volume: 10 });
      return out;
    };
    const t = await setup([closeCross('1h', 5, { sessions: ['regular'] })], { history: hourly });
    await t.prime('STK:NVDA', { last: 100 });
    at('2026-10-13T15:50:00');
    t.tick('STK:NVDA', { last: 100 });
    // The reload that is due brings the bars up to the 15:00 one, which the live price then moves.
    await vi.advanceTimersByTimeAsync(2000);
    t.tick('STK:NVDA', { last: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.notifications).toHaveLength(0);
    // The 15:00 bar ends at 16:00 and is read in the post-market.
    at('2026-10-13T16:00:30');
    t.tick('STK:NVDA', { last: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(titles(t.notifications)).toEqual(['NVDA crossed above MA5 · 1h']);
    expect(t.statusOf('a1')?.state).toBe('triggered');
  });

  it('keeps indicator alerts to 20 bar series when turning them on', async () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      alert({ id: `i${i}`, contract: stock(`S${i}`), rule: { type: 'indicator', timeframe: '1D', on: 'close', signal: { ind: 'rsi', kind: 'level', period: 6, level: 80, cross: 'up' } }, active: i < 20, createdAt: i }),
    );
    const t = await setup(many);
    expect(() => t.svc.setActive(['i20'], true)).toThrow('at most 20');
    expect(t.stored()[20].active).toBe(false);
    // Another interval of an instrument already watched is another series too.
    expect(() => t.svc.upsert(alert({ id: 'n', contract: stock('S0'), rule: { type: 'indicator', timeframe: '1h', on: 'close', signal: { ind: 'rsi', kind: 'level', period: 6, level: 80, cross: 'up' } } }))).toThrow('at most 20');
    t.svc.upsert(alert({ id: 'same', contract: stock('S0'), rule: { type: 'indicator', timeframe: '1D', on: 'close', signal: { ind: 'kdj', kind: 'cross', n: 9, m1: 3, m2: 3, cross: 'up' } } }));
    expect(t.history.filter((r) => r.contract.symbol === 'S0')).toHaveLength(1);
  });
});

describe('AlertService: news', () => {
  const NVDA_ID = 4815747;
  const LOGIN = [
    { code: 'BRFG', name: 'Briefing.com General Market Columns' },
    { code: 'BRFUPDN', name: 'Briefing.com Analyst Actions' },
    { code: 'DJNL', name: 'Dow Jones Newsletters' },
  ];
  const FIVE_MIN = 5 * 60_000;
  const news = (over: Partial<PriceAlert> = {}): PriceAlert => alert({ id: 'n1', rule: { type: 'news', providers: ['BRFUPDN'] }, frequency: 'always', ...over });

  /** The alert service with the real news service over a fake IB with the free providers. */
  async function setupNews(initial: unknown[], providers = LOGIN) {
    const fake = createFakeIb();
    const ibNews = fakeNews(fake, providers);
    // setup() makes its own IB double: hand it this one through a context it builds on.
    const t = await setupWith(fake, initial);
    const publish = (articleId: string, time: string, text = `Headline ${articleId}`, provider = 'BRFUPDN') =>
      ibNews.headlines.push({ conId: NVDA_ID, time, provider, articleId, text });
    return { ...t, ibNews, publish };
  }

  async function setupWith(fake: ReturnType<typeof createFakeIb>, initial: unknown[]) {
    const f = createFakeContext(fake.ib);
    let stored = sanitizeAlerts(initial) ?? [];
    f.ctx.store.getPriceAlerts = () => stored;
    f.ctx.store.setPriceAlerts = (list: PriceAlert[]) => void (stored = sanitizeAlerts(list) ?? stored);
    const subs = new Map<string, QuoteSubscription[]>();
    f.ctx.quotes = { setSubscriptions: (owner: string, s: QuoteSubscription[]) => void subs.set(owner, s), getQuote: () => undefined, onQuote: () => () => undefined } as unknown as QuoteService;
    f.ctx.contracts = { getInfo: async () => null, resolve: async (c: ContractRef) => ({ ...c, conId: NVDA_ID }) } as unknown as MainContext['contracts'];
    fake.ready();
    f.ctx.news = createNewsService(f.ctx);
    const svc = createAlertService(f.ctx);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    const statusOf = (id: string): AlertStatus | undefined => svc.statuses().find((s) => s.id === id);
    return { ...f, fake, svc, subs, statusOf, stored: () => stored };
  }

  it('announces a headline that comes after the alert, never one from before it, and holds no market data line', async () => {
    const t = await setupNews([]);
    t.publish('old', '2026-10-13 14:30:00.0');
    t.svc.upsert(news({ note: 'Earnings week' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.statusOf('n1')).toMatchObject({ state: 'ok', checkedAt: T0, headline: 'Headline old' });
    expect(t.subs.get('alerts')).toEqual([]);
    t.publish('a1', '2026-10-13 15:03:00.0', '{A:800015:L:en:K:n/a:C:0.97}NVIDIA target raised to $150 at Example Securities');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.notifications).toEqual([
      {
        kind: 'price',
        title: { en: 'NVDA: new headline — NVIDIA target raised to $150 at Example Securities', zh: 'NVDA 新闻：NVIDIA target raised to $150 at Example Securities' },
        body: { en: 'Source: Briefing.com Analyst Actions · Note: Earnings week', zh: '来源：Briefing.com Analyst Actions · 备注：Earnings week' },
        contract: stock('NVDA'),
      },
    ]);
    expect(t.stored()[0]).toMatchObject({ active: true, lastTriggeredAt: T0 + FIVE_MIN, lastValue: 1 });
    // The same headline is not announced again.
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.notifications).toHaveLength(1);
  });

  it("fires on the alert's providers only, once for several headlines, and turns a one-time alert off", async () => {
    const t = await setupNews([news({ frequency: 'once' })]);
    t.publish('d1', '2026-10-13 15:01:00.0', 'Newsletter', 'DJNL');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.notifications).toHaveLength(0);
    t.publish('a1', '2026-10-13 15:06:00.0', 'First');
    t.publish('a2', '2026-10-13 15:07:00.0', 'Second');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.notifications.map((n) => [n.title.en, n.body.en])).toEqual([['NVDA: new headline — Second', 'Source: Briefing.com Analyst Actions · 1 more new headline']]);
    expect(t.stored()[0].active).toBe(false);
    expect(t.statusOf('n1')?.state).toBe('triggered');
    expect(t.ibNews.requests).toHaveLength(3);
    // Off: its stock is not checked any more.
    await vi.advanceTimersByTimeAsync(2 * FIVE_MIN);
    expect(t.ibNews.requests).toHaveLength(3);
  });

  it('fires a daily news alert once per New York trading day', async () => {
    const t = await setupNews([news({ frequency: 'daily' })]);
    t.publish('a1', '2026-10-13 15:03:00.0');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    t.publish('a2', '2026-10-13 15:08:00.0');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.notifications).toHaveLength(1);
    expect(t.statusOf('n1')?.state).toBe('triggered');
    // 20:00 New York starts the next trading day.
    vi.setSystemTime(Date.parse('2026-10-13T20:01:00-04:00'));
    t.publish('a3', '2026-10-14 00:01:00.0');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.notifications.map((n) => n.title.en)).toEqual(['NVDA: new headline — Headline a1', 'NVDA: new headline — Headline a3']);
  });

  it('starts an alert added later from the check made when it is created', async () => {
    const t = await setupNews([news()]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    // Published before the second alert exists; the first alert has not seen it yet.
    t.publish('a1', '2026-10-13 15:01:00.0');
    t.svc.upsert(news({ id: 'n2' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.notifications).toHaveLength(1);
    expect(t.statusOf('n2')).toMatchObject({ state: 'ok', headline: 'Headline a1' });
    t.publish('a2', '2026-10-13 15:06:00.0');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.notifications).toHaveLength(3);
    // A resumed alert starts again from the check made when it is turned on (2 s after the last
    // check): the first alert announces what that check finds, the resumed one does not.
    t.svc.setActive(['n2'], false);
    t.publish('a3', '2026-10-13 15:12:00.0');
    t.svc.setActive(['n2'], true);
    expect(t.statusOf('n2')).toMatchObject({ state: 'waiting', reason: 'news' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.notifications.map((n) => n.title.en).slice(3)).toEqual(['NVDA: new headline — Headline a3']);
    expect(t.statusOf('n2')).toMatchObject({ state: 'ok', headline: 'Headline a3' });
  });

  it('says why a news alert is not watched', async () => {
    const t = await setupNews([news({ rule: { type: 'news', providers: ['BZ'] } }), news({ id: 'n2' })], [LOGIN[1]]);
    expect(t.statusOf('n1')).toEqual({ id: 'n1', state: 'noData', reason: 'noProviders' });
    expect(t.statusOf('n2')).toMatchObject({ state: 'ok' });
    t.ibNews.refuse = { code: 10276, message: 'News feed is not allowed' };
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.statusOf('n2')).toEqual({ id: 'n2', state: 'noData', reason: 'newsError', message: 'News feed is not allowed (IB 10276)' });
    expect(t.events.filter((e) => e.type === 'alertStatuses').length).toBeGreaterThan(0);
    t.fake.close();
    expect(t.statusOf('n2')).toEqual({ id: 'n2', state: 'offline' });
    // Another login: its providers are asked for before anything is checked.
    t.ibNews.answerProviders = false;
    t.fake.newSession('params');
    t.fake.ready();
    expect(t.statusOf('n2')).toEqual({ id: 'n2', state: 'waiting', reason: 'newsProviders' });
  });

  it('waits for its first check after a restart, and announces nothing from before it', async () => {
    const fake = createFakeIb();
    const ibNews = fakeNews(fake, LOGIN);
    ibNews.headlines.push({ conId: NVDA_ID, time: '2026-10-13 14:00:00.0', provider: 'BRFUPDN', articleId: 'a0', text: 'Before' });
    ibNews.answerProviders = false;
    const t = await setupWith(fake, [news()]);
    expect(t.statusOf('n1')).toEqual({ id: 'n1', state: 'waiting', reason: 'newsProviders' });
    ibNews.answerProviders = true;
    await vi.advanceTimersByTimeAsync(60_000 + 10_000);
    expect(t.statusOf('n1')).toMatchObject({ state: 'ok', headline: 'Before' });
    expect(t.notifications).toHaveLength(0);
  });
});
