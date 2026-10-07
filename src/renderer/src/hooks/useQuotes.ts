// Quote subscriptions owned by a component. The main process unions all owners.

import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { contractKey } from '@shared/contract';
import type { ContractRef, Quote, QuoteProfile, QuoteSubscription } from '@shared/types';
import { setQuoteSubscriptions } from '../state/quoteSubscriptions';
import { useStore } from '../state/store';

/**
 * Declares the quotes a component needs. `owner` must be unique per mounted component
 * (e.g. "watchlist", "chart", "options-chain"). Subscriptions are released on unmount.
 */
export function useQuoteSubscriptions(owner: string, contracts: ContractRef[], profile: QuoteProfile = 'basic'): void {
  const subs: QuoteSubscription[] = useMemo(() => {
    const seen = new Set<string>();
    const out: QuoteSubscription[] = [];
    for (const c of contracts) {
      const k = contractKey(c) + '|' + profile;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ contract: c, profile });
    }
    return out;
  }, [contracts, profile]);
  useQuoteSubscriptionList(owner, subs);
}

/**
 * Declares an owner's subscriptions with a profile each (several profiles of one contract are
 * several entries). Sent again only when their contracts or profiles change; released on unmount.
 */
export function useQuoteSubscriptionList(owner: string, subs: readonly QuoteSubscription[]): void {
  const signature = subs.map((s) => contractKey(s.contract) + '|' + s.profile).join(',');
  const connected = useStore((s) => s.connection.status === 'connected');

  useEffect(() => {
    void setQuoteSubscriptions(owner, [...subs]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, signature, connected]);

  useEffect(() => () => void setQuoteSubscriptions(owner, []), [owner]);
}

/** Current quote for an instrument (undefined until the first tick). */
export function useQuote(contract: ContractRef | null | undefined): Quote | undefined {
  const key = contract ? contractKey(contract) : '';
  return useStore((s) => (key ? s.quotes[key] : undefined));
}

/**
 * Quotes for a set of keys. The component re-renders only when one of these quotes changes
 * (the bridge replaces a quote object only when it changed), not on every quote batch.
 */
export function useQuotesByKey(keys: readonly string[]): Record<string, Quote> {
  return useStore(
    useShallow((s) => {
      const out: Record<string, Quote> = {};
      for (const k of keys) {
        const q = s.quotes[k];
        if (q) out[k] = q;
      }
      return out;
    }),
  );
}

/** Best available "last" price: last trade, else mid, else previous close. */
export function lastPrice(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (q.last != null && q.last > 0) return q.last;
  if (q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  if (q.mark != null && q.mark > 0) return q.mark;
  return q.close ?? undefined;
}

/** Percent change of the last price against the previous close. */
export function changePct(q: Quote | undefined): number | undefined {
  if (!q?.close) return undefined;
  const last = lastPrice(q);
  // A price that is only the previous close says nothing about today's change.
  if (last == null || (last === q.close && !(q.last && q.last > 0) && !(q.bid && q.ask) && !(q.mark && q.mark > 0))) return undefined;
  return (last / q.close - 1) * 100;
}

/**
 * Whether market data requests (quotes, bars, depth, chains, contract details) can be answered:
 * connected to IB, or the built-in simulator (TAPE_DEMO=1, development builds only), which
 * works offline.
 */
export function useMarketDataAvailable(): boolean {
  return useStore((s) => s.demo || s.connection.status === 'connected');
}
