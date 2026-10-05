import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractKey, index, option, stock } from '@shared/contract';
import type { TapeEvent } from '@shared/ipc';
import type { ContractRef, Quote } from '@shared/types';
import type { ContractService } from '../context';
import { createFakeContext, createFakeIb, settle } from './fakeIb';
import { LINGER_MS, createQuoteService, quotePatch, RECONCILE_MS } from './quotes';
import { TICK } from './tickMap';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quoteEvents = (events: TapeEvent[]) => events.filter((e): e is Extract<TapeEvent, { type: 'quotes' }> => e.type === 'quotes');

/** Services start on setImmediate (real timers); timeouts and Date are faked afterwards. */
async function setup(demo = false, fake = true) {
  const ib = createFakeIb();
  const { ctx, events } = createFakeContext(ib.ib, demo);
  const resolved: ContractRef[] = [];
  ctx.contracts = {
    resolve: async (c: ContractRef) => {
      resolved.push(c);
      return { ...c, conId: 4242 };
    },
  } as unknown as ContractService;
  const svc = createQuoteService(ctx);
  ctx.quotes = svc;
  await settle();
  if (fake) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  return { fake: ib, ctx, events, svc, resolved };
}

/** Lets the debounced reconcile run. */
const reconciled = () => vi.advanceTimersByTime(RECONCILE_MS);

const reqIdOf = (fake: ReturnType<typeof createFakeIb>, symbol: string): number => {
  const call = [...fake.callsOf('reqMktData')].reverse().find((c) => (c[1] as { symbol?: string; conId?: number }).symbol === symbol);
  return call![0] as number;
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
  vi.useRealTimers();
});

describe('quote subscriptions with IB', () => {
  it('waits for the handshake, then requests delayed-frozen data and one line per contract', async () => {
    const { fake, svc } = await setup();
    svc.setSubscriptions('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: index('SPX', 'CBOE'), profile: 'basic' },
    ]);
    svc.setSubscriptions('options-underlying', [{ contract: stock('AAPL'), profile: 'underlying' }]);
    reconciled();
    expect(fake.calls).toEqual([]);
    fake.ready();
    expect(fake.callsOf('reqMarketDataType')).toEqual([[4]]);
    const reqs = fake.callsOf('reqMktData');
    expect(reqs.map((r) => [(r[1] as { symbol: string }).symbol, r[2], r[3], r[4]])).toEqual([
      ['AAPL', '100,101,104,106,165,318,456', false, false],
      ['SPX', '', false, false],
    ]);
  });

  it('reconciles a burst of owner changes in one pass', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
    svc.setSubscriptions('chart', [{ contract: stock('MSFT'), profile: 'basic' }]);
    svc.setSubscriptions('chart', [{ contract: stock('NVDA'), profile: 'basic' }]);
    expect(fake.callsOf('reqMktData')).toHaveLength(0);
    reconciled();
    expect(fake.callsOf('reqMktData').map((c) => (c[1] as { symbol: string }).symbol)).toEqual(['NVDA']);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
  });

  it('keeps a released line for 30 s and reuses it when the contract is wanted again', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    const id = reqIdOf(fake, 'AAPL');
    fake.emit('tickPrice', id, TICK.LAST, 227.5);
    fake.emit('tickPrice', id, TICK.CLOSE, 224.5);
    vi.advanceTimersByTime(100);
    svc.setSubscriptions('chart', [{ contract: stock('MSFT'), profile: 'basic' }]);
    reconciled();
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    // The lingering line keeps its quote current but no longer publishes it.
    const before = quoteEvents(events).length;
    fake.emit('tickPrice', id, TICK.LAST, 228);
    vi.advanceTimersByTime(200);
    expect(quoteEvents(events).slice(before).some((e) => 'STK:AAPL' in e.quotes)).toBe(false);
    expect(svc.getQuote('STK:AAPL')?.last).toBe(228);
    // Back to AAPL within the linger time: no request, and the renderer gets the whole quote.
    vi.advanceTimersByTime(10_000);
    svc.setSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(quoteEvents(events).at(-1)!.quotes['STK:AAPL']).toMatchObject({ key: 'STK:AAPL', last: 228, close: 224.5 });
    // MSFT lingers now (released 100 ms ago) and is cancelled once its time is up; its quote goes with the line.
    vi.advanceTimersByTime(LINGER_MS - 101);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fake.callsOf('cancelMktData')).toEqual([[reqIdOf(fake, 'MSFT')]]);
    expect(svc.getQuote('STK:MSFT')).toBeUndefined();
    expect(svc.getQuote('STK:AAPL')?.last).toBe(228);
  });

  it('keeps a line whose ticks cover the new profiles and re-requests one that does not', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    svc.setSubscriptions('options-underlying', [{ contract: stock('AAPL'), profile: 'underlying' }]);
    reconciled();
    const first = fake.callsOf('reqMktData')[0][0];
    expect(fake.callsOf('cancelMktData')).toEqual([[first]]);
    expect(fake.callsOf('reqMktData')[1][2]).toBe('100,101,104,106,165,318,456');
    // Dropping the underlying profile keeps the richer line.
    svc.setSubscriptions('options-underlying', []);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    expect(fake.callsOf('cancelMktData')).toHaveLength(1);
  });

  it('maps ticks, notifies listeners at once and batches only changed fields', async () => {
    const { fake, svc, events } = await setup();
    const seen: Quote[] = [];
    cleanup.push(svc.onQuote((q) => seen.push({ ...q })));
    fake.ready();
    svc.setSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    const id = reqIdOf(fake, 'AAPL');
    fake.emit('marketDataType', id, 3);
    fake.emit('tickPrice', id, TICK.DELAYED_LAST, 227.48);
    fake.emit('tickPrice', id, TICK.DELAYED_CLOSE, 224.52);
    fake.emit('tickSize', id, TICK.DELAYED_VOLUME, 1000);
    fake.emit('tickPrice', id + 999, TICK.LAST, 1); // unknown request: ignored
    expect(seen.map((q) => q.last)).toEqual([undefined, 227.48, 227.48, 227.48]);
    expect(quoteEvents(events)).toHaveLength(0);
    vi.advanceTimersByTime(100);
    let batches = quoteEvents(events);
    expect(batches).toHaveLength(1);
    expect(batches[0].quotes['STK:AAPL']).toMatchObject({ key: 'STK:AAPL', last: 227.48, close: 224.52, volume: 1000, marketDataType: 3 });
    expect(svc.getQuote('STK:AAPL')?.last).toBe(227.48);
    // The next batch carries only what changed.
    fake.emit('tickPrice', id, TICK.DELAYED_LAST, 227.5);
    fake.emit('tickSize', id, TICK.DELAYED_VOLUME, 1100);
    vi.advanceTimersByTime(100);
    batches = quoteEvents(events);
    const { updatedAt, ...rest } = batches[1].quotes['STK:AAPL'];
    expect(updatedAt).toBeTypeOf('number');
    expect(rest).toEqual({ key: 'STK:AAPL', last: 227.5, volume: 1100 });
  });

  it('keeps the quote on request errors and clears the error when data arrives', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    const id = reqIdOf(fake, 'AAPL');
    fake.error(id, 10197, 'No market data during competing live session');
    expect(svc.getQuote('STK:AAPL')?.error).toEqual({ code: 10197, message: 'No market data during competing live session' });
    fake.error(id, 2176, 'Warning: fractional share size rules'); // notice: ignored
    fake.error(id, 10091, 'Part of requested market data requires additional subscription for API.'); // warning: ignored
    expect(svc.getQuote('STK:AAPL')?.error?.code).toBe(10197);
    vi.advanceTimersByTime(100);
    fake.emit('tickPrice', id, TICK.LAST, 227.5);
    const q = svc.getQuote('STK:AAPL')!;
    expect(q.error).toBeUndefined();
    expect('error' in q).toBe(true);
    vi.advanceTimersByTime(100);
    const last = quoteEvents(events).at(-1)!;
    expect('error' in last.quotes['STK:AAPL']).toBe(true);
    expect(last.quotes['STK:AAPL'].error).toBeUndefined();
    // 10197 lines stay open at IB, so they are cancelled normally (after lingering).
    svc.setSubscriptions('watchlist', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData')).toEqual([[id]]);
  });

  it('marks dead lines final, does not cancel them and retries an unresolved contract with its conId', async () => {
    const { fake, svc, resolved } = await setup();
    fake.ready();
    svc.setSubscriptions('watchlist', [{ contract: stock('XYZ'), profile: 'basic' }]);
    reconciled();
    const id = reqIdOf(fake, 'XYZ');
    fake.error(id, 200, 'No security definition has been found for the request');
    // A retry follows, so this 200 is not final yet.
    expect(svc.getQuote('STK:XYZ')?.error).toEqual({ code: 200, message: 'No security definition has been found for the request' });
    vi.useRealTimers();
    await settle();
    expect(resolved).toHaveLength(1);
    const retry = fake.callsOf('reqMktData').at(-1)!;
    expect(retry[1]).toMatchObject({ conId: 4242 });
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    // A second 200 on the resolved line is final.
    fake.error(retry[0] as number, 200, 'No security definition has been found for the request');
    await settle();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    expect(svc.getQuote('STK:XYZ')?.error?.final).toBe(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    svc.setSubscriptions('watchlist', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    expect(svc.getQuote('STK:XYZ')).toBeUndefined();
  });

  it('keeps a 354 line alive when IB falls back to delayed data on it, and cancels it later', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    const call = option('MSFT', '20261005', 487.5, 'C');
    const put = option('MSFT', '20261005', 487.5, 'P');
    svc.setSubscriptions('options-chain', [
      { contract: call, profile: 'option' },
      { contract: put, profile: 'option' },
    ]);
    reconciled();
    const [callId, putId] = fake.callsOf('reqMktData').map((c) => c[0] as number);
    // Seen live: 354, then 10167 / marketDataType 3 and delayed ticks on the same line.
    fake.error(callId, 354, 'Requested market data is not subscribed.');
    expect(svc.getQuote(contractKey(call))?.error?.final).toBe(true);
    fake.error(callId, 10167, 'Requested market data is not subscribed. Displaying delayed market data.');
    expect(svc.getQuote(contractKey(call))?.error).toBeUndefined();
    fake.emit('tickPrice', callId, TICK.DELAYED_LAST, 31.7);
    // The put never recovers: it stays dead.
    fake.error(putId, 354, 'Requested market data is not subscribed.');
    svc.setSubscriptions('options-chain', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData')).toEqual([[callId]]);
  });

  it('marks 354 final and keeps 10197 transient', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setSubscriptions('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: stock('MSFT'), profile: 'basic' },
    ]);
    reconciled();
    fake.error(reqIdOf(fake, 'AAPL'), 354, 'Requested market data is not subscribed.');
    fake.error(reqIdOf(fake, 'MSFT'), 10197, 'No market data during competing live session');
    expect(svc.getQuote('STK:AAPL')?.error).toEqual({ code: 354, message: 'Requested market data is not subscribed.', final: true });
    expect(svc.getQuote('STK:MSFT')?.error?.final).toBeUndefined();
  });

  it('caps market data lines and hands freed lines to the overflow', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    const many = Array.from({ length: 100 }, (_, i) => ({ contract: stock(`S${i}`), profile: 'basic' as const }));
    svc.setSubscriptions('big', many);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(95);
    expect(svc.getQuote('STK:S99')?.error).toEqual({ code: -1, message: 'Market data line limit reached', final: true });
    expect(svc.getQuote('STK:S0')?.error).toBeUndefined();
    svc.setSubscriptions('big', many.slice(10));
    reconciled();
    // The released lines linger, so the overflow takes them over by reclaiming them.
    expect(fake.callsOf('cancelMktData')).toHaveLength(5);
    expect(fake.callsOf('reqMktData')).toHaveLength(100);
    expect(svc.getQuote('STK:S99')?.error).toBeUndefined();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData')).toHaveLength(10);
  });

  it('gives visible views lines before background owners', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    const background = Array.from({ length: 95 }, (_, i) => ({ contract: stock(`B${i}`), profile: 'basic' as const }));
    svc.setSubscriptions('portfolio', background);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(95);
    svc.setSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    // The newest background contract yields its line to the chart.
    expect(fake.callsOf('cancelMktData')).toEqual([[reqIdOf(fake, 'B94')]]);
    expect(reqIdOf(fake, 'AAPL')).toBeGreaterThan(0);
    expect(svc.getQuote('STK:B94')?.error).toMatchObject({ message: 'Market data line limit reached', final: true });
    expect(svc.getQuote('STK:AAPL')?.error).toBeUndefined();
  });

  it('reclaims lingering lines first when the cap is reached', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setSubscriptions('chart', [{ contract: stock('OLD'), profile: 'basic' }]);
    reconciled();
    svc.setSubscriptions('chart', []);
    reconciled();
    vi.advanceTimersByTime(1000);
    svc.setSubscriptions('portfolio', Array.from({ length: 95 }, (_, i) => ({ contract: stock(`P${i}`), profile: 'basic' as const })));
    reconciled();
    expect(fake.callsOf('cancelMktData')).toEqual([[reqIdOf(fake, 'OLD')]]);
    expect(fake.callsOf('reqMktData')).toHaveLength(96);
    expect(svc.getQuote('STK:OLD')).toBeUndefined();
  });

  it('subscribes everything again after a reconnect', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setSubscriptions('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: option('AAPL', '20261016', 230, 'C'), profile: 'option' },
    ]);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    fake.close();
    svc.setSubscriptions('chart', [{ contract: stock('MSFT'), profile: 'basic' }]);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    fake.ready();
    const after = fake.callsOf('reqMktData').slice(2);
    expect(after.map((r) => (r[1] as { symbol: string }).symbol)).toEqual(['AAPL', 'AAPL', 'MSFT']);
    expect(after[1][2]).toBe('100,101,106,221');
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    expect(fake.callsOf('reqMarketDataType')).toHaveLength(2);
    // 1101 "data lost": ready fires again without a close; all lines are requested again.
    fake.ready();
    expect(fake.callsOf('reqMktData')).toHaveLength(8);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
  });

  it('maps option open interest and the mark price to the option quote', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    const call = option('AAPL', '20261016', 230, 'C');
    svc.setSubscriptions('options-chain', [{ contract: call, profile: 'option' }]);
    reconciled();
    const id = fake.callsOf('reqMktData')[0][0] as number;
    expect(fake.callsOf('reqMktData')[0][2]).toBe('100,101,106,221');
    fake.emit('tickSize', id, TICK.OPTION_CALL_OPEN_INTEREST, 5120);
    fake.emit('tickPrice', id, TICK.MARK_PRICE, 3.15);
    fake.emit('tickOptionComputation', id, TICK.MODEL_OPTION, 0, 0.27, 0.45, 3.1, 0, 0.03, 0.2, -0.09, 227.4);
    expect(svc.getQuote(contractKey(call))).toMatchObject({ openInterest: 5120, mark: 3.15, iv: 0.27, delta: 0.45, gamma: 0.03, vega: 0.2, theta: -0.09, undPrice: 227.4 });
  });

  it('does constant work per tick however many lines are open', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setSubscriptions('portfolio', Array.from({ length: 95 }, (_, i) => ({ contract: stock(`P${i}`), profile: 'basic' as const })));
    reconciled();
    const ids = fake.callsOf('reqMktData').map((c) => c[0] as number);
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) fake.emit('tickPrice', ids[i % ids.length], TICK.LAST, 100 + (i % 7));
    expect(performance.now() - t0).toBeLessThan(1500);
    vi.advanceTimersByTime(100);
    expect(svc.getQuote('STK:P3')?.last).toBeGreaterThan(99);
  });
});

describe('quotePatch', () => {
  it('sends the whole quote first, then changed and cleared fields', () => {
    const q: Quote = { key: 'K', last: 1, bid: 0.9, updatedAt: 1 };
    expect(quotePatch(undefined, q)).toEqual({ key: 'K', last: 1, bid: 0.9, updatedAt: 1, error: undefined });
    expect(quotePatch({ ...q }, { ...q, updatedAt: 2 })).toBeNull();
    const next: Quote = { key: 'K', last: 2, updatedAt: 3, error: { code: 1, message: 'x' } };
    expect(quotePatch(q, next)).toEqual({ key: 'K', last: 2, bid: undefined, error: { code: 1, message: 'x' }, updatedAt: 3 });
  });
});

describe('quote subscriptions in demo mode', () => {
  it('serves simulated quotes without touching IB', async () => {
    const { fake, svc, events } = await setup(true, false);
    fake.ready();
    svc.setSubscriptions('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: index('VIX', 'CBOE'), profile: 'basic' },
    ]);
    cleanup.push(() => svc.setSubscriptions('watchlist', []));
    await wait(RECONCILE_MS + 5);
    expect(svc.getQuote('STK:AAPL')).toMatchObject({ marketDataType: 1 });
    expect(svc.getQuote('STK:AAPL')?.last).toBeGreaterThan(150);
    expect(svc.getQuote('IND:VIX')?.last).toBeGreaterThan(5);
    await wait(1000);
    expect(fake.calls).toEqual([]);
    const keys = new Set(quoteEvents(events).flatMap((e) => Object.keys(e.quotes)));
    expect(keys).toEqual(new Set(['STK:AAPL', 'IND:VIX']));
  });
});
