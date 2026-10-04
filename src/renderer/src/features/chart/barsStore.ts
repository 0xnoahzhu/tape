// Historical bars cache, keyed by "<contractKey>|<timeframe>".
//
// For scripted screenshots the store is reachable as `window.__tape.bars` (see debug.ts),
// so capture steps can seed bars without IB:
//   __tape.bars.getState().seed('STK:AAPL|1D', [{ time, open, high, low, close, volume }, …])
// Seeded entries are never refetched.

import { create } from 'zustand';
import { contractKey } from '@shared/contract';
import type { Bar, ContractRef, Timeframe } from '@shared/types';
import { cleanBars, isIntraday } from './chartMath';
import { historyErrorMessage } from './errors';

export interface BarsEntry {
  status: 'loading' | 'ready' | 'error';
  bars: Bar[];
  /** IB's message when the last request failed. */
  error?: string;
  /** Unix ms of the last successful load. */
  loadedAt?: number;
  seeded?: boolean;
}

interface BarsState {
  entries: Record<string, BarsEntry>;
  /** Puts bars into the cache (debug / screenshots). */
  seed(key: string, bars: Bar[]): void;
}

const MAX_ENTRIES = 40;

export const useBarsStore = create<BarsState>()((set) => ({
  entries: {},
  seed: (key, bars) => set((s) => ({ entries: { ...s.entries, [key]: { status: 'ready', bars: cleanBars(bars), loadedAt: Date.now(), seeded: true } } })),
}));

export function barsKey(c: ContractRef, tf: Timeframe): string {
  return `${contractKey(c)}|${tf}`;
}

/** How long loaded bars are considered fresh. */
export function barsTtl(tf: Timeframe): number {
  return isIntraday(tf) ? 60_000 : 15 * 60_000;
}

function patch(key: string, entry: BarsEntry): void {
  useBarsStore.setState((s) => {
    const entries = { ...s.entries, [key]: entry };
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      keys
        .filter((k) => k !== key)
        .sort((a, b) => (entries[a].loadedAt ?? 0) - (entries[b].loadedAt ?? 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => delete entries[k]);
    }
    return { entries };
  });
}

const inflight = new Map<string, Promise<void>>();

/**
 * Loads bars unless a fresh copy is cached (or `force`). Keeps showing cached bars while
 * refreshing; a failed refresh keeps them and records the error.
 */
export function loadBars(contract: ContractRef, timeframe: Timeframe, force = false): Promise<void> {
  const key = barsKey(contract, timeframe);
  const cur = useBarsStore.getState().entries[key];
  if (cur?.seeded) return Promise.resolve();
  if (!force && cur?.status === 'ready' && cur.loadedAt && Date.now() - cur.loadedAt < barsTtl(timeframe)) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;

  // Background refreshes (force) keep the current state on screen instead of flashing "Loading".
  if (!cur || (cur.status === 'error' && !force)) patch(key, { status: 'loading', bars: cur?.bars ?? [] });
  const p = window.tape
    .getHistory({ contract, timeframe, outsideRth: isIntraday(timeframe) })
    .then(
      (bars) => {
        if (useBarsStore.getState().entries[key]?.seeded) return;
        patch(key, { status: 'ready', bars: cleanBars(bars ?? []), loadedAt: Date.now() });
      },
      (err: unknown) => {
        const prev = useBarsStore.getState().entries[key];
        if (prev?.seeded) return;
        const error = historyErrorMessage(err);
        // A failed refresh keeps the bars already on screen.
        if (prev?.bars.length) patch(key, { ...prev, status: 'ready', error });
        else patch(key, { status: 'error', bars: [], error });
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
