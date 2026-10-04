// Debounced IB symbol search (reqMatchingSymbols) with a small per-term cache.

import { useEffect, useState } from 'react';
import type { SymbolMatch } from '@shared/types';
import { errorText } from '../../state/orderActions';

export interface SymbolSearch {
  /** The term the matches belong to (results of an older term are never shown for a newer one). */
  term: string;
  matches: SymbolMatch[];
  loading: boolean;
  error?: string;
}

const DEBOUNCE_MS = 220;
const cache = new Map<string, SymbolMatch[]>();

export function useSymbolSearch(term: string): SymbolSearch {
  const [state, setState] = useState<SymbolSearch>({ term: '', matches: [], loading: false });

  useEffect(() => {
    const q = term.trim().toUpperCase();
    if (!q) {
      setState({ term: '', matches: [], loading: false });
      return;
    }
    const hit = cache.get(q);
    if (hit) {
      setState({ term: q, matches: hit, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    let alive = true;
    const timer = setTimeout(() => {
      window.tape
        .searchSymbols(q)
        .then((matches) => {
          // An empty list may mean the search was superseded by a newer one in main: do not cache it.
          if (matches.length) cache.set(q, matches);
          if (alive) setState({ term: q, matches, loading: false });
        })
        .catch((err: unknown) => {
          if (alive) setState({ term: q, matches: [], loading: false, error: errorText(err) });
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [term]);

  return state;
}
