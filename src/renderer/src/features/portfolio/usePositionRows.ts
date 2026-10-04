// Live position rows: IB positions + quote subscriptions + sector classification.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/shallow';
import { contractKey } from '@shared/contract';
import type { ContractRef, Position } from '@shared/types';
import { lastPrice, useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useStore } from '../../state/store';
import { livePrice, positionRow, quoteContract, sectorOf, sortRows, underlyingOf, type Classification, type PositionRow } from './calc';

// Contract details of underlyings that IB sent without an industry, fetched once per session.
// null = IB does not know the contract. Failures (not connected, timeouts) are not cached and
// are retried when the connection comes back.
const infoCache = new Map<string, Classification | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let cacheVersion = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function bump(): void {
  cacheVersion++;
  listeners.forEach((l) => l());
}

function ownClassification(p: Position): Classification | undefined {
  return p.industry || p.category ? { industry: p.industry, category: p.category } : undefined;
}

/** Classification per underlying key: from the positions themselves, else from contract details. */
function useClassifications(positions: Position[]): Map<string, Classification> {
  const connected = useStore((s) => s.connection.status === 'connected');
  const version = useSyncExternalStore(subscribe, () => cacheVersion);

  const known = useMemo(() => {
    const map = new Map<string, Classification>();
    for (const p of positions) {
      const own = ownClassification(p);
      if (!own) continue;
      const k = contractKey(underlyingOf(p.contract));
      // A stock position also classifies the options written on it.
      if (!map.has(k) || p.contract.secType === 'STK') map.set(k, own);
    }
    return map;
  }, [positions]);

  const missing = useMemo(() => {
    const out = new Map<string, ContractRef>();
    for (const p of positions) {
      const und = underlyingOf(p.contract);
      const k = contractKey(und);
      if (und.secType === 'STK' && !known.has(k) && !infoCache.has(k)) out.set(k, und);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, known, version]);
  const missingSig = [...missing.keys()].sort().join(',');

  useEffect(() => {
    if (!connected) return;
    for (const [k, und] of missing) {
      if (inflight.has(k)) continue;
      inflight.add(k);
      window.tape
        .getContractInfo(und)
        .then(
          (info) => infoCache.set(k, info ? { industry: info.industry, category: info.category, longName: info.longName } : null),
          () => undefined,
        )
        .finally(() => {
          inflight.delete(k);
          bump();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingSig, connected]);

  return useMemo(() => {
    const map = new Map(known);
    for (const [k, v] of infoCache) if (v && !map.has(k)) map.set(k, v);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, version]);
}

/** Positions of the active account (IB may report several accounts for advisors). */
function useAccountPositions(): Position[] {
  const positions = useStore((s) => s.positions);
  const account = useStore((s) => s.connection.account ?? s.account?.account);
  return useMemo(() => {
    if (!account || positions.every((p) => p.account === positions[0].account)) return positions;
    return positions.filter((p) => !p.account || p.account === account);
  }, [positions, account]);
}

/** Position rows valued at live prices, largest first. Subscribes to quotes while mounted. */
export function usePositionRows(): PositionRow[] {
  const positions = useAccountPositions();
  const netLiq = useStore((s) => s.account?.netLiquidation);
  const contracts = useMemo(() => positions.map((p) => quoteContract(p.contract)), [positions]);
  useQuoteSubscriptions('portfolio', contracts, 'basic');
  const keys = useMemo(() => positions.map((p) => contractKey(p.contract)), [positions]);
  const prices = useStore(
    useShallow((s) =>
      keys.map((k, i) => {
        const q = s.quotes[k];
        return livePrice(positions[i].contract.secType, q, lastPrice(q));
      }),
    ),
  );
  const classes = useClassifications(positions);

  return useMemo(
    () =>
      sortRows(
        positions.map((p, i) => {
          const und = underlyingOf(p.contract);
          const sector = sectorOf(und.secType, ownClassification(p) ?? classes.get(contractKey(und)));
          return positionRow(p, prices[i], netLiq, sector);
        }),
      ),
    [positions, prices, netLiq, classes],
  );
}
