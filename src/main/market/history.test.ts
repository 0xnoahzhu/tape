// HistoryService against the IB double and the memory bar cache, on fake timers and a fake clock.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { Bar, ContractRef, HistoryRequest } from '@shared/types';
import type { HistoryService } from '../context';
import type { SeriesCoverage } from './coverage';
import { createFakeContext, createFakeIb } from './fakeIb';
import { BACKOFF_START_MS, COVERAGE_NS, createHistoryService, HEAD_ERROR_MS, MAX_QUEUED, PAGE_BUDGET, PAGE_BUDGET_WINDOW_MS, PAGE_TTL_MS, SupersededError } from './history';
import { historySpec, parseBarTime, seriesKey } from './historyParams';
import { ibEndDateTime, weekdaysBackStart } from './historyPages';

type Row = [time: string, open: number, high: number, low: number, close: number, volume: number];

/** New York wall time as a unix ms instant (EDT, UTC−4, in the dates used here). */
const ny = (date: string, hhmm = '14:00') => Date.parse(`${date}T${hhmm}:00-04:00`);
const nySec = (date: string, hhmm = '14:00') => ny(date, hhmm) / 1000;
const day = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 1000;
const row = (time: string, close: number, volume = 100): Row => [time, close, close + 1, close - 1, close, volume];
const closes = (bars: Array<{ close: number }>) => bars.map((b) => b.close);

function setup(now: number) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now });
  const fake = createFakeIb();
  const f = createFakeContext(fake.ib);
  const svc = createHistoryService(f.ctx);
  /** Answers by "<duration>@<endDateTime>" or by duration ("2 Y", "2 D", …); a function may answer with an error instead. */
  const answers = new Map<string, Row[] | ((id: number) => void)>();
  /** reqHeadTimestamp's answer (formatDate 2: epoch seconds), or a function answering with an error. */
  let head: string | ((id: number) => void) = String(day('19801212'));
  let autoAnswer = true;
  const answer = (id: number, duration: string, end = '') => {
    const a = answers.get(`${duration}@${end}`) ?? answers.get(duration);
    if (typeof a === 'function') return a(id);
    for (const r of a ?? []) fake.emit('historicalData', id, ...r);
    fake.emit('historicalData', id, 'finished', -1, -1, -1, -1, -1);
  };
  fake.onCall = (name, args) => {
    if (name === 'reqHistoricalData' && autoAnswer) queueMicrotask(() => answer(args[0] as number, args[3] as string, args[2] as string));
    if (name === 'reqHeadTimestamp' && autoAnswer) {
      const id = args[0] as number;
      queueMicrotask(() => (typeof head === 'function' ? head(id) : fake.emit('headTimestamp', id, head)));
    }
  };
  const hist = () => fake.callsOf('reqHistoricalData');
  fake.ready();
  return {
    fake,
    ...f,
    svc,
    answers,
    hist,
    /** [duration, endDateTime] of every historical data request. */
    asked: () => hist().map((c) => [c[3], c[2]]),
    heads: () => fake.callsOf('reqHeadTimestamp'),
    setHead: (h: typeof head) => void (head = h),
    flush: () => vi.advanceTimersByTimeAsync(0),
    manual: () => void (autoAnswer = false),
    auto: () => void (autoAnswer = true),
    /** Answers the request with this reqId as IB would. */
    answerCall: (call: unknown[]) => answer(call[0] as number, call[3] as string, call[2] as string),
    /** endDateTime (unix seconds) of the historical data request with this reqId. */
    endOf: (id: number) => parseBarTime(String(hist().find((c) => c[0] === id)?.[2] ?? '')),
    get: (req: HistoryRequest) => svc.get(req),
    older: (req: HistoryRequest, before: number, limit: number) => svc.getOlder(req, before, limit),
    coverage: async (req: HistoryRequest) => (await f.ctx.db.kv.get<SeriesCoverage>(COVERAGE_NS, seriesKey(historySpec(req), `${req.contract.secType}:${req.contract.symbol}`)))?.value,
  };
}

afterEach(() => vi.useRealTimers());

const aapl1D: HistoryRequest = { contract: stock('AAPL'), timeframe: '1D' };

describe('newest bars', () => {
  it('loads the window once, then only the tail since the second-newest bar', async () => {
    const t = setup(ny('2026-09-30'));
    t.answers.set('2 Y', [row('20240930', 100), row('20241001', 101), row('20260928', 200), row('20260929', 201), row('20260930', 202)]);
    const first = await t.get(aapl1D);
    expect(t.hist().map((c) => [c[3], c[4]])).toEqual([['2 Y', '1 day']]);
    expect(closes(first)).toEqual([100, 101, 200, 201, 202]);
    const series = seriesKey(historySpec(aapl1D), 'STK:AAPL');
    expect(series).toBe('STK:AAPL|1 day|TRADES|1');
    expect(await t.ctx.db.bars.last(series)).toBe(day('20260930'));
    // What was requested is covered: from the first bar (IB's 2 Y reach back further than the window) to now.
    expect(await t.coverage(aapl1D)).toEqual({ ranges: [[day('20240930'), nySec('2026-09-30')]], fetchedAt: ny('2026-09-30'), first: day('20240930') });

    // Within the TTL: memory, no request.
    await t.get(aapl1D);
    expect(t.hist()).toHaveLength(1);

    // Later the same day only the forming bar can have moved: the cache answers at once and the
    // tail ("2 D") is refreshed in the background.
    vi.setSystemTime(ny('2026-09-30', '15:00'));
    t.manual();
    t.answers.set('2 D', [row('20260929', 201), row('20260930', 203.5)]);
    expect(closes(await t.get(aapl1D))).toEqual([100, 101, 200, 201, 202]);
    await t.flush();
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D']);
    t.answerCall(t.hist()[1]);
    await t.flush();
    expect(closes(await t.get(aapl1D))).toEqual([100, 101, 200, 201, 203.5]);
    expect(t.hist()).toHaveLength(2);

    // Next morning a new session has opened: the load waits for the tail, three trading days
    // back from the second-newest stored bar. The window has moved on by a day.
    vi.setSystemTime(ny('2026-10-01', '10:00'));
    t.answers.set('3 D', [row('20260929', 201), row('20260930', 204), row('20261001', 205)]);
    let settled = false;
    const third = t.get(aapl1D).then((bars) => ((settled = true), bars));
    await t.flush();
    expect(settled).toBe(false);
    t.answerCall(t.hist()[2]);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D', '3 D']);
    expect(closes(await third)).toEqual([101, 200, 201, 204, 205]);
  });

  it('needs no request after the close until the next session, unless fresh', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    t.answers.set('2 Y', [row('20241007', 100), row('20261001', 201), row('20261002', 202)]);
    await t.get(aapl1D);
    // A restart on Sunday: the memory cache is gone, the bar cache is settled.
    const svc2 = createHistoryService(t.ctx);
    vi.setSystemTime(ny('2026-10-04', '12:00'));
    expect(closes(await svc2.get(aapl1D))).toEqual([100, 201, 202]);
    expect(t.hist()).toHaveLength(1);
    // fresh bypasses both caches and waits for the tail.
    t.answers.set('2 D', [row('20261001', 201), row('20261002', 202.5)]);
    expect(closes(await svc2.get({ ...aapl1D, fresh: true }))).toEqual([100, 201, 202.5]);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D']);
    // Monday during the session the tail is fetched again.
    vi.setSystemTime(ny('2026-10-05', '11:00'));
    t.answers.set('3 D', [row('20261001', 201), row('20261002', 202.5), row('20261005', 203)]);
    expect(closes(await svc2.get(aapl1D))).toEqual([100, 201, 202.5, 203]);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D', '3 D']);
  });

  it('waits for the tail after the close when the daily bars were loaded during the session', async () => {
    const t = setup(ny('2026-09-30', '10:00'));
    t.answers.set('2 Y', [row('20241002', 100), row('20260929', 251), row('20260930', 252.5)]);
    await t.get(aapl1D);
    t.manual();
    /** A load that waits for IB's answer to the tail. */
    const waited = async (svc: HistoryService) => {
      let settled = false;
      const p = svc.get(aapl1D).then((bars) => ((settled = true), bars));
      await t.flush();
      expect(settled).toBe(false);
      t.answerCall(t.hist().at(-1)!);
      return closes(await p);
    };
    // 16:05: the 10:00 bar is not today's close (the renderer shows the daily close after the session).
    vi.setSystemTime(ny('2026-09-30', '16:05'));
    t.answers.set('2 D', [row('20260929', 251), row('20260930', 243.1)]);
    expect(await waited(t.svc)).toEqual([100, 251, 243.1]);
    // Within the close's settling time: answered at once, refreshed in the background.
    vi.setSystemTime(ny('2026-09-30', '16:15'));
    expect(closes(await t.get(aapl1D))).toEqual([100, 251, 243.1]);
    await t.flush();
    t.answers.set('2 D', [row('20260929', 251), row('20260930', 243.2)]);
    t.answerCall(t.hist().at(-1)!);
    await t.flush();
    // 20:30 after a restart (the load time is persisted): loaded before the close settled.
    vi.setSystemTime(ny('2026-09-30', '20:30'));
    t.answers.set('2 D', [row('20260929', 251), row('20260930', 243.25)]);
    expect(await waited(createHistoryService(t.ctx))).toEqual([100, 251, 243.25]);
    // Settled: the cache answers until the next session.
    expect(closes(await createHistoryService(t.ctx).get(aapl1D))).toEqual([100, 251, 243.25]);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D', '2 D', '2 D']);
  });

  it('does not answer a load after the close from bars loaded minutes before it', async () => {
    const t = setup(ny('2026-09-30', '15:58'));
    t.answers.set('2 Y', [row('20241002', 100), row('20260929', 251), row('20260930', 252.5)]);
    await t.get(aapl1D);
    t.manual();
    t.answers.set('2 D', [row('20260929', 251), row('20260930', 243.1)]);
    vi.setSystemTime(ny('2026-09-30', '16:01'));
    // Within the TTL of the database's load time (a restart) and of the memory cache.
    for (const svc of [createHistoryService(t.ctx), t.svc]) {
      let settled = false;
      const p = svc.get(aapl1D).then((bars) => ((settled = true), bars));
      await t.flush();
      expect(settled).toBe(false);
      t.answerCall(t.hist().at(-1)!);
      expect(closes(await p)).toEqual([100, 251, 243.1]);
    }
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '2 D', '2 D']);
  });

  it('reloads the window when IB adjusted the history (a split) and drops older coverage', async () => {
    const t = setup(ny('2026-09-30'));
    t.answers.set('2 Y', [row('20240930', 100), row('20260929', 200), row('20260930', 202)]);
    await t.get(aapl1D);
    // Some older history paged in, down to the listing.
    t.setHead(String(Date.UTC(2023, 9, 2, 13, 30) / 1000));
    t.answers.set('1 Y@20240930-00:00:00', [row('20231002', 80), row('20240927', 99)]);
    await t.older(aapl1D, day('20240930'), 10);
    expect((await t.coverage(aapl1D))?.ranges).toEqual([[day('20231002'), nySec('2026-09-30')]]);

    vi.setSystemTime(ny('2026-09-30', '15:00'));
    t.answers.set('2 D', [row('20260929', 50), row('20260930', 50.5)]);
    t.answers.set('2 Y', [row('20240930', 25), row('20260929', 50), row('20260930', 50.5)]);
    // The cache answers at once; the background tail finds the history adjusted and reloads.
    expect(closes(await t.get(aapl1D))).toEqual([100, 200, 202]);
    await t.flush();
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y', '1 Y', '2 D', '2 Y']);
    expect(closes(await t.get(aapl1D))).toEqual([25, 50, 50.5]);
    // The unadjusted older bars are no longer covered: paging asks IB again.
    expect((await t.coverage(aapl1D))?.ranges).toEqual([[day('20240930'), nySec('2026-09-30', '15:00')]]);
  });

  it('loads the whole window when the coverage does not reach it, whatever is stored', async () => {
    const t = setup(ny('2026-09-30'));
    // Stored by something else: only recent bars, no coverage.
    await t.ctx.db.bars.put('STK:AAPL|1 day|TRADES|1', [{ time: day('20260929'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    t.answers.set('2 Y', [row('20240930', 100), row('20260930', 202)]);
    await t.get(aapl1D);
    expect(t.hist().map((c) => c[3])).toEqual(['2 Y']);
  });

  it('replaces the re-stamped forming bar of weekly series', async () => {
    const t = setup(ny('2026-10-01'));
    const w: HistoryRequest = { contract: stock('AAPL'), timeframe: '1W' };
    t.answers.set('10 Y', [row('20161007', 10), row('20260925', 200), row('20261001', 201)]);
    // The window starts on Saturday 2016-10-01: the week of 10-03 is whole.
    expect((await t.get(w)).map((b) => b.time)).toEqual([day('20161007'), day('20260925'), day('20261001')]);
    // Friday, same week: answered at once, the tail refreshed in the background.
    vi.setSystemTime(ny('2026-10-02', '15:00'));
    t.answers.set('3 W', [row('20260918', 199), row('20260925', 200), row('20261002', 203)]);
    expect((await t.get(w)).map((b) => b.time)).toEqual([day('20161007'), day('20260925'), day('20261001')]);
    await t.flush();
    expect(t.hist().map((c) => c[3])).toEqual(['10 Y', '3 W']);
    expect((await t.get(w)).map((b) => [b.time, b.close])).toEqual([
      [day('20161007'), 10],
      [day('20260918'), 199],
      [day('20260925'), 200],
      [day('20261002'), 203],
    ]);
    // The stale stamp stays in the bar cache but is never served.
    const svc2 = createHistoryService(t.ctx);
    expect((await svc2.get(w)).map((b) => b.time)).toEqual([day('20161007'), day('20260918'), day('20260925'), day('20261002')]);
  });

  it('drops a first weekly bar that may be partial', async () => {
    const t = setup(ny('2026-10-01'));
    const w: HistoryRequest = { contract: { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' }, timeframe: '1W' };
    // No New York sessions: only the bars prove anything, and the first week may be cut.
    t.answers.set('10 Y', [row('20161007', 1.1), row('20161014', 1.2), row('20261001', 1.3)]);
    expect((await t.get(w)).map((b) => b.time)).toEqual([day('20161014'), day('20261001')]);
  });

  it('answers at once when only the forming intraday bar can have moved', async () => {
    const t = setup(ny('2026-09-30', '10:01'));
    const m5: HistoryRequest = { contract: stock('AAPL'), timeframe: '5m', outsideRth: true };
    const bar = (hhmm: string, close: number): Row => [String(nySec('2026-09-30', hhmm)), close, close, close, close, 1];
    t.answers.set('10 D', [bar('09:55', 1), bar('10:00', 2)]);
    await t.get(m5);
    t.manual();
    // 10:04: the 10:00 bar is still forming.
    vi.setSystemTime(ny('2026-09-30', '10:04'));
    expect(closes(await t.get(m5))).toEqual([1, 2]);
    await t.flush();
    expect(t.hist()).toHaveLength(2);
    t.answers.set(t.hist()[1][3] as string, [bar('09:55', 1), bar('10:00', 2.5)]);
    t.answerCall(t.hist()[1]);
    await t.flush();
    // 10:06: a new bar has started since the last load; the answer waits for IB.
    vi.setSystemTime(ny('2026-09-30', '10:06'));
    let settled = false;
    const p = t.get(m5).then((bars) => ((settled = true), bars));
    await t.flush();
    expect(settled).toBe(false);
    t.answers.set(t.hist()[2][3] as string, [bar('10:00', 2.6), bar('10:05', 3)]);
    t.answerCall(t.hist()[2]);
    expect(closes(await p)).toEqual([1, 2.6, 3]);
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

describe('older bars', () => {
  it('pages daily bars back from IB, then from the cache, and stops at the head timestamp', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    t.answers.set('2 Y', [row('20241003', 100), row('20241004', 101), row('20261001', 200), row('20261002', 201)]);
    await t.get(aapl1D);
    // AAPL here listed on 2023-10-03 (13:30 UTC).
    t.setHead(String(Date.UTC(2023, 9, 3, 13, 30) / 1000));
    t.answers.set('1 Y@20241003-00:00:00', [row('20231003', 90), row('20231004', 91), row('20241001', 98), row('20241002', 99)]);
    const p1 = await t.older(aapl1D, day('20241003'), 3);
    expect(p1.done).toBe(false);
    expect(closes(p1.bars)).toEqual([91, 98, 99]);
    expect(t.asked()).toEqual([
      ['2 Y', ''],
      ['1 Y', '20241003-00:00:00'],
    ]);
    expect(t.heads()).toHaveLength(1);
    // The rest down to the head timestamp is covered: from the cache, done.
    expect(await t.older(aapl1D, day('20231004'), 3)).toEqual({ bars: [expect.objectContaining({ time: day('20231003'), close: 90 })], done: true });
    expect(await t.older(aapl1D, day('20231003'), 3)).toEqual({ bars: [], done: true });

    // Second pass after a restart: coverage and head timestamp are persisted, IB is not asked.
    const svc2 = createHistoryService(t.ctx);
    expect(closes((await svc2.getOlder(aapl1D, day('20241003'), 3)).bars)).toEqual([91, 98, 99]);
    expect(await svc2.getOlder(aapl1D, day('20231004'), 100)).toEqual({ bars: [expect.objectContaining({ close: 90 })], done: true });
    expect(t.hist()).toHaveLength(2);
    expect(t.heads()).toHaveLength(1);
    // The head request was cancelled after its answer (IB keeps it open otherwise).
    expect(t.fake.callsOf('cancelHeadTimestamp')).toEqual([[t.heads()[0][0]]]);
  });

  it('fills the gap between covered ranges with one request', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const series = 'STK:AAPL|1 day|TRADES|1';
    const bar = (ymd: string) => ({ time: day(ymd), open: 1, high: 1, low: 1, close: Number(ymd.slice(4)), volume: 1 });
    await t.ctx.db.bars.put(series, [bar('20240102'), bar('20240229'), bar('20240401'), bar('20240402'), bar('20240531')]);
    await t.ctx.db.kv.set(COVERAGE_NS, series, { ranges: [[day('20240101'), day('20240301')], [day('20240401'), day('20240601')]] });
    await t.ctx.db.kv.set(COVERAGE_NS, 'head|STK:AAPL|TRADES|1', { head: day('20000103') });
    t.answers.set('1 Y@20240401-00:00:00', [row('20230403', 403), row('20240102', 102), row('20240229', 229), row('20240315', 315), row('20240328', 328)]);
    const page = await t.older(aapl1D, day('20240402'), 4);
    expect(t.asked()).toEqual([['1 Y', '20240401-00:00:00']]);
    expect(t.heads()).toHaveLength(0);
    expect(closes(page.bars)).toEqual([229, 315, 328, 401]);
    expect((await t.coverage(aapl1D))?.ranges).toEqual([[day('20230403'), day('20240601')]]);
    // The gap is now known: the next page comes from the cache.
    expect(closes((await t.older(aapl1D, day('20240229'), 2)).bars)).toEqual([403, 102]);
    expect(t.hist()).toHaveLength(1);
  });

  it('keeps going back over option windows without trades', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const call = option('AAPL', '20261120', 260, 'C');
    const m5: HistoryRequest = { contract: call, timeframe: '5m', outsideRth: true };
    const at = (date: string, hhmm: string, close: number): Row => [String(nySec(date, hhmm)), close, close, close, close, 1];
    t.answers.set('10 D', [at('2026-09-21', '14:20', 81), at('2026-10-02', '15:55', 74)]);
    await t.get(m5);
    t.setHead(String(nySec('2026-06-08', '13:00')));
    // Sep 18 had no trades (162 "no data"), Sep 17 had two, then one on Sep 8.
    const noData = (id: number) => t.fake.error(id, 162, 'Historical Market Data Service error message:HMDS query returned no data: AAPL  261120C00260000@SMART Trades');
    const sep21 = ibEndDateTime(weekdaysBackStart(nySec('2026-10-02', '17:00'), 10));
    expect(sep21).toBe('20260921-04:00:00');
    t.answers.set(`1 D@${sep21}`, noData);
    t.answers.set('1 D@20260918-04:00:00', [at('2026-09-17', '10:00', 80), at('2026-09-17', '15:55', 79)]);
    t.answers.set('10 D@20260917-04:00:00', [at('2026-09-08', '11:00', 78)]);
    const page = await t.older(m5, nySec('2026-09-21', '14:20'), 50);
    // An empty answer doubles the next request, a thin one scales it to the trades seen (2 of 192 bars).
    expect(t.asked().slice(1)).toEqual([
      ['1 D', '20260921-04:00:00'],
      ['1 D', '20260918-04:00:00'],
      ['10 D', '20260917-04:00:00'],
    ]);
    expect(page).toEqual({ bars: [78, 80, 79].map((close) => expect.objectContaining({ close })), done: false });
    // The next call goes on from where the coverage ends (ten weekdays before Sep 17), not from Sep 21 again.
    t.answers.set('1 D@20260903-04:00:00', [at('2026-09-02', '11:00', 77)]);
    expect(closes((await t.older(m5, nySec('2026-09-08', '11:00'), 1)).bars)).toEqual([77]);
    expect(t.asked().at(-1)).toEqual(['1 D', '20260903-04:00:00']);
  });

  it('is done when IB has nothing older and no head timestamp', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    t.setHead((id) => t.fake.error(id, 162, 'Historical Market Data Service error message:No head time stamp'));
    t.answers.set('1 Y@20200101-00:00:00', []);
    expect(await t.older(aapl1D, day('20200101'), 50)).toEqual({ bars: [], done: true });
    expect(t.heads()).toHaveLength(1);
    // IB's "none" is remembered for a day.
    expect(await t.older(aapl1D, day('20200101'), 60)).toEqual({ bars: [], done: true });
    expect(t.heads()).toHaveLength(1);
  });

  it('pages 1Y charts in whole years of monthly bars', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const y: HistoryRequest = { contract: stock('AAPL'), timeframe: '1Y' };
    t.setHead(String(day('20000103') + 14 * 3600));
    const months: Row[] = [];
    for (let year = 2004; year < 2007; year++) for (let m = 1; m <= 12; m++) months.push(row(`${year}${String(m).padStart(2, '0')}28`, year * 100 + m));
    t.answers.set('3 Y@20070101-00:00:00', months);
    const page = await t.older(y, day('20070101'), 3);
    expect(page.bars.map((b) => [b.time, b.close])).toEqual([
      [day('20040101'), 200412],
      [day('20050101'), 200512],
      [day('20060101'), 200612],
    ]);
  });

  it('serves intraday coverage only within the bar retention', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const m5: HistoryRequest = { contract: stock('AAPL'), timeframe: '5m', outsideRth: true };
    const series = seriesKey(historySpec(m5), 'STK:AAPL');
    const old = nySec('2026-08-20', '10:00');
    await t.ctx.db.bars.put(series, [{ time: old, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    await t.ctx.db.kv.set(COVERAGE_NS, series, { ranges: [[nySec('2026-08-15', '00:00'), nySec('2026-10-02', '17:00')]] });
    await t.ctx.db.kv.set(COVERAGE_NS, 'head|STK:AAPL|TRADES|0', { head: day('20000103') });
    const before = nySec('2026-08-21', '10:00');
    await t.older(m5, before, 10);
    // Over 29 days old: the database may have dropped those bars, so IB is asked.
    expect(t.asked()[0]).toEqual(['1 D', ibEndDateTime(before)]);
  });

  it('ends page requests on the bar grid, so IB never answers with a cut bar', async () => {
    // Friday 17:03:27: intraday bars are served from Sep 4 00:00 New York (29 days back, then midnight).
    const now = Date.parse('2026-10-02T17:03:27-04:00');
    const t = setup(now);
    const m5: HistoryRequest = { contract: stock('AAPL'), timeframe: '5m', outsideRth: true };
    const series = seriesKey(historySpec(m5), 'STK:AAPL');
    await t.ctx.db.kv.set(COVERAGE_NS, 'head|STK:AAPL|TRADES|0', { head: day('19801212') });
    const whole = (time: number): Bar => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 });
    const span = (from: number, to: number) => Array.from({ length: (to - from) / 300 }, (_, i) => whole(from + i * 300));
    // Covered since Aug 15, and stored around the boundary.
    await t.ctx.db.bars.put(series, span(nySec('2026-09-03', '16:00'), nySec('2026-09-04', '10:00')));
    await t.ctx.db.kv.set(COVERAGE_NS, series, { ranges: [[nySec('2026-08-15', '00:00'), now / 1000]], fetchedAt: now });
    // IB cuts the bar that holds the end time (live: the 17:00 UTC bar ending at 17:03:27 had 89,119 of its 107,898).
    const cutting = (id: number) => {
      const end = t.endOf(id);
      for (const b of span(nySec('2026-08-20', '04:00'), nySec('2026-09-04', '20:00')).filter((x) => x.time < end)) {
        const cut = b.time + 300 > end;
        t.fake.emit('historicalData', id, String(b.time), b.open, cut ? 1.1 : b.high, b.low, cut ? 1 : b.close, cut ? 7 : b.volume);
      }
      t.fake.emit('historicalData', id, 'finished', -1, -1, -1, -1, -1);
    };
    t.answers.set('1 D', cutting);
    const page = await t.older(m5, nySec('2026-09-04', '10:00'), 300);
    expect(t.asked()).toEqual([['1 D', ibEndDateTime(nySec('2026-09-04', '00:00'))]]);
    expect(page.bars.find((b) => b.time === nySec('2026-09-03', '17:00'))).toEqual(whole(nySec('2026-09-03', '17:00')));
    expect(await t.ctx.db.bars.get(series, nySec('2026-09-03', '17:00'), nySec('2026-09-03', '17:05'))).toEqual([whole(nySec('2026-09-03', '17:00'))]);
    // A page before a time inside a bar asks up to the bar's end, and gets it whole.
    const inside = nySec('2026-08-20', '10:03') + 27;
    expect((await t.older(m5, inside, 2)).bars).toEqual([whole(nySec('2026-08-20', '09:55')), whole(nySec('2026-08-20', '10:00'))]);
    expect(t.asked().at(-1)).toEqual(['1 D', ibEndDateTime(nySec('2026-08-20', '10:05'))]);
  });

  it('pages weekly bars of an instrument without New York sessions to its first week', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const eur: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };
    const w: HistoryRequest = { contract: eur, timeframe: '1W' };
    // Live: the head timestamp is 2005-03-09 00:00 New York, the first weekly bar 2005-03-11.
    t.setHead('1110344400');
    const fridays = (id: number) => {
      const end = t.endOf(id);
      for (let s = day('20050311'); s < end; s += 7 * 86_400) t.fake.emit('historicalData', id, new Date(s * 1000).toISOString().slice(0, 10).replace(/-/g, ''), 1, 1, 1, 1, 0);
      t.fake.emit('historicalData', id, 'finished', -1, -1, -1, -1, -1);
    };
    t.answers.set('6 Y', fridays);
    const page = await t.older(w, day('20070302'), 300);
    expect(page.done).toBe(true);
    expect(page.bars[0].time).toBe(day('20050311'));
    expect(page.bars).toHaveLength(103);
    expect(t.hist()).toHaveLength(1);
    // Coverage from before this was claimed (from the week after the first bar): one request for the lone first week.
    const series = seriesKey(historySpec(w), contractKey(eur));
    await t.ctx.db.kv.set(COVERAGE_NS, series, { ranges: [[day('20050314'), day('20070226')]] });
    const svc2 = createHistoryService(t.ctx);
    expect(await svc2.getOlder(w, day('20050318'), 300)).toEqual({ bars: [expect.objectContaining({ time: day('20050311') })], done: true });
    expect(t.asked().at(-1)).toEqual(['6 Y', '20050314-00:00:00']);
    expect(await svc2.getOlder(w, day('20050311'), 300)).toEqual({ bars: [], done: true });
    expect(t.hist()).toHaveLength(2);
  });

  it('takes only IB\'s "no data" answer as no head timestamp', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const call = option('AAPL', '20261120', 260, 'C');
    const m5: HistoryRequest = { contract: call, timeframe: '5m', outsideRth: true };
    const hkey = `head|${contractKey(call)}|TRADES|0`;
    t.setHead((id) => t.fake.error(id, 162, 'Historical Market Data Service error message:Historical data request pacing violation'));
    // Windows without trades, while older ones have them.
    const noData = (id: number) => t.fake.error(id, 162, 'Historical Market Data Service error message:HMDS query returned no data: AAPL  261120C00260000@SMART Trades');
    for (const d of ['2 D', '4 D', '7 D', '10 D']) t.answers.set(d, noData);
    const before = nySec('2026-09-21', '14:20');
    const first = t.older(m5, before, 300);
    // The pacing violation pauses historical requests.
    await vi.advanceTimersByTimeAsync(BACKOFF_START_MS);
    expect(await first).toEqual({ bars: [], done: false });
    expect(t.asked()).toHaveLength(3);
    expect(await t.ctx.db.kv.get(COVERAGE_NS, hkey)).toBeUndefined();
    // Not asked again for a while; then IB answers.
    vi.advanceTimersByTime(PAGE_TTL_MS);
    await t.older(m5, before, 299);
    expect(t.heads()).toHaveLength(1);
    vi.advanceTimersByTime(HEAD_ERROR_MS);
    t.setHead(String(nySec('2026-06-08', '13:00')));
    await t.older(m5, before, 298);
    expect(t.heads()).toHaveLength(2);
    expect((await t.ctx.db.kv.get(COVERAGE_NS, hkey))?.value).toEqual({ head: nySec('2026-06-08', '13:00') });
    // IB's "no data" for the type (live, for TRADES of a currency pair) is remembered as none.
    const eur: HistoryRequest = { contract: { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' }, timeframe: '1D', whatToShow: 'TRADES' };
    t.setHead((id) => t.fake.error(id, 162, 'Historical Market Data Service error message:No historical market data for EUR/CASH@IDEALPRO Last 0'));
    t.answers.set('1 Y@20200101-00:00:00', []);
    expect(await t.older({ ...eur, whatToShow: 'MIDPOINT' }, day('20200101'), 10)).toEqual({ bars: [], done: true });
    expect((await t.ctx.db.kv.get(COVERAGE_NS, 'head|CASH:EUR|MIDPOINT|1'))?.value).toEqual({ head: null });
  });

  it('keeps pages within their share of the historical data budget', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    t.answers.set('1 Y@20200101-00:00:00', [row('20190102', 1), row('20191231', 2)]);
    for (let i = 0; i < PAGE_BUDGET; i++) await t.older({ contract: stock(`S${i}`), timeframe: '1D' }, day('20200101'), 2);
    expect(t.hist()).toHaveLength(PAGE_BUDGET);
    const late = t.older({ contract: stock('LATE'), timeframe: '1D' }, day('20200101'), 2);
    await t.flush();
    expect(t.hist()).toHaveLength(PAGE_BUDGET);
    // The newest bars of another chart go at once.
    t.answers.set('2 Y', [row('20241002', 5)]);
    expect(closes(await t.get({ contract: stock('NEW'), timeframe: '1D' }))).toEqual([5]);
    await vi.advanceTimersByTimeAsync(PAGE_BUDGET_WINDOW_MS - 1);
    expect(t.hist()).toHaveLength(PAGE_BUDGET + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes((await late).bars)).toEqual([1, 2]);
    expect(t.hist()).toHaveLength(PAGE_BUDGET + 2);
  });

  it('pages intraday bars beyond the retention from what it fetched, without keeping that coverage', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    const m5: HistoryRequest = { contract: stock('AAPL'), timeframe: '5m', outsideRth: true };
    await t.ctx.db.kv.set(COVERAGE_NS, 'head|STK:AAPL|TRADES|0', { head: day('20000103') });
    const bar = (hhmm: string, close: number): Row => [String(nySec('2026-08-20', hhmm)), close, close, close, close, 1];
    const before = nySec('2026-08-20', '10:00');
    t.answers.set(`1 D@${ibEndDateTime(before)}`, [bar('04:00', 1), bar('09:55', 2)]);
    expect(closes((await t.older(m5, before, 2)).bars)).toEqual([1, 2]);
    expect(t.hist()).toHaveLength(1);
    expect((await t.coverage(m5))?.ranges).toEqual([]);
  });

  it('shares identical page requests in flight and answers them from memory for 15 s', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    await t.ctx.db.kv.set(COVERAGE_NS, 'head|STK:AAPL|TRADES|1', { head: day('20000103') });
    t.answers.set('1 Y@20200101-00:00:00', [row('20190102', 1), row('20191231', 2)]);
    const [a, b] = await Promise.all([t.older(aapl1D, day('20200101'), 2), t.older(aapl1D, day('20200101'), 2)]);
    expect(a).toEqual(b);
    expect(t.hist()).toHaveLength(1);
    // Dropping the coverage proves the next answer comes from memory.
    await t.ctx.db.kv.delete(COVERAGE_NS, 'STK:AAPL|1 day|TRADES|1');
    expect(await t.older(aapl1D, day('20200101'), 2)).toEqual(a);
    vi.advanceTimersByTime(PAGE_TTL_MS);
    expect(await t.older(aapl1D, day('20200101'), 2)).toEqual(a);
    expect(t.hist()).toHaveLength(1);
  });

  it("supersedes a slot's pages by newer pages and by the newest bars of another series", async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    await t.ctx.db.kv.set(COVERAGE_NS, 'head|STK:AAPL|TRADES|1', { head: day('20000103') });
    t.manual();
    const chart = { ...aapl1D, slot: 'chart' };
    const p1 = t.older(chart, day('20200101'), 10).catch((e: unknown) => e);
    await t.flush();
    expect(t.hist()).toHaveLength(1);
    // Loading the newest bars of the same series does not cancel the page.
    const refresh = t.get(chart).catch((e: unknown) => e);
    await t.flush();
    expect(t.hist()).toHaveLength(2);
    expect(t.fake.callsOf('cancelHistoricalData')).toEqual([]);
    // A newer page of the slot supersedes the older one, which is cancelled at IB.
    const p2 = t.older(chart, day('20190101'), 10).catch((e: unknown) => e);
    expect(await p1).toBeInstanceOf(SupersededError);
    expect(t.fake.callsOf('cancelHistoricalData')).toEqual([[t.hist()[0][0]]]);
    await t.flush();
    const [, aaplNewest, page2] = t.hist().map((c) => c[0]);
    // The chart switches to MSFT: the pending AAPL page and newest bars go.
    const msft = t.get({ contract: stock('MSFT'), timeframe: '1D', slot: 'chart' });
    expect(await p2).toBeInstanceOf(SupersededError);
    expect(await refresh).toBeInstanceOf(SupersededError);
    expect(t.fake.callsOf('cancelHistoricalData').slice(1)).toEqual([[page2], [aaplNewest]]);
    await t.flush();
    t.answerCall(t.hist()[3]);
    await msft;
  });

  it('pages wait behind requests for the newest bars, at most two at a time', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    for (const s of ['A', 'B', 'C', 'D']) await t.ctx.db.kv.set(COVERAGE_NS, `head|STK:${s}|TRADES|1`, { head: day('20000103') });
    t.manual();
    const sym = (c: unknown[]) => (c[1] as { symbol: string }).symbol;
    const busy = ['S1', 'S2', 'S3', 'S4', 'S5'].map((s) => t.get({ contract: stock(s), timeframe: '1D' }));
    await t.flush();
    const pages = ['A', 'B', 'C'].map((s) => t.older({ contract: stock(s), timeframe: '1D' }, day('20200101'), 10));
    const newest = t.get({ contract: stock('N'), timeframe: '1D' });
    await t.flush();
    expect(t.hist().map(sym)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    // A slot frees up: the newest-bars request goes first.
    t.answerCall(t.hist()[0]);
    await t.flush();
    expect(t.hist().map(sym).slice(5)).toEqual(['N']);
    for (const c of t.hist().slice(1)) t.answerCall(c);
    await t.flush();
    // Then the pages, two at a time.
    expect(t.hist().map(sym).slice(6)).toEqual(['A', 'B']);
    t.answerCall(t.hist()[6]);
    await t.flush();
    expect(t.hist().map(sym).slice(8)).toEqual(['C']);
    t.auto();
    for (const c of t.hist().slice(7)) t.answerCall(c);
    await Promise.all([...busy, ...pages, newest]);
  });

  it('pages from the simulator in demo mode', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: ny('2026-10-02', '17:00') });
    const f = createFakeContext(createFakeIb().ib, true);
    const svc = createHistoryService(f.ctx);
    const bars = await svc.get(aapl1D);
    const page = await svc.getOlder(aapl1D, bars[0].time, 10);
    expect(page.done).toBe(true);
    const mid = await svc.getOlder(aapl1D, bars[100].time, 10);
    expect(mid).toEqual({ bars: bars.slice(90, 100), done: false });
  });

  it('rejects invalid page requests', async () => {
    const t = setup(ny('2026-10-02', '17:00'));
    await expect(t.older(aapl1D, NaN, 10)).rejects.toThrow('Invalid history request');
    await expect(t.older({ ...aapl1D, timeframe: '2m' as never }, 1, 10)).rejects.toThrow('Invalid history request');
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
    t.answers.set('2 Y', [row('20240930', 1)]);
    t.answerCall(t.hist()[1]);
    expect(closes(await b)).toEqual([1]);
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
    t.answerCall(nvda);
    expect(closes(await c)).toEqual([2]);
    expect(t.fake.callsOf('cancelHistoricalData')).toHaveLength(1);
    const tsla = t.hist().find((x) => (x[1] as { symbol: string }).symbol === 'TSLA')!;
    t.answerCall(tsla);
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
    for (const c of t.hist()) t.answerCall(c);
    await Promise.all(busy);
    await t.flush();
    expect(t.hist().map((c) => (c[1] as { symbol: string }).symbol)).toEqual(['A', 'B', 'C', 'D', 'E', 'X2']);
    t.answerCall(t.hist()[5]);
    await latest;
    expect(t.fake.callsOf('cancelHistoricalData')).toEqual([]);
  });

  it('keeps at most five requests out and bounds the waiting ones', async () => {
    const t = setup(ny('2026-09-30'));
    t.manual();
    const out = Array.from({ length: 5 + MAX_QUEUED + 1 }, (_, i) =>
      t.get({ contract: stock(`S${i}`), timeframe: '1D' }).then(
        () => 'ok',
        (e: Error) => e.message,
      ),
    );
    await t.flush();
    expect(t.hist()).toHaveLength(5);
    // The oldest waiting request (S5) made room for the newest.
    expect(await out[5]).toMatch(/Too many historical data requests/);
    for (let round = 0; round < 6; round++) {
      for (const c of t.hist().slice(round * 5)) t.answerCall(c);
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
    expect(closes(await a)).toEqual([7]);
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
