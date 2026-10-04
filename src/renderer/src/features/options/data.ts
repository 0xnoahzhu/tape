// Data hooks of the options desk: the underlying, its chain parameters and history.

import { useMemo } from 'react';
import { contractKey, stock } from '@shared/contract';
import type { Bar, ContractRef, HistoryRequest, OptionChainParams } from '@shared/types';
import { buildChain, type ChainExpiry } from './chain';
import { ivRank } from './math';
import { retryRequest, seedRequest, useCachedRequest } from './requests';

/** The instrument whose chain is shown: stocks / ETFs and indices; an option maps to its stock. */
export function underlyingOf(c: ContractRef): ContractRef | null {
  if (c.secType === 'STK' || c.secType === 'IND') return c;
  if (c.secType === 'OPT') return stock(c.symbol);
  return null;
}

const HOUR = 3_600_000;
const chainKey = (u: ContractRef) => `chain:${contractKey(u)}`;
const historyKey = (u: ContractRef, what: string) => `hist:${what}:${contractKey(u)}`;

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

/** Daily closes of the underlying (TRADES) or of its 30-day implied volatility. Null while unavailable. */
export function useDailyCloses(underlying: ContractRef | null, whatToShow: 'TRADES' | 'OPTION_IMPLIED_VOLATILITY'): { closes: number[] | null; error?: string } {
  const key = underlying ? historyKey(underlying, whatToShow) : null;
  const req: HistoryRequest | null = underlying ? { contract: underlying, timeframe: '1D', ...(whatToShow === 'TRADES' ? {} : { whatToShow }) } : null;
  const entry = useCachedRequest<Bar[]>(key, () => window.tape.getHistory(req!), HOUR / 6, (d) => !d.length);
  const bars = entry?.data;
  const closes = useMemo(() => (bars && bars.length ? bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0) : null), [bars]);
  return { closes: closes && closes.length ? closes : null, error: entry?.error };
}

/**
 * 52-week implied volatility history of the underlying (IB's OPTION_IMPLIED_VOLATILITY bars)
 * with IV rank / percentile of `current` (the underlying's 30-day IV, else the last bar).
 */
export function useIvHistory(underlying: ContractRef | null, current: number | undefined) {
  const { closes, error } = useDailyCloses(underlying, 'OPTION_IMPLIED_VOLATILITY');
  const hist = useMemo(() => (closes ? closes.slice(-252) : null), [closes]);
  const now = current != null && current > 0 ? current : hist?.[hist.length - 1];
  const stats = hist && now != null ? ivRank(hist, now) : null;
  return { hist, current: now, stats, error };
}

// ---------------------------------------------------------------------------
// Debug handle for scripted captures: window.__tape.options
//
//   __tape.options.seedChain('AAPL', [{ exchange: 'SMART', tradingClass: 'AAPL', multiplier: 100,
//     underlyingConId: 265598, expirations: ['20261009', …], strikes: [200, 202.5, …] }])
//   __tape.options.seedHistory('AAPL', 'TRADES', bars)   // or 'OPTION_IMPLIED_VOLATILITY'
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
    seedHistory: (u: string | ContractRef, what: 'TRADES' | 'OPTION_IMPLIED_VOLATILITY', bars: Bar[]) => seedRequest(historyKey(asUnderlying(u), what), bars),
  };
}
