// Composes everything the full desk shows from the store, the chain parameters and
// the quote subscriptions it owns. Kept in one hook so every tab sees the same numbers.

import { useEffect, useMemo } from 'react';
import { contractKey, daysToExpiry } from '@shared/contract';
import type { ContractRef, Quote } from '@shared/types';
import { lastPrice, useQuote, useQuoteSubscriptions, useQuotesByKey } from '../../hooks/useQuotes';
import { useStore } from '../../state/store';
import { atmIv, chainContract, nearestIndex, optionData, strikeWindow, termExpiries, type ChainExpiry, type OptionData } from './chain';
import { useChain, underlyingOf, type ChainData } from './data';
import { useDesk } from './deskStore';
import { dropUnlisted, useUnlisted, useUnlistedProbe } from './listing';
import { expectedMove, yearsToExpiry } from './math';
import { legContract } from './strategies';

/** IB allows ~100 market data lines by default; the chain uses at most this many. */
export const MAX_CHAIN_CONTRACTS = 60;
/** Strike rows that fit the line budget; larger windows subscribe only the rows in view. */
export const MAX_CHAIN_ROWS = MAX_CHAIN_CONTRACTS / 2;
/** Expirations sampled for the term structure. */
export const TERM_EXPIRIES = 8;

export interface ChainRow {
  strike: number;
  call: OptionData;
  put: OptionData;
  callContract: ContractRef;
  putContract: ContractRef;
  atm: boolean;
  em: '' | '+1σ' | '−1σ';
  callItm: boolean;
  putItm: boolean;
}

export interface TermPoint {
  expiry: string;
  dte: number;
  iv?: number;
}

export interface DeskModel {
  underlying: ContractRef | null;
  symbol: string;
  uq?: Quote;
  spot?: number;
  /** Chain with the strikes known to be unlisted per expiry left out. */
  chain: ChainData;
  exp?: ChainExpiry;
  expIndex: number;
  /** Years to the selected expiry. */
  t: number;
  dte: number;
  /** Displayed strikes (all strikes for range "all"). */
  rows: ChainRow[];
  /** Index (in rows) of the ATM / center row. */
  centerRow: number;
  /** Strike used as ATM (center of the window); exact ATM only when `spot` is known. */
  centerStrike?: number;
  ivAtm?: number;
  /** Where ivAtm comes from: the chain's ATM options or the underlying's 30-day IV. */
  ivAtmSource?: 'chain' | 'underlying';
  em?: number;
  /** Rows whose quotes are subscribed (the visible part of windows over the line budget). */
  quotedRows: ChainRow[];
  term: TermPoint[];
  quotes: Record<string, Quote>;
  /** First market data error among the desk's subscriptions. */
  dataError?: { code: number; message: string };
}

const keyOf = (c: ContractRef) => contractKey(c);

/** `visible` = rows in the viewport when the window exceeds MAX_CHAIN_ROWS (from/to are row indices). */
export function useDeskModel(visible: { from: number; to: number } | null): DeskModel {
  const symbolRef = useStore((s) => s.symbol);
  const symKey = contractKey(symbolRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const underlying = useMemo(() => underlyingOf(symbolRef), [symKey]);
  const uKey = underlying ? contractKey(underlying) : '';
  const marketIssue = useStore((s) => s.connection.marketDataIssue);
  const { tab, range, expiry, legs } = useDesk();
  const setUnderlying = useDesk((s) => s.setUnderlying);
  useEffect(() => setUnderlying(uKey), [uKey, setUnderlying]);

  const underlyingList = useMemo(() => (underlying ? [underlying] : []), [underlying]);
  useQuoteSubscriptions('options-underlying', underlyingList, 'underlying');
  const uq = useQuote(underlying);
  const spot = lastPrice(uq);

  // Strikes IB reports as not listed in an expiry are left out (listing.ts), so the strike
  // window, the ATM row, the term structure and the templates use strikes that trade.
  const rawChain = useChain(underlying);
  const unlisted = useUnlisted();
  const expiries = useMemo(() => dropUnlisted(rawChain.expiries, unlisted), [rawChain.expiries, unlisted]);
  const chain: ChainData = { ...rawChain, expiries };
  const expIndex = Math.max(0, expiries.findIndex((e) => e.expiry === expiry));
  const exp: ChainExpiry | undefined = expiries[expIndex];
  // Time to expiry at minute resolution keeps the derived rows stable between quote batches.
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const t = exp ? yearsToExpiry(exp.expiry, minute) : 0;
  const dte = exp ? daysToExpiry(exp.expiry) : 0;
  const symbol = underlying?.symbol ?? symbolRef.symbol;

  // Strike window around ATM (or the middle of the list when the price is unknown).
  const strikes = exp?.strikes ?? [];
  const centerIdx = strikes.length ? (spot != null ? nearestIndex(strikes, spot) : Math.floor(strikes.length / 2)) : -1;
  const win = strikeWindow(strikes, Math.max(0, centerIdx), range);
  const centerStrike = centerIdx >= 0 ? strikes[centerIdx] : undefined;

  const rowContracts = useMemo(() => {
    if (!exp) return [];
    return exp.strikes.slice(win.from, win.to).map((k) => ({ strike: k, call: chainContract(symbol, exp, k, 'C'), put: chainContract(symbol, exp, k, 'P') }));
  }, [exp, symbol, win.from, win.to]);

  // Subscribe the window (or, when it exceeds the line budget, the rows in view), capped at the budget.
  const subRange = visible && rowContracts.length > MAX_CHAIN_ROWS ? visible : { from: 0, to: rowContracts.length };
  const subFrom = Math.max(0, subRange.from);
  const subTo = Math.min(rowContracts.length, subRange.to, subFrom + MAX_CHAIN_ROWS);
  const chainSubs = useMemo(() => rowContracts.slice(subFrom, subTo).flatMap((r) => [r.call, r.put]), [rowContracts, subFrom, subTo]);
  useQuoteSubscriptions('options-chain', chainSubs, 'option');

  const legSubs = useMemo(() => (underlying ? legs.filter((l) => l.right !== 'S').map((l) => legContract(l, underlying)) : []), [legs, underlying]);
  useQuoteSubscriptions('options-legs', legSubs, 'option');

  // Term structure: ATM call + put of up to 8 expirations, one per monthly cycle. The ATM strike
  // moves to the next-nearest one when IB reports it as not listed in that expiry.
  const termExps = useMemo(() => termExpiries(expiries, TERM_EXPIRIES), [expiries]);
  const ref = spot ?? centerStrike;
  const termContracts = useMemo(() => {
    if (ref == null) return [];
    return termExps.flatMap((e) => {
      const k = e.strikes[nearestIndex(e.strikes, ref)];
      return k == null ? [] : [chainContract(symbol, e, k, 'C'), chainContract(symbol, e, k, 'P')];
    });
    // Re-center only when the ATM strike would change by a step, not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termExps, symbol, ref != null ? Math.round(ref) : null]);
  useQuoteSubscriptions('options-term', tab === 'vol' ? termContracts : [], 'option');

  const probed = useMemo(() => [...chainSubs, ...legSubs, ...termContracts], [chainSubs, legSubs, termContracts]);
  // Only the quotes the desk shows: unrelated quote updates (e.g. the watchlist) do not re-render it.
  const quoteKeys = useMemo(
    () => [...rowContracts.flatMap((r) => [r.call, r.put]), ...legSubs, ...termContracts].map(keyOf),
    [rowContracts, legSubs, termContracts],
  );
  const quotes = useQuotesByKey(quoteKeys);
  useUnlistedProbe(probed, quotes);

  const baseRows: ChainRow[] = useMemo(() => {
    return rowContracts.map((r) => {
      const atm = spot != null && r.strike === centerStrike;
      return {
        strike: r.strike,
        callContract: r.call,
        putContract: r.put,
        call: optionData(quotes[keyOf(r.call)], r.strike, 'C', spot, t),
        put: optionData(quotes[keyOf(r.put)], r.strike, 'P', spot, t),
        atm,
        em: '',
        callItm: spot != null && r.strike < spot,
        putItm: spot != null && r.strike > spot,
      };
    });
  }, [rowContracts, quotes, spot, t, centerStrike]);

  const centerRow = Math.max(0, baseRows.findIndex((r) => r.strike === centerStrike));
  const atmRow = spot != null ? baseRows[centerRow] : undefined;
  const chainIv = atmRow ? atmIv(quotes[keyOf(atmRow.callContract)], quotes[keyOf(atmRow.putContract)]) : undefined;
  const ivAtm = chainIv ?? (uq?.impliedVol && uq.impliedVol > 0 ? uq.impliedVol : undefined);
  const ivAtmSource = chainIv != null ? 'chain' : ivAtm != null ? 'underlying' : undefined;
  const em = spot != null && ivAtm != null && exp ? expectedMove(spot, ivAtm, t) : undefined;

  // ±1σ markers on the strikes closest to spot ± expected move.
  let rows = baseRows;
  if (em != null && spot != null && baseRows.length) {
    const ks = baseRows.map((r) => r.strike);
    const hi = nearestIndex(ks, spot + em);
    const lo = nearestIndex(ks, spot - em);
    rows = baseRows.map((r, i) => (i === hi ? { ...r, em: '+1σ' } : i === lo ? { ...r, em: '−1σ' } : r));
  }

  const term: TermPoint[] = useMemo(() => {
    const out: TermPoint[] = [];
    for (let i = 0; i < termContracts.length; i += 2) {
      const c = termContracts[i];
      out.push({ expiry: c.lastTradeDate!, dte: daysToExpiry(c.lastTradeDate!), iv: atmIv(quotes[keyOf(c)], quotes[keyOf(termContracts[i + 1])]) });
    }
    return out;
  }, [termContracts, quotes]);

  const quotedRows = rows.slice(subFrom, subTo);
  // Strikes from reqSecDefOptParams are a union over expiries; 200 "no security definition"
  // just means the strike is not listed for this expiry (it is dropped once confirmed).
  const dataIssue = (e: Quote['error']) => (e && e.code !== 200 ? e : undefined);
  const dataError =
    dataIssue(uq?.error) ??
    quotedRows.map((r) => dataIssue(quotes[keyOf(r.callContract)]?.error) ?? dataIssue(quotes[keyOf(r.putContract)]?.error)).find(Boolean) ??
    marketIssue;

  return {
    underlying,
    symbol,
    uq,
    spot,
    chain,
    exp,
    expIndex,
    t,
    dte,
    rows,
    centerRow,
    centerStrike,
    ivAtm,
    ivAtmSource,
    em,
    quotedRows,
    term,
    quotes,
    dataError,
  };
}
