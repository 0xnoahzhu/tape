// The quote service and the renderer's quotes end to end: the main-process service (with the price
// alert service) sends its batches through a stand-in for Electron's IPC (a structured clone, as
// Electron makes) to the renderer's bridge, whose owners subscribe through state/quoteSubscriptions.
// Seen live: after a page switch some watchlist rows showed a price without a change, because the
// renderer had rebuilt those quotes from changes alone (no previous close).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { option, stock } from '@shared/contract';
import { defaultSettings, defaultWatchlists } from '@shared/defaults';
import type { TapeApi, TapeEvent } from '@shared/ipc';
import type { AppSnapshot, Position, PriceAlert, Quote, QuoteSubscription } from '@shared/types';
import { createAlertService } from './alerts';
import { createFakeContext, createFakeIb, settle } from './fakeIb';
import { createQuoteService } from './quotes';
import { TICK } from './tickMap';

const SYMBOLS = ['AAPL', 'NVDA', 'MSFT', 'AMD', 'META', 'AMZN', 'TSLA', 'SPY', 'QQQ'];

/** What the test uses of the renderer's modules, which are typed for the DOM (tsconfig.web.json), not for this project. */
interface RendererModules {
  startBridge(): Promise<void>;
  setQuoteSubscriptions(owner: string, subs: QuoteSubscription[]): Promise<void>;
  useStore: { getState(): { quotes: Record<string, Quote> }; setState(patch: { quotes: Record<string, Quote> }): void };
  changePct(q: Quote | undefined): number | undefined;
  startRiskWatcher(): void;
}

/** Imports a renderer module by a path the type checker does not follow (see RendererModules). */
const rendererModule = (path: string): Promise<Partial<RendererModules>> => import(/* @vite-ignore */ `../../renderer/src/${path}`);
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

const alertOn = (symbol: string, i: number): PriceAlert => ({ id: `a${i}`, contract: stock(symbol), condition: 'above', price: 99_999, repeat: false, createdAt: 0, active: true });

/** Tape's main process (quotes and price alerts) and a renderer connected to it. */
async function setup(opts: { alerts?: string[]; positions?: Position[] } = {}) {
  const fake = createFakeIb();
  const { ctx, stored } = createFakeContext(fake.ib);
  stored.alerts = (opts.alerts ?? []).map(alertOn);
  const svc = createQuoteService(ctx);
  ctx.quotes = svc;
  ctx.alerts = createAlertService(ctx);
  await settle();

  let listeners: Array<(e: TapeEvent) => void> = [];
  ctx.emit = (e) => {
    for (const l of listeners) l(structuredClone(e));
  };
  const resends: string[][] = [];
  const snapshot = (): AppSnapshot => ({
    platform: 'darwin',
    appVersion: '0.0.0',
    demo: false,
    settings: defaultSettings(),
    dark: false,
    connection: fake.ib.getState(),
    account: null,
    positions: opts.positions ?? [],
    orders: [],
    executions: [],
    watchlists: defaultWatchlists(),
    priceAlerts: stored.alerts,
    notifications: [],
    nav: [],
    logFilePath: '',
    lock: { locked: false, hasPin: false, biometrics: { available: false } } as unknown as AppSnapshot['lock'],
    afterReset: false,
    marketDataCheck: { running: false } as unknown as AppSnapshot['marketDataCheck'],
  });
  const tape = {
    onEvent: (l: (e: TapeEvent) => void) => {
      listeners.push(l);
      return () => void (listeners = listeners.filter((x) => x !== l));
    },
    getSnapshot: async () => structuredClone(snapshot()),
    setQuoteSubscriptions: async (owner: string, subs: QuoteSubscription[]) => svc.setRendererSubscriptions(owner, structuredClone(subs)),
    resendQuotes: async (keys: string[]) => {
      resends.push(keys);
      svc.resend(structuredClone(keys));
    },
    notify: async () => undefined,
  } as unknown as TapeApi;

  /** A page load: fresh renderer modules (the bridge and the owner list are module state). */
  const loadRenderer = async () => {
    vi.useRealTimers();
    listeners = [];
    (globalThis as { window?: unknown }).window = { tape };
    vi.resetModules();
    const paths = ['state/bridge', 'state/quoteSubscriptions', 'state/store', 'hooks/useQuotes', 'features/options/riskWatcher'];
    const m = Object.assign({}, ...(await Promise.all(paths.map(rendererModule)))) as RendererModules;
    await m.startBridge();
    fakeTimers();
    const quote = (s: string) => m.useStore.getState().quotes[`STK:${s}`];
    return {
      quote,
      change: (s: string) => m.changePct(quote(s)),
      store: m.useStore,
      startRiskWatcher: m.startRiskWatcher,
      /** The watchlist's owner (the Trade page): [] when the page goes. */
      watch: (symbols: string[]) => m.setQuoteSubscriptions('watchlist', symbols.map((s) => ({ contract: stock(s), profile: 'basic' as const }))),
    };
  };

  const reqIdOf = (symbol: string): number => {
    const call = [...fake.callsOf('reqMktData')].reverse().find((c) => (c[1] as { symbol?: string; secType?: string }).symbol === symbol && (c[1] as { secType?: string }).secType === 'STK');
    return call![0] as number;
  };
  /** A line's first ticks: type 1, bid / ask / last and the previous close (lines requested since `after` only). */
  const image = (symbols: string[], after = 0) => {
    for (const s of symbols) {
      const id = reqIdOf(s);
      if (id <= after) continue;
      fake.emit('marketDataType', id, 1);
      fake.emit('tickPrice', id, TICK.BID, 99.99);
      fake.emit('tickPrice', id, TICK.ASK, 100.01);
      fake.emit('tickPrice', id, TICK.LAST, 100);
      fake.emit('tickPrice', id, TICK.CLOSE, 99);
    }
  };
  /** Later trades: only last / bid / ask move. */
  const trade = (symbols: string[], last: number) => {
    for (const s of symbols) {
      const id = reqIdOf(s);
      fake.emit('tickPrice', id, TICK.LAST, last);
      fake.emit('tickPrice', id, TICK.BID, last - 0.01);
      fake.emit('tickPrice', id, TICK.ASK, last + 0.01);
    }
  };
  const lastReqId = () => (fake.callsOf('reqMktData').at(-1)?.[0] as number | undefined) ?? 0;
  fake.ready();
  const renderer = await loadRenderer();
  return { fake, svc, renderer, loadRenderer, image, trade, lastReqId, resends };
}

describe('renderer quotes', () => {
  it('keep their close when price alerts hold some watchlist stocks while the Trade page is away', async () => {
    const { renderer: r, image, trade, lastReqId, resends } = await setup({ alerts: ['NVDA', 'MSFT', 'META', 'TSLA'] });
    await r.watch(SYMBOLS);
    await vi.advanceTimersByTimeAsync(20);
    image(SYMBOLS);
    await vi.advanceTimersByTimeAsync(150);
    for (const s of SYMBOLS) expect(r.change(s), s).toBeCloseTo(1.0101, 3);
    // The Orders page (Cmd+3), for longer than lines linger: the renderer drops the quotes.
    await r.watch([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(r.quote('NVDA')).toBeUndefined();
    trade(SYMBOLS, 101);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(r.quote('NVDA')).toBeUndefined(); // the alert's line streams in main only
    // Back on the Trade page: the alert lines are reused, the others requested again.
    const before = lastReqId();
    await r.watch(SYMBOLS);
    await vi.advanceTimersByTimeAsync(20);
    image(SYMBOLS, before);
    trade(SYMBOLS, 102);
    await vi.advanceTimersByTimeAsync(150);
    for (const s of SYMBOLS) {
      expect(r.quote(s)?.close, s).toBe(99);
      expect(r.quote(s)?.marketDataType, s).toBe(1);
      expect(r.change(s), s).toBeCloseTo(3.0303, 3);
    }
    expect(resends).toEqual([]);
  });

  it('come whole, with their close, to a reloaded or reopened window', async () => {
    const { svc, renderer: r, loadRenderer, image, trade, resends } = await setup({ alerts: ['NVDA'] });
    await r.watch(SYMBOLS);
    await vi.advanceTimersByTimeAsync(20);
    image(SYMBOLS);
    await vi.advanceTimersByTimeAsync(150);
    // The window closes (its owners never release) and opens again: main/index.ts resets the renderer.
    svc.resetRenderer();
    trade(SYMBOLS, 101);
    await vi.advanceTimersByTimeAsync(150);
    const r2 = await loadRenderer();
    expect(r2.quote('AAPL')).toBeUndefined();
    await r2.watch(SYMBOLS);
    await vi.advanceTimersByTimeAsync(20);
    trade(SYMBOLS, 102);
    await vi.advanceTimersByTimeAsync(150);
    for (const s of SYMBOLS) expect(r2.change(s), s).toBeCloseTo(3.0303, 3);
    expect(resends).toEqual([]);
  });

  it('keep what the options risk watcher reads while the watchlist lets it go', async () => {
    const call = option('TSLA', '20261016', 380, 'C');
    const position: Position = { account: 'DU1', key: 'TSLA-C', contract: call, quantity: 1, avgPrice: 5, multiplier: 100, updatedAt: 0 };
    const { renderer: r, image, trade, resends } = await setup({ positions: [position] });
    r.startRiskWatcher();
    await r.watch(['TSLA', 'AAPL']);
    await vi.advanceTimersByTimeAsync(20);
    image(['TSLA', 'AAPL']);
    await vi.advanceTimersByTimeAsync(2_200); // the watcher evaluates 2 s after a store change
    await r.watch(['AAPL']);
    await vi.advanceTimersByTimeAsync(400);
    trade(['TSLA'], 101);
    await vi.advanceTimersByTimeAsync(150);
    expect(r.quote('TSLA')).toMatchObject({ last: 101, close: 99 });
    // Never dropped, so never asked for whole.
    expect(resends).toEqual([]);
  });

  it('come whole when changes arrive for a quote the renderer does not hold', async () => {
    const { renderer: r, image, trade, resends } = await setup();
    await r.watch(SYMBOLS);
    await vi.advanceTimersByTimeAsync(20);
    image(SYMBOLS);
    await vi.advanceTimersByTimeAsync(150);
    // However the copy was lost, changes alone never make a quote.
    r.store.setState({ quotes: {} });
    trade(['MSFT'], 101);
    await vi.advanceTimersByTimeAsync(100);
    expect(resends).toEqual([['STK:MSFT']]);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.quote('MSFT')).toMatchObject({ last: 101, close: 99, marketDataType: 1 });
    expect(r.change('MSFT')).toBeCloseTo(2.0202, 3);
  });
});
