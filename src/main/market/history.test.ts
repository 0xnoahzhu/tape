// HistoryService against the IB double and the memory bar cache, on fake timers and a fake clock.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { option, stock } from '@shared/contract';
import type { HistoryRequest } from '@shared/types';
import { createFakeContext, createFakeIb } from './fakeIb';
import { BACKOFF_START_MS, createHistoryService, MAX_QUEUED, SupersededError } from './history';
import { historySpec, seriesKey } from './historyParams';

type Row = [time: string, open: number, high: number, low: number, close: number, volume: number];

/** New York wall time as a unix ms instant (EDT, UTC−4, in the dates used here). */
const ny = (date: string, hhmm = '14:00') => Date.parse(`${date}T${hhmm}:00-04:00`);
const day = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 1000;
const row = (time: string, close: number, volume = 100): Row => [time, close, close + 1, close - 1, close, volume];

function setup(now: number) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now });
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib);
  const svc = createHistoryService(f.ctx);
  /** Answers per duration ("2 Y", "2 D", …); a function may answer with an error instead. */
  const answers = new Map<string, Row[] | ((id: number) => void)>();
  let autoAnswer = true;
  const answer = (id: number, duration: string) => {
    const a = answers.get(duration);
    if (typeof a === 'function') return a(id);
    for (const r of a ?? []) fake.emit('historicalData', id, ...r);
    fake.emit('historicalData', id, 'finished', -1, -1, -1, -1, -1);
  };
  fake.onCall = (name, args) => {
    if (name === 'reqHistoricalData' && autoAnswer) queueMicrotask(() => answer(args[0] as number, args[3] as string));
  };
  const hist = () => fake.callsOf('reqHistoricalData');
  const flush = () => vi.advanceTimersByTimeAsync(0);
  fake.ready();
  return {
    fake,
    ...f,
    svc,
    answers,
    hist,
    flush,
    manual: () => void (autoAnswer = false),
    answer,
    get: (req: HistoryRequest) => svc.get(req),
  };
}

afterEach(() => vi.useRealTimers());

const aapl1D: HistoryRequest = { contract: stock('AAPL'), timeframe: '1D' };

describe('incremental daily bars', () => {
  it('loads the window once, then only the tail since the second-newest bar', async () => {
    const t = setup(ny('2026-09-30'));
    t.answers.set('2 Y', [row('20240930', 100), row('20241001', 101), row('20260928', 200), row('20260929', 201), row('20260930', 202)]);
    const first = await t.get(aapl1D);
    expect(t.hist().map((c) => [c[3], c[4]])).toEqual([['2 Y', '1 day']]);
    expect(first.map((b) => b.close)).toEqual([100, 101, 200, 201, 202]);
    const series = seriesKey(historySpec(aapl1D), 'STK:AAPL');
    expect(series).toBe('STK:AAPL|1 day|TRADES|1');
    expect(await t.ctx.db.bars.last(series)).toBe(day('20260930'));

    // Within the TTL: memory, no request.
    await t.get(aapl1D);
    expect(t.hist()).toHaveLength(1);

    // Later the same day: the last two bars again ("2 D"), the newest one updated.
    vi.setSystemTime(ny('2026-09-30', '15:00'));
    t.answers.set('2 D', [row('20260929', 201), row('20260930', 203.5)]);
    const second = await t.get(aapl1D);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D']);
    expect(second.map((b) => b.close)).toEqual([100, 101, 200, 201, 203.5]);

    // Next morning: three trading days back from the second-newest stored bar. The window has
    // moved on by a day, so the first bar is no longer part of it.
    vi.setSystemTime(ny('2026-10-01', '10:00'));
    t.answers.set('3 D', [row('20260929', 201), row('20260930', 204), row('20261001', 205)]);
    const third = await t.get(aapl1D);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D', '3 D']);
    expect(third.map((b) => b.close)).toEqual([101, 200, 201, 204, 205]);
  });

  it('needs no request after the close until the next session, unless fresh', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    t.answers.set('2 Y', [row('20241007', 100), row('20261001', 201), row('20261002', 202)]);
    await t.get(aapl1D);
    // A restart on Sunday: the memory cache is gone, the bar cache is settled.
    const svc2 = createHistoryService(t.ctx);
    vi.setSystemTime(ny('2026-10-04', '12:00'));
    expect((await svc2.get(aapl1D)).map((b) => b.close)).toEqual([100, 201, 202]);
    expect(t.hist()).toHaveLength(1);
    // fresh bypasses both caches and fetches the tail.
    t.answers.set('2 D', [row('20261001', 201), row('20261002', 202.5)]);
    expect((await svc2.get({ ...aapl1D, fresh: true })).map((b) => b.close)).toEqual([100, 201, 202.5]);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D']);
    // Monday during the session the tail is fetched again.
    vi.setSystemTime(ny('2026-10-05', '11:00'));
    t.answers.set('3 D', [row('20261001', 201), row('20261002', 202.5), row('20261005', 203)]);
    expect((await svc2.get(aapl1D)).map((b) => b.close)).toEqual([100, 201, 202.5, 203]);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D', '3 D']);
  });

  it('loads the whole window again when IB adjusted the history (a split)', async () => {
    const t = setup(ny('2026-09-30'));
    t.answers.set('2 Y', [row('20240930', 100), row('20260929', 200), row('20260930', 202)]);
    await t.get(aapl1D);
    vi.setSystemTime(ny('2026-09-30', '15:00'));
    t.answers.set('2 D', [row('20260929', 50), row('20260930', 50.5)]);
    t.answers.set('2 Y', [row('20240930', 25), row('20260929', 50), row('20260930', 50.5)]);
    expect((await t.get(aapl1D)).map((b) => b.close)).toEqual([25, 50, 50.5]);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D', '2 Y']);
  });

  it('loads the whole window when the stored bars do not cover it', async () => {
    const t = setup(ny('2026-09-30'));
    // Stored by something else: only recent bars, no bookkeeping.
    await t.ctx.db.bars.put('STK:AAPL|1 day|TRADES|1', [{ time: day('20260929'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    t.answers.set('2 Y', [row('20240930', 100), row('20260930', 202)]);
    await t.get(aapl1D);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y']);
  });

  it('replaces the re-stamped forming bar of weekly series', async () => {
    const t = setup(ny('2026-10-01'));
    const w: HistoryRequest = { contract: stock('AAPL'), timeframe: '1W' };
    t.answers.set('10 Y', [row('20161007', 10), row('20260925', 200), row('20261001', 201)]);
    expect((await t.get(w)).map((b) => b.time)).toEqual([day('20161007'), day('20260925'), day('20261001')]);
    vi.setSystemTime(ny('2026-10-02', '15:00'));
    t.answers.set('3 W', [row('20260918', 199), row('20260925', 200), row('20261002', 203)]);
    const bars = await t.get(w);
    expect(t.hist().map((c) => c[3])).toEqual(['10 Y', '3 W']);
    expect(bars.map((b) => [b.time, b.close])).toEqual([
      [day('20161007'), 10],
      [day('20260918'), 199],
      [day('20260925'), 200],
      [day('20261002'), 203],
    ]);
    // The stale stamp stays in the bar cache but is never served.
    const svc2 = createHistoryService(t.ctx);
    expect((await svc2.get(w)).map((b) => b.time)).toEqual([day('20161007'), day('20260918'), day('20260925'), day('20261002')]);
  });
});

describe('options', () => {
  it('builds daily bars from 8-hour bars and shares them with the weekly timeframe', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const call = option('AAPL', '20261120', 260, 'C');
    const at = (iso: string) => String(Date.parse(iso) / 1000);
    t.answers.set('2 Y', [
      [at('2026-10-01T13:30:00Z'), 5, 5.5, 4.9, 5.2, 10],
      [at('2026-10-01T16:00:00Z'), 5.2, 6, 5.1, 5.8, 20],
      [at('2026-10-02T13:30:00Z'), 5.8, 5.9, 5.0, 5.1, 5],
      [at('2026-10-02T16:00:00Z'), 5.1, 5.3, 4.8, 5.0, 7],
    ]);
    const daily = await t.get({ contract: call, timeframe: '1D' });
    expect(t.hist()[0].slice(3, 6)).toEqual(['2 Y', '8 hours', 'TRADES']);
    expect(daily).toEqual([
      { time: day('20261001'), open: 5, high: 6, low: 4.9, close: 5.8, volume: 30 },
      { time: day('20261002'), open: 5.8, high: 5.9, low: 4.8, close: 5.0, volume: 12 },
    ]);
    const weekly = await t.get({ contract: call, timeframe: '1W' });
    expect(weekly).toEqual([{ time: day('20261002'), open: 5, high: 6, low: 4.8, close: 5.0, volume: 42 }]);
    expect(t.hist()).toHaveLength(1);
  });
});

describe('scheduling', () => {
  it('supersedes older requests of the same slot and cancels them at IB', async () => {
    const t = setup(ny('2026-09-30'));
    t.manual();
    const a = t.get({ ...aapl1D, slot: 'chart' });
    const aErr = a.catch((e: unknown) => e);
    await t.flush();
    const [aId] = t.hist()[0] as [number];
    const b = t.get({ contract: stock('MSFT'), timeframe: '1D', slot: 'chart' });
    expect(await aErr).toBeInstanceOf(SupersededError);
    expect(t.fake.callsOf('cancelHistoricalData')).toEqual([[aId]]);
    await t.flush();
    const [bId] = t.hist()[1] as [number];
    t.answers.set('2 Y', [row('20240930', 1)]);
    t.answer(bId, '2 Y');
    expect((await b).map((x) => x.close)).toEqual([1]);
    // Another slot's request for the same series is not affected by the chart switching.
    t.answers.set('2 Y', [row('20240930', 2)]);
    const c = t.get({ contract: stock('NVDA'), timeframe: '1D', slot: 'opt' });
    const d = t.get({ contract: stock('NVDA'), timeframe: '1D', slot: 'chart' });
    await t.flush();
    const e = t.get({ contract: stock('TSLA'), timeframe: '1D', slot: 'chart' });
    const dErr = d.catch((x: unknown) => x);
    expect(await dErr).toBeInstanceOf(SupersededError);
    await t.flush();
    const nvda = t.hist().find((x) => (x[1] as { symbol: string }).symbol === 'NVDA')!;
    t.answer(nvda[0] as number, '2 Y');
    expect((await c).map((x) => x.close)).toEqual([2]);
    expect(t.fake.callsOf('cancelHistoricalData')).toHaveLength(1);
    const tsla = t.hist().find((x) => (x[1] as { symbol: string }).symbol === 'TSLA')!;
    t.answer(tsla[0] as number, '2 Y');
    await e;
  });

  it('drops queued requests of a slot without sending them', async () => {
    const t = setup(ny('2026-09-30'));
    t.manual();
    const busy = ['A', 'B', 'C', 'D', 'E'].map((s) => t.get({ contract: stock(s), timeframe: '1D' }));
    await t.flush();
    expect(t.hist()).toHaveLength(5);
    const queued = t.get({ contract: stock('X1'), timeframe: '1D', slot: 'chart' }).catch((e: unknown) => e);
    const latest = t.get({ contract: stock('X2'), timeframe: '1D', slot: 'chart' });
    expect(await queued).toBeInstanceOf(SupersededError);
    for (const c of t.hist()) t.answer(c[0] as number, '2 Y');
    await Promise.all(busy);
    await t.flush();
    expect(t.hist().map((c) => (c[1] as { symbol: string }).symbol)).toEqual(['A', 'B', 'C', 'D', 'E', 'X2']);
    t.answer(t.hist()[5][0] as number, '2 Y');
    await latest;
    expect(t.fake.callsOf('cancelHistoricalData')).toEqual([]);
  });

  it('keeps at most five requests out and bounds the waiting ones', async () => {
    const t = setup(ny('2026-09-30'));
    t.manual();
    const out = Array.from({ length: 5 + MAX_QUEUED + 1 }, (_, i) => t.get({ contract: stock(`S${i}`), timeframe: '1D' }).then(
      () => 'ok',
      (e: Error) => e.message,
    ));
    await t.flush();
    expect(t.hist()).toHaveLength(5);
    // The oldest waiting request (S5) made room for the newest.
    expect(await out[5]).toMatch(/Too many historical data requests/);
    for (let round = 0; round < 6; round++) {
      for (const c of t.hist().slice(round * 5)) t.answer(c[0] as number, '2 Y');
      await t.flush();
    }
    expect(t.hist().map((c) => (c[1] as { symbol: string }).symbol)).not.toContain('S5');
    expect((await Promise.all(out)).filter((r) => r === 'ok')).toHaveLength(5 + MAX_QUEUED);
  });

  it('pauses after a pacing violation and retries once', async () => {
    const t = setup(ny('2026-09-30'));
    let violations = 1;
    t.answers.set('2 Y', (id) => {
      if (violations-- > 0) t.fake.error(id, 162, 'Historical Market Data Service error message:Historical data request pacing violation');
      else {
        t.fake.emit('historicalData', id, ...row('20240930', 7));
        t.fake.emit('historicalData', id, 'finished', -1, -1, -1, -1, -1);
      }
    });
    const a = t.get(aapl1D);
    await t.flush();
    expect(t.hist()).toHaveLength(1);
    const b = t.get({ contract: stock('MSFT'), timeframe: '1D' });
    await vi.advanceTimersByTimeAsync(BACKOFF_START_MS - 1);
    expect(t.hist()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await a).map((x) => x.close)).toEqual([7]);
    await b;
    expect(t.hist()).toHaveLength(3);
    // Twice in a row: the second violation is reported.
    violations = 2;
    const c = t.get({ contract: stock('NVDA'), timeframe: '1D' }).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(BACKOFF_START_MS);
    expect(await c).toMatch(/pacing violation/);
  });

  it('remembers final errors briefly instead of asking IB again', async () => {
    const t = setup(ny('2026-09-30'));
    const message = "Historical Market Data Service error message:No data of type EODChart is available for the exchange 'BEST' and the security type 'Warrant' and '2 y' and '1 day'";
    t.answers.set('2 Y', (id) => t.fake.error(id, 162, message));
    await expect(t.get(aapl1D)).rejects.toThrow('No data of type EODChart');
    await expect(t.get(aapl1D)).rejects.toThrow('No data of type EODChart');
    expect(t.hist()).toHaveLength(1);
    vi.setSystemTime(ny('2026-09-30', '14:01'));
    await expect(t.get(aapl1D)).rejects.toThrow('No data of type EODChart');
    expect(t.hist()).toHaveLength(2);
  });

  it('starts the response timeout when the request is written, not when it is queued', async () => {
    const t = setup(ny('2026-09-30'));
    t.manual();
    t.fake.autoSent = false;
    const p = t.get(aapl1D).catch((e: Error) => e.message);
    await t.flush();
    // Held by IB's pacing rules for a minute: no timeout yet.
    await vi.advanceTimersByTimeAsync(60_000);
    t.fake.written('reqHistoricalData', t.hist()[0][0] as number);
    await vi.advanceTimersByTimeAsync(19_999);
    let settled = false;
    void p.then(() => (settled = true));
    await t.flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatch(/timed out after 20 s/);
    expect(t.fake.callsOf('cancelHistoricalData')).toHaveLength(1);
  });
});

