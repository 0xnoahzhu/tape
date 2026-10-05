// Data hooks of the dashboard widgets: the quotes they read beyond the positions' own (option
// underlyings, the holdings' dividends, SPY and QQQ), Wall Street Horizon earnings and the
// benchmark bars. Each hook subscribes only while its widget is on the layout (`active`), under
// its own quote owner, so the main process unions it with the portfolio's lines:
//   dashboard-und    option underlyings (moneyness, dollar delta) — basic
//   dashboard-div    the holdings' stocks — 'dividends' (generic tick 456, live lines only)
//   dashboard-bench  SPY and QQQ — basic

import { useEffect, useMemo, useState } from 'react';
import { contractKey, stock } from '@shared/contract';
import type { Bar, ContractRef, CorporateEarnings, HistoryRequest, NavPoint, Quote, QuoteDividends } from '@shared/types';
import { lastPrice, useMarketDataAvailable, useQuoteSubscriptions, useQuotesByKey } from '../../../hooks/useQuotes';
import { useStore } from '../../../state/store';
import { rangeReturn, sliceRange, underlyingOf, type PositionRow, type RangeKey } from '../calc';
import { useNavSeries } from '../EquityCard';
import { usePortfolioUi } from '../uiState';
import { barsCover, benchmarkReturn, benchmarkRows, holdingUnderlyings, type BenchmarkRow } from './model';

const NONE: ContractRef[] = [];
const HOUR = 3_600_000;
const UNAVAILABLE: CorporateEarnings = { status: 'unavailable', events: [] };

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
      k.add(contractKey(r.position.contract));
      const u = underlyingOf(r.position.contract);
      const uk = contractKey(u);
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
 * Upcoming earnings of the holdings' stocks (Wall Street Horizon), asked when the holdings or the
 * connection change and every hour (main keeps the answers for the day). `unsubscribed` without
 * the WSH subscription; `unavailable` while not connected.
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

  if (!available) return UNAVAILABLE;
  // Answers for a former set of holdings still apply to the stocks that remain.
  return state?.value;
}

// ---------------------------------------------------------------------------
// Benchmark

export const BENCHMARKS = ['SPY', 'QQQ'] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

const BENCH_CONTRACTS: ContractRef[] = BENCHMARKS.map((s) => stock(s));
/** Daily bars are reloaded after this long (today's bar grows; the live price is used meanwhile). */
const BARS_TTL_MS = HOUR;
/** Older pages asked for an ALL range beyond the first window (2 years of daily bars). */
const MAX_OLDER_PAGES = 4;
const OLDER_PAGE_BARS = 1000;

const benchRequest = (sym: Benchmark): HistoryRequest => ({ contract: stock(sym), timeframe: '1D', slot: `dash-bench-${sym}` });

interface BarsEntry {
  bars: Bar[];
  at: number;
  /** Nothing older exists. */
  done: boolean;
}

/** Daily bars per benchmark, shared by every mounted widget for the session. */
const barsCache = new Map<Benchmark, BarsEntry>();
const loading = new Map<Benchmark, Promise<void>>();

/** Loads (or extends back to `start`) the daily bars of a benchmark. */
function loadBars(sym: Benchmark, start: number | undefined): Promise<void> {
  const pending = loading.get(sym);
  if (pending) return pending;
  const run = async () => {
    let entry = barsCache.get(sym);
    if (!entry || Date.now() - entry.at > BARS_TTL_MS) {
      const bars = await window.tape.getHistory(benchRequest(sym));
      entry = { bars, at: Date.now(), done: false };
      // Keep older pages loaded before.
      const prev = barsCache.get(sym);
      if (prev && bars.length && prev.bars.length && prev.bars[0].time < bars[0].time) {
        entry = { ...entry, bars: [...prev.bars.filter((b) => b.time < bars[0].time), ...bars], done: prev.done };
      }
      barsCache.set(sym, entry);
    }
    for (let i = 0; i < MAX_OLDER_PAGES && start !== undefined && entry.bars.length && !entry.done && !barsCover(entry.bars, start); i++) {
      const page = await window.tape.getOlderBars(benchRequest(sym), entry.bars[0].time, OLDER_PAGE_BARS);
      entry = { ...entry, bars: [...page.bars, ...entry.bars], done: page.done || !page.bars.length };
      barsCache.set(sym, entry);
    }
  };
  const p = run().finally(() => loading.delete(sym));
  loading.set(sym, p);
  return p;
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
 * against SPY and QQQ over the same span: live price (else the newest close) against the daily
 * close at or before the range's first NAV sample.
 */
export function useBenchmark(active = true): BenchmarkView {
  const range = usePortfolioUi((s) => s.range);
  const series = useNavSeries();
  const available = useMarketDataAvailable();
  const connected = useStore((s) => s.connection.status === 'connected');
  const slice = useMemo(() => sliceRange(series, range, Date.now()), [series, range]);
  const start = slice.points[0]?.t;
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
  }, [active, available, connected, start]);

  return useMemo(() => {
    const ret = (sym: Benchmark) => {
      const bars = barsCache.get(sym)?.bars ?? [];
      return benchmarkReturn(bars, start, lastPrice(quotes[contractKey(stock(sym))]));
    };
    const portfolio = rangeReturn(slice.points)?.pct;
    const { rows, vsSpy } = benchmarkRows(portfolio, ret('SPY'), ret('QQQ'));
    return { range, points: slice.points, covered: slice.covered, rows, vsSpy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, slice, start, quotes, version]);
}
