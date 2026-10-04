// Historical bars (reqHistoricalData) per timeframe, kept in the bar cache so charts open from
// disk and scroll back in time. Demo mode synthesizes bars that end at the simulated price.
//
// Cache. Every series (contract + bar size + whatToShow + useRTH) is stored in ctx.db.bars, and
// its coverage, the time ranges whose bars are known to be complete because IB was asked for
// them, in ctx.db.kv (namespace 'coverage'; coverage.ts, and historyPages.ts for what an answer
// proves). Intraday coverage is limited to the database's retention of the series' bars (by bar
// size: seconds, minutes, hours; from 00:00 New York after the retention minus a day). 45-second
// bars are the 15-second series merged, quarters (like years) the monthly series merged. The
// database also evicts whole series (not
// used for months, or over its size cap) with their coverage, and can be cleared; the service
// then drops its in-memory copy of their coverage (watchEvictions), so they are fetched again,
// and a load that read bars and coverage across the eviction does not trust that coverage.
//
// Newest bars, get(req):
// - cold (the newest covered range does not reach the window start): the window is fetched;
// - loaded within the TTL (10 s for seconds bars, 30 s for other intraday bars, 5 min otherwise, but not across a session's open,
//   close or settling) or settled (US bars loaded after the last close, until the next
//   session): answered from the cache without asking IB;
// - otherwise the tail since the second-newest stored bar is fetched and merged. When a whole
//   bar of the timeframe has started since the last load (newestBarsStale: a new intraday bar,
//   a new session for daily bars, a new week / month), or the regular session has closed since
//   (its daily bar became final), the answer waits for the tail. Otherwise only the forming bar
//   can have moved: the cache answers at once and the tail is refreshed in the background (the
//   next load returns it);
// - `fresh` always waits for the tail. A tail that disagrees with the stored bars (a split)
//   reloads the window and drops the older coverage.
//
// Older bars, getOlder(req, before, limit): the cache answers when the covered range below
// `before` holds `limit` bars or reaches IB's head timestamp. Otherwise IB is asked for the next
// chunk back (endDateTime = the start of the covered range, on the bar grid; a duration sized to
// about the missing bars), the answer is stored and claimed, and the page is read from the cache
// again; at most MAX_PAGE_REQUESTS requests per call. done: the head timestamp (reqHeadTimestamp,
// cached for a month) is reached, or IB has nothing and no head timestamp, or (limited) a page of
// bars of 30 seconds or less would reach back beyond six months (IB's documented limit for them:
// not enforced on every account, but paging that far is not worth IB's request budget). Seconds
// windows ('N S') count session time at IB, so the newest window ends at the newest stored bar
// rather than now (a weekend shows Friday's last half hour of 1-second bars). Only IB's explicit
// "no data" answer counts as no head timestamp (remembered for a day); other errors (pacing,
// permissions, a timeout) leave it unknown for HEAD_ERROR_MS, and paging goes on without it.
//
// Scheduling. IB's wire-level rules (identical requests within 15 s, 5 per contract within 2 s,
// 60 per 10 minutes) are enforced by the send queue (ib/tws/pacing.ts). This service bounds what
// waits there: at most MAX_CONCURRENT requests are out (at most MAX_PAGE_CONCURRENT of them for
// pages) and at most MAX_QUEUED wait (beyond that the oldest of the lowest priority is dropped);
// requests for the newest bars go first, then background refreshes, then pages. Pages use at
// most PAGE_BUDGET of IB's 60 historical requests per 10 minutes, so scrolling far back never
// leaves the newest bars of the next chart waiting in IB's pacing. A newer request from the same
// slot (e.g. the chart) supersedes older ones, cancelling them at IB when already sent; a slot's
// pages are superseded by its newer pages and by a newest-bars request for another series.
// Identical requests share one load (pages are remembered for 15 s). A 162 pacing
// violation pauses all requests (exponential backoff from 10 s) and retries a bar request once;
// other 162 errors are final and remembered for 30 s.

import { EventName, OUT_MSG_ID, type BarSizeSetting, type WhatToShow as IbWhatToShow } from '../ib/tws';
import { contractKey, contractLabel } from '@shared/contract';
import { isSmallBarSize, SECONDS_HISTORY_DAYS } from '@shared/timeframes';
import type { Bar, ContractRef, HistoryPage, HistoryRequest } from '@shared/types';
import type { HistoryService, MainContext } from '../context';
import { HOURS_RETENTION_DAYS, INTRADAY_RETENTION_DAYS, SECONDS_RETENTION_DAYS } from '../db/types';
import { addRange, clipRanges, normalizeRanges, parseCoverage, rangeBefore, type Range, type SeriesCoverage } from './coverage';
import { demoMarket } from './demo';
import { toIbContract } from './ibContract';
import { ibRequest, IbRequestError, isIbConnected, NOT_CONNECTED, TtlCache } from './ibRequest';
import {
  aggregateBars,
  BAR_SIZE_SEC,
  barsToDays,
  dedupePeriods,
  historyAdjusted,
  historyKey,
  historySpec,
  historyTtlMs,
  isTimeframe,
  mergeIntraday,
  mergeTail,
  normalizeBars,
  overlapAdjusted,
  parseBarTime,
  planFetch,
  seriesKey,
  seriesPeriod,
  windowStartSec,
  type HistorySpec,
} from './historyParams';
import {
  alignUp,
  claimStart,
  durationUnits,
  expectedBars,
  headStamp,
  ibEndDateTime,
  intradayCoverageStart,
  MIN_DENSITY,
  newestBarsStale,
  pageBound,
  pageDuration,
  pageEnd,
  periodStart,
} from './historyPages';

/** Response timeout, counted from the moment the request is written (it may wait for pacing). */
const HISTORY_TIMEOUT_MS = 20_000;
const HEAD_TIMEOUT_MS = 15_000;
/** IB paces historical requests; more than a handful in flight risks pacing violations. */
const MAX_CONCURRENT = 5;
/** Pages are fetched while scrolling, one after the other; they never take every slot. */
const MAX_PAGE_CONCURRENT = 2;
/**
 * Page requests (reqHistoricalData) within PAGE_BUDGET_WINDOW_MS. IB allows 60 historical
 * requests per 10 minutes; the rest stay for the newest bars.
 */
export const PAGE_BUDGET = 40;
export const PAGE_BUDGET_WINDOW_MS = 600_000;
/** Requests waiting beyond the ones in flight; past this the oldest of the lowest priority is dropped. */
export const MAX_QUEUED = 20;
export const BACKOFF_START_MS = 10_000;
const BACKOFF_MAX_MS = 160_000;
/** Final errors are answered from memory this long, so a view does not repeat a doomed request. */
const FAILURE_TTL_MS = 30_000;
/** An identical page request within this time is answered from memory (IB refuses identical requests within 15 s). */
export const PAGE_TTL_MS = 15_000;
/** IB requests one getOlder call may make (more when a chunk had no trades, e.g. options). */
export const MAX_PAGE_REQUESTS = 3;
const MAX_PAGE_LIMIT = 5_000;
/** kv namespace of the coverage documents (by series) and head timestamps ('head|…'). */
export const COVERAGE_NS = 'coverage';
/** Head timestamps are asked again after a month; IB's "none" after a day. */
const HEAD_TTL_MS = 30 * 86_400_000;
const HEAD_RETRY_MS = 86_400_000;
/** A head timestamp request that failed otherwise (pacing, permissions, timeout) is not repeated for this long. */
export const HEAD_ERROR_MS = 60_000;
const MAX_MEMORY_DOCS = 500;
/**
 * Days of intraday bars the cache serves: the retention of the series' class minus a day (the
 * next maintenance may run at any time).
 */
const COVERAGE_DAYS = { seconds: SECONDS_RETENTION_DAYS - 1, minutes: INTRADAY_RETENTION_DAYS - 1, hours: HOURS_RETENTION_DAYS - 1 } as const;
const DAY_MS = 86_400_000;
/** An 'N S' window (bars below a minute). */
const isSecondsWindow = (duration: string) => /^\d+ S$/.test(duration.trim());

const Priority = { Newest: 0, Refresh: 1, Page: 2 } as const;
type Priority = (typeof Priority)[keyof typeof Priority];

export class SupersededError extends Error {
  constructor() {
    super('Historical data request superseded by a newer one');
    this.name = 'SupersededError';
  }
}

const isPacingViolation = (err: unknown) => err instanceof IbRequestError && err.code === 162 && /pacing violation/i.test(err.message);
/**
 * IB's answer that it has no data to tell a head timestamp from (live: 162 "No historical market
 * data for EUR/CASH@IDEALPRO Last 0" for TRADES of a currency pair).
 */
const isNoHead = (err: unknown) => err instanceof IbRequestError && err.code === 162 && /no head time ?stamp|no historical market data|returned no data/i.test(err.message);
/** IB's answer will not change when asked again: no security definition, no data of this type, invalid request. */
const isFinal = (err: unknown) => err instanceof IbRequestError && !isPacingViolation(err);
const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));
const abortReason = (signal: AbortSignal) => toError(signal.reason ?? 'aborted');

interface Waiter<T> {
  slot?: string;
  resolve(value: T): void;
  reject(err: Error): void;
}

interface Job<T = unknown> {
  key: string;
  series: string;
  waiters: Set<Waiter<T>>;
  done: boolean;
  /** The waiters were answered from the cache; the job goes on refreshing the tail. */
  answered: boolean;
  abort: AbortController;
  /** Removes the job from its map of running jobs. */
  forget(): void;
}

interface Ticket {
  priority: Priority;
  seq: number;
  /** Page budget the request takes: 1 for a page's reqHistoricalData, 0 for anything else. */
  cost: number;
  grant(): void;
  fail(err: Error): void;
}

/** Slot of a view's pages ('chart' → 'chart#page'). */
const pageSlot = (slot: string) => `${slot}#page`;

export function createHistoryService(ctx: MainContext): HistoryService {
  /** Newest bars by request, with the time they were loaded. */
  const results = new TtlCache<{ bars: Bar[]; at: number }>();
  const pages = new TtlCache<HistoryPage>();
  const failures = new Map<string, { error: Error; until: number }>();
  const newestJobs = new Map<string, Job<Bar[]>>();
  const pageJobs = new Map<string, Job<HistoryPage>>();
  /** The latest job of each slot. */
  const slots = new Map<string, Job>();
  /** Coverage documents by series (the in-memory copy is the one that is updated). */
  const coverages = new Map<string, SeriesCoverage>();
  /** Coverage reads in flight; `evicted` when the series was evicted meanwhile (what is read may predate it). */
  const coverageLoads = new Map<string, { promise: Promise<SeriesCoverage>; evicted: boolean }>();
  /** Reads pairing a series' stored bars with its coverage, in flight; `evicted` as above. */
  const pairedReads = new Set<{ series: string; evicted: boolean }>();
  const heads = new Map<string, { head: number | null; at: number }>();
  /** Head timestamps IB could not tell just now (pacing, permissions, timeout), by key: until when they are not asked again. */
  const headErrors = new Map<string, number>();
  /** Share of the expected bars each series' page answers had (sparse options), to size the next request. */
  const densities = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // IB request permits

  const waiting: Ticket[] = [];
  let active = 0;
  let activePages = 0;
  let ticketSeq = 0;
  let pausedUntil = 0;
  let backoffMs = BACKOFF_START_MS;
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** Times page requests were let out within the budget window, one entry per unit of cost. */
  const pageSpent: number[] = [];

  /** Milliseconds until a page request of `cost` fits the page budget (0: now). */
  const budgetWait = (cost: number, now: number): number => {
    while (pageSpent.length && now - pageSpent[0] >= PAGE_BUDGET_WINDOW_MS) pageSpent.shift();
    const excess = pageSpent.length + cost - PAGE_BUDGET;
    return excess > 0 ? pageSpent[Math.min(excess, pageSpent.length) - 1] + PAGE_BUDGET_WINDOW_MS - now : 0;
  };
  const spend = (cost: number) => {
    const now = Date.now();
    for (let i = 0; i < cost; i++) pageSpent.push(now);
  };

  const pump = () => {
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = null;
    if (!waiting.length) return;
    const now = Date.now();
    if (pausedUntil > now) {
      pumpTimer = setTimeout(pump, pausedUntil - now);
      return;
    }
    let wake = Infinity;
    for (let i = 0; i < waiting.length && active < MAX_CONCURRENT; ) {
      const t = waiting[i];
      if (t.priority === Priority.Page) {
        if (activePages >= MAX_PAGE_CONCURRENT) {
          i++;
          continue;
        }
        const wait = budgetWait(t.cost, now);
        if (wait > 0) {
          wake = Math.min(wake, wait);
          i++;
          continue;
        }
      }
      waiting.splice(i, 1);
      t.grant();
    }
    if (wake < Infinity) pumpTimer = setTimeout(pump, wake);
  };

  /** Waits for a request slot (by priority, then first come); resolves with its release. */
  const acquire = (priority: Priority, signal: AbortSignal, cost = 0): Promise<() => void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortReason(signal));
      const page = priority === Priority.Page;
      const onAbort = () => {
        const i = waiting.indexOf(ticket);
        if (i >= 0) waiting.splice(i, 1);
        reject(abortReason(signal));
      };
      const ticket: Ticket = {
        priority,
        seq: ++ticketSeq,
        cost,
        grant() {
          signal.removeEventListener('abort', onAbort);
          active++;
          if (page) activePages++;
          spend(cost);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            if (page) activePages--;
            pump();
          });
        },
        fail(err) {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      let i = waiting.length;
      while (i > 0 && waiting[i - 1].priority > priority) i--;
      waiting.splice(i, 0, ticket);
      while (waiting.length > MAX_QUEUED) {
        const lowest = waiting[waiting.length - 1].priority;
        const [dropped] = waiting.splice(
          waiting.findIndex((t) => t.priority === lowest),
          1,
        );
        dropped.fail(new Error('Too many historical data requests are waiting; this one was dropped'));
      }
      pump();
    });

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(abortReason(signal));
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

  // ---------------------------------------------------------------------------
  // IB

  /** One reqHistoricalData; IB's "no data" is an empty answer. Bars are in series form (days built for options). */
  const requestBars = (job: Job, spec: HistorySpec, contract: ContractRef, duration: string, end: string): Promise<Bar[]> => {
    const rows: Bar[] = [];
    return ibRequest<Bar[]>(ctx, {
      label: `Historical data for ${contractLabel(contract)} (${spec.barSize}, ${duration}${end ? ` to ${end}` : ''})`,
      timeoutMs: HISTORY_TIMEOUT_MS,
      timeoutFromWrite: OUT_MSG_ID.REQ_HISTORICAL_DATA,
      signal: job.abort.signal,
      send: (api, reqId) =>
        api.reqHistoricalData(reqId, toIbContract(contract), end, duration, spec.barSize as BarSizeSetting, spec.whatToShow as IbWhatToShow, spec.useRTH, 2, false),
      cancel: (api, reqId) => api.cancelHistoricalData(reqId),
      events: {
        [EventName.historicalData]: (args, ctl) => {
          const [time, open, high, low, close, volume] = args as [string, number, number, number, number, number | undefined];
          // The client ends the data set with a "finished-<start>-<end>" marker row.
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
        // 162 "HMDS query returned no data" is an empty answer (options: no trades in the window).
        if (e.code === 162 && /returned no data/i.test(e.message)) {
          ctl.resolve([]);
          return true;
        }
        return false;
      },
    });
  };

  /** After a pacing violation every request pauses (exponential backoff from BACKOFF_START_MS). */
  const pauseForPacing = () => {
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    pausedUntil = Math.max(pausedUntil, Date.now() + wait);
    console.warn(`[history] pacing violation, pausing historical requests for ${wait / 1000} s`);
  };

  /** Fetches under a permit, with one retry after a pacing violation. */
  const fetchBars = async (job: Job, spec: HistorySpec, contract: ContractRef, duration: string, end: string, priority: Priority): Promise<Bar[]> => {
    const cost = priority === Priority.Page ? 1 : 0;
    const release = await acquire(priority, job.abort.signal, cost);
    try {
      try {
        const bars = await requestBars(job, spec, contract, duration, end);
        backoffMs = BACKOFF_START_MS;
        return bars;
      } catch (err) {
        if (!isPacingViolation(err)) throw err;
        pauseForPacing();
        await sleep(Math.max(0, pausedUntil - Date.now()), job.abort.signal);
        spend(cost);
        const bars = await requestBars(job, spec, contract, duration, end);
        backoffMs = BACKOFF_START_MS;
        return bars;
      }
    } finally {
      release();
    }
  };

  /** IB's earliest bar of the instrument (unix seconds), or null when IB has no data to tell it from. */
  const requestHead = async (job: Job, spec: HistorySpec, contract: ContractRef): Promise<number | null> => {
    let sentId: number | undefined;
    let answered = false;
    const release = await acquire(Priority.Page, job.abort.signal);
    try {
      return await ibRequest<number | null>(ctx, {
        label: `Head timestamp for ${contractLabel(contract)}`,
        timeoutMs: HEAD_TIMEOUT_MS,
        signal: job.abort.signal,
        send: (api, reqId) => {
          sentId = reqId;
          api.reqHeadTimestamp(reqId, toIbContract(contract), spec.whatToShow as IbWhatToShow, spec.useRTH === 1, 2);
        },
        cancel: (api, reqId) => api.cancelHeadTimestamp(reqId),
        events: {
          [EventName.headTimestamp]: ([ts], ctl) => {
            answered = true;
            const t = parseBarTime(String(ts));
            ctl.resolve(Number.isFinite(t) ? t : null);
          },
        },
      });
    } catch (err) {
      if (isNoHead(err)) return null;
      if (isPacingViolation(err)) pauseForPacing();
      throw err;
    } finally {
      release();
      // IB keeps an answered head timestamp request open until it is cancelled (as in IB's samples).
      if (answered && sentId !== undefined && isIbConnected(ctx)) {
        try {
          ctx.ib.api?.cancelHeadTimestamp(sentId);
        } catch {
          // the session is gone, and the request with it
        }
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Bar cache and coverage

  const remember = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_MEMORY_DOCS) map.delete(map.keys().next().value!);
  };

  const coverageOf = (series: string): Promise<SeriesCoverage> => {
    watchEvictions();
    const known = coverages.get(series);
    if (known) return Promise.resolve(known);
    let load = coverageLoads.get(series);
    if (!load) {
      const entry = { evicted: false } as { promise: Promise<SeriesCoverage>; evicted: boolean };
      entry.promise = (async () => {
        let doc: SeriesCoverage = { ranges: [] };
        try {
          const row = await ctx.db?.kv.get(COVERAGE_NS, series);
          if (row && !entry.evicted) doc = parseCoverage(row.value);
        } catch (err) {
          console.warn('[history] coverage unavailable:', err);
        }
        const updated = coverages.get(series);
        if (updated) return updated;
        remember(coverages, series, doc);
        return doc;
      })().finally(() => coverageLoads.get(series) === entry && coverageLoads.delete(series));
      coverageLoads.set(series, (load = entry));
    }
    return load.promise;
  };

  /**
   * The database evicts series (maintenance: not used for months, or over its size cap) together
   * with their coverage, or clears all market data: what is kept here about them goes too, so
   * they are fetched again instead of answered from bars that are gone. A coverage write made
   * from the dropped copy before the notice arrived (the worker evicted first) is deleted again,
   * and reads in flight are flagged (pairedRead). Head timestamps of evicted series stay in
   * memory: they are IB's answers, not claims about stored bars (a clear drops them as well).
   */
  let evictionsWatched = false;
  const watchEvictions = () => {
    if (evictionsWatched) return;
    evictionsWatched = true;
    ctx.db?.onEvicted?.((evicted) => {
      if (evicted === 'all') {
        for (const load of coverageLoads.values()) load.evicted = true;
        for (const read of pairedReads) read.evicted = true;
        coverages.clear();
        heads.clear();
        densities.clear();
        return;
      }
      const gone = new Set(evicted);
      for (const read of pairedReads) if (gone.has(read.series)) read.evicted = true;
      for (const series of evicted) {
        const load = coverageLoads.get(series);
        if (load) load.evicted = true;
        if (coverages.delete(series) || load) void ctx.db?.kv.delete(COVERAGE_NS, series);
        densities.delete(series);
      }
    });
  };

  /**
   * Runs a read of a series' stored bars and its coverage, telling whether the series was
   * evicted meanwhile. The two may then disagree: the coverage (often the in-memory copy, read
   * at once) can predate the eviction while the bars were read after it, so the coverage would
   * claim bars that are gone.
   */
  const pairedRead = async <T>(series: string, read: () => Promise<T>): Promise<{ value: T; evicted: boolean }> => {
    watchEvictions();
    const entry = { series, evicted: false };
    pairedReads.add(entry);
    try {
      const value = await read();
      return { value, evicted: entry.evicted };
    } finally {
      pairedReads.delete(entry);
    }
  };

  /** Coverage the cache can answer from: intraday bars older than their retention may be gone. */
  const usable = (spec: HistorySpec, ranges: Range[], nowMs: number): Range[] =>
    spec.retention === 'daily' ? ranges : clipRanges(ranges, intradayCoverageStart(nowMs, COVERAGE_DAYS[spec.retention], BAR_SIZE_SEC[spec.seriesBarSize]));

  /** Applies a change to a series' coverage (atomically against the in-memory copy) and persists it. */
  const updateCoverage = async (spec: HistorySpec, series: string, change: (c: SeriesCoverage) => SeriesCoverage): Promise<SeriesCoverage> => {
    const loaded = await coverageOf(series);
    const next = change(coverages.get(series) ?? loaded);
    next.ranges = usable(spec, next.ranges, Date.now());
    remember(coverages, series, next);
    void ctx.db?.kv.set(COVERAGE_NS, series, next);
    return next;
  };

  const claim = (c: SeriesCoverage, range: [number, number] | undefined): Range[] => (range && range[0] < range[1] ? addRange(c.ranges, range) : c.ranges);

  const storeBars = (spec: HistorySpec, series: string, bars: Bar[]) => {
    if (bars.length) void ctx.db?.bars.put(series, bars, { retention: spec.retention });
  };

  /** Stored bars of the series in [from, to), with stale stamps of re-stamped periods dropped. */
  const readBars = async (spec: HistorySpec, series: string, from: number, to?: number): Promise<Bar[]> => {
    try {
      const stored = (await ctx.db?.bars.get(series, from, to)) ?? [];
      const period = seriesPeriod(spec.seriesBarSize);
      return period ? dedupePeriods(stored, period) : stored;
    } catch (err) {
      console.warn('[history] bar cache unavailable:', err);
      return [];
    }
  };

  /** The timeframe's bars from the series' bars. */
  const present = (spec: HistorySpec, bars: Bar[]): Bar[] =>
    spec.aggregate ? aggregateBars(bars, spec.aggregate) : spec.mergeSec ? mergeIntraday(bars, spec.mergeSec) : bars;

  /**
   * First series time from which the presented bars of a covered range starting at `start` are
   * complete: aggregated periods (weeks, months, quarters, years of a finer series) only from a
   * period boundary, unless nothing older exists (`seriesStart`); merged buckets (45 s) always
   * from a bucket boundary.
   */
  const completeFrom = (spec: HistorySpec, start: number, seriesStart?: number): number => {
    // A window of small bars starts anywhere (IB counts session seconds), so the bucket holding
    // its first bar is partial even where the series begins.
    if (spec.mergeSec) return Math.ceil(start / spec.mergeSec) * spec.mergeSec;
    if (seriesStart !== undefined && start <= seriesStart) return start;
    if (spec.aggregate) return alignUp(start, spec.aggregate);
    return start;
  };

  /** Start of the newest-bars window; 'N S' windows end at the newest stored bar (IB counts session time). */
  const windowStartOf = async (spec: HistorySpec, series: string, nowMs: number): Promise<number> => {
    if (!isSecondsWindow(spec.duration)) return windowStartSec(spec.duration, nowMs);
    let last: number | undefined;
    try {
      last = await ctx.db?.bars.last(series);
    } catch {
      // read as a window ending now
    }
    return windowStartSec(spec.duration, nowMs, last);
  };

  // ---------------------------------------------------------------------------
  // Newest bars

  /**
   * Whether daily and longer bars loaded at `at` may still be answered within their TTL: not
   * once a session has opened, closed or settled since (newestBarsStale), e.g. bars loaded at
   * 15:58 are no answer at 16:01. Intraday bars go by the TTL (30 s) alone.
   */
  const stillCurrent = (req: HistoryRequest, spec: HistorySpec, at: number, nowMs: number) => spec.intraday || !newestBarsStale(req.timeframe, at, nowMs);

  /** The answer for the newest bars: the covered part of the window. */
  const newestAnswer = (spec: HistorySpec, bars: Bar[], c: SeriesCoverage, windowStart: number, nowMs: number): Bar[] => {
    const newest = usable(spec, c.ranges, nowMs).at(-1);
    // An 'N S' window counted from the newest bar (a full load may have brought newer ones).
    if (isSecondsWindow(spec.duration) && bars.length) windowStart = Math.min(windowStart, windowStartSec(spec.duration, nowMs, bars[bars.length - 1].time));
    const windowFrom = spec.aggregate ? periodStart(windowStart, spec.aggregate) : spec.mergeSec ? completeFrom(spec, windowStart) : windowStart;
    const from = newest ? Math.max(completeFrom(spec, newest[0], c.first), windowFrom) : windowFrom;
    return present(
      spec,
      bars.filter((b) => b.time >= from),
    );
  };

  const loadNewest = async (job: Job<Bar[]>, req: HistoryRequest, spec: HistorySpec, fresh: boolean): Promise<Bar[]> => {
    const now = Date.now();
    const windowStart = await windowStartOf(spec, job.series, now);
    const readFrom = spec.aggregate ? periodStart(windowStart, spec.aggregate) : windowStart;
    const read = await pairedRead(job.series, () => Promise.all([readBars(spec, job.series, readFrom), coverageOf(job.series)]));
    job.abort.signal.throwIfAborted();
    const stored = read.value[0];
    // Evicted while being read: nothing is known to be stored, so the window is loaded cold.
    const cov: SeriesCoverage = read.evicted ? { ranges: [] } : read.value[1];
    const ranges = usable(spec, cov.ranges, now);
    const ttlMs = cov.fetchedAt !== undefined && !stillCurrent(req, spec, cov.fetchedAt, now) ? 0 : historyTtlMs(req.timeframe);
    const plan = planFetch({ spec, contract: req.contract, coverage: { ...cov, ranges }, stored, nowMs: now, ttlMs, fresh, windowStart });
    if (plan.kind === 'none') return newestAnswer(spec, stored, cov, windowStart, now);
    if (!isIbConnected(ctx)) {
      // Offline: what is stored is better than nothing.
      if (stored.length) return newestAnswer(spec, stored, cov, windowStart, now);
      throw new Error(NOT_CONNECTED);
    }
    const nowSec = Math.floor(now / 1000);
    let priority: Priority = Priority.Newest;
    if (plan.kind === 'tail') {
      if (!fresh && !newestBarsStale(req.timeframe, cov.fetchedAt!, now)) {
        // Only the forming bar can have moved: answer now, refresh the tail in the background.
        answerEarly(job, newestAnswer(spec, stored, cov, windowStart, now));
        priority = Priority.Refresh;
      }
      const tail = await fetchBars(job, spec, req.contract, plan.duration, '', priority);
      if (!historyAdjusted(stored, tail)) {
        storeBars(spec, job.series, tail);
        const range = tail.length ? claimStart({ spec, contract: req.contract, end: nowSec, duration: plan.duration, bars: tail }) : undefined;
        const next = await updateCoverage(spec, job.series, (c) => ({ ...c, ranges: claim(c, range === undefined ? undefined : [range, nowSec]), fetchedAt: now }));
        return newestAnswer(spec, mergeTail(stored, tail, spec.seriesBarSize), next, windowStart, now);
      }
      // IB adjusted the history (a split): the window is loaded again, older coverage is dropped.
      console.warn(`[history] ${job.series}: history was adjusted, reloading`);
    }
    const bars = await fetchBars(job, spec, req.contract, spec.duration, '', priority);
    storeBars(spec, job.series, bars);
    const start = claimStart({ spec, contract: req.contract, end: nowSec, duration: spec.duration, bars });
    // A split while the chart was not opened (a full load after a long time) makes older pages stale too.
    const reset = plan.kind === 'tail' || overlapAdjusted(stored, bars);
    if (reset && plan.kind !== 'tail') console.warn(`[history] ${job.series}: history was adjusted, dropping older bars`);
    const next = await updateCoverage(spec, job.series, (c) => ({
      ranges: claim(reset ? { ranges: [] } : c, start === undefined ? undefined : [start, nowSec]),
      fetchedAt: now,
      ...(bars.length ? { first: bars[0].time } : {}),
    }));
    return newestAnswer(spec, bars, next, windowStart, now);
  };

  // ---------------------------------------------------------------------------
  // Older bars

  const headKey = (req: HistoryRequest, spec: HistorySpec) => `head|${contractKey(req.contract)}|${spec.whatToShow}|${spec.useRTH}`;
  const headFresh = (h: { head: number | null; at: number }) => Date.now() - h.at < (h.head === null ? HEAD_RETRY_MS : HEAD_TTL_MS);

  /** The cached head timestamp, without asking IB (undefined: not known yet). */
  const cachedHead = async (key: string): Promise<{ head: number | null; at: number } | undefined> => {
    const known = heads.get(key);
    if (known) return known;
    try {
      const row = await ctx.db?.kv.get<{ head: number | null }>(COVERAGE_NS, key);
      const head = row?.value?.head;
      if (row && (head === null || Number.isFinite(head))) {
        const h = { head: head ?? null, at: row.updatedAt };
        remember(heads, key, h);
        return h;
      }
    } catch {
      // asked from IB below
    }
    return undefined;
  };

  /**
   * Asks IB for the head timestamp and remembers its answer (null: IB has none). undefined when
   * IB could not tell just now (a pacing violation, missing permissions, a timeout): nothing is
   * persisted, and IB is not asked again for HEAD_ERROR_MS.
   */
  const loadHead = async (job: Job, req: HistoryRequest, spec: HistorySpec, key: string): Promise<number | null | undefined> => {
    if ((headErrors.get(key) ?? 0) > Date.now()) return undefined;
    try {
      const head = await requestHead(job, spec, req.contract);
      remember(heads, key, { head, at: Date.now() });
      void ctx.db?.kv.set(COVERAGE_NS, key, { head });
      return head;
    } catch (err) {
      if (job.abort.signal.aborted || !isIbConnected(ctx)) throw err;
      console.warn(`[history] head timestamp of ${contractLabel(req.contract)} unavailable: ${toError(err).message}`);
      remember(headErrors, key, Date.now() + HEAD_ERROR_MS);
      return undefined;
    }
  };

  const loadPage = async (job: Job<HistoryPage>, req: HistoryRequest, spec: HistorySpec, before: number, limit: number): Promise<HistoryPage> => {
    const bound = pageBound(before, spec);
    const hkey = headKey(req, spec);
    const cached = await cachedHead(hkey);
    /** IB's current head timestamp (null: IB has none; undefined: not asked yet, or IB could not tell). */
    let head = cached && headFresh(cached) ? cached.head : undefined;
    let headAsked = false;
    /** The head timestamp to go by: a stale one counts until IB is asked again. */
    const knownHead = () => (head !== undefined ? head : cached?.head);
    /** Its series time, when there is one. */
    const headAt = () => {
      const h = knownHead();
      return typeof h === 'number' ? headStamp(h, spec) : undefined;
    };
    // What this call fetched, also beyond the retention of intraday bars (where the database may
    // drop them at any time and the stored coverage does not reach): the page is built from both.
    let fetched: Bar[] = [];
    let claimed: Range[] = [];
    const period = seriesPeriod(spec.seriesBarSize);
    // IB's small bars (30 s or less) are paged back six months at most.
    const sixMonths = isSmallBarSize(BAR_SIZE_SEC[spec.seriesBarSize] ?? Infinity) ? Math.floor((Date.now() - SECONDS_HISTORY_DAYS * DAY_MS) / 1000) : undefined;
    for (let requests = 0; ; ) {
      const read = await pairedRead(job.series, async () => {
        const cov = await coverageOf(job.series);
        const range = rangeBefore(normalizeRanges([...usable(spec, cov.ranges, Date.now()), ...claimed]), bound);
        const start = range ? range[0] : bound;
        const seriesHead = headAt();
        const complete = seriesHead !== undefined && start <= seriesHead;
        const from = complete ? start : completeFrom(spec, start);
        let series: Bar[] = [];
        if (from < bound) {
          const own = fetched.filter((b) => b.time >= from && b.time < bound);
          const merged = normalizeBars([...(await readBars(spec, job.series, from, bound)), ...own]);
          series = period ? dedupePeriods(merged, period) : merged;
        }
        return { start, complete, series };
      });
      job.abort.signal.throwIfAborted();
      // Evicted while being read: the coverage may claim bars that were gone already. Read
      // again (the coverage is gone now) instead of asking IB for older bars than needed.
      if (read.evicted) continue;
      const { start, complete, series } = read.value;
      const bars = present(spec, series).filter((b) => b.time < before);
      if (bars.length >= limit) return { bars: bars.slice(bars.length - limit), done: false };
      if (complete) return { bars, done: true };
      if (sixMonths !== undefined && start <= sixMonths) return { bars, done: true, limited: true };
      if (requests >= MAX_PAGE_REQUESTS) return { bars, done: false };
      if (!isIbConnected(ctx)) {
        if (bars.length) return { bars, done: false };
        throw new Error(NOT_CONNECTED);
      }
      if (head === undefined && !headAsked) {
        headAsked = true;
        head = await loadHead(job, req, spec, hkey);
        if (typeof head === 'number' && start <= headStamp(head, spec)) continue;
      }
      const density = densities.get(job.series) ?? 1;
      const duration = pageDuration(spec, limit - bars.length, density);
      // The end is on the bar grid, so no bar comes cut; bars at or after `start` are covered already.
      const older = (await fetchBars(job, spec, req.contract, duration, ibEndDateTime(pageEnd(start, spec)), Priority.Page)).filter((b) => b.time < start);
      requests++;
      // An empty answer doubles the next request; a thin one scales it to what the series has.
      const seen = older.length / Math.max(1, expectedBars(spec, duration));
      remember(densities, job.series, Math.max(MIN_DENSITY, Math.min(1, older.length ? seen : density / 2)));
      storeBars(spec, job.series, older);
      fetched = normalizeBars([...older, ...fetched]);
      const claimFrom = claimStart({ spec, contract: req.contract, end: start, duration, bars: older, head: headAt() });
      if (claimFrom !== undefined) {
        claimed = addRange(claimed, [claimFrom, start]);
        await updateCoverage(spec, job.series, (c) => ({ ...c, ranges: claim(c, [claimFrom, start]) }));
      }
      // Nothing older: done when IB has no head timestamp, or when nothing could be claimed
      // either (no calendar start says there is more). While the head timestamp is unknown (IB
      // could not tell just now), a later call goes on.
      const known = knownHead();
      if (!older.length && (known === null || (known !== undefined && claimFrom === undefined))) return { bars, done: true };
      // An answer that proves nothing: another request would repeat it.
      if (claimFrom === undefined) return { bars, done: false };
    }
  };

  // ---------------------------------------------------------------------------
  // Jobs and slots

  /** Answers a job's waiters; `final` ends the job, otherwise it goes on (background refresh). */
  const settle = <T>(job: Job<T>, outcome: { value: T } | { error: Error }, final: boolean) => {
    if (final) {
      job.done = true;
      job.forget();
    }
    const waiters = [...job.waiters];
    job.waiters.clear();
    for (const w of waiters) {
      if (w.slot && slots.get(w.slot) === job) slots.delete(w.slot);
      if ('value' in outcome) w.resolve(outcome.value);
      else w.reject(outcome.error);
    }
  };

  function answerEarly<T>(job: Job<T>, value: T): void {
    job.answered = true;
    settle(job, { value }, false);
  }

  /** Stops a job nobody waits for: its permit request is withdrawn, or the request cancelled at IB. */
  const drop = (job: Job, error: Error) => {
    if (job.done) return;
    job.forget();
    job.abort.abort(error);
  };

  /** Makes `job` (or a cache answer, null) the latest of `slot`; the slot's older waiters are superseded. */
  const claimSlot = (slot: string | undefined, job: Job | null) => {
    if (!slot) return;
    const prev = slots.get(slot);
    if (job) slots.set(slot, job);
    else slots.delete(slot);
    if (prev && prev !== job) supersede(prev, slot);
  };

  const supersede = (prev: Job, slot: string) => {
    if (prev.done) return;
    const error = new SupersededError();
    for (const w of [...prev.waiters]) {
      if (w.slot !== slot) continue;
      prev.waiters.delete(w);
      w.reject(error);
    }
    if (slots.get(slot) === prev) slots.delete(slot);
    if (!prev.waiters.size && !prev.answered) drop(prev, error);
  };

  /** A view moved to another series: its pending pages of the old one are no longer wanted. */
  const supersedePages = (slot: string | undefined, series: string) => {
    if (!slot) return;
    const pending = slots.get(pageSlot(slot));
    if (pending && pending.series !== series) supersede(pending, pageSlot(slot));
  };

  /** Joins the running job for `key`, or starts one. */
  const run = <T>(map: Map<string, Job<T>>, key: string, series: string, slot: string | undefined, body: (job: Job<T>) => Promise<T>, onValue: (value: T) => void, onError: (key: string, err: Error, job: Job<T>) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { slot, resolve, reject };
      const running = map.get(key);
      if (running) {
        running.waiters.add(waiter);
        claimSlot(slot, running as Job);
        return;
      }
      const job: Job<T> = {
        key,
        series,
        waiters: new Set([waiter]),
        done: false,
        answered: false,
        abort: new AbortController(),
        forget: () => {
          if (map.get(key) === job) map.delete(key);
        },
      };
      map.set(key, job);
      claimSlot(slot, job as Job);
      body(job).then(
        (value) => {
          onValue(value);
          settle(job, { value }, true);
        },
        (err: unknown) => {
          const error = toError(err);
          onError(key, error, job);
          settle(job, { error }, true);
        },
      );
    });

  const failed = (key: string): Error | undefined => {
    const f = failures.get(key);
    if (!f) return undefined;
    if (f.until > Date.now()) return f.error;
    failures.delete(key);
    return undefined;
  };

  /** Remembers a final error for its key; a background refresh (nobody waiting) only logs. */
  const remembered = (key: string, error: Error, job: Job) => {
    if (job.answered) {
      if (!(error instanceof SupersededError)) console.warn(`[history] background refresh of ${job.series} failed: ${error.message}`);
      return;
    }
    if (!isFinal(error)) return;
    failures.set(key, { error, until: Date.now() + FAILURE_TTL_MS });
    if (failures.size > MAX_MEMORY_DOCS) for (const [k, f] of failures) if (f.until <= Date.now()) failures.delete(k);
  };

  const validRequest = (req: HistoryRequest) => !!req?.contract?.symbol && isTimeframe(req.timeframe);
  const slotOf = (req: HistoryRequest) => (typeof req.slot === 'string' && req.slot ? req.slot : undefined);

  return {
    async get(req: HistoryRequest): Promise<Bar[]> {
      if (!validRequest(req)) throw new Error('Invalid history request');
      if (ctx.demo) {
        const bars = demoMarket().bars(req.contract, req.timeframe, { outsideRth: req.outsideRth, whatToShow: req.whatToShow });
        // Seconds charts open with their window, as from IB; older bars come as pages.
        const spec = historySpec(req);
        if (!isSecondsWindow(spec.duration)) return bars;
        return bars.slice(-Math.ceil(durationUnits(spec.duration) / (spec.mergeSec ?? BAR_SIZE_SEC[spec.barSize] ?? 1)));
      }
      const ckey = contractKey(req.contract);
      const key = historyKey(req, ckey);
      const spec = historySpec(req);
      const series = seriesKey(spec, ckey);
      const slot = slotOf(req);
      const fresh = req.fresh === true;
      supersedePages(slot, series);
      if (!fresh) {
        const hit = results.peek(key);
        if (hit && stillCurrent(req, spec, hit.at, Date.now())) {
          claimSlot(slot, null);
          return hit.bars;
        }
        const error = failed(key);
        if (error) {
          claimSlot(slot, null);
          throw error;
        }
      }
      return run(
        newestJobs,
        fresh ? `${key}|fresh` : key,
        series,
        slot,
        (job) => loadNewest(job, req, spec, fresh),
        (bars) => {
          results.set(key, { bars, at: Date.now() }, historyTtlMs(req.timeframe));
          failures.delete(key);
        },
        (_k, err, job) => remembered(key, err, job),
      );
    },

    async getOlder(req: HistoryRequest, before: number, limit: number): Promise<HistoryPage> {
      if (!validRequest(req) || !Number.isFinite(before)) throw new Error('Invalid history request');
      const max = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(Number(limit) || 0)));
      if (ctx.demo) {
        const older = demoMarket()
          .bars(req.contract, req.timeframe, { outsideRth: req.outsideRth, whatToShow: req.whatToShow })
          .filter((b) => b.time < before);
        return { bars: older.slice(Math.max(0, older.length - max)), done: older.length <= max };
      }
      const ckey = contractKey(req.contract);
      const spec = historySpec(req);
      const series = seriesKey(spec, ckey);
      const key = `${historyKey(req, ckey)}|page|${before}|${max}`;
      const slot = slotOf(req);
      const hit = pages.peek(key);
      if (hit) {
        if (slot) claimSlot(pageSlot(slot), null);
        return hit;
      }
      const error = failed(key);
      if (error) throw error;
      return run(
        pageJobs,
        key,
        series,
        slot && pageSlot(slot),
        (job) => loadPage(job, req, spec, before, max),
        (page) => pages.set(key, page, PAGE_TTL_MS),
        remembered,
      );
    },
  };
}
