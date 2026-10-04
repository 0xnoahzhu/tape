// Historical bars (reqHistoricalData) per timeframe. Demo mode synthesizes bars that end at the
// simulated price.
//
// Bars are kept in the bar cache (ctx.db.bars) per series (contract + bar size + whatToShow +
// useRTH): a load fetches only the tail since the second-newest stored bar, nothing at all
// while the series is fresh or settled (after the close), and the whole window only when the
// stored bars do not cover it (see planFetch). Results are also kept in memory for a short TTL.
//
// IB's wire-level rules (identical requests, 5 per contract within 2 s, 60 per 10 minutes) are
// enforced by the send queue (ib/tws/pacing.ts). This service bounds what can wait there: at
// most MAX_CONCURRENT requests are out, at most MAX_QUEUED wait behind them (the oldest is
// dropped), and a newer request from the same slot (e.g. the chart) supersedes the older ones,
// cancelling them at IB when they were already sent. A 162 pacing violation pauses all requests
// (exponential backoff from 10 s) and retries once; other 162 errors are final.

import { EventName, OUT_MSG_ID, type BarSizeSetting, type WhatToShow as IbWhatToShow } from '../ib/tws';
import { contractKey, contractLabel } from '@shared/contract';
import type { Bar, HistoryRequest } from '@shared/types';
import type { HistoryService, MainContext } from '../context';
import { demoMarket } from './demo';
import { toIbContract } from './ibContract';
import { ibRequest, IbRequestError, isIbConnected, NOT_CONNECTED, TtlCache } from './ibRequest';
import {
  aggregateBars,
  barsToDays,
  dedupePeriods,
  historyAdjusted,
  historyKey,
  historySpec,
  historyTtlMs,
  isTimeframe,
  mergeTail,
  normalizeBars,
  parseBarTime,
  planFetch,
  seriesKey,
  seriesPeriod,
  windowStartSec,
  type HistorySpec,
  type SeriesMeta,
} from './historyParams';

/** Response timeout, counted from the moment the request is written (it may wait for pacing). */
const HISTORY_TIMEOUT_MS = 20_000;
/** IB paces historical requests; more than a handful in flight risks pacing violations. */
const MAX_CONCURRENT = 5;
/** Requests waiting beyond the ones in flight; past this the oldest waiting request is dropped. */
export const MAX_QUEUED = 20;
export const BACKOFF_START_MS = 10_000;
const BACKOFF_MAX_MS = 160_000;
/** Final errors are answered from memory this long, so a view does not repeat a doomed request. */
const FAILURE_TTL_MS = 30_000;
/** kv namespace of the per-series bookkeeping (SeriesMeta). */
const META_NS = 'series';

export class SupersededError extends Error {
  constructor() {
    super('Historical data request superseded by a newer one');
    this.name = 'SupersededError';
  }
}

const isPacingViolation = (err: unknown) => err instanceof IbRequestError && err.code === 162 && /pacing violation/i.test(err.message);
/** IB's answer will not change when asked again: no security definition, no data of this type, invalid request. */
const isFinal = (err: unknown) => err instanceof IbRequestError && !isPacingViolation(err);

interface Waiter {
  slot?: string;
  resolve(bars: Bar[]): void;
  reject(err: Error): void;
}

interface Job {
  key: string;
  req: HistoryRequest;
  spec: HistorySpec;
  series: string;
  fresh: boolean;
  waiters: Set<Waiter>;
  state: 'queued' | 'running' | 'done';
  abort: AbortController;
}

export function createHistoryService(ctx: MainContext): HistoryService {
  const results = new TtlCache<Bar[]>();
  const failures = new Map<string, { error: Error; until: number }>();
  /** Queued and running jobs by result key (concurrent callers share one). */
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  /** The latest job of each slot. */
  const slots = new Map<string, Job>();
  let running = 0;
  let pausedUntil = 0;
  let backoffMs = BACKOFF_START_MS;
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // IB

  const fetchBars = (job: Job, duration: string): Promise<Bar[]> => {
    const { req, spec } = job;
    const rows: Bar[] = [];
    return ibRequest<Bar[]>(ctx, {
      label: `Historical data for ${contractLabel(req.contract)} (${req.timeframe})`,
      timeoutMs: HISTORY_TIMEOUT_MS,
      timeoutFromWrite: OUT_MSG_ID.REQ_HISTORICAL_DATA,
      signal: job.abort.signal,
      send: (api, reqId) =>
        api.reqHistoricalData(reqId, toIbContract(req.contract), '', duration, spec.barSize as BarSizeSetting, spec.whatToShow as IbWhatToShow, spec.useRTH, 2, false),
      cancel: (api, reqId) => api.cancelHistoricalData(reqId),
      events: {
        [EventName.historicalData]: (args, ctl) => {
          const [time, open, high, low, close, volume] = args as [string, number, number, number, number, number | undefined];
          // The library ends the data set with a "finished-<start>-<end>" marker row.
          if (String(time).startsWith('finished')) {
            const bars = normalizeBars(rows);
            ctl.resolve(spec.toDays ? barsToDays(bars) : bars);
            return;
          }
          const t = parseBarTime(String(time));
          if (!Number.isFinite(t)) return;
          rows.push({ time: t, open, high, low, close, volume: volume != null && volume > 0 ? volume : 0 });
        },
      },
      onError: (e, ctl) => {
        // 162 "HMDS query returned no data" is an empty result, not a failure.
        if (e.code === 162 && /returned no data/i.test(e.message)) {
          ctl.resolve([]);
          return true;
        }
        return false;
      },
    });
  };

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason as Error);
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

  /** Fetches with one retry after a pacing violation (all requests pause, exponential backoff). */
  const fetchPaced = async (job: Job, duration: string): Promise<Bar[]> => {
    try {
      const bars = await fetchBars(job, duration);
      backoffMs = BACKOFF_START_MS;
      return bars;
    } catch (err) {
      if (!isPacingViolation(err)) throw err;
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      console.warn(`[history] pacing violation, pausing historical requests for ${wait / 1000} s`);
      await sleep(Math.max(0, pausedUntil - Date.now()), job.abort.signal);
      const bars = await fetchBars(job, duration);
      backoffMs = BACKOFF_START_MS;
      return bars;
    }
  };

  // ---------------------------------------------------------------------------
  // Bar cache

  const readStored = async (job: Job, fromSec: number): Promise<{ stored: Bar[]; meta: SeriesMeta | undefined }> => {
    const db = ctx.db;
    if (!db) return { stored: [], meta: undefined };
    try {
      const [stored, row] = await Promise.all([db.bars.get(job.series, fromSec), db.kv.get<SeriesMeta>(META_NS, job.series)]);
      const period = seriesPeriod(job.spec.seriesBarSize);
      return { stored: period ? dedupePeriods(stored, period) : stored, meta: row?.value };
    } catch (err) {
      console.warn('[history] bar cache unavailable:', err);
      return { stored: [], meta: undefined };
    }
  };

  const store = (job: Job, bars: Bar[], meta: SeriesMeta) => {
    const db = ctx.db;
    if (!db) return;
    if (bars.length) void db.bars.put(job.series, bars, { intraday: job.spec.intraday });
    void db.kv.set(META_NS, job.series, meta);
  };

  /** The timeframe's bars from the series' bars. */
  const present = (job: Job, bars: Bar[]): Bar[] => (job.spec.aggregate ? aggregateBars(bars, job.spec.aggregate) : bars);

  const load = async (job: Job): Promise<Bar[]> => {
    const now = Date.now();
    const { stored, meta } = await readStored(job, windowStartSec(job.spec.duration, now));
    job.abort.signal.throwIfAborted();
    const plan = planFetch({ spec: job.spec, contract: job.req.contract, stored, meta, nowMs: now, ttlMs: historyTtlMs(job.req.timeframe), fresh: job.fresh });
    if (plan.kind === 'none') return present(job, stored);
    if (!isIbConnected(ctx)) {
      // Offline: what is stored is better than nothing.
      if (stored.length) return present(job, stored);
      throw new Error(NOT_CONNECTED);
    }
    if (plan.kind === 'tail') {
      const tail = await fetchPaced(job, plan.duration);
      if (!historyAdjusted(stored, tail)) {
        store(job, tail, { first: meta?.first, fetchedAt: Date.now() });
        return present(job, mergeTail(stored, tail, job.spec.seriesBarSize));
      }
      // IB adjusted the history (a split): the whole window is loaded again.
    }
    const bars = await fetchPaced(job, job.spec.duration);
    if (bars.length) store(job, bars, { first: bars[0].time, fetchedAt: Date.now() });
    return present(job, bars);
  };

  // ---------------------------------------------------------------------------
  // Scheduling

  const settle = (job: Job, outcome: { bars: Bar[] } | { error: Error }) => {
    job.state = 'done';
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    const waiters = [...job.waiters];
    job.waiters.clear();
    for (const w of waiters) {
      if (w.slot && slots.get(w.slot) === job) slots.delete(w.slot);
      if ('bars' in outcome) w.resolve(outcome.bars);
      else w.reject(outcome.error);
    }
  };

  const pump = () => {
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = null;
    const wait = pausedUntil - Date.now();
    if (wait > 0 && queue.length) {
      pumpTimer = setTimeout(pump, wait);
      return;
    }
    while (running < MAX_CONCURRENT && queue.length) start(queue.shift()!);
  };

  const start = (job: Job) => {
    running++;
    job.state = 'running';
    load(job)
      .then(
        (bars) => {
          results.set(job.key, bars, historyTtlMs(job.req.timeframe));
          failures.delete(job.key);
          settle(job, { bars });
        },
        (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          if (isFinal(error)) failures.set(job.key, { error, until: Date.now() + FAILURE_TTL_MS });
          settle(job, { error });
        },
      )
      .finally(() => {
        running--;
        pump();
      });
  };

  /** Stops a job nobody waits for: unqueued, or cancelled at IB when it is running. */
  const drop = (job: Job, error: Error) => {
    if (job.state === 'done') return;
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    if (job.state === 'queued') {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      settle(job, { error });
    } else {
      job.abort.abort(error);
    }
  };

  const enqueue = (job: Job) => {
    queue.push(job);
    while (queue.length > MAX_QUEUED) drop(queue[0], new Error('Too many historical data requests are waiting; this one was dropped'));
    pump();
  };

  /** Makes `job` (or a cache answer, null) the latest of `slot`; the slot's older waiters are superseded. */
  const claimSlot = (slot: string | undefined, job: Job | null) => {
    if (!slot) return;
    const prev = slots.get(slot);
    if (job) slots.set(slot, job);
    else slots.delete(slot);
    if (!prev || prev === job || prev.state === 'done') return;
    const error = new SupersededError();
    for (const w of [...prev.waiters]) {
      if (w.slot !== slot) continue;
      prev.waiters.delete(w);
      w.reject(error);
    }
    if (!prev.waiters.size) drop(prev, error);
  };

  return {
    async get(req: HistoryRequest): Promise<Bar[]> {
      if (!req?.contract?.symbol || !isTimeframe(req.timeframe)) throw new Error('Invalid history request');
      if (ctx.demo) {
        return demoMarket().bars(req.contract, req.timeframe, { outsideRth: req.outsideRth, whatToShow: req.whatToShow });
      }
      const ckey = contractKey(req.contract);
      const key = historyKey(req, ckey);
      const slot = typeof req.slot === 'string' && req.slot ? req.slot : undefined;
      const fresh = req.fresh === true;
      if (!fresh) {
        const hit = results.peek(key);
        if (hit) {
          claimSlot(slot, null);
          return hit;
        }
        const failed = failures.get(key);
        if (failed && failed.until > Date.now()) {
          claimSlot(slot, null);
          throw failed.error;
        }
      }
      return new Promise<Bar[]>((resolve, reject) => {
        const waiter: Waiter = { slot, resolve, reject };
        let job = jobs.get(key);
        if (job && fresh && job.state === 'queued') job.fresh = true;
        if (!job) {
          const spec = historySpec(req);
          job = { key, req, spec, series: seriesKey(spec, ckey), fresh, waiters: new Set(), state: 'queued', abort: new AbortController() };
          jobs.set(key, job);
          job.waiters.add(waiter);
          claimSlot(slot, job);
          enqueue(job);
        } else {
          job.waiters.add(waiter);
          claimSlot(slot, job);
        }
      });
    },
  };
}
