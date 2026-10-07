// What the Positions table's shown columns read beyond the position rows: the positions' own
// quotes (subscribed by the 'portfolio' owner, usePositionRows), their contract details (fetched by
// the main process for every position, so getContractInfo answers from its cache), the gross value
// of all rows and the holdings' earnings (the Positions tab's one useEarnings, shared with the event
// chips: PositionsView.tsx). Each is read only while a shown column needs it, so the rows are not
// redrawn for changes no shown column reads.
//
// Columns with a `profile` need more generic ticks on the positions' lines: the 'positions-table'
// owner asks for them, on the portfolio's own contracts (no new line), only while such a column is
// shown, and only for the positions it applies to (columns.ts → addOnSubscriptions). The first set
// goes out at once; later changes of the shown columns 500 ms after the last one (a quick run of
// column toggles is one re-request of each line), changes of the rows at once, with the 'portfolio'
// owner's (a new position's line is requested once); unmounting releases them at once. Details the
// main process still holds from an older mapping (ContractInfo.v below CONTRACT_DETAILS_VERSION) are
// asked for again while it refetches them in the background (reaskDelay).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CONTRACT_DETAILS_VERSION, contractKey } from '@shared/contract';
import type { ContractInfo, CorporateEarnings, EarningsEvent, Quote, QuoteSubscription } from '@shared/types';
import { useMarketDataAvailable, useQuoteSubscriptionList, useQuotesByKey } from '../../hooks/useQuotes';
import type { PositionRow } from './calc';
import { addOnSubscriptions, rowId, type ColumnDef } from './columns';

/** The quote owner of the shown columns' extra generic ticks. */
export const POSITIONS_TABLE_OWNER = 'positions-table';
/** Changes to the extra ticks wait this long after the last one. */
export const ADD_ON_DEBOUNCE_MS = 500;

/**
 * Passes the first value on at once and each later one `ms` after the last push (a newer push
 * restarts the wait), so a burst of changes becomes one.
 */
export function latestAfter<T>(ms: number, emit: (value: T) => void): { push(value: T): void; cancel(): void } {
  let first = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push(value) {
      if (first) {
        first = false;
        emit(value);
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        emit(value);
      }, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * The shown columns that ask for extra generic ticks (a `profile`), and their signature: the only
 * input of the extra ticks that waits (latestAfter). The rows do not: a new position's extra ticks
 * reach main with the 'portfolio' owner's update (both effects run in one commit), so its line is
 * requested once, with them, not first with the basic ticks and then again.
 */
export function profileColumns(columns: readonly ColumnDef[]): { defs: ColumnDef[]; sig: string } {
  const defs = columns.filter((c) => c.profile);
  return { defs, sig: defs.map((c) => c.id).join(',') };
}

/** `value` through latestAfter, by its signature `sig`. */
function useLatestAfter<T>(value: T, sig: string, ms: number): T {
  const [out, setOut] = useState(value);
  const debounce = useRef<ReturnType<typeof latestAfter<T>> | null>(null);
  debounce.current ??= latestAfter(ms, setOut);
  useEffect(() => {
    debounce.current!.push(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => () => debounce.current?.cancel(), []);
  return out;
}

// Contract details per row id, once per session. null = IB does not know the contract. Failures
// (not connected, timeouts) are not cached and are retried when market data comes back.
const details = new Map<string, ContractInfo | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
/** Re-asks so far per row id for details below the current version; cleared when market data comes back. */
const reasks = new Map<string, number>();
let wasAvailable = false;

/** Waits before the re-asks for outdated details: 5 s, 15 s, 45 s, 2 min, 5 min; then none. */
const REASK_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/** The wait before re-ask `n` (from 0) for details the main process is still upgrading; undefined after the last. */
export function reaskDelay(n: number): number | undefined {
  return REASK_MS[n];
}

const outdated = (info: ContractInfo | null | undefined): boolean => !!info && (info.v ?? 1) < CONTRACT_DETAILS_VERSION;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function bump(): void {
  version++;
  listeners.forEach((l) => l());
}

function ask(r: PositionRow): void {
  const id = rowId(r);
  if (inflight.has(id)) return;
  inflight.add(id);
  window.tape
    .getContractInfo(r.position.contract)
    .then(
      (info) => details.set(id, info),
      () => undefined,
    )
    .finally(() => {
      inflight.delete(id);
      bump();
    });
}

/** Contract details of the rows by row id, while `active`; missing while unknown. */
export function usePositionDetails(rows: readonly PositionRow[], active: boolean): ReadonlyMap<string, ContractInfo | null> {
  const available = useMarketDataAvailable();
  const v = useSyncExternalStore(subscribe, () => version);
  const sig = active ? rows.map(rowId).join(',') : '';

  // Market data back: the re-asks start over.
  useEffect(() => {
    if (available && !wasAvailable) reasks.clear();
    wasAvailable = available;
  }, [available]);

  useEffect(() => {
    if (!active || !available) return;
    for (const r of rows) if (!details.has(rowId(r))) ask(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, available]);

  // Details from an older mapping: asked for again (main answers from memory) until the upgraded ones come.
  useEffect(() => {
    if (!active || !available) return;
    const due = rows.filter((r) => outdated(details.get(rowId(r))) && reaskDelay(reasks.get(rowId(r)) ?? 0) !== undefined);
    if (!due.length) return;
    const n = Math.min(...due.map((r) => reasks.get(rowId(r)) ?? 0));
    const timer = setTimeout(() => {
      for (const r of due) {
        const id = rowId(r);
        if ((reasks.get(id) ?? 0) !== n) continue;
        reasks.set(id, n + 1);
        ask(r);
      }
    }, reaskDelay(n));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, available, v]);

  return useMemo(() => {
    const out = new Map<string, ContractInfo | null>();
    if (!active) return out;
    for (const r of rows) {
      const id = rowId(r);
      if (details.has(id)) out.set(id, details.get(id)!);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, v]);
}

const NO_KEYS: string[] = [];
const NO_EARNINGS: ReadonlyMap<string, EarningsEvent> = new Map();

export interface PositionColumnData {
  /** The rows' quotes by contract key (empty while no shown column reads quotes). */
  quotes: Readonly<Record<string, Quote>>;
  /** Contract details by row id (empty while no shown column reads them). */
  infos: ReadonlyMap<string, ContractInfo | null>;
  /** Σ |value in the account currency| of all rows; undefined while a row's is unknown (or no shown column reads it). */
  grossBase?: number;
  /** The next earnings by the underlying's contract key (empty while no shown column reads them). */
  earnings: ReadonlyMap<string, EarningsEvent>;
}

/** `corporate`: the holdings' earnings (data.ts → useEarnings), read only while an earnings column is shown. */
export function usePositionColumnData(rows: readonly PositionRow[], columns: readonly ColumnDef[], corporate: CorporateEarnings | undefined): PositionColumnData {
  const needQuotes = columns.some((c) => c.needs === 'quote');
  const needDetails = columns.some((c) => c.needs === 'details');
  const needGross = columns.some((c) => c.needs === 'gross');
  const needEarnings = columns.some((c) => c.needs === 'earnings');
  const keySig = needQuotes ? rows.map((r) => r.key).join(',') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => (needQuotes ? rows.map((r) => contractKey(r.position.contract)) : NO_KEYS), [keySig]);
  const quotes = useQuotesByKey(keys);
  const infos = usePositionDetails(rows, needDetails);

  // The extra generic ticks of the shown columns (none for the default columns). Only a change of
  // the shown columns waits; the rows go straight through (profileColumns).
  const profiled = useMemo(() => profileColumns(columns), [columns]);
  const shown = useLatestAfter(profiled.defs, profiled.sig, ADD_ON_DEBOUNCE_MS);
  const subs: readonly QuoteSubscription[] = useMemo(() => addOnSubscriptions(rows, shown), [rows, shown]);
  useQuoteSubscriptionList(POSITIONS_TABLE_OWNER, subs);

  const earnings = useMemo(() => {
    if (!needEarnings || corporate?.status !== 'ok') return NO_EARNINGS;
    // The soonest upcoming event per stock (IB lists them soonest first).
    const out = new Map<string, EarningsEvent>();
    for (const e of corporate.events) if (!out.has(e.key)) out.set(e.key, e);
    return out;
  }, [needEarnings, corporate]);

  const grossBase = useMemo(() => {
    if (!needGross) return undefined;
    let sum = 0;
    for (const r of rows) {
      if (r.valueBase === undefined || !Number.isFinite(r.valueBase)) return undefined;
      sum += Math.abs(r.valueBase);
    }
    return sum;
  }, [rows, needGross]);
  return { quotes, infos, grossBase, earnings };
}
