// Data hooks of the dashboard widgets: the quotes they read beyond the positions' own (option
// underlyings, the holdings' dividends, SPY and QQQ), the holdings' earnings and the
// benchmark bars. Each hook subscribes only while its widget is on the layout (`active`), under
// its own quote owner, so the main process unions it with the portfolio's lines:
//   dashboard-und    option underlyings (moneyness, dollar delta) — basic
//   dashboard-div    the holdings' stocks — 'dividends' (generic tick 456, live lines only)
//   dashboard-bench  SPY and QQQ — basic
// The benchmark bars are 5-minute or hourly ones for a recent start, else daily.

import { useEffect, useMemo, useState } from 'react';
import { contractKey, stock } from '@shared/contract';
import { nyDayStart } from '@shared/session';
import { barSeconds } from '@shared/timeframes';
import type { Bar, ContractRef, CorporateEarnings, HistoryRequest, NavPoint, Quote, QuoteDividends } from '@shared/types';
import { lastPrice, useMarketDataAvailable, useQuoteSubscriptions, useQuotesByKey } from '../../../hooks/useQuotes';
import { useStore } from '../../../state/store';
import { rangeReturn, sliceRange, underlyingOf, type PositionRow, type RangeKey } from '../calc';
import { useNavSeries } from '../EquityCard';
import { usePortfolioUi } from '../uiState';
import { barsCover, benchmarkReturn, benchmarkRows, holdingUnderlyings, intradayCovers, intradayTimeframe, type BenchmarkBars, type BenchmarkRow } from './model';

const NONE: ContractRef[] = [];
const HOUR = 3_600_000;
/** How soon earnings are asked again while main's scanner is still looking dates up. */
const PENDING_POLL_MS = 3000;
const UNAVAILABLE: CorporateEarnings = { status: 'unavailable', events: [] };

/**
 * New York midnight of the current New York day (unix ms), re-checked every minute so the
 * "today" of the fills follows the day while the app runs.
 */
export function useNyDayStart(): number {
  const [start, setStart] = useState(() => nyDayStart(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setStart(nyDayStart(Date.now())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return start;
}

const isOptionRow = (r: PositionRow) => r.position.contract.secType === 'OPT' || r.position.contract.secType === 'FOP';

export function useHoldingUnderlyings(rows: readonly PositionRow[]): Map<string, ContractRef> {
  const sig = rows.map((r) => r.key).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => holdingUnderlyings(rows), [sig]);
}

/**
 * Quotes of the option positions (greeks, model underlying price; already subscribed by the
 * portfolio) and of their underlyings, which this hook subscribes while `active`.
 */
export function useOptionQuotes(rows: readonly PositionRow[], active = true): Record<string, Quote> {
  const sig = rows.map((r) => r.key).join(',');
  const { underlyings, keys } = useMemo(() => {
    const und = new Map<string, ContractRef>();
    const k = new Set<string>();
    for (const r of rows) {
      if (!isOptionRow(r)) continue;
      const own = contractKey(r.position.contract);
      k.add(own);
      const u = underlyingOf(r.position.contract);
      const uk = contractKey(u);
      // A futures option has no underlying of its own here (underlyingOf returns it).
      if (uk === own) continue;
      k.add(uk);
      und.set(uk, u);
    }
    return { underlyings: [...und.values()], keys: [...k] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useQuoteSubscriptions('dashboard-und', active ? underlyings : NONE, 'basic');
  return useQuotesByKey(keys);
}

/**
 * IB's dividend summary of the holdings' stocks by contract key, subscribed while `active`.
 * Undefined for a stock IB has sent none for (delayed lines carry none).
 */
export function useHoldingDividends(underlyings: ReadonlyMap<string, ContractRef>, active = true): Record<string, QuoteDividends | undefined> {
  const stocks = useMemo(() => [...underlyings.values()].filter((c) => c.secType === 'STK'), [underlyings]);
  const keys = useMemo(() => stocks.map(contractKey), [stocks]);
  useQuoteSubscriptions('dashboard-div', active ? stocks : NONE, 'dividends');
  const quotes = useQuotesByKey(keys);
  return useMemo(() => Object.fromEntries(keys.map((k) => [k, quotes[k]?.dividends])), [keys, quotes]);
}

/**
 * Upcoming earnings of the holdings' stocks (Wall Street Horizon, else estimated from IB's market
 * scanner), asked when the holdings or the connection change and every hour (main keeps the
 * answers for the day), every few seconds while the scanner is still looking dates up
 * (`pending`) and when a stock is due to be searched again (`retryInMs`). `unsubscribed` when IB
 * refuses both; `unavailable` while not connected.
 */
export function useEarnings(underlyings: ReadonlyMap<string, ContractRef>, active = true): CorporateEarnings | undefined {
  const available = useMarketDataAvailable();
  const stocks = useMemo(() => [...underlyings.values()].filter((c) => c.secType === 'STK'), [underlyings]);
  const sig = stocks.map(contractKey).sort().join(',');
  const [state, setState] = useState<{ sig: string; value: CorporateEarnings } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), HOUR);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || !available) return;
    let live = true;
    window.tape.getEarnings(stocks).then(
      (value) => live && setState({ sig, value }),
      () => live && setState({ sig, value: UNAVAILABLE }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, available, active, tick]);

  // Main answers at once with what the scanner knows so far; ask again until it is done, and
  // when a stock it could not search yet is due again.
  useEffect(() => {
    if (!active || !available || state?.sig !== sig) return;
    const { pending, retryInMs } = state.value;
    const delay = pending ? PENDING_POLL_MS : typeof retryInMs === 'number' && Number.isFinite(retryInMs) ? Math.max(PENDING_POLL_MS, retryInMs) : undefined;
    if (delay === undefined) return;
    const timer = setTimeout(() => setTick((t) => t + 1), delay);
    return () => clearTimeout(timer);
  }, [active, available, sig, state]);

  if (!available) return UNAVAILABLE;
  // Answers for a former set of holdings still apply to the stocks that remain.
  return state?.value;
}

// ---------------------------------------------------------------------------
// Benchmark

export const BENCHMARKS = ['SPY', 'QQQ'] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

const BENCH_CONTRACTS: ContractRef[] = BENCHMARKS.map((s) => stock(s));
/** Bars are reloaded after this long (the newest bar grows; the live price is used meanwhile). */
const BARS_TTL_MS = HOUR;
/** Older pages asked for an ALL range beyond the first window (2 years of daily bars). */
const MAX_OLDER_PAGES = 4;
const OLDER_PAGE_BARS = 1000;

type BenchTimeframe = '1D' | NonNullable<ReturnType<typeof intradayTimeframe>>;

const benchRequest = (sym: Benchmark, timeframe: BenchTimeframe): HistoryRequest => ({
  contract: stock(sym),
  timeframe,
  slot: `dash-bench-${sym}-${timeframe}`,
});

interface BarsEntry {
  bars: Bar[];
  at: number;
  /** Nothing older exists. */
  done: boolean;
}

/** Bars per benchmark and interval, shared by every mounted widget for the session. */
const barsCache = new Map<string, BarsEntry>();
const loading = new Map<string, Promise<void>>();
const cacheKey = (sym: Benchmark, tf: BenchTimeframe) => `${sym}|${tf}`;

/** The newest bars of one interval, reloaded after BARS_TTL_MS (older daily pages are kept). */
async function loadNewest(sym: Benchmark, tf: BenchTimeframe): Promise<BarsEntry> {
  const key = cacheKey(sym, tf);
  const prev = barsCache.get(key);
  if (prev && Date.now() - prev.at <= BARS_TTL_MS) return prev;
  const bars = await window.tape.getHistory(benchRequest(sym, tf));
  let entry: BarsEntry = { bars, at: Date.now(), done: false };
  if (prev && bars.length && prev.bars.length && prev.bars[0].time < bars[0].time) {
    entry = { ...entry, bars: [...prev.bars.filter((b) => b.time < bars[0].time), ...bars], done: prev.done };
  }
  barsCache.set(key, entry);
  return entry;
}

/**
 * Loads the bars that price a benchmark at `start`: intraday ones for a recent start, and the
 * daily bars (extended back to `start`) when those do not reach it.
 */
function loadBars(sym: Benchmark, start: number): Promise<void> {
  const tf = intradayTimeframe(start, Date.now());
  const key = `${sym}|${tf ?? '1D'}`;
  const pending = loading.get(key);
  if (pending) return pending;
  const run = async () => {
    if (tf && intradayCovers((await loadNewest(sym, tf)).bars, start)) return;
    let entry = await loadNewest(sym, '1D');
    for (let i = 0; i < MAX_OLDER_PAGES && entry.bars.length && !entry.done && !barsCover(entry.bars, start); i++) {
      const page = await window.tape.getOlderBars(benchRequest(sym, '1D'), entry.bars[0].time, OLDER_PAGE_BARS);
      entry = { ...entry, bars: [...page.bars, ...entry.bars], done: page.done || !page.bars.length };
      barsCache.set(cacheKey(sym, '1D'), entry);
    }
  };
  const p = run().finally(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

/** The cached bars that price a benchmark at `start` (see loadBars). */
function benchmarkBars(sym: Benchmark, start: number | undefined): BenchmarkBars {
  const daily = barsCache.get(cacheKey(sym, '1D'))?.bars ?? [];
  const tf = start !== undefined ? intradayTimeframe(start, Date.now()) : undefined;
  const intraday = tf ? barsCache.get(cacheKey(sym, tf))?.bars : undefined;
  return { daily, intraday: tf && intraday ? { bars: intraday, barSec: barSeconds(tf)! } : undefined };
}

export interface BenchmarkView {
  range: RangeKey;
  /** The NAV slice of the equity chart's range (its first sample is the comparison's start). */
  points: NavPoint[];
  /** The NAV history reaches back to the start of the range. */
  covered: boolean;
  rows: BenchmarkRow[];
  /** Portfolio minus SPY in percentage points. */
  vsSpy?: number;
}

/**
 * The portfolio's return over the equity chart's range (the same figure as the equity card)
 * against SPY and QQQ over the same span: live price (else the newest close) against their price
 * at the range's first NAV sample (intraday bars for a recent start, else the daily close at or
 * before it).
 */
export function useBenchmark(active = true): BenchmarkView {
  const range = usePortfolioUi((s) => s.range);
  const series = useNavSeries();
  const available = useMarketDataAvailable();
  const connected = useStore((s) => s.connection.status === 'connected');
  const slice = useMemo(() => sliceRange(series, range, Date.now()), [series, range]);
  const start = slice.points[0]?.t;
  // The bars an aging start needs change (5-minute, hourly, daily); re-checked on every render.
  const tf = start !== undefined ? intradayTimeframe(start, Date.now()) : undefined;
  const [version, setVersion] = useState(0);

  useQuoteSubscriptions('dashboard-bench', active ? BENCH_CONTRACTS : NONE, 'basic');
  const quotes = useQuotesByKey(useMemo(() => BENCH_CONTRACTS.map(contractKey), []));

  useEffect(() => {
    if (!active || !available || start === undefined) return;
    let live = true;
    for (const sym of BENCHMARKS) {
      loadBars(sym, start).then(
        () => live && setVersion((v) => v + 1),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [active, available, connected, start, tf]);

  return useMemo(() => {
    const ret = (sym: Benchmark) => benchmarkReturn(benchmarkBars(sym, start), start, lastPrice(quotes[contractKey(stock(sym))]));
    const portfolio = rangeReturn(slice.points)?.pct;
    const { rows, vsSpy } = benchmarkRows(portfolio, ret('SPY'), ret('QQQ'));
    return { range, points: slice.points, covered: slice.covered, rows, vsSpy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, slice, start, tf, quotes, version]);
}
