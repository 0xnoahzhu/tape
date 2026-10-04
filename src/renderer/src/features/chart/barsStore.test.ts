import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, ContractRef, HistoryPage, HistoryRequest } from '@shared/types';
import {
  barsKey,
  CHART_SLOT,
  loadBars,
  barsTtl,
  loadOlder,
  MAX_OLDER_PAGE,
  OLDER_PAGE,
  olderPageSize,
  OLDER_RETRY_MAX_MS,
  OLDER_RETRY_MS,
  olderRetryDelay,
  scheduleOlderRetry,
  useBarsStore,
} from './barsStore';

const AAPL: ContractRef = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' };
const KEY = barsKey(AAPL, '1D');
const T0 = Date.UTC(2026, 0, 2) / 1000;
const day = (i: number): Bar => ({ time: T0 + i * 86_400, open: 100, high: 101, low: 99, close: 100, volume: 10 });
const days = (from: number, n: number) => Array.from({ length: n }, (_, k) => day(from + k));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: Error): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getHistory = vi.fn<(req: HistoryRequest) => Promise<Bar[]>>();
const getOlderBars = vi.fn<(req: HistoryRequest, before: number, limit: number) => Promise<HistoryPage>>();
const entry = () => useBarsStore.getState().entries[KEY];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 5, 15));
  (globalThis as unknown as { window: unknown }).window = { tape: { getHistory, getOlderBars } };
  useBarsStore.setState({ entries: {} });
  getHistory.mockReset();
  getOlderBars.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

async function loadWindow(bars: Bar[]) {
  getHistory.mockResolvedValueOnce(bars);
  await loadBars(AAPL, '1D', false, CHART_SLOT);
}

describe('loadOlder', () => {
  it('asks for one page before the oldest bar, in the chart slot, and puts it in front', async () => {
    await loadWindow(days(500, 100));
    expect(getHistory.mock.calls[0][0]).toMatchObject({ slot: CHART_SLOT, timeframe: '1D' });
    const page = deferred<HistoryPage>();
    getOlderBars.mockReturnValueOnce(page.promise);
    const p = loadOlder(AAPL, '1D');
    expect(entry().older).toEqual({ status: 'loading' });
    // A second call while the first is out does not ask again.
    void loadOlder(AAPL, '1D');
    expect(getOlderBars).toHaveBeenCalledTimes(1);
    const [req, before, limit] = getOlderBars.mock.calls[0];
    expect(req).toMatchObject({ contract: AAPL, timeframe: '1D', slot: CHART_SLOT });
    expect(before).toBe(day(500).time);
    expect(limit).toBe(OLDER_PAGE);
    page.resolve({ bars: days(200, 300), done: false });
    await p;
    expect(entry().bars).toHaveLength(400);
    expect(entry().bars[0].time).toBe(day(200).time);
    expect(entry().older).toEqual({ status: 'idle' });
  });

  it("stops at IB's six-month limit of seconds bars, remembering why", async () => {
    await loadWindow(days(500, 100));
    getOlderBars.mockResolvedValueOnce({ bars: days(450, 50), done: true, limited: true });
    await loadOlder(AAPL, '1D');
    expect(entry().older).toEqual({ status: 'done', limited: true });
    await loadOlder(AAPL, '1D');
    expect(getOlderBars).toHaveBeenCalledTimes(1);
  });

  it('sizes pages per interval (seconds at about one IB request) and as asked by a range, within the service limit', async () => {
    expect([olderPageSize('1s'), olderPageSize('5s'), olderPageSize('30s'), olderPageSize('45s'), olderPageSize('1m'), olderPageSize('1D')]).toEqual([1800, 1440, 1920, 640, OLDER_PAGE, OLDER_PAGE]);
    expect([barsTtl('1s'), barsTtl('1m'), barsTtl('1Q')]).toEqual([30_000, 60_000, 900_000]);
    await loadWindow(days(500, 100));
    getOlderBars.mockResolvedValueOnce({ bars: days(400, 100), done: false });
    await loadOlder(AAPL, '1D', 777.4);
    getOlderBars.mockResolvedValueOnce({ bars: days(300, 100), done: false });
    await loadOlder(AAPL, '1D', 1e9);
    expect(getOlderBars.mock.calls.map((c) => c[2])).toEqual([777, MAX_OLDER_PAGE]);
  });

  it('stops once IB has no older bars', async () => {
    await loadWindow(days(500, 100));
    getOlderBars.mockResolvedValueOnce({ bars: days(450, 50), done: true });
    await loadOlder(AAPL, '1D');
    expect(entry().older).toEqual({ status: 'done' });
    expect(entry().bars).toHaveLength(150);
    await loadOlder(AAPL, '1D');
    expect(getOlderBars).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal and waits before asking again', async () => {
    await loadWindow(days(500, 100));
    getOlderBars.mockRejectedValueOnce(
      new Error("Error invoking remote method 'tape:getOlderBars': IbRequestError: Historical Market Data Service error message:No market data permissions for NYSE STK (IB 162)"),
    );
    await loadOlder(AAPL, '1D');
    expect(entry().older).toMatchObject({ status: 'error', error: 'No market data permissions for NYSE STK (IB 162)' });
    expect(entry().bars).toHaveLength(100);
    await loadOlder(AAPL, '1D');
    expect(getOlderBars).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + OLDER_RETRY_MS + 1);
    getOlderBars.mockResolvedValueOnce({ bars: days(400, 100), done: false });
    await loadOlder(AAPL, '1D');
    expect(entry().older).toEqual({ status: 'idle' });
    expect(entry().bars).toHaveLength(200);
  });

  it('retries soon after being superseded, without an error', async () => {
    await loadWindow(days(500, 100));
    getOlderBars.mockRejectedValueOnce(new Error('SupersededError: Historical data request superseded by a newer one'));
    await loadOlder(AAPL, '1D');
    expect(entry().older?.status).toBe('idle');
    expect(entry().older?.error).toBeUndefined();
    vi.setSystemTime(Date.now() + 1_001);
    getOlderBars.mockResolvedValueOnce({ bars: [], done: true });
    await loadOlder(AAPL, '1D');
    expect(entry().older?.status).toBe('done');
  });

  it('waits after an empty page that is not the end, and says so', async () => {
    await loadWindow(days(500, 100));
    getOlderBars.mockResolvedValueOnce({ bars: [], done: false });
    await loadOlder(AAPL, '1D');
    expect(entry().older).toEqual({ status: 'empty', retryAt: Date.now() + OLDER_RETRY_MS, failures: 1 });
    await loadOlder(AAPL, '1D');
    expect(getOlderBars).toHaveBeenCalledTimes(1);
    // Bars it already has (not strictly older) count as an empty page too.
    vi.setSystemTime(Date.now() + OLDER_RETRY_MS);
    getOlderBars.mockResolvedValueOnce({ bars: days(500, 3), done: false });
    await loadOlder(AAPL, '1D');
    expect(entry().older).toMatchObject({ status: 'empty', failures: 2 });
    expect(entry().bars).toHaveLength(100);
  });

  it('waits longer after each refused or empty page in a row, and starts over after a page with bars', async () => {
    await loadWindow(days(500, 100));
    const waits: number[] = [];
    const fail = async (outcome: 'refused' | 'empty') => {
      if (outcome === 'refused') getOlderBars.mockRejectedValueOnce(new Error('Historical data request timed out'));
      else getOlderBars.mockResolvedValueOnce({ bars: [], done: false });
      await loadOlder(AAPL, '1D');
      const retryAt = entry().older!.retryAt!;
      waits.push(retryAt - Date.now());
      // One ms early is still too early.
      vi.setSystemTime(retryAt - 1);
      const calls = getOlderBars.mock.calls.length;
      await loadOlder(AAPL, '1D');
      expect(getOlderBars).toHaveBeenCalledTimes(calls);
      vi.setSystemTime(retryAt);
    };
    for (const o of ['refused', 'empty', 'refused', 'refused', 'empty', 'refused', 'refused'] as const) await fail(o);
    expect(waits).toEqual([1, 2, 4, 8, 16, 16, 16].map((k) => k * OLDER_RETRY_MS));
    expect(entry().older).toMatchObject({ status: 'error', failures: 7 });

    getOlderBars.mockResolvedValueOnce({ bars: days(400, 100), done: false });
    await loadOlder(AAPL, '1D');
    expect(entry().older).toEqual({ status: 'idle' });
    await fail('refused');
    expect(waits.at(-1)).toBe(OLDER_RETRY_MS);
  });

  it('keeps the count of failed pages across a superseded one', async () => {
    await loadWindow(days(500, 100));
    getOlderBars.mockRejectedValueOnce(new Error('Historical data request timed out'));
    await loadOlder(AAPL, '1D');
    vi.setSystemTime(entry().older!.retryAt!);
    getOlderBars.mockRejectedValueOnce(new Error('SupersededError: Historical data request superseded by a newer one'));
    await loadOlder(AAPL, '1D');
    expect(entry().older).toEqual({ status: 'idle', retryAt: Date.now() + 1_000, failures: 1 });
    vi.setSystemTime(entry().older!.retryAt!);
    getOlderBars.mockRejectedValueOnce(new Error('Historical data request timed out'));
    await loadOlder(AAPL, '1D');
    expect(entry().older).toMatchObject({ status: 'error', retryAt: Date.now() + 2 * OLDER_RETRY_MS, failures: 2 });
  });

  it('does nothing before the window loaded or for seeded bars', async () => {
    await loadOlder(AAPL, '1D');
    useBarsStore.getState().seed(KEY, days(0, 10));
    await loadOlder(AAPL, '1D');
    expect(getOlderBars).not.toHaveBeenCalled();
  });

  it('drops a page when the window was reloaded without the bars it continues', async () => {
    await loadWindow(days(500, 100));
    const page = deferred<HistoryPage>();
    getOlderBars.mockReturnValueOnce(page.promise);
    const p = loadOlder(AAPL, '1D');
    // A split: the reloaded window disagrees with the loaded bars, which are replaced.
    getHistory.mockResolvedValueOnce(days(520, 100).map((b) => ({ ...b, close: 25, open: 25, high: 26, low: 24 })));
    await loadBars(AAPL, '1D', true, CHART_SLOT);
    page.resolve({ bars: days(200, 300), done: false });
    await p;
    expect(entry().bars).toHaveLength(100);
    expect(entry().bars[0].time).toBe(day(520).time);
  });
});

describe('loadBars', () => {
  it('keeps older pages and their state when the window is refreshed', async () => {
    await loadWindow(days(500, 100));
    getOlderBars.mockResolvedValueOnce({ bars: days(200, 300), done: true });
    await loadOlder(AAPL, '1D');
    getHistory.mockResolvedValueOnce(days(510, 91));
    await loadBars(AAPL, '1D', true, CHART_SLOT);
    expect(entry().bars).toHaveLength(401);
    expect(entry().bars[0].time).toBe(day(200).time);
    expect(entry().older).toEqual({ status: 'done' });
  });

  it('replaces a sliding seconds window on reload unless older pages were loaded in front of it', async () => {
    const S0 = Date.UTC(2026, 9, 5, 14) / 1000;
    const secs = (from: number, n: number): Bar[] => Array.from({ length: n }, (_, k) => ({ time: S0 + from + k, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const key = barsKey(AAPL, '1s');
    // 120 reloads of a 1800-bar window sliding a minute each: the entry stays at the window.
    for (let i = 0; i < 120; i++) {
      getHistory.mockResolvedValueOnce(secs(i * 60, 1800));
      await loadBars(AAPL, '1s', true, CHART_SLOT);
    }
    expect(useBarsStore.getState().entries[key].bars).toHaveLength(1800);
    expect(useBarsStore.getState().entries[key].bars[0].time).toBe(S0 + 119 * 60);
    // After a page was loaded the reload keeps it (and what lies between) in front of the window.
    const start = S0 + 119 * 60;
    getOlderBars.mockResolvedValueOnce({ bars: secs(119 * 60 - 1800, 1800), done: false });
    await loadOlder(AAPL, '1s');
    getHistory.mockResolvedValueOnce(secs(120 * 60, 1800));
    await loadBars(AAPL, '1s', true, CHART_SLOT);
    const bars = useBarsStore.getState().entries[key].bars;
    expect(bars[0].time).toBe(start - 1800);
    expect(bars).toHaveLength(1800 + 60 + 1800);
  });

  it('treats a superseded request as no result, not as an error', async () => {
    getHistory.mockRejectedValueOnce(new Error('SupersededError: Historical data request superseded by a newer one'));
    await loadBars(AAPL, '1D', false, CHART_SLOT);
    expect(entry()).toBeUndefined();
    await loadWindow(days(0, 10));
    getHistory.mockRejectedValueOnce(new Error('SupersededError: Historical data request superseded by a newer one'));
    await loadBars(AAPL, '1D', true, CHART_SLOT);
    expect(entry()).toMatchObject({ status: 'ready' });
    expect(entry().error).toBeUndefined();
    expect(entry().bars).toHaveLength(10);
  });
});

describe('olderRetryDelay', () => {
  it('doubles from OLDER_RETRY_MS up to OLDER_RETRY_MAX_MS', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(olderRetryDelay)).toEqual([15_000, 15_000, 30_000, 60_000, 120_000, 240_000, 240_000, 240_000]);
    expect(OLDER_RETRY_MAX_MS).toBe(240_000);
  });
});

describe('scheduleOlderRetry', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 15));
  });

  it('asks once retryAt has passed, and not before', () => {
    const ask = vi.fn();
    const cancel = scheduleOlderRetry(Date.now() + 5_000, ask);
    expect(cancel).toBeTypeOf('function');
    vi.advanceTimersByTime(4_999);
    expect(ask).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('does not ask after being cancelled', () => {
    const ask = vi.fn();
    scheduleOlderRetry(Date.now() + 5_000, ask)!();
    vi.advanceTimersByTime(60_000);
    expect(ask).not.toHaveBeenCalled();
  });

  it('schedules nothing without a wait (the caller asks right away)', () => {
    const ask = vi.fn();
    expect(scheduleOlderRetry(undefined, ask)).toBeUndefined();
    expect(scheduleOlderRetry(Date.now(), ask)).toBeUndefined();
    expect(scheduleOlderRetry(Date.now() - 1, ask)).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(ask).not.toHaveBeenCalled();
  });

  // The chart's effect at the oldest bar: the view is clamped there and does not move, so only the timer asks again.
  it('lets a chart parked at the oldest bar load the page after a refusal and after an empty page', async () => {
    await loadWindow(days(500, 100));
    let cancel: (() => void) | undefined;
    const ask = () => void loadOlder(AAPL, '1D');
    const park = () => {
      cancel?.();
      ask();
      cancel = scheduleOlderRetry(entry().older?.retryAt, ask);
    };
    getOlderBars.mockRejectedValueOnce(new Error('Historical data request pacing violation (IB 162)'));
    park();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry().older).toMatchObject({ status: 'error' });
    park();
    expect(getOlderBars).toHaveBeenCalledTimes(1);

    getOlderBars.mockResolvedValueOnce({ bars: [], done: false });
    await vi.advanceTimersByTimeAsync(OLDER_RETRY_MS + 100);
    expect(getOlderBars).toHaveBeenCalledTimes(2);
    expect(entry().older).toMatchObject({ status: 'empty', failures: 2 });
    park();

    getOlderBars.mockResolvedValueOnce({ bars: days(200, 300), done: false });
    await vi.advanceTimersByTimeAsync(2 * OLDER_RETRY_MS - 1_000);
    expect(getOlderBars).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(getOlderBars).toHaveBeenCalledTimes(3);
    expect(entry().older).toEqual({ status: 'idle' });
    expect(entry().bars).toHaveLength(400);
    cancel?.();
  });
});
