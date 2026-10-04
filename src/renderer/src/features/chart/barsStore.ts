// Historical bars cache, keyed by "<contractKey>|<timeframe>".
//
// An entry holds the chart's window of bars (loadBars) plus the older pages fetched while the
// user scrolls back (loadOlder → getOlderBars). A reload of the window keeps those pages in
// front of it (keepOlderBars), so a refresh does not throw the scrolled-back history away.
//
// For scripted screenshots the store is reachable as `window.__tape.bars` (see debug.ts),
// so capture steps can seed bars without IB:
//   __tape.bars.getState().seed('STK:AAPL|1D', [{ time, open, high, low, close, volume }, …])
// Seeded entries are never refetched and never page.

import { create } from 'zustand';
import { contractKey } from '@shared/contract';
import type { Bar, ContractRef, HistoryRequest, Timeframe } from '@shared/types';
import { cleanBars, isIntraday, keepOlderBars, prependBars } from './chartMath';
import { historyErrorMessage } from './errors';

/**
 * Paging of older bars for an entry: idle (more can be asked for), loading, empty (the last page
 * had no bars although older data exists), error (the last page was refused) or done (IB has
 * nothing older).
 */
export interface OlderState {
  status: 'idle' | 'loading' | 'empty' | 'error' | 'done';
  /** IB's message when the last page was refused. */
  error?: string;
  /** Unix ms before which no page is requested again (after a refused, empty or superseded page). */
  retryAt?: number;
  /** Refused or empty pages in a row; each one doubles the wait. */
  failures?: number;
}

export interface BarsEntry {
  status: 'loading' | 'ready' | 'error';
  bars: Bar[];
  /** IB's message when the last request failed. */
  error?: string;
  /** Unix ms of the last successful load. */
  loadedAt?: number;
  seeded?: boolean;
  /** Paging state of older bars (absent: nothing requested yet). */
  older?: OlderState;
}

interface BarsState {
  entries: Record<string, BarsEntry>;
  /** Puts bars into the cache (debug / screenshots). */
  seed(key: string, bars: Bar[]): void;
}

const MAX_ENTRIES = 40;
/** The history service slot of the chart: its newer requests supersede the older ones still waiting. */
export const CHART_SLOT = 'chart';
/** Bars per older page. */
export const OLDER_PAGE = 300;
/**
 * A refused or empty page is not requested again for this long (IB rejects identical requests
 * within 15 s). The wait doubles with each refused or empty page in a row, up to OLDER_RETRY_MAX_MS,
 * so a page that keeps failing does not use up IB's historical data budget (60 per 10 minutes).
 */
export const OLDER_RETRY_MS = 15_000;
export const OLDER_RETRY_MAX_MS = 4 * 60_000;
/** After a page was superseded by a newer chart request. */
const SUPERSEDED_RETRY_MS = 1_000;
/** Retry timers fire this much after retryAt, so the store's gate has surely opened. */
const RETRY_SLACK_MS = 50;

/** Wait before the next page after `failures` refused or empty pages in a row. */
export function olderRetryDelay(failures: number): number {
  return Math.min(OLDER_RETRY_MAX_MS, OLDER_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

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

function historyRequest(contract: ContractRef, timeframe: Timeframe, slot?: string): HistoryRequest {
  return { contract, timeframe, outsideRth: isIntraday(timeframe), ...(slot ? { slot } : {}) };
}

const isSuperseded = (err: unknown) => /superseded/i.test(historyErrorMessage(err));

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

function remove(key: string): void {
  useBarsStore.setState((s) => {
    if (!(key in s.entries)) return s;
    const entries = { ...s.entries };
    delete entries[key];
    return { entries };
  });
}

const inflight = new Map<string, Promise<void>>();
const olderInflight = new Map<string, Promise<void>>();

/**
 * Loads bars unless a fresh copy is cached (or `force`). Keeps showing cached bars while
 * refreshing; a failed refresh keeps them and records the error. `slot` is the history
 * service slot (CHART_SLOT for the chart's own series).
 */
export function loadBars(contract: ContractRef, timeframe: Timeframe, force = false, slot?: string): Promise<void> {
  const key = barsKey(contract, timeframe);
  const cur = useBarsStore.getState().entries[key];
  if (cur?.seeded) return Promise.resolve();
  if (!force && cur?.status === 'ready' && cur.loadedAt && Date.now() - cur.loadedAt < barsTtl(timeframe)) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;

  // Background refreshes (force) keep the current state on screen instead of flashing "Loading".
  if (!cur || (cur.status === 'error' && !force)) patch(key, { status: 'loading', bars: cur?.bars ?? [], older: cur?.older });
  const p = window.tape
    .getHistory(historyRequest(contract, timeframe, slot))
    .then(
      (loaded) => {
        const prev = useBarsStore.getState().entries[key];
        if (prev?.seeded) return;
        const fresh = cleanBars(loaded ?? []);
        const bars = prev ? keepOlderBars(prev.bars, fresh) : fresh;
        // Older pages stay (with their paging state) only when they were kept in front of the window.
        patch(key, { status: 'ready', bars, loadedAt: Date.now(), older: bars !== fresh ? prev?.older : undefined });
      },
      (err: unknown) => {
        const prev = useBarsStore.getState().entries[key];
        if (prev?.seeded) return;
        // A newer chart request took over (e.g. another symbol): not a failure of this series.
        if (isSuperseded(err)) {
          if (prev?.bars.length) patch(key, { ...prev, status: 'ready' });
          else remove(key);
          return;
        }
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

/**
 * Loads one page of bars older than the oldest loaded bar and puts it in front. At most one page
 * per series is in flight; nothing is requested once IB has no older data (done), while a refused
 * or empty page waits out its retry delay (olderRetryDelay), or before the window itself has loaded.
 */
export function loadOlder(contract: ContractRef, timeframe: Timeframe): Promise<void> {
  const key = barsKey(contract, timeframe);
  const cur = useBarsStore.getState().entries[key];
  if (!cur || cur.seeded || cur.status !== 'ready' || !cur.bars.length) return Promise.resolve();
  const older = cur.older;
  if (older?.status === 'done' || (older?.retryAt != null && Date.now() < older.retryAt)) return Promise.resolve();
  const running = olderInflight.get(key);
  if (running) return running;

  const before = cur.bars[0].time;
  const failures = older?.failures ?? 0;
  // A refused or empty page: one more in a row, and a longer wait.
  const failed = (state: OlderState): OlderState => ({ ...state, retryAt: Date.now() + olderRetryDelay(failures + 1), failures: failures + 1 });
  patch(key, { ...cur, older: { status: 'loading' } });
  const settle = (next: (e: BarsEntry) => BarsEntry) => {
    const e = useBarsStore.getState().entries[key];
    if (e && !e.seeded) patch(key, next(e));
  };
  const p = window.tape
    .getOlderBars(historyRequest(contract, timeframe, CHART_SLOT), before, OLDER_PAGE)
    .then(
      (page) =>
        settle((e) => {
          // The window was reloaded without the bars this page continues: drop the page.
          if (e.bars[0]?.time !== before) return { ...e, older: undefined };
          const bars = prependBars(cleanBars(page?.bars ?? []), e.bars);
          if (page?.done) return { ...e, bars, older: { status: 'done' } };
          // An empty page that is not the end would only repeat itself at once: wait before asking again.
          return { ...e, bars, older: bars !== e.bars ? { status: 'idle' } : failed({ status: 'empty' }) };
        }),
      (err: unknown) =>
        settle((e) =>
          isSuperseded(err)
            ? { ...e, older: { status: 'idle', retryAt: Date.now() + SUPERSEDED_RETRY_MS, ...(failures ? { failures } : {}) } }
            : { ...e, older: failed({ status: 'error', error: historyErrorMessage(err) }) },
        ),
    )
    .finally(() => olderInflight.delete(key));
  olderInflight.set(key, p);
  return p;
}

/**
 * Calls `ask` once a refused, empty or superseded page's wait (`retryAt`) is over, so paging goes
 * on while the view stays put at the oldest bar. Returns the cancel function, or undefined when
 * nothing waits (no retryAt, or it has passed: the caller asks right away).
 */
export function scheduleOlderRetry(retryAt: number | undefined, ask: () => void, now = Date.now()): (() => void) | undefined {
  if (retryAt == null || retryAt <= now) return undefined;
  const t = setTimeout(ask, retryAt - now + RETRY_SLACK_MS);
  return () => clearTimeout(t);
}
