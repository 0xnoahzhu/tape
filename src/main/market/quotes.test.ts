import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractKey, index, option, stock } from '@shared/contract';
import type { TapeEvent } from '@shared/ipc';
import type { ContractRef, Quote } from '@shared/types';
import type { ContractService } from '../context';
import { createFakeContext, createFakeIb, settle } from './fakeIb';
import {
  CLOSE_RETRY_MS,
  CLOSE_WAIT_MS,
  LINGER_MS,
  createQuoteService,
  PRIMARY_GIVE_UP_MS,
  quotePatch,
  RECONCILE_MS,
  SIDE_TIMEOUT_MS,
  SMART_RETRY_MS,
} from './quotes';
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
    svc.setRendererSubscriptions('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: index('SPX', 'CBOE'), profile: 'basic' },
    ]);
    svc.setRendererSubscriptions('options-underlying', [{ contract: stock('AAPL'), profile: 'underlying' }]);
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
    svc.setRendererSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
    svc.setRendererSubscriptions('chart', [{ contract: stock('MSFT'), profile: 'basic' }]);
    svc.setRendererSubscriptions('chart', [{ contract: stock('NVDA'), profile: 'basic' }]);
    expect(fake.callsOf('reqMktData')).toHaveLength(0);
    reconciled();
    expect(fake.callsOf('reqMktData').map((c) => (c[1] as { symbol: string }).symbol)).toEqual(['NVDA']);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
  });

  it('keeps a released line for 30 s and reuses it when the contract is wanted again', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    const id = reqIdOf(fake, 'AAPL');
    fake.emit('tickPrice', id, TICK.LAST, 227.5);
    fake.emit('tickPrice', id, TICK.CLOSE, 224.5);
    vi.advanceTimersByTime(100);
    svc.setRendererSubscriptions('chart', [{ contract: stock('MSFT'), profile: 'basic' }]);
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
    svc.setRendererSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
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
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    svc.setRendererSubscriptions('options-underlying', [{ contract: stock('AAPL'), profile: 'underlying' }]);
    reconciled();
    const first = fake.callsOf('reqMktData')[0][0];
    expect(fake.callsOf('cancelMktData')).toEqual([[first]]);
    expect(fake.callsOf('reqMktData')[1][2]).toBe('100,101,104,106,165,318,456');
    // Dropping the underlying profile keeps the richer line.
    svc.setRendererSubscriptions('options-underlying', []);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    expect(fake.callsOf('cancelMktData')).toHaveLength(1);
  });

  it('maps ticks, notifies listeners at once and batches only changed fields', async () => {
    const { fake, svc, events } = await setup();
    const seen: Quote[] = [];
    cleanup.push(svc.onQuote((q) => seen.push({ ...q })));
    fake.ready();
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
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
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
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
    svc.setRendererSubscriptions('watchlist', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData')).toEqual([[id]]);
  });

  it('marks dead lines final, does not cancel them and retries an unresolved contract with its conId', async () => {
    const { fake, svc, resolved } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('XYZ'), profile: 'basic' }]);
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
    svc.setRendererSubscriptions('watchlist', []);
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
    svc.setRendererSubscriptions('options-chain', [
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
    svc.setRendererSubscriptions('options-chain', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData')).toEqual([[callId]]);
  });

  it('marks 354 final and keeps 10197 transient', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('watchlist', [
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
    svc.setRendererSubscriptions('big', many);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(95);
    expect(svc.getQuote('STK:S99')?.error).toEqual({ code: -1, message: 'Market data line limit reached', final: true });
    expect(svc.getQuote('STK:S0')?.error).toBeUndefined();
    svc.setRendererSubscriptions('big', many.slice(10));
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
    svc.setRendererSubscriptions('portfolio', background);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(95);
    svc.setRendererSubscriptions('chart', [{ contract: stock('AAPL'), profile: 'basic' }]);
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
    svc.setRendererSubscriptions('chart', [{ contract: stock('OLD'), profile: 'basic' }]);
    reconciled();
    svc.setRendererSubscriptions('chart', []);
    reconciled();
    vi.advanceTimersByTime(1000);
    svc.setRendererSubscriptions('portfolio', Array.from({ length: 95 }, (_, i) => ({ contract: stock(`P${i}`), profile: 'basic' as const })));
    reconciled();
    expect(fake.callsOf('cancelMktData')).toEqual([[reqIdOf(fake, 'OLD')]]);
    expect(fake.callsOf('reqMktData')).toHaveLength(96);
    expect(svc.getQuote('STK:OLD')).toBeUndefined();
  });

  it('subscribes everything again after a reconnect', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: option('AAPL', '20261016', 230, 'C'), profile: 'option' },
    ]);
    reconciled();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    fake.close();
    svc.setRendererSubscriptions('chart', [{ contract: stock('MSFT'), profile: 'basic' }]);
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
    svc.setRendererSubscriptions('options-chain', [{ contract: call, profile: 'option' }]);
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
    svc.setRendererSubscriptions('portfolio', Array.from({ length: 95 }, (_, i) => ({ contract: stock(`P${i}`), profile: 'basic' as const })));
    reconciled();
    const ids = fake.callsOf('reqMktData').map((c) => c[0] as number);
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) fake.emit('tickPrice', ids[i % ids.length], TICK.LAST, 100 + (i % 7));
    expect(performance.now() - t0).toBeLessThan(1500);
    vi.advanceTimersByTime(100);
    expect(svc.getQuote('STK:P3')?.last).toBeGreaterThan(99);
  });
});

describe('probe lines and main-process owners', () => {
  it('opens a probe line within the line budget, forwards its answers and cancels it on close', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    const seen: unknown[] = [];
    const probe = svc.probe({ ...stock('SPY'), conId: 756733, exchange: 'ARCA' }, '', (e) => seen.push(e))!;
    const [id, contract, ticks, snapshot, regulatory] = fake.callsOf('reqMktData')[0] as [number, unknown, string, boolean, boolean];
    expect([contract, ticks, snapshot, regulatory]).toEqual([{ conId: 756733, exchange: 'ARCA', secType: 'STK', currency: 'USD' }, '', false, false]);
    fake.emit('marketDataType', id, 1);
    fake.emit('tickPrice', id, TICK.BID, 670.1);
    fake.error(id, 10167, 'Displaying delayed market data.');
    expect(seen).toEqual([
      { kind: 'type', type: 1 },
      { kind: 'tick', field: TICK.BID, value: 670.1 },
      { kind: 'error', code: 10167, message: 'Displaying delayed market data.' },
    ]);
    // Not a quote of any owner.
    expect(svc.getQuote('STK:SPY')).toBeUndefined();
    probe.close();
    probe.close();
    expect(fake.callsOf('cancelMktData')).toEqual([[id]]);
  });

  it('counts probes against the cap, does not cancel a dead one and ends them with the session', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('chart', Array.from({ length: 94 }, (_, i) => ({ contract: stock(`S${i}`), profile: 'basic' as const })));
    reconciled();
    const events: unknown[] = [];
    const a = svc.probe(stock('SPY'), '', (e) => events.push(e));
    expect(a).not.toBeNull();
    // 95 lines in use: no second probe, and a new owner contract overflows.
    expect(svc.probe(stock('QQQ'), '', () => undefined)).toBeNull();
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('MSFT'), profile: 'basic' }]);
    reconciled();
    expect(svc.getQuote('STK:MSFT')?.error).toMatchObject({ message: 'Market data line limit reached' });
    const probeId = fake.callsOf('reqMktData').find((c) => (c[1] as { symbol: string }).symbol === 'SPY')![0] as number;
    fake.error(probeId, 354, 'Requested market data is not subscribed.');
    // The dead probe gives its line back.
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('MSFT'), profile: 'basic' }, { contract: stock('IBM'), profile: 'basic' }]);
    reconciled();
    expect(svc.getQuote('STK:MSFT')?.error).toBeUndefined();
    a!.close();
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    const b = svc.probe(stock('QQQ'), '', (e) => events.push(e));
    expect(b).toBeNull(); // MSFT took the freed line
    svc.setRendererSubscriptions('watchlist', []);
    reconciled();
    const c = svc.probe(stock('DIA'), '', (e) => events.push(e))!;
    expect(c).not.toBeNull();
    fake.close();
    expect(events.at(-1)).toEqual({ kind: 'error', code: -1, message: 'Connection closed' });
    c.close();
    expect(fake.callsOf('cancelMktData').map((x) => x[0])).not.toContain(fake.callsOf('reqMktData').at(-1)![0]);
  });

  it('keeps quotes only main-process owners want from the renderer and reports line notices', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    const notices: unknown[] = [];
    cleanup.push(svc.onNotice((key, code) => notices.push([key, code])));
    const seen: string[] = [];
    cleanup.push(svc.onQuote((q) => seen.push(q.key)));
    svc.setSubscriptions('md-check', [{ contract: stock('SPY'), profile: 'basic' }]);
    reconciled();
    const id = reqIdOf(fake, 'SPY');
    fake.error(id, 10167, 'Displaying delayed market data.');
    fake.emit('marketDataType', id, 3);
    fake.emit('tickPrice', id, TICK.DELAYED_LAST, 670);
    vi.advanceTimersByTime(200);
    expect(notices).toEqual([['STK:SPY', 10167]]);
    expect(seen).toContain('STK:SPY');
    expect(quoteEvents(events)).toHaveLength(0);
    expect(svc.wanted().map((w) => [w.contract.symbol, w.quote?.marketDataType])).toEqual([['SPY', 3]]);
    // A renderer owner wanting it too gets the whole quote at once.
    svc.setRendererSubscriptions('chart', [{ contract: stock('SPY'), profile: 'basic' }]);
    reconciled();
    vi.advanceTimersByTime(100);
    expect(quoteEvents(events).at(-1)!.quotes['STK:SPY']).toMatchObject({ last: 670, marketDataType: 3 });
    expect(fake.callsOf('reqMktData')).toHaveLength(1);
  });
});

describe('main-process owners', () => {
  it('sends a quote only a main-process owner held once a background renderer owner wants it', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setSubscriptions('md-check', [{ contract: stock('SPY'), profile: 'basic' }]);
    reconciled();
    const id = reqIdOf(fake, 'SPY');
    fake.emit('marketDataType', id, 2);
    fake.emit('tickPrice', id, TICK.LAST, 670);
    fake.emit('tickPrice', id, TICK.CLOSE, 668);
    vi.advanceTimersByTime(200);
    expect(quoteEvents(events)).toHaveLength(0);
    svc.setRendererSubscriptions('portfolio', [{ contract: stock('SPY'), profile: 'basic' }]);
    reconciled();
    vi.advanceTimersByTime(100);
    expect(quoteEvents(events).at(-1)?.quotes['STK:SPY']).toMatchObject({ last: 670, marketDataType: 2 });
  });
});

describe('primary-exchange fallback', () => {
  /** A quote service whose contracts resolve to `primary` (NASDAQ by default), with AAPL wanted by the watchlist. */
  async function fallbackSetup(primary = 'NASDAQ') {
    const env = await setup();
    env.ctx.contracts = {
      resolve: async (c: ContractRef) => {
        env.resolved.push(c);
        return { ...c, conId: 265598, primaryExchange: primary };
      },
    } as unknown as ContractService;
    env.fake.ready();
    env.svc.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    return { ...env, smartId: reqIdOf(env.fake, 'AAPL') };
  }
  const flushAsync = () => vi.advanceTimersByTimeAsync(0);
  const lastReq = (fake: ReturnType<typeof createFakeIb>) => fake.callsOf('reqMktData').at(-1)! as [number, ...unknown[]];

  it('moves a delayed SMART stock to its primary exchange when that one is live', async () => {
    const { fake, svc, events, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    fake.emit('tickPrice', smartId, TICK.DELAYED_LAST, 331.85);
    await flushAsync();
    const [sideId, contract, ticks, snapshot] = lastReq(fake) as [number, unknown, string, boolean];
    expect([contract, ticks, snapshot]).toEqual([{ conId: 265598, exchange: 'NASDAQ', secType: 'STK', currency: 'USD' }, '318', false]);
    // The side line's ticks wait for its data type; the quote stays SMART's meanwhile.
    fake.emit('tickPrice', sideId, TICK.BID, 332.41);
    expect(svc.getQuote('STK:AAPL')).toMatchObject({ marketDataType: 3, last: 331.85 });
    expect(svc.getQuote('STK:AAPL')?.bid).toBeUndefined();
    fake.emit('marketDataType', sideId, 1);
    expect(fake.callsOf('cancelMktData')).toEqual([[smartId]]);
    expect(svc.getQuote('STK:AAPL')).toMatchObject({ marketDataType: 1, bid: 332.41, source: { kind: 'primary', exchange: 'NASDAQ' } });
    fake.emit('tickPrice', sideId, TICK.LAST, 332.2);
    expect(svc.getQuote('STK:AAPL')?.last).toBe(332.2);
    // Ticks of the old line no longer count.
    fake.emit('tickPrice', smartId, TICK.DELAYED_LAST, 330);
    expect(svc.getQuote('STK:AAPL')?.last).toBe(332.2);
    vi.advanceTimersByTime(100);
    expect(quoteEvents(events).at(-1)!.quotes['STK:AAPL']).toMatchObject({ source: { kind: 'primary', exchange: 'NASDAQ' }, marketDataType: 1 });
    // One line per contract in the steady state.
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
  });

  it('keeps SMART and does not probe again for a while when the exchange is delayed too', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    fake.error(smartId, 10167, 'Requested market data is not subscribed. Displaying delayed market data.');
    await flushAsync();
    const sideId = lastReq(fake)[0];
    fake.error(sideId, 10167, 'Displaying delayed market data.');
    expect(fake.callsOf('cancelMktData')).toEqual([[sideId]]);
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    expect(svc.getQuote('STK:AAPL')?.source).toBeUndefined();
    // After the give-up time the still delayed line is probed once more; a silent side line times out.
    await vi.advanceTimersByTimeAsync(PRIMARY_GIVE_UP_MS);
    expect(fake.callsOf('reqMktData')).toHaveLength(3);
    const again = lastReq(fake)[0];
    await vi.advanceTimersByTimeAsync(SIDE_TIMEOUT_MS);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([again]);
    expect(svc.getQuote('STK:AAPL')?.source).toBeUndefined();
  });

  it('tries SMART again every 10 minutes and goes back to it once it is live', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 4);
    await flushAsync();
    const primaryId = lastReq(fake)[0];
    fake.emit('marketDataType', primaryId, 1);
    await vi.advanceTimersByTimeAsync(SMART_RETRY_MS);
    const [retryId, retryContract] = lastReq(fake) as [number, { exchange: string; symbol: string }];
    expect([retryContract.symbol, retryContract.exchange]).toEqual(['AAPL', 'SMART']);
    fake.emit('marketDataType', retryId, 3);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([retryId]);
    expect(svc.getQuote('STK:AAPL')?.source).toEqual({ kind: 'primary', exchange: 'NASDAQ' });
    await vi.advanceTimersByTimeAsync(SMART_RETRY_MS);
    const second = lastReq(fake)[0];
    expect(second).not.toBe(retryId);
    fake.emit('marketDataType', second, 1);
    fake.emit('tickPrice', second, TICK.LAST, 333);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([primaryId]);
    expect(svc.getQuote('STK:AAPL')).toMatchObject({ marketDataType: 1, last: 333 });
    expect(svc.getQuote('STK:AAPL')?.source).toBeUndefined();
    // Released, the SMART line lingers and goes like any other.
    svc.setRendererSubscriptions('watchlist', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([second]);
  });

  it('starts on SMART again after a reconnect, and tries SMART when a competing session ends', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    fake.emit('marketDataType', lastReq(fake)[0], 1);
    expect(svc.getQuote('STK:AAPL')?.source).toBeDefined();
    fake.close();
    fake.ready();
    const fresh = lastReq(fake) as [number, { exchange: string }];
    expect(fresh[1].exchange).toBe('SMART');
    expect(svc.getQuote('STK:AAPL')?.source).toBeUndefined();
    // On the exchange again; then 10197 comes and goes.
    fake.emit('marketDataType', fresh[0], 3);
    await flushAsync();
    const primaryId = lastReq(fake)[0];
    fake.emit('marketDataType', primaryId, 1);
    const before = fake.callsOf('reqMktData').length;
    fake.error(primaryId, 10197, 'No market data during competing live session');
    fake.emit('tickPrice', primaryId, TICK.LAST, 332);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.callsOf('reqMktData')).toHaveLength(before + 1);
    expect((lastReq(fake)[1] as { exchange: string }).exchange).toBe('SMART');
  });

  it('keeps the exchange line when the profiles change, and leaves other instruments alone', async () => {
    const { fake, svc, smartId, resolved } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    fake.emit('marketDataType', lastReq(fake)[0], 1);
    svc.setRendererSubscriptions('options-underlying', [{ contract: stock('AAPL'), profile: 'underlying' }]);
    reconciled();
    const [, contract, ticks] = lastReq(fake) as [number, { exchange: string }, string];
    expect([contract.exchange, ticks]).toEqual(['NASDAQ', '100,101,104,106,165,318,456']);
    expect(svc.getQuote('STK:AAPL')?.source).toEqual({ kind: 'primary', exchange: 'NASDAQ' });
    // Options, an index and a stock routed to its exchange already are never moved.
    const n = resolved.length;
    svc.setRendererSubscriptions('chart', [
      { contract: option('AAPL', '20261016', 230, 'C'), profile: 'option' },
      { contract: index('SPX', 'CBOE'), profile: 'basic' },
      { contract: { ...stock('IBM'), exchange: 'NYSE' }, profile: 'basic' },
    ]);
    reconciled();
    for (const sym of ['SPX', 'IBM']) fake.emit('marketDataType', reqIdOf(fake, sym), 3);
    fake.emit('marketDataType', fake.callsOf('reqMktData').find((c) => (c[1] as { secType: string }).secType === 'OPT')![0], 3);
    await flushAsync();
    expect(resolved).toHaveLength(n);
  });

  it('goes back to SMART when the exchange line turns delayed and SMART is delayed too', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    const primaryId = lastReq(fake)[0];
    fake.emit('marketDataType', primaryId, 1);
    expect(svc.getQuote('STK:AAPL')?.source).toBeDefined();
    // The exchange goes delayed: SMART is tried at once and answers delayed as well.
    fake.emit('marketDataType', primaryId, 3);
    await flushAsync();
    const [retryId, retry] = lastReq(fake) as [number, { exchange: string }];
    expect(retry.exchange).toBe('SMART');
    fake.emit('marketDataType', retryId, 3);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([primaryId]);
    expect(svc.getQuote('STK:AAPL')).toMatchObject({ marketDataType: 3 });
    expect(svc.getQuote('STK:AAPL')?.source).toBeUndefined();
    expect(svc.fallbacks()).toEqual([]); // the exchange is no longer live
    // No new exchange probe until the give-up time has passed.
    const n = fake.callsOf('reqMktData').length;
    fake.emit('marketDataType', retryId, 3);
    await vi.advanceTimersByTimeAsync(SMART_RETRY_MS);
    expect(fake.callsOf('reqMktData')).toHaveLength(n);
  });

  it('requests SMART again when the exchange line is delayed and the SMART side line fails', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    const primaryId = lastReq(fake)[0];
    fake.emit('marketDataType', primaryId, 1);
    fake.emit('marketDataType', primaryId, 4);
    await flushAsync();
    const retryId = lastReq(fake)[0];
    fake.error(retryId, 10168, 'Requested market data is not subscribed. Delayed market data is not enabled.');
    const [freshId, fresh] = lastReq(fake) as [number, { exchange: string }];
    expect(freshId).not.toBe(retryId);
    expect(fresh.exchange).toBe('SMART');
    expect(fake.callsOf('cancelMktData')).toContainEqual([primaryId]);
    expect(svc.getQuote('STK:AAPL')?.source).toBeUndefined();
  });

  it('does not churn side lines when a side line answers 10197 while delayed prices flow', async () => {
    const { fake, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    for (let i = 0; i < 20; i++) {
      const side = lastReq(fake)[0];
      if (side !== smartId) fake.error(side, 10197, 'No market data during competing live session');
      fake.emit('tickPrice', smartId, TICK.DELAYED_LAST, 331 + i / 100);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
  });

  it('ends a competing session only on a live price of a line that reported it, at most once a minute', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    svc.setRendererSubscriptions('chart', [{ contract: stock('NVDA'), profile: 'basic' }]);
    reconciled();
    const nvda = reqIdOf(fake, 'NVDA');
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    fake.error(lastReq(fake)[0], 10168, 'not subscribed'); // the exchange is not live either: give up
    const n = fake.callsOf('reqMktData').length;
    fake.error(nvda, 10197, 'No market data during competing live session');
    // Delayed AAPL prices do not end it.
    fake.emit('tickPrice', smartId, TICK.DELAYED_LAST, 331);
    await flushAsync();
    expect(fake.callsOf('reqMktData')).toHaveLength(n);
    fake.emit('marketDataType', nvda, 1);
    fake.emit('tickPrice', nvda, TICK.LAST, 180);
    await flushAsync();
    expect(fake.callsOf('reqMktData')).toHaveLength(n + 1); // AAPL's exchange probed again
    fake.error(lastReq(fake)[0], 10168, 'not subscribed');
    fake.error(nvda, 10197, 'No market data during competing live session');
    fake.emit('tickPrice', nvda, TICK.LAST, 181);
    await flushAsync();
    expect(fake.callsOf('reqMktData')).toHaveLength(n + 1);
  });

  it('gives a line a side line held back to a contract waiting for one, and never takes a lingering line', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    svc.setRendererSubscriptions('chart', Array.from({ length: 94 }, (_, i) => ({ contract: stock(`S${i}`), profile: 'basic' as const })));
    reconciled();
    svc.setRendererSubscriptions('chart', Array.from({ length: 93 }, (_, i) => ({ contract: stock(`S${i}`), profile: 'basic' as const })));
    reconciled();
    // 94 lines plus S93 lingering: no free line for a side line, and S93 keeps its line.
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    expect(fake.callsOf('reqMktData')).toHaveLength(95);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    // S93 goes; the next probe takes the free line, and MSFT arrives meanwhile.
    vi.advanceTimersByTime(LINGER_MS);
    await vi.advanceTimersByTimeAsync(60_000 - LINGER_MS); // the retry after "no free line"
    const sideId = lastReq(fake)[0];
    expect((lastReq(fake)[1] as { exchange: string }).exchange).toBe('NASDAQ');
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }, { contract: stock('MSFT'), profile: 'basic' }]);
    reconciled();
    expect(svc.getQuote('STK:MSFT')?.error).toMatchObject({ message: 'Market data line limit reached' });
    fake.emit('marketDataType', sideId, 3);
    reconciled();
    expect(fake.callsOf('reqMktData').some((c) => (c[1] as { symbol: string }).symbol === 'MSFT')).toBe(true);
    expect(svc.getQuote('STK:MSFT')?.error).toBeUndefined();
  });

  it('keeps the give-up when the line goes, so a stock wanted again does not probe its exchange again', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    fake.emit('marketDataType', lastReq(fake)[0], 3); // the exchange is delayed too: give up
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    // Released and swept (route and quote go), then wanted again: SMART only, no side line.
    svc.setRendererSubscriptions('watchlist', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([smartId]);
    expect(svc.getQuote('STK:AAPL')).toBeUndefined();
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    const again = lastReq(fake)[0];
    fake.emit('marketDataType', again, 3);
    await flushAsync();
    expect(fake.callsOf('reqMktData')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(PRIMARY_GIVE_UP_MS - LINGER_MS - 1_000);
    expect(fake.callsOf('reqMktData')).toHaveLength(3);
    // At the end of the give-up the still delayed line probes once.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.callsOf('reqMktData')).toHaveLength(4);
    expect((lastReq(fake)[1] as { exchange: string }).exchange).toBe('NASDAQ');
  });

  it('remembers what the fallback found after the line goes and across reconnects, per account', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    expect(svc.fallbacks()).toEqual([]);
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    const primaryId = lastReq(fake)[0];
    fake.emit('marketDataType', primaryId, 1);
    expect(svc.fallbacks()).toEqual([{ symbol: 'AAPL', exchange: 'NASDAQ', at: Date.now(), active: true }]);
    // The user leaves the page: the exchange line goes after lingering, the finding stays.
    svc.setRendererSubscriptions('watchlist', []);
    reconciled();
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([primaryId]);
    expect(svc.wanted()).toEqual([]);
    expect(svc.fallbacks()).toMatchObject([{ symbol: 'AAPL', exchange: 'NASDAQ', active: false }]);
    fake.close();
    fake.ready();
    expect(svc.fallbacks()).toHaveLength(1);
    // SMART answers live: the finding no longer holds.
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('AAPL'), profile: 'basic' }]);
    reconciled();
    fake.emit('marketDataType', lastReq(fake)[0], 1);
    expect(svc.fallbacks()).toEqual([]);
    // A finding goes when the exchange answers delayed, and with another account.
    fake.emit('marketDataType', lastReq(fake)[0], 3);
    await flushAsync();
    fake.emit('marketDataType', lastReq(fake)[0], 1);
    expect(svc.fallbacks()).toHaveLength(1);
    const state = fake.ib.getState();
    fake.ib.getState = () => ({ ...state, account: 'DU111', accounts: ['DU111'] });
    fake.close();
    fake.ready();
    expect(svc.fallbacks()).toHaveLength(1); // the first account seen
    fake.ib.getState = () => ({ ...state, account: 'DU222', accounts: ['DU222'] });
    fake.close();
    fake.ready();
    expect(svc.fallbacks()).toEqual([]);
  });

  it('requests a quote served by its exchange again on that exchange when it has no close', async () => {
    const { fake, svc, smartId } = await fallbackSetup();
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    const primaryId = lastReq(fake)[0];
    fake.emit('marketDataType', primaryId, 1);
    fake.emit('tickPrice', primaryId, TICK.LAST, 333.42);
    await vi.advanceTimersByTimeAsync(CLOSE_WAIT_MS);
    expect(fake.callsOf('cancelMktData').at(-1)).toEqual([primaryId]);
    const [againId, again] = lastReq(fake) as [number, { exchange: string }];
    expect(again.exchange).toBe('NASDAQ');
    fake.emit('marketDataType', againId, 1);
    fake.emit('tickPrice', againId, TICK.CLOSE, 333.69);
    expect(svc.getQuote('STK:AAPL')).toMatchObject({ close: 333.69, last: 333.42, source: { kind: 'primary', exchange: 'NASDAQ' } });
  });

  it('does not move stocks whose primary exchange is not a US one IB serves directly', async () => {
    const { fake, svc, smartId } = await fallbackSetup('PINK');
    fake.emit('marketDataType', smartId, 3);
    await flushAsync();
    expect(fake.callsOf('reqMktData')).toHaveLength(1);
    expect(svc.getQuote('STK:AAPL')?.source).toBeUndefined();
  });
});

describe('the renderer copy', () => {
  /** A live line's first ticks (its subscription image): type 1, bid / ask / last and the previous close. */
  const image = (fake: ReturnType<typeof createFakeIb>, symbol: string, last: number, close: number) => {
    const id = reqIdOf(fake, symbol);
    fake.emit('marketDataType', id, 1);
    fake.emit('tickPrice', id, TICK.BID, last - 0.01);
    fake.emit('tickPrice', id, TICK.ASK, last + 0.01);
    fake.emit('tickPrice', id, TICK.LAST, last);
    fake.emit('tickPrice', id, TICK.CLOSE, close);
  };
  const basic = (...symbols: string[]) => symbols.map((s) => ({ contract: stock(s), profile: 'basic' as const }));

  it('does not send what only main-process owners want, and sends the whole quote when a renderer owner wants it again', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    // A price alert on NVDA and the watchlist (seen live: the renderer kept a price without a close).
    svc.setSubscriptions('alerts', basic('NVDA'));
    svc.setRendererSubscriptions('watchlist', basic('NVDA'));
    reconciled();
    const id = reqIdOf(fake, 'NVDA');
    image(fake, 'NVDA', 236.59, 233.95);
    vi.advanceTimersByTime(100);
    expect(quoteEvents(events).at(-1)).toMatchObject({ quotes: { 'STK:NVDA': { close: 233.95, marketDataType: 1 } }, full: ['STK:NVDA'] });
    // The Orders page: the watchlist releases NVDA and the renderer drops it; the alert keeps the line.
    svc.setRendererSubscriptions('watchlist', []);
    reconciled();
    const seen: Array<number | undefined> = [];
    cleanup.push(svc.onQuote((q) => seen.push(q.last)));
    const before = quoteEvents(events).length;
    fake.emit('tickPrice', id, TICK.LAST, 236.7);
    vi.advanceTimersByTime(LINGER_MS + 100);
    expect(seen).toEqual([236.7]);
    expect(quoteEvents(events)).toHaveLength(before);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    // Back on the Trade page: the whole quote, with its close and data type.
    svc.setRendererSubscriptions('watchlist', basic('NVDA'));
    reconciled();
    vi.advanceTimersByTime(100);
    const back = quoteEvents(events).at(-1)!;
    expect(back.full).toEqual(['STK:NVDA']);
    expect(back.quotes['STK:NVDA']).toMatchObject({ last: 236.7, close: 233.95, marketDataType: 1 });
    // Then changes only.
    fake.emit('tickPrice', id, TICK.LAST, 236.8);
    vi.advanceTimersByTime(100);
    expect(quoteEvents(events).at(-1)!.full).toBeUndefined();
    expect(fake.callsOf('reqMktData')).toHaveLength(1);
  });

  it('drops the owners of a replaced or closed renderer and sends the new one whole quotes', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setSubscriptions('alerts', basic('TSLA'));
    svc.setRendererSubscriptions('watchlist', basic('AAPL', 'TSLA'));
    svc.setRendererSubscriptions('search', basic('IBM'));
    reconciled();
    image(fake, 'AAPL', 333.42, 333.69);
    image(fake, 'TSLA', 377.59, 370.59);
    image(fake, 'IBM', 290, 288);
    vi.advanceTimersByTime(100);
    // A reload: the old renderer never released its owners; the new one starts empty and declares its own.
    svc.resetRenderer();
    svc.setRendererSubscriptions('watchlist', basic('AAPL', 'TSLA'));
    reconciled();
    vi.advanceTimersByTime(100);
    const batch = quoteEvents(events).at(-1)!;
    expect([...batch.full!].sort()).toEqual(['STK:AAPL', 'STK:TSLA']);
    expect(batch.quotes['STK:AAPL']).toMatchObject({ last: 333.42, close: 333.69, marketDataType: 1 });
    expect(batch.quotes['STK:TSLA']).toMatchObject({ close: 370.59 });
    // The old renderer's search went with it: its line lingers and is cancelled.
    vi.advanceTimersByTime(LINGER_MS);
    expect(fake.callsOf('cancelMktData')).toEqual([[reqIdOf(fake, 'IBM')]]);
    // The window is closed (macOS keeps Tape running): nothing is sent, its lines go, the alert keeps TSLA's.
    svc.resetRenderer();
    reconciled();
    const n = quoteEvents(events).length;
    fake.emit('tickPrice', reqIdOf(fake, 'TSLA'), TICK.LAST, 380);
    vi.advanceTimersByTime(LINGER_MS + 100);
    expect(quoteEvents(events)).toHaveLength(n);
    expect(fake.callsOf('cancelMktData').map((c) => c[0])).toEqual([reqIdOf(fake, 'IBM'), reqIdOf(fake, 'AAPL')]);
    expect(svc.getQuote('STK:TSLA')).toMatchObject({ last: 380, close: 370.59 });
  });

  it('sends a quote whole again when the renderer asks, but only one a renderer owner wants', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('watchlist', basic('AAPL'));
    svc.setSubscriptions('alerts', basic('NVDA'));
    reconciled();
    image(fake, 'AAPL', 333.42, 333.69);
    image(fake, 'NVDA', 236.59, 233.95);
    vi.advanceTimersByTime(100);
    fake.emit('tickPrice', reqIdOf(fake, 'AAPL'), TICK.LAST, 333.5);
    svc.resend(['STK:AAPL', 'STK:NVDA', 'STK:NONE']);
    vi.advanceTimersByTime(100);
    const batch = quoteEvents(events).at(-1)!;
    expect(batch.full).toEqual(['STK:AAPL']);
    expect(Object.keys(batch.quotes)).toEqual(['STK:AAPL']);
    expect(batch.quotes['STK:AAPL']).toMatchObject({ last: 333.5, close: 333.69, marketDataType: 1 });
  });

  it('never sends a close IB marks not available', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('watchlist', basic('NVDA'));
    reconciled();
    const id = reqIdOf(fake, 'NVDA');
    image(fake, 'NVDA', 236.59, 233.95);
    vi.advanceTimersByTime(100);
    fake.emit('tickPrice', id, TICK.CLOSE, -1);
    fake.emit('tickPrice', id, TICK.CLOSE, 0);
    fake.emit('tickPrice', id, TICK.LAST, 236.7);
    vi.advanceTimersByTime(100);
    expect('close' in quoteEvents(events).at(-1)!.quotes['STK:NVDA']).toBe(false);
    expect(svc.getQuote('STK:NVDA')?.close).toBe(233.95);
  });
});

describe('a missing previous close', () => {
  it('requests a line again that streams prices without a close, and then leaves it alone', async () => {
    const { fake, svc, events } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('portfolio', [{ contract: stock('NVDA'), profile: 'dividends' }]);
    reconciled();
    const first = reqIdOf(fake, 'NVDA');
    // Data without the subscription image (a line opened during a competing session).
    fake.emit('tickPrice', first, TICK.BID, 236.58);
    fake.emit('tickPrice', first, TICK.ASK, 236.6);
    vi.advanceTimersByTime(CLOSE_WAIT_MS - 1);
    expect(fake.callsOf('reqMktData')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fake.callsOf('cancelMktData')).toEqual([[first]]);
    const [again, contract, ticks] = fake.callsOf('reqMktData')[1] as [number, { symbol: string }, string];
    expect([contract.symbol, ticks]).toEqual(['NVDA', '318,456']);
    // The quote keeps its prices meanwhile, and the new request brings the close.
    expect(svc.getQuote('STK:NVDA')).toMatchObject({ bid: 236.58, ask: 236.6 });
    fake.emit('tickPrice', again, TICK.LAST, 236.59);
    fake.emit('tickPrice', again, TICK.CLOSE, 233.95);
    vi.advanceTimersByTime(100);
    expect(quoteEvents(events).at(-1)!.quotes['STK:NVDA']).toMatchObject({ last: 236.59, close: 233.95 });
    fake.emit('tickPrice', again, TICK.LAST, 236.7);
    vi.advanceTimersByTime(4 * CLOSE_RETRY_MS);
    expect(fake.callsOf('reqMktData')).toHaveLength(2);
    expect(fake.callsOf('cancelMktData')).toHaveLength(1);
  });

  it('backs off for an instrument that has no close', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('NEWCO'), profile: 'basic' }]);
    reconciled();
    const priced = () => fake.emit('tickPrice', reqIdOf(fake, 'NEWCO'), TICK.LAST, 20);
    const requests = () => fake.callsOf('reqMktData').length;
    priced();
    vi.advanceTimersByTime(CLOSE_WAIT_MS);
    expect(requests()).toBe(2);
    // Its first trading day: still no close. The next request comes CLOSE_RETRY_MS later, then twice that.
    priced();
    vi.advanceTimersByTime(CLOSE_RETRY_MS - 1);
    expect(requests()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(requests()).toBe(3);
    priced();
    vi.advanceTimersByTime(2 * CLOSE_RETRY_MS - 1);
    expect(requests()).toBe(3);
    vi.advanceTimersByTime(1);
    expect(requests()).toBe(4);
  });

  it('leaves options, lingering lines, main-process owners and a new session alone', async () => {
    const { fake, svc } = await setup();
    fake.ready();
    const call = option('NVDA', '20261016', 240, 'C');
    svc.setRendererSubscriptions('options-chain', [{ contract: call, profile: 'option' }]);
    svc.setRendererSubscriptions('chart', [{ contract: stock('AMD'), profile: 'basic' }]);
    svc.setRendererSubscriptions('watchlist', [{ contract: stock('MSFT'), profile: 'basic' }]);
    svc.setSubscriptions('alerts', [{ contract: stock('TSLA'), profile: 'basic' }]);
    reconciled();
    fake.emit('tickPrice', fake.callsOf('reqMktData')[0][0], TICK.BID, 1.2);
    for (const s of ['AMD', 'TSLA']) fake.emit('tickPrice', reqIdOf(fake, s), TICK.LAST, 100);
    // The chart moves on before the check: AMD lingers.
    vi.advanceTimersByTime(1_000);
    svc.setRendererSubscriptions('chart', []);
    reconciled();
    vi.advanceTimersByTime(CLOSE_WAIT_MS);
    expect(fake.callsOf('reqMktData')).toHaveLength(4);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
    // A reconnect requests every line again before MSFT's check is due.
    fake.emit('tickPrice', reqIdOf(fake, 'MSFT'), TICK.LAST, 517);
    vi.advanceTimersByTime(1_000);
    fake.close();
    fake.ready();
    const n = fake.callsOf('reqMktData').length;
    vi.advanceTimersByTime(CLOSE_RETRY_MS);
    expect(fake.callsOf('reqMktData')).toHaveLength(n);
    expect(fake.callsOf('cancelMktData')).toEqual([]);
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
    svc.setRendererSubscriptions('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: index('VIX', 'CBOE'), profile: 'basic' },
    ]);
    cleanup.push(() => svc.setRendererSubscriptions('watchlist', []));
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
