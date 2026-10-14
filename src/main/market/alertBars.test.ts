import { describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import type { Bar, ContractRef, HistoryRequest, Quote } from '@shared/types';
import { createAlertBars, feedKey, INTRADAY_REFRESH_MS, nextDailyReload } from './alertBars';

const ny = (s: string) => Date.parse(`${s}-04:00`);
const sec = (s: string) => ny(s) / 1000;
const bar = (time: number, close: number): Bar => ({ time, open: close, high: close, low: close, close, volume: 5 });
/** One-minute bars from 10:50 to the forming 11:00 bar, closing at 100. */
const minuteBars = (): Bar[] => Array.from({ length: 11 }, (_, i) => bar(sec('2026-10-13T10:50:00') + i * 60, 100));

/** Feeds on a fake clock and history; `answer` settles the pending loads. */
function setup(opts: { connected?: boolean; bars?: () => Bar[]; fail?: string } = {}) {
  let now = ny('2026-10-13T11:00:30');
  let connected = opts.connected ?? true;
  const requests: HistoryRequest[] = [];
  const pending: Array<() => void> = [];
  const feeds = createAlertBars({
    history: (req) => {
      requests.push(req);
      return new Promise((resolve, reject) => pending.push(() => (opts.fail ? reject(new Error(opts.fail)) : resolve((opts.bars ?? minuteBars)()))));
    },
    info: async () => null,
    connected: () => connected,
    now: () => now,
  });
  const answer = async () => {
    for (const settle of pending.splice(0)) settle();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    feeds,
    requests,
    answer,
    at: (t: number) => void (now = t),
    advance: (ms: number) => void (now += ms),
    connect: (on: boolean) => void (connected = on),
  };
}

const live = (last: number, marketDataType: Quote['marketDataType'] = 1): Quote => ({ key: 'STK:NVDA', last, marketDataType, updatedAt: 0 });

describe('nextDailyReload', () => {
  it('reloads daily bars after the open and, fresh, after the close on New York weekdays', () => {
    expect(nextDailyReload(ny('2026-10-13T08:00:00'))).toEqual({ at: ny('2026-10-13T09:31:00'), fresh: false });
    expect(nextDailyReload(ny('2026-10-13T10:00:00'))).toEqual({ at: ny('2026-10-13T16:05:00'), fresh: true });
    // Friday evening: Monday morning.
    expect(nextDailyReload(ny('2026-10-16T17:00:00'))).toEqual({ at: ny('2026-10-19T09:31:00'), fresh: false });
  });
});

describe('alert bars', () => {
  it("loads each series once with the chart's request, in the background", async () => {
    const t = setup();
    const refused = t.feeds.want([
      { contract: stock('NVDA'), timeframe: '1m' },
      { contract: stock('NVDA'), timeframe: '1m' },
      { contract: stock('NVDA'), timeframe: '1D' },
    ]);
    expect(refused).toEqual([]);
    expect(t.requests).toEqual([
      { contract: stock('NVDA'), timeframe: '1m', outsideRth: true, slot: 'alerts:STK:NVDA|1m', background: true },
      { contract: stock('NVDA'), timeframe: '1D', outsideRth: false, slot: 'alerts:STK:NVDA|1D', background: true },
    ]);
    expect(t.feeds.get(feedKey(stock('NVDA'), '1m'))?.state).toBe('loading');
    await t.answer();
    expect(t.feeds.get(feedKey(stock('NVDA'), '1m'))).toMatchObject({ state: 'ready', forming: true });
  });

  it('keeps at most 20 series and drops those no longer wanted', () => {
    const t = setup();
    const series = Array.from({ length: 22 }, (_, i) => ({ contract: stock(`S${i}`), timeframe: '5m' as const }));
    expect(t.feeds.want(series)).toEqual(['STK:S20|5m', 'STK:S21|5m']);
    expect(t.requests).toHaveLength(20);
    t.feeds.want(series.slice(1, 2));
    expect(t.feeds.get('STK:S0|5m')).toBeUndefined();
    expect(t.feeds.get('STK:S1|5m')).toBeDefined();
  });

  it('extends the forming bar with live prices and starts the next bar on time', async () => {
    const t = setup();
    const key = feedKey(stock('NVDA'), '1m');
    t.feeds.want([{ contract: stock('NVDA'), timeframe: '1m' }]);
    await t.answer();
    const v0 = t.feeds.get(key)!.version;
    t.feeds.quote(live(101));
    const after = t.feeds.get(key)!;
    expect(after.version).not.toBe(v0);
    expect(after.bars.at(-1)).toMatchObject({ time: sec('2026-10-13T11:00:00'), close: 101, high: 101, low: 100 });
    // Delayed data never touches intraday bars: they are IB's again until live prices come back.
    t.feeds.quote(live(90, 3));
    t.advance(45_000);
    t.feeds.tick();
    expect(t.feeds.get(key)!.bars.at(-1)).toMatchObject({ time: sec('2026-10-13T11:00:00'), close: 100 });
    // Live again at 11:01:15: the 11:01 bar opens at the previous close.
    t.feeds.quote(live(101));
    expect(t.feeds.get(key)!.bars.at(-1)).toMatchObject({ time: sec('2026-10-13T11:01:00'), open: 100, close: 101 });
    // No trade for a minute: the next bar starts on its own, flat at the last close.
    t.advance(60_000);
    t.feeds.tick();
    expect(t.feeds.get(key)!.bars.slice(-2)).toMatchObject([
      { time: sec('2026-10-13T11:01:00'), close: 101 },
      { time: sec('2026-10-13T11:02:00'), open: 101, close: 101 },
    ]);
  });

  it('reloads an intraday series as soon as live quotes come back after delayed ones', async () => {
    let stored = minuteBars();
    const t = setup({ bars: () => stored });
    const key = feedKey(stock('NVDA'), '1m');
    t.feeds.want([{ contract: stock('NVDA'), timeframe: '1m' }]);
    await t.answer();
    // Ten minutes of live quotes build the bars up to 11:10.
    for (let i = 0; i < 10; i++) {
      t.advance(60_000);
      t.feeds.quote(live(101 + i));
      t.feeds.tick();
    }
    expect(t.feeds.get(key)!.bars.at(-1)).toMatchObject({ time: sec('2026-10-13T11:10:00'), close: 110 });
    // A delayed episode longer than live prices bridge (3 bars) drops the live bars.
    for (let i = 0; i < 5; i++) {
      t.advance(60_000);
      t.feeds.quote(live(90, 3));
      t.feeds.tick();
    }
    expect(t.feeds.get(key)!.bars.at(-1)).toMatchObject({ time: sec('2026-10-13T11:00:00'), close: 100 });
    expect(t.requests).toHaveLength(1);
    // Live again at 11:15:30: the next tick reloads, and the feed is current again.
    t.feeds.quote(live(111));
    t.advance(1000);
    t.feeds.tick();
    expect(t.requests).toHaveLength(2);
    stored = Array.from({ length: 26 }, (_, i) => bar(sec('2026-10-13T10:50:00') + i * 60, 111));
    await t.answer();
    expect(t.feeds.get(key)).toMatchObject({ forming: true, bars: expect.arrayContaining([expect.objectContaining({ time: sec('2026-10-13T11:15:00') })]) });
    expect(t.feeds.get(key)!.bars.at(-1)).toMatchObject({ time: sec('2026-10-13T11:15:00') });
    // Live quotes alone do not reload again.
    t.advance(60_000);
    t.feeds.quote(live(112));
    t.feeds.tick();
    expect(t.requests).toHaveLength(2);
  });

  it("keeps a US stock's weekly bar forming until the week's last regular close", async () => {
    const week = (day: string, close: number) => bar(Date.parse(`${day}T00:00:00Z`) / 1000, close);
    const t = setup({ bars: () => [week('2026-10-05', 99), week('2026-10-12', 100)] });
    const key = feedKey(stock('NVDA'), '1W');
    t.feeds.want([{ contract: stock('NVDA'), timeframe: '1W' }]);
    await t.answer();
    expect(t.feeds.get(key)!.forming).toBe(true);
    // After Tuesday's close and in Wednesday's pre-market the week is still trading.
    t.at(ny('2026-10-13T16:01:00'));
    expect(t.feeds.get(key)!.forming).toBe(true);
    t.at(ny('2026-10-14T08:00:00'));
    expect(t.feeds.get(key)!.forming).toBe(true);
    t.at(ny('2026-10-16T15:59:00'));
    expect(t.feeds.get(key)!.forming).toBe(true);
    // Friday's close ends it.
    t.at(ny('2026-10-16T16:00:00'));
    expect(t.feeds.get(key)!.forming).toBe(false);
    t.at(ny('2026-10-17T12:00:00'));
    expect(t.feeds.get(key)!.forming).toBe(false);
  });

  it('reloads intraday series every 30 minutes, and every series soon after a reconnect', async () => {
    const t = setup();
    t.feeds.want([
      { contract: stock('NVDA'), timeframe: '1m' },
      { contract: stock('AAPL'), timeframe: '5m' },
    ]);
    await t.answer();
    t.advance(INTRADAY_REFRESH_MS - 1000);
    t.feeds.tick();
    expect(t.requests).toHaveLength(2);
    // Spread over the interval: by twice the interval both have reloaded.
    t.advance(INTRADAY_REFRESH_MS);
    t.feeds.tick();
    expect(t.requests).toHaveLength(4);
    await t.answer();
    t.feeds.reconnected();
    t.feeds.tick();
    expect(t.requests).toHaveLength(5);
    t.advance(3000);
    t.feeds.tick();
    expect(t.requests).toHaveLength(6);
  });

  it('reloads daily bars fresh after the close', async () => {
    const t = setup({ bars: () => [bar(sec('2026-10-12T00:00:00'), 99), bar(sec('2026-10-13T00:00:00'), 100)] });
    t.feeds.want([{ contract: stock('NVDA'), timeframe: '1D' }]);
    await t.answer();
    t.at(ny('2026-10-13T16:05:00'));
    t.feeds.tick();
    expect(t.requests.at(-1)).toMatchObject({ timeframe: '1D', fresh: true });
  });

  it('waits for the connection, and retries a failed load after a minute', async () => {
    const t = setup({ connected: false, fail: 'No market data permissions' });
    const eur: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };
    t.feeds.want([{ contract: eur, timeframe: '1h' }]);
    expect(t.requests).toHaveLength(0);
    t.connect(true);
    t.feeds.tick();
    expect(t.requests).toHaveLength(1);
    await t.answer();
    expect(t.feeds.get(feedKey(eur, '1h'))).toMatchObject({ state: 'error', error: 'No market data permissions', bars: [] });
    t.advance(59_000);
    t.feeds.tick();
    expect(t.requests).toHaveLength(1);
    t.advance(1000);
    t.feeds.tick();
    expect(t.requests).toHaveLength(2);
  });
});
