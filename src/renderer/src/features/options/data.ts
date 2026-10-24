// Data hooks of the options desk: the underlying, its chain parameters and IV history.

import { useMemo } from 'react';
import { contractKey, stock } from '@shared/contract';
import type { Bar, ContractRef, HistoryRequest, OptionChainParams } from '@shared/types';
import { underlyingOf as positionUnderlying } from '../portfolio/calc';
import { buildChain, type ChainExpiry } from './chain';
import { ivRank } from './math';
import { retryRequest, seedRequest, useCachedRequest } from './requests';

/**
 * The instrument whose chain is shown: stocks / ETFs and indices. An option charted from the chain
 * keeps that chain (`current`, the desk's underlying, when symbol and currency match); another maps
 * to its underlying as a position does (portfolio/calc.ts: an index option to its index, else the stock).
 */
export function underlyingOf(c: ContractRef, current?: ContractRef | null): ContractRef | null {
  if (c.secType === 'STK' || c.secType === 'IND') return c;
  if (c.secType !== 'OPT') return null;
  if (current && current.symbol === c.symbol && (current.currency || 'USD') === (c.currency || 'USD')) return current;
  return positionUnderlying(c);
}

const HOUR = 3_600_000;
const chainKey = (u: ContractRef) => `chain:${contractKey(u)}`;
const ivHistoryKey = (u: ContractRef) => `hist:OPTION_IMPLIED_VOLATILITY:${contractKey(u)}`;

export interface ChainData {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  expiries: ChainExpiry[];
  error?: string;
  retry(): void;
}

export function useChain(underlying: ContractRef | null): ChainData {
  const key = underlying ? chainKey(underlying) : null;
  const entry = useCachedRequest<OptionChainParams[]>(key, () => window.tape.getOptionChainParams(underlying!), 6 * HOUR, (d) => !d.length);
  const symbol = underlying?.symbol ?? '';
  const params = entry?.data;
  const expiries = useMemo(() => (params ? buildChain(params, symbol) : []), [params, symbol]);
  const retry = () => key && retryRequest(key);
  if (!key) return { status: 'idle', expiries: [], retry };
  if (expiries.length) return { status: 'ready', expiries, retry };
  if (!entry || entry.pending) return { status: 'loading', expiries, retry };
  if (entry.error) return { status: 'error', expiries, error: entry.error, retry };
  return { status: 'empty', expiries, retry };
}

/**
 * Daily closes of the underlying's 30-day implied volatility (IB's OPTION_IMPLIED_VOLATILITY bars)
 * and their dates (bar times). Null while unavailable.
 */
function useIvCloses(underlying: ContractRef | null): { closes: number[] | null; times: number[] | null; error?: string } {
  const key = underlying ? ivHistoryKey(underlying) : null;
  const req: HistoryRequest | null = underlying ? { contract: underlying, timeframe: '1D', whatToShow: 'OPTION_IMPLIED_VOLATILITY' } : null;
  const entry = useCachedRequest<Bar[]>(key, () => window.tape.getHistory(req!), HOUR / 6, (d) => !d.length);
  const bars = entry?.data;
  const valid = useMemo(() => (bars ? bars.filter((b) => Number.isFinite(b.close) && b.close > 0) : []), [bars]);
  const closes = useMemo(() => (valid.length ? valid.map((b) => b.close) : null), [valid]);
  const times = useMemo(() => (valid.length ? valid.map((b) => b.time) : null), [valid]);
  return { closes, times, error: entry?.error };
}

/**
 * 52-week implied volatility history of the underlying (IB's OPTION_IMPLIED_VOLATILITY bars)
 * with IV rank / percentile of `current` (the underlying's 30-day IV, else the last bar).
 */
export function useIvHistory(underlying: ContractRef | null, current: number | undefined) {
  const { closes, times: allTimes, error } = useIvCloses(underlying);
  const hist = useMemo(() => (closes ? closes.slice(-252) : null), [closes]);
  // The dates of `hist`'s closes (bar times: dates at 00:00 UTC).
  const times = useMemo(() => (allTimes ? allTimes.slice(-252) : null), [allTimes]);
  const now = current != null && current > 0 ? current : hist?.[hist.length - 1];
  const stats = hist && now != null ? ivRank(hist, now) : null;
  return { hist, times, current: now, stats, error };
}

// ---------------------------------------------------------------------------
// Debug handle for scripted captures: window.__tape.options
//
//   __tape.options.seedChain('AAPL', [{ exchange: 'SMART', tradingClass: 'AAPL', multiplier: 100,
//     underlyingConId: 265598, expirations: ['20261009', …], strikes: [200, 202.5, …] }])
//   __tape.options.seedHistory('AAPL', bars)              // daily IV bars (OPTION_IMPLIED_VOLATILITY)
//   __tape.options.desk.setState({ tab: 'vol' })          // feature-local UI state
//
// A string symbol means a US stock; pass a ContractRef for an index.

const asUnderlying = (u: string | ContractRef): ContractRef => (typeof u === 'string' ? stock(u) : u);

export function attachDebugHandle(desk: unknown): void {
  const w = window as unknown as { __tape?: Record<string, unknown> };
  w.__tape = w.__tape ?? {};
  w.__tape.options = {
    desk,
    seedChain: (u: string | ContractRef, params: OptionChainParams[]) => seedRequest(chainKey(asUnderlying(u)), params),
    seedHistory: (u: string | ContractRef, bars: Bar[]) => seedRequest(ivHistoryKey(asUnderlying(u)), bars),
  };
}
