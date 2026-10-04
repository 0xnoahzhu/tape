// Debounced IB symbol search (reqMatchingSymbols through window.tape.searchSymbols).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SymbolMatch } from '@shared/types';
import { useStore } from '../../state/store';

/**
 * idle: nothing typed · loading: waiting for the debounce or IB · done: IB answered ·
 * unavailable: not connected (outside demo mode), or the request failed (pacing, timeout,
 * no permission …).
 */
export type SearchStatus = 'idle' | 'loading' | 'done' | 'unavailable';

export interface SearchResult {
  /** The trimmed query the status refers to (always the current query). */
  query: string;
  status: SearchStatus;
  /** While loading, the previous query's matches, so the list does not flicker while typing. */
  matches: SymbolMatch[];
}

interface Settled {
  query: string;
  status: 'done' | 'unavailable';
  matches: SymbolMatch[];
}

export function useSymbolSearch(query: string, delayMs = 200): SearchResult & { flush: () => void } {
  const q = query.trim();
  const connected = useStore((s) => s.connection.status === 'connected');
  const demo = useStore((s) => s.demo);
  // Demo mode answers searches from the simulator while IB is not connected.
  const available = connected || demo;
  const [settled, setSettled] = useState<Settled | null>(null);
  const seq = useRef(0);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; run: () => void } | null>(null);

  useEffect(() => {
    const id = ++seq.current;
    if (!q || !available) return;
    const run = () => {
      pending.current = null;
      window.tape.searchSymbols(q).then(
        (matches) => id === seq.current && setSettled({ query: q, status: 'done', matches }),
        () => id === seq.current && setSettled({ query: q, status: 'unavailable', matches: [] }),
      );
    };
    const timer = setTimeout(run, delayMs);
    pending.current = { timer, run };
    return () => {
      clearTimeout(timer);
      pending.current = null;
    };
  }, [q, available, connected, delayMs]);

  /** Skips the remaining debounce delay (used when Enter is pressed while typing). */
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    p.run();
  }, []);

  let result: SearchResult;
  if (!q) result = { query: '', status: 'idle', matches: [] };
  else if (!available) result = { query: q, status: 'unavailable', matches: [] };
  else if (settled?.query === q) result = settled;
  else result = { query: q, status: 'loading', matches: settled?.status === 'done' ? settled.matches : [] };
  return { ...result, flush };
}
