// Quote subscriptions per UI owner. The main process unions the owners and cancels market data
// that no owner wants, but the renderer keeps every quote it ever received. Quotes released by
// every owner are dropped from the store, so they do not linger as if current (stale values on
// re-subscribe, "delayed" markets in Settings › Market data, unbounded growth).

import { contractKey } from '@shared/contract';
import type { Quote, QuoteSubscription } from '@shared/types';
import { useStore } from './store';

/** Longer than the main process's 100 ms quote batching, so a batch queued before the release is dropped too. */
const PRUNE_DELAY_MS = 300;

/** Contract keys wanted by each owner. */
export class QuoteOwners {
  private readonly owners = new Map<string, Set<string>>();

  /** Records the keys an owner wants; returns the keys it wanted before and no longer does. */
  set(owner: string, keys: Iterable<string>): string[] {
    const prev = this.owners.get(owner);
    const next = new Set(keys);
    if (next.size) this.owners.set(owner, next);
    else this.owners.delete(owner);
    return prev ? [...prev].filter((k) => !next.has(k)) : [];
  }

  wanted(key: string): boolean {
    for (const keys of this.owners.values()) if (keys.has(key)) return true;
    return false;
  }
}

/** The quote map without `keys`; the same object when none of them is present. */
export function withoutQuotes(quotes: Record<string, Quote>, keys: Iterable<string>): Record<string, Quote> {
  let next: Record<string, Quote> | null = null;
  for (const k of keys) {
    if (!(k in quotes)) continue;
    next ??= { ...quotes };
    delete next[k];
  }
  return next ?? quotes;
}

const owners = new QuoteOwners();
const released = new Set<string>();
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

/** Restarted on every release, so a key is dropped only after its last batch can have arrived. */
function schedulePrune(): void {
  if (pruneTimer) clearTimeout(pruneTimer);
  pruneTimer = setTimeout(prune, PRUNE_DELAY_MS);
}

function prune(): void {
  pruneTimer = null;
  const stale = [...released].filter((k) => !owners.wanted(k));
  released.clear();
  const { quotes } = useStore.getState();
  const next = withoutQuotes(quotes, stale);
  if (next !== quotes) useStore.setState({ quotes: next });
}

/**
 * Declares the full set of quotes one owner needs (pass [] to release them). Use this instead of
 * calling window.tape.setQuoteSubscriptions directly, so released quotes are dropped.
 */
export function setQuoteSubscriptions(owner: string, subs: QuoteSubscription[]): Promise<void> {
  for (const k of owners.set(owner, subs.map((s) => contractKey(s.contract)))) released.add(k);
  const done = window.tape.setQuoteSubscriptions(owner, subs);
  if (released.size) done.then(schedulePrune, schedulePrune);
  return done;
}
