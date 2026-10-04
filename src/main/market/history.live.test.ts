// Live check of the history service (bar cache, coverage, paging) against a running IB Gateway /
// TWS with a paper account. Skipped unless TAPE_LIVE_IB is set, e.g.:
//
//   TAPE_LIVE_IB=127.0.0.1:4002 TAPE_CLIENT_ID=181 pnpm vitest run src/main/market/history.live.test.ts
//
// Loads AAPL daily and 5-minute bars into a SQLite bar cache (a temporary file) and pages back
// several pages, then does the same with a new service on the same file: the second pass must
// not ask IB for anything. The paged bars are compared with one direct request over the same span
// (no gaps, no duplicates, the same OHLCV: no bar cut at a page boundary). An AAPL option (sparse
// trades) is paged too. Only historical data is requested. Use a client id no other program uses.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { option, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import type { Bar, HistoryRequest, Settings } from '@shared/types';
import type { HistoryService, MainContext } from '../context';
import { createSqliteClient, type DbTransport } from '../db/client';
import { serve } from '../db/server';
import { EventName, OUT_MSG_ID } from '../ib/tws';
import { toIbContract } from './ibContract';
import { ibEndDateTime } from './historyPages';
import { parseBarTime } from './historyParams';

const live = process.env.TAPE_LIVE_IB;
const dir = mkdtempSync(join(tmpdir(), 'tape-history-live-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    whenReady: () => Promise.resolve(),
    on: () => undefined,
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)('history against a live IB Gateway', { timeout: 300_000 }, async () => {
  const { createApiLog } = await import('../ib/apiLog');
  const { createConnection } = await import('../ib/connection');
  const { createHistoryService } = await import('./history');

  const [host, port] = (live ?? '127.0.0.1:4002').split(':');
  const base = defaultSettings();
  const settings: Settings = { ...base, connection: { ...base.connection, host, port: Number(port) }, apiLog: { ...base.apiLog, writeFile: false } };

  // SQLite bar cache in this thread (the app runs the same server in a worker).
  const { port1, port2 } = new MessageChannel();
  const transport: DbTransport = {
    post: (req, transfer) => (transfer ? port1.postMessage(req, transfer) : port1.postMessage(req)),
    listen: (onMessage) => void port1.on('message', onMessage),
    terminate: async () => port1.close(),
  };
  serve(port2, { file: join(dir, 'tape.db'), log: () => undefined });
  const db = createSqliteClient(transport);

  const ctx = {
    demo: false,
    isDev: true,
    emit: () => undefined,
    store: { getSettings: () => settings, onSettingsChanged: () => () => undefined },
    notifier: { notify: (n: unknown) => n },
    db,
  } as unknown as MainContext;
  ctx.apiLog = createApiLog(ctx);
  ctx.ib = createConnection(ctx);
  await sleep(10);

  const frames = { hist: 0, head: 0, cancel: 0, all: 0 };
  ctx.ib.on(EventName.sent, (tokens: unknown) => {
    if (!Array.isArray(tokens)) return;
    frames.all++;
    const id = Number(tokens[0]);
    if (id === OUT_MSG_ID.REQ_HISTORICAL_DATA) frames.hist++;
    else if (id === OUT_MSG_ID.REQ_HEAD_TIMESTAMP) frames.head++;
    else if (id === OUT_MSG_ID.CANCEL_HISTORICAL_DATA || id === OUT_MSG_ID.CANCEL_HEAD_TIMESTAMP) frames.cancel++;
  });
  const errors: string[] = [];
  ctx.ib.onRequestError((e) => errors.push(`${e.code} ${e.message}`));

  afterAll(async () => {
    await ctx.ib.disconnect();
    await db.close();
    port2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One step: wall time and IB requests it made. */
  async function step<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; requests: number }> {
    const before = frames.hist + frames.head;
    const t0 = performance.now();
    const value = await run();
    return { value, ms: Math.round(performance.now() - t0), requests: frames.hist + frames.head - before };
  }

  function expectSeries(bars: Bar[], before?: number) {
    for (let i = 1; i < bars.length; i++) expect(bars[i].time).toBeGreaterThan(bars[i - 1].time);
    if (before !== undefined && bars.length) expect(bars[bars.length - 1].time).toBeLessThan(before);
  }

  /** The newest bars, then `pages` pages back; every step timed and counted. */
  async function walk(svc: HistoryService, req: HistoryRequest, limit: number, pages: number) {
    const newest = await step(() => svc.get(req));
    expectSeries(newest.value);
    const steps = [{ what: 'newest', ms: newest.ms, requests: newest.requests, bars: newest.value.length, done: false }];
    let all = newest.value;
    for (let i = 0; i < pages && all.length; i++) {
      const before = all[0].time;
      const page = await step(() => svc.getOlder(req, before, limit));
      expectSeries(page.value.bars, before);
      expect(page.value.bars.length).toBeLessThanOrEqual(limit);
      steps.push({ what: `page ${i + 1}`, ms: page.ms, requests: page.requests, bars: page.value.bars.length, done: page.value.done });
      all = [...page.value.bars, ...all];
      if (page.value.done) break;
    }
    expectSeries(all);
    return { steps, all };
  }

  /** One direct request (no cache), for comparing what the pages put together. */
  function direct(req: HistoryRequest, barSize: string, duration: string, end: string, useRTH: number): Promise<Bar[]> {
    const api = ctx.ib.api!;
    const reqId = ctx.ib.nextReqId();
    const bars: Bar[] = [];
    return new Promise((resolve, reject) => {
      const offData = ctx.ib.on(EventName.historicalData, (id: number, time: string, open: number, high: number, low: number, close: number, volume?: number) => {
        if (id !== reqId) return;
        if (String(time).startsWith('finished')) {
          offData();
          resolve(bars);
        } else bars.push({ time: parseBarTime(String(time)), open, high, low, close, volume: volume != null && volume > 0 ? volume : 0 });
      });
      setTimeout(() => reject(new Error('direct request timed out')), 60_000);
      api.reqHistoricalData(reqId, toIbContract(req.contract), end, duration, barSize as never, 'TRADES' as never, useRTH, 2, false);
    });
  }

  const report: Record<string, unknown> = {};

  it('pages AAPL daily and 5-minute bars back, then serves them from the cache', async () => {
    await ctx.ib.connect();
    expect(ctx.ib.isConnected()).toBe(true);
    const daily: HistoryRequest = { contract: stock('AAPL'), timeframe: '1D', slot: 'chart' };
    const m5: HistoryRequest = { contract: stock('AAPL'), timeframe: '5m', outsideRth: true, slot: 'chart' };

    const cold = createHistoryService(ctx);
    const framesBefore = { ...frames };
    // Three 5-minute pages stay within the 29 days of intraday coverage the cache serves.
    const d1 = await walk(cold, daily, 300, 4);
    const f1 = await walk(cold, m5, 500, 3);
    const coldFrames = { hist: frames.hist - framesBefore.hist, head: frames.head - framesBefore.head };

    // A new service on the same database: nothing in memory, everything on disk.
    const warm = createHistoryService(ctx);
    const warmBefore = { ...frames };
    const d2 = await walk(warm, daily, 300, 4);
    const f2 = await walk(warm, m5, 500, 3);
    const warmFrames = { hist: frames.hist - warmBefore.hist, head: frames.head - warmBefore.head };
    console.log(JSON.stringify({ daily: { cold: d1.steps, warm: d2.steps }, m5: { cold: f1.steps, warm: f2.steps }, frames: { cold: coldFrames, warm: warmFrames } }));
    expect(d2.all).toEqual(d1.all);
    expect(f2.all).toEqual(f1.all);
    // Pages come from the cache; the newest bars need IB only when they are not settled.
    for (const s of [...d2.steps, ...f2.steps].filter((x) => x.what !== 'newest')) expect(s.requests).toBe(0);

    // What the pages put together equals one direct request over the same span, bar for bar.
    const directDaily = await direct(daily, '1 day', '10 Y', '', 1);
    const from = Math.max(d1.all[0].time, directDaily[0].time);
    expect(d1.all.length).toBeGreaterThan(1000);
    expect(directDaily.filter((b) => b.time >= from && b.time <= d1.all[d1.all.length - 1].time)).toEqual(d1.all.filter((b) => b.time >= from));
    const directM5 = await direct(m5, '5 mins', '10 D', ibEndDateTime(f1.all[0].time + 10 * 86_400), 0);
    const span = directM5.filter((b) => b.time >= f1.all[0].time);
    expect(span.length).toBeGreaterThan(100);
    expect(f1.all.filter((b) => b.time <= span[span.length - 1].time)).toEqual(span);

    // Beyond the retention the cache does not serve intraday pages: one request per page, no loop.
    const deepBars: Bar[] = [];
    const deep = await walk(warm, m5, 500, 2).then(async (w) => {
      let before = w.all[0].time;
      const out = [];
      for (let i = 0; i < 3; i++) {
        const page = await step(() => warm.getOlder(m5, before, 500));
        expectSeries(page.value.bars, before);
        out.push({ ms: page.ms, requests: page.requests, bars: page.value.bars.length, oldest: new Date(page.value.bars[0].time * 1000).toISOString() });
        deepBars.unshift(...page.value.bars);
        before = page.value.bars[0].time;
        expect(page.requests).toBeLessThanOrEqual(2);
      }
      return out;
    });
    const directDeep = await direct(m5, '5 mins', '10 D', ibEndDateTime(deepBars[deepBars.length - 1].time + 300), 0);
    const deepSpan = directDeep.filter((b) => b.time >= deepBars[0].time);
    expect(deepSpan.length).toBeGreaterThan(500);
    expect(deepBars).toEqual(deepSpan);
    // A page before a time inside a bar gets that bar whole (the request ends on the bar grid).
    const inside = deepBars[200].time + 150;
    const cut = await step(() => warm.getOlder(m5, inside, 20));
    expect(cut.value.bars).toEqual(deepBars.slice(181, 201));

    Object.assign(report, { deep5m: deep, daily: { cold: d1.steps, warm: d2.steps }, m5: { cold: f1.steps, warm: f2.steps }, frames: { cold: coldFrames, warm: warmFrames }, errors });
    console.log(JSON.stringify(report, null, 1));
  });

  it('pages weekly and yearly bars in whole periods', async () => {
    const svc = createHistoryService(ctx);
    for (const [tf, limit] of [
      ['1W', 200],
      ['1Y', 10],
    ] as const) {
      const req: HistoryRequest = { contract: stock('AAPL'), timeframe: tf };
      const { steps, all } = await walk(svc, req, limit, 2);
      // One bar per period: no partial period at a page boundary shows up twice.
      const keys = all.map((b) => (tf === '1Y' ? new Date(b.time * 1000).getUTCFullYear() : Math.floor((b.time / 86_400 + 3) / 7)));
      expect(new Set(keys).size).toBe(keys.length);
      report[tf] = steps;
    }
    console.log(JSON.stringify({ '1W': report['1W'], '1Y': report['1Y'] }, null, 1));
  });

  it('pages an AAPL option (sparse trades) back toward its head timestamp', async () => {
    const svc = createHistoryService(ctx);
    const call = option('AAPL', '20261120', 260, 'C');
    const daily = await walk(svc, { contract: call, timeframe: '1D' }, 100, 2);
    // The 2 Y window of 8-hour bars reaches back beyond the listing: the first page is done.
    expect(daily.steps[1]).toMatchObject({ bars: 0, done: true });
    const m5 = await walk(svc, { contract: call, timeframe: '5m', outsideRth: true }, 300, 3);
    report.option = { daily: daily.steps, m5: m5.steps, errors };
    console.log(JSON.stringify(report.option, null, 1));
  });
});
