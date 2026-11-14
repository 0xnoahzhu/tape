// Data of the Positioning tab: the stored open-interest snapshots of the underlying (main keeps one a
// trading day, market/positioning.ts) and the scan that refreshes today's. The tab scans on its own
// once per underlying and scope while today's snapshot lacks a tenth or more of the options it
// shows (or IB is not connected: then the stored days are shown); Rescan reads them again.
// Leaving the tab stops a running scan (what it read is kept).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { contractKey } from '@shared/contract';
import { tradingDay } from '@shared/session';
import type { ContractRef, PositioningProgress, PositioningSnapshot } from '@shared/types';
import { useStore } from '../../state/store';

/** Trading days of snapshots loaded for the history charts. */
export const HISTORY_DAYS = 60;
/** Today's snapshot covers the view when it has at least this share of its options. */
export const COVERED = 0.9;

const optKey = (c: Pick<ContractRef, 'lastTradeDate' | 'strike' | 'right'>) => `${c.lastTradeDate}|${c.strike}|${c.right}`;

/** Share of `contracts` that `snap` has a row for. */
export function coverage(snap: PositioningSnapshot | undefined, contracts: readonly ContractRef[]): number {
  if (!snap || !contracts.length) return 0;
  const have = new Set(snap.rows.map((r) => `${r.expiry}|${r.strike}|${r.right}`));
  return contracts.filter((c) => have.has(optKey(c))).length / contracts.length;
}

export interface PositioningData {
  /** Stored days, oldest first; null while loading. */
  snaps: PositioningSnapshot[] | null;
  progress: PositioningProgress | null;
  error?: string;
  scan(): void;
  stop(): void;
}

export function usePositioning(underlying: ContractRef | null, contracts: readonly ContractRef[], scopeKey: string): PositioningData {
  const key = underlying ? contractKey(underlying) : '';
  const [snaps, setSnaps] = useState<PositioningSnapshot[] | null>(null);
  const [error, setError] = useState<string>();
  const progress = useStore((s) => (s.positioningScan?.underlying === key ? s.positioningScan : null));
  const canScan = useStore((s) => s.demo || s.connection.status === 'connected');
  const tried = useRef(new Set<string>());
  const live = useRef(key);
  live.current = key;

  const reload = useCallback(async () => {
    if (!underlying) return;
    const forKey = contractKey(underlying);
    try {
      const list = await window.tape.getPositioning(underlying, HISTORY_DAYS);
      if (live.current === forKey) setSnaps(list);
    } catch (err) {
      if (live.current === forKey) {
        setSnaps([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    // The underlying is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    setSnaps(null);
    setError(undefined);
    void reload();
  }, [reload]);

  const contractsRef = useRef(contracts);
  contractsRef.current = contracts;
  const run = useCallback(async () => {
    const list = contractsRef.current;
    if (!underlying || !list.length) return;
    setError(undefined);
    try {
      await window.tape.scanPositioning(underlying, [...list]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  // Scan once per underlying and scope when today's snapshot does not cover the view.
  const latest = snaps?.[snaps.length - 1];
  const needed = useMemo(() => !latest || latest.day !== tradingDay(Date.now()) || coverage(latest, contracts) < COVERED, [latest, contracts]);
  useEffect(() => {
    if (!snaps || !underlying || !contracts.length || !canScan || progress?.running) return;
    const k = `${key}|${scopeKey}`;
    if (tried.current.has(k)) return;
    tried.current.add(k);
    if (needed) void run();
  }, [snaps, underlying, contracts.length, canScan, progress?.running, key, scopeKey, needed, run]);

  // Leaving the tab (or the underlying) stops a running scan.
  useEffect(
    () => () => {
      if (useStore.getState().positioningScan?.running) void window.tape.cancelPositioningScan().catch(() => undefined);
    },
    [key],
  );

  return {
    snaps,
    progress,
    error,
    scan: () => void run(),
    stop: () => void window.tape.cancelPositioningScan().catch(() => undefined),
  };
}
