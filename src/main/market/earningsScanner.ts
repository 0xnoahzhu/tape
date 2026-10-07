// Next earnings dates of US stocks from IB's market scanner, for accounts without Wall Street
// Horizon (corporateEvents.ts asks WSH first and comes here when IB refuses it).
//
// The scan SCAN_nextEarningsDateTime_ASC on STK.US.MAJOR with the filter
// "nextEarningsDateTimeAbove=X;nextEarningsDateTimeBelow=Y;" (epoch seconds, inclusive) works
// without the WSH subscription, but its rows carry no date: a date is inferred from whether a
// stock is listed for a window. A search per stock narrows it down: the day (bisection over
// today .. today + HORIZON_DAYS in New York), then the time: IB stamps after-close releases
// exactly 16:00:00 ET, many pre-open ones exactly 09:30:00 ET and a date without a time 00:00:00
// ET, so those three instants are asked first; otherwise the half-hour slot and, when the release
// is at the slot's start, the exact minute. IB marks no date as confirmed, so every result is an
// estimate.
//
// A scan answers at most 50 rows, sorted by date: a stock in a cut answer is there for sure, its
// absence proves nothing. Scans are narrowed to the stock's prices as they are when the scan is
// sent (± 3 %, halved twice when an answer is cut), and a window that stays cut is split. A
// search costs 9 scans for an after-close release, 10 before the open, 11 without a time, about
// 19 with an exact time, at most MAX_SCANS_PER_SYMBOL. At most SCAN_CONCURRENCY scans are open at
// a time (IB allows 10) and each is cancelled however it ends. Results are kept per connection for
// the New York day ('none' and 'unknown' too, but one found with a narrowed band is asked once
// more after RETRY_MS: the stock's price may have moved away from Tape's); transient failures are
// tried again after RETRY_MS, and the answer says when (`retryInMs`).

import { EventName, OUT_MSG_ID, type ContractDetails, type ScannerSubscription, type TagValue } from '../ib/tws';
import { isScannerCancelAck } from '../ib/errorCodes';
import { contractKey } from '@shared/contract';
import type { ContractRef, EarningsEvent } from '@shared/types';
import type { MainContext } from '../context';
import { afterStartup, IbRequestError, ibRequest, isIbConnected, Limiter } from './ibRequest';
import { addDays, nyWallToEpochMs, parseYyyymmdd, RTH_CLOSE, RTH_OPEN, yyyymmdd, type CalendarDay } from './nyTime';

/** How far ahead a stock's next earnings are looked for (beyond: no earnings shown). */
export const HORIZON_DAYS = 120;
/** IB's most rows per scan. */
export const SCAN_ROWS = 50;
export const SCAN_CODE = 'SCAN_nextEarningsDateTime_ASC';
export const LOCATION = 'STK.US.MAJOR';
/** Counted from the write; IB answered within 2.4 s in the probes. */
export const SCAN_TIMEOUT_MS = 10_000;
/** Scans open at a time (IB allows 10 active API scans). */
export const SCAN_CONCURRENCY = 3;
export const MAX_SCANS_PER_SYMBOL = 24;
/** Price band around the stock's price: ± 3 %, halved while answers are cut, down to 0.75 %. */
export const BAND_START = 0.03;
export const BAND_MIN = 0.0075;
/** How long a stock without any price waits for its first quote. */
export const PRICE_WAIT_MS = 10_000;
export const RETRY_MS = 5 * 60_000;
/** Slots of the time-of-day search, in minutes (48 per day). */
export const SLOT_MIN = 30;

/** IB's "Historical Market Data Service query message: N items retrieved" before a scan's rows. */
const RETRIEVED_CODE = 165;

// ---------------------------------------------------------------------------
// Windows (epoch seconds, inclusive, New York wall time)

export type Window = readonly [above: number, below: number];

const ny = (day: CalendarDay, minutes: number): number => nyWallToEpochMs(day, minutes) / 1000;

/** Days i..j after `today`, midnight to midnight (23 h and 25 h days included). */
export function dayWindow(today: CalendarDay, i: number, j: number): Window {
  return [ny(addDays(today, i), 0), ny(addDays(today, j + 1), 0) - 1];
}

/** Half-hour slots i..j of `day` (slot 0 starts at midnight). */
export function slotWindow(day: CalendarDay, i: number, j: number): Window {
  return [ny(day, SLOT_MIN * i), ny(day, SLOT_MIN * (j + 1)) - 1];
}

// ---------------------------------------------------------------------------
// Requests

export interface ScanQuery {
  above: number;
  below: number;
  minPrice: number;
  maxPrice: number;
}

export interface ScanResult {
  rows: Array<{ conId: number; symbol: string }>;
  /** The answer was cut at SCAN_ROWS: stocks after the last row are missing. */
  truncated: boolean;
}

/**
 * The scan of one window and price band. Both date bounds are always sent: without them stocks
 * that report no earnings (VOO) are listed too. No market cap: Tape does not know a holding's.
 */
export function scannerRequest(q: ScanQuery): { subscription: ScannerSubscription; filter: TagValue[] } {
  return {
    subscription: {
      numberOfRows: SCAN_ROWS,
      instrument: 'STK',
      locationCode: LOCATION,
      scanCode: SCAN_CODE,
      abovePrice: q.minPrice,
      belowPrice: q.maxPrice,
      stockTypeFilter: 'ALL',
    },
    filter: [
      { tag: 'nextEarningsDateTimeAbove', value: String(q.above) },
      { tag: 'nextEarningsDateTimeBelow', value: String(q.below) },
    ],
  };
}

/**
 * IB's 165 text before a scan's rows: "…:3 items retrieved", "…:50 out of 435 items retrieved"
 * (the answer is cut: `total`) or "…:no items retrieved". Undefined for any other text.
 */
export function parseRetrieved(msg: string): { count: number; total?: number } | undefined {
  const m = /(?:^|:)\s*(no|\d+)(?:\s+out of\s+(\d+))?\s+items? retrieved/i.exec(msg);
  if (!m) return undefined;
  const count = /^no$/i.test(m[1]) ? 0 : Number(m[1]);
  return m[2] !== undefined ? { count, total: Number(m[2]) } : { count };
}

const floor2 = (v: number) => Math.floor(v * 100 + 1e-6) / 100;
const ceil2 = (v: number) => Math.ceil(v * 100 - 1e-6) / 100;

/** The price filter around the stock's prices, rounded outward to cents. */
export function priceBand(prices: readonly number[], margin: number): { minPrice: number; maxPrice: number } {
  return { minPrice: floor2(Math.min(...prices) * (1 - margin)), maxPrice: ceil2(Math.max(...prices) * (1 + margin)) };
}

// ---------------------------------------------------------------------------
// Search (pure: scans come from a function)

/** The stock's search used up its scans (MAX_SCANS_PER_SYMBOL). */
export class BudgetError extends Error {
  constructor(scans: number) {
    super(`Earnings date search stopped after ${scans} scans`);
    this.name = 'BudgetError';
  }
}

export interface ProbeResult {
  /** The stock is listed for the window: its next earnings fall in it. */
  present: boolean;
  /** Not listed, but the answer was cut even at the narrowest band: it may still be in the window. */
  truncated: boolean;
}

/** Asks whether one stock's next earnings fall in [above, below] (epoch seconds). */
export type Probe = (above: number, below: number) => Promise<ProbeResult>;

/**
 * The probe of one stock (by conId) over `scan`, its band around `prices` (read again for every
 * scan when a function). A cut answer without the stock is asked again with half the price band
 * (down to BAND_MIN); the narrower band is kept for the rest of the search (`narrowed`). Throws
 * BudgetError once `budget` scans were sent. `scans` counts them.
 */
export function makeProbe(
  scan: (q: ScanQuery) => Promise<ScanResult>,
  conId: number,
  prices: readonly number[] | (() => readonly number[]),
  budget = MAX_SCANS_PER_SYMBOL,
): Probe & { readonly scans: number; readonly narrowed: boolean } {
  let scans = 0;
  let margin = BAND_START;
  const probe: Probe = async (above, below) => {
    for (;;) {
      if (scans >= budget) throw new BudgetError(scans);
      scans++;
      const r = await scan({ above, below, ...priceBand(typeof prices === 'function' ? prices() : prices, margin) });
      const present = r.rows.some((row) => row.conId === conId);
      // Rows come by date ascending: a stock in a cut answer is in the window for sure.
      if (present || !r.truncated || margin <= BAND_MIN) return { present, truncated: !present && r.truncated };
      margin = Math.max(BAND_MIN, margin / 2);
    }
  };
  return Object.defineProperties(probe, {
    scans: { get: () => scans },
    narrowed: { get: () => margin < BAND_START },
  }) as Probe & { readonly scans: number; readonly narrowed: boolean };
}

export type Located = number | 'none' | 'unknown';

/**
 * Depth-first search over cells 0..n-1 (earliest first) for the cell holding the stock: its
 * index, 'none' when no cell holds it or 'unknown' when a cut answer could not be resolved.
 * `known`: the stock is already known to be in 0..n-1 (the whole range is not asked again).
 * A half is skipped without a scan when the other half is known to be empty.
 */
export async function locate(n: number, win: (i: number, j: number) => Window, probe: Probe, known: boolean): Promise<Located> {
  const rec = async (a: number, b: number, inRange: boolean): Promise<Located> => {
    if (!inRange) {
      const r = await probe(...win(a, b));
      if (r.present) inRange = true;
      else if (!r.truncated) return 'none';
      else if (a === b) return 'unknown';
    }
    if (a === b) return a;
    const m = (a + b) >> 1;
    const left = await rec(a, m, false);
    if (typeof left === 'number') return left;
    if (left === 'none' && inRange) return rec(m + 1, b, true);
    const right = await rec(m + 1, b, false);
    if (typeof right === 'number') return right;
    return left === 'unknown' || right === 'unknown' || inRange ? 'unknown' : 'none';
  };
  return rec(0, n - 1, known);
}

export type EarningsSearch =
  | { kind: 'found'; date: string; time?: EarningsEvent['time']; minutes?: number }
  | { kind: 'none' }
  | { kind: 'unknown' };

/**
 * A stock's next earnings within `horizonDays` of `today` (New York): the day, then 16:00:00
 * (after the close), 09:30:00 (before the open) and 00:00:00 (no time) exactly, else the half-hour
 * slot and the slot's first minute. A located day the stock is not listed for as a whole gives
 * 'unknown' (its price may have left the band): no date rather than a wrong one. Out of budget:
 * the date without a time once the day was confirmed, else 'unknown'.
 */
export async function searchEarnings(today: CalendarDay, probe: Probe, horizonDays = HORIZON_DAYS): Promise<EarningsSearch> {
  let confirmed: string | undefined;
  try {
    const d = await locate(horizonDays + 1, (i, j) => dayWindow(today, i, j), probe, false);
    if (typeof d !== 'number') return { kind: d };
    const day = addDays(today, d);
    const date = yyyymmdd(day);
    const at = async (minutes: number) => (await probe(ny(day, minutes), ny(day, minutes))).present;
    // IB's stamps for "after the close" and "before the open": no exact time.
    if (await at(RTH_CLOSE)) return { kind: 'found', date, time: 'amc' };
    if (await at(RTH_OPEN)) return { kind: 'found', date, time: 'bmo' };
    // Midnight: a date without a time (TWS shows none for it), not a release before the open.
    if (await at(0)) return { kind: 'found', date };
    if (!(await probe(ny(day, 0), ny(day, 1440) - 1)).present) return { kind: 'unknown' };
    confirmed = date;
    const s = await locate(1440 / SLOT_MIN, (i, j) => slotWindow(day, i, j), probe, true);
    if (typeof s !== 'number') return { kind: 'found', date };
    const start = SLOT_MIN * s;
    // Midnight itself was asked above.
    if (start > 0 && (await at(start))) {
      return { kind: 'found', date, minutes: start, time: start < RTH_OPEN ? 'bmo' : start >= RTH_CLOSE ? 'amc' : 'dmh' };
    }
    const end = start + SLOT_MIN;
    return { kind: 'found', date, time: end <= RTH_OPEN ? 'bmo' : start >= RTH_CLOSE ? 'amc' : 'dmh' };
  } catch (err) {
    if (!(err instanceof BudgetError)) throw err;
    return confirmed ? { kind: 'found', date: confirmed } : { kind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// IB

/**
 * One scan: its rows, then IB's subscription is cancelled (however the request ends). 165
 * ("N items retrieved", 0–1.3 s before the rows, sometimes missing) tells whether the answer was
 * cut; without it 50 rows count as cut. IB's 162 acknowledging the cancel is harmless; any other
 * error rejects.
 */
export function requestScan(ctx: MainContext, q: ScanQuery): Promise<ScanResult> {
  const { subscription, filter } = scannerRequest(q);
  const rows: ScanResult['rows'] = [];
  let retrieved: ReturnType<typeof parseRetrieved>;
  return ibRequest<ScanResult>(ctx, {
    label: 'Earnings date scan',
    timeoutMs: SCAN_TIMEOUT_MS,
    timeoutFromWrite: OUT_MSG_ID.REQ_SCANNER_SUBSCRIPTION,
    cancelWhenDone: true,
    send: (api, reqId) => api.reqScannerSubscription(reqId, subscription, [], filter),
    cancel: (api, reqId) => api.cancelScannerSubscription(reqId),
    events: {
      [EventName.scannerData]: (args) => {
        const c = (args[1] as ContractDetails | undefined)?.contract;
        if (c?.conId) rows.push({ conId: c.conId, symbol: c.symbol ?? '' });
      },
      [EventName.scannerDataEnd]: (_args, ctl) => {
        // "50 out of 435 items retrieved": cut. Without a 165, a full page counts as cut.
        ctl.resolve({ rows, truncated: retrieved ? retrieved.total !== undefined : rows.length >= SCAN_ROWS });
      },
    },
    onError: (e) => {
      if (e.code === RETRIEVED_CODE) {
        retrieved = parseRetrieved(e.message);
        return true;
      }
      return isScannerCancelAck(e.code, e.message);
    },
  });
}

/**
 * IB refusing the scanner itself (162 other than pacing or a limit, 321 "Error validating
 * request"): not asked again on this connection for the New York day.
 */
export const isScannerRefusal = (err: unknown): boolean =>
  err instanceof IbRequestError && ((err.code === 162 && !/pacing|limit|max/i.test(err.message)) || err.code === 321);

export interface ScannerLookup {
  /** Estimated earnings of the stocks searched today. */
  events: EarningsEvent[];
  /** Some stocks are still being searched: ask again shortly. */
  pending: boolean;
  /** IB refused the scanner on this connection today. */
  refused: boolean;
  /** Stocks with an answer for today. */
  answered: number;
  /** Stocks the scanner cannot look up (not US dollar ones): not searched, no answer. */
  uncovered: number;
  /** Some stocks wait to be searched again (a timeout, an IB error, no price): ask again after this many ms. */
  retryInMs?: number;
}

export interface EarningsScanner {
  /**
   * What is known for `stocks` today (YYYYMMDD, New York); starts the searches still missing.
   * Never waits for IB.
   */
  lookup(stocks: readonly ContractRef[], today: string): ScannerLookup;
}

type Found = Omit<Extract<EarningsSearch, { kind: 'found' }>, 'kind'>;

export function createEarningsScanner(ctx: MainContext): EarningsScanner {
  /** Per contract key for one New York day; `found` undefined: none within the horizon, or unknown. */
  const results = new Map<string, { day: string; found?: Found }>();
  /** Epoch ms before which a stock is not searched again (a timeout, an IB error, no price). */
  const retryAt = new Map<string, number>();
  /** The New York day a stock's 'none' or 'unknown' with a narrowed band was asked once more. */
  const rechecked = new Map<string, string>();
  const running = new Map<string, Promise<void>>();
  const limiter = new Limiter(SCAN_CONCURRENCY);
  /** Bumped when the connection closes: searches of an older connection stop and keep nothing. */
  let generation = 0;
  /** The New York day IB refused the scanner on this connection. */
  let refusedDay: string | null = null;
  let warned = false;

  // Per connection: a 1101 (data lost, ready again) keeps the results.
  afterStartup(() =>
    ctx.ib.onClosed(() => {
      generation++;
      results.clear();
      retryAt.clear();
      rechecked.clear();
      running.clear();
      refusedDay = null;
      warned = false;
    }),
  );

  /** The stock's prices Tape knows: its quote (last, close, mark, last RTH trade) and its position's. */
  function pricesOf(key: string): number[] {
    const q = ctx.quotes.getQuote(key);
    const values = [q?.last, q?.close, q?.mark, q?.lastRthTrade];
    for (const p of ctx.account.getPositions()) if (p.key === key && p.contract.secType === 'STK') values.push(p.marketPrice);
    return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  }

  /** Waits up to PRICE_WAIT_MS for a quote with a price (the Positions tab's 'positions-div' line). */
  function waitForPrice(key: string): Promise<number[]> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve(pricesOf(key));
      };
      const timer = setTimeout(done, PRICE_WAIT_MS);
      const off = ctx.quotes.onQuote((q) => {
        if (q.key === key && pricesOf(key).length) done();
      });
    });
  }

  function start(key: string, und: ContractRef, today: string): void {
    const gen = generation;
    const scan = (q: ScanQuery): Promise<ScanResult> =>
      gen === generation ? requestScan(ctx, q) : Promise.reject(new Error('Earnings date scan: connection closed'));
    // Started in a microtask, so `running` holds the search before it can end.
    const run = Promise.resolve().then(async () => {
      try {
        const info = await ctx.contracts.getInfo(und);
        if (gen !== generation) return;
        const conId = info?.contract.conId;
        if (!conId || info.stockType === 'ETF') {
          results.set(key, { day: today });
          return;
        }
        let prices = pricesOf(key);
        if (!prices.length) prices = await waitForPrice(key);
        if (gen !== generation) return;
        if (!prices.length) {
          retryAt.set(key, Date.now() + RETRY_MS);
          return;
        }
        // The band follows the prices at each scan: a search may wait minutes for its turn.
        const probe = makeProbe(scan, conId, () => {
          const now = pricesOf(key);
          return now.length ? now : prices;
        });
        // One scan at a time per stock, so the limiter bounds the open scans.
        const res = await limiter.run(async () => (gen !== generation || refusedDay === today ? null : searchEarnings(parseYyyymmdd(today), probe)));
        if (gen !== generation || !res) return;
        // A narrowed band misses a stock whose price moved away from Tape's: no date found is
        // asked once more before it holds for the day.
        if (res.kind !== 'found' && probe.narrowed && rechecked.get(key) !== today) {
          rechecked.set(key, today);
          retryAt.set(key, Date.now() + RETRY_MS);
          return;
        }
        let found: Found | undefined;
        if (res.kind === 'found') {
          found = { date: res.date };
          if (res.time) found.time = res.time;
          if (res.minutes !== undefined) found.minutes = res.minutes;
        }
        results.set(key, found ? { day: today, found } : { day: today });
      } catch (err) {
        if (gen !== generation) return;
        if (isScannerRefusal(err)) {
          refusedDay = today;
          if (!warned) console.warn('[earnings] IB refused the market scanner:', (err as Error).message);
          warned = true;
        } else {
          retryAt.set(key, Date.now() + RETRY_MS);
        }
      } finally {
        if (gen === generation) running.delete(key);
      }
    });
    running.set(key, run);
  }

  return {
    lookup(stocks, today) {
      const events: EarningsEvent[] = [];
      let pending = false;
      let answered = 0;
      let uncovered = 0;
      let retryIn = Infinity;
      const now = Date.now();
      for (const und of stocks) {
        const key = contractKey(und);
        // STK.US.MAJOR lists US dollar stocks only.
        if (und.currency !== 'USD') {
          uncovered++;
          continue;
        }
        const hit = results.get(key);
        if (hit?.day === today) {
          answered++;
          if (hit.found && hit.found.date >= today) events.push({ key, ...hit.found, estimated: true });
          continue;
        }
        if (running.has(key)) {
          pending = true;
          continue;
        }
        if (refusedDay === today || !isIbConnected(ctx)) continue;
        const retry = retryAt.get(key) ?? 0;
        if (retry > now) {
          retryIn = Math.min(retryIn, retry - now);
          continue;
        }
        start(key, und, today);
        pending = true;
      }
      return { events, pending, refused: refusedDay === today, answered, uncovered, ...(retryIn < Infinity ? { retryInMs: retryIn } : {}) };
    },
  };
}
