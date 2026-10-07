// What the Positions table's shown columns read beyond the position rows: the positions' own
// quotes (already subscribed by the 'portfolio' owner, usePositionRows), their contract details
// (fetched by the main process for every position, so getContractInfo answers from its cache) and
// the gross value of all rows. Each is read only while a shown column needs it, so the rows are not
// redrawn for changes no shown column reads. No new market data is requested.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { contractKey } from '@shared/contract';
import type { ContractInfo, Quote } from '@shared/types';
import { useMarketDataAvailable, useQuotesByKey } from '../../hooks/useQuotes';
import type { PositionRow } from './calc';
import { rowId, type ColumnDef } from './columns';

// Contract details per row id, once per session. null = IB does not know the contract. Failures
// (not connected, timeouts) are not cached and are retried when market data comes back.
const details = new Map<string, ContractInfo | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function bump(): void {
  version++;
  listeners.forEach((l) => l());
}

/** Contract details of the rows by row id, while `active`; missing while unknown. */
export function usePositionDetails(rows: readonly PositionRow[], active: boolean): ReadonlyMap<string, ContractInfo | null> {
  const available = useMarketDataAvailable();
  const v = useSyncExternalStore(subscribe, () => version);
  const sig = active ? rows.map(rowId).join(',') : '';

  useEffect(() => {
    if (!active || !available) return;
    for (const r of rows) {
      const id = rowId(r);
      if (details.has(id) || inflight.has(id)) continue;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, available]);

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

export interface PositionColumnData {
  /** The rows' quotes by contract key (empty while no shown column reads quotes). */
  quotes: Readonly<Record<string, Quote>>;
  /** Contract details by row id (empty while no shown column reads them). */
  infos: ReadonlyMap<string, ContractInfo | null>;
  /** Σ |value in the account currency| of all rows; undefined while a row's is unknown (or no shown column reads it). */
  grossBase?: number;
}

export function usePositionColumnData(rows: readonly PositionRow[], columns: readonly ColumnDef[]): PositionColumnData {
  const needQuotes = columns.some((c) => c.needs === 'quote');
  const needDetails = columns.some((c) => c.needs === 'details');
  const needGross = columns.some((c) => c.needs === 'gross');
  const keySig = needQuotes ? rows.map((r) => r.key).join(',') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => (needQuotes ? rows.map((r) => contractKey(r.position.contract)) : NO_KEYS), [keySig]);
  const quotes = useQuotesByKey(keys);
  const infos = usePositionDetails(rows, needDetails);
  const grossBase = useMemo(() => {
    if (!needGross) return undefined;
    let sum = 0;
    for (const r of rows) {
      if (r.valueBase === undefined || !Number.isFinite(r.valueBase)) return undefined;
      sum += Math.abs(r.valueBase);
    }
    return sum;
  }, [rows, needGross]);
  return { quotes, infos, grossBase };
}
