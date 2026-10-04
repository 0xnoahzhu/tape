// Contract details (long name, primary exchange, liquid hours, min tick) per instrument.
// The main process caches as well; this keeps the renderer from asking again on every
// symbol switch. Failed requests (e.g. not connected) are retried on the next connect.

import { useMarketDataAvailable } from '../../hooks/useQuotes';
import { useEffect } from 'react';
import { create } from 'zustand';
import { contractKey } from '@shared/contract';
import type { ContractInfo, ContractRef } from '@shared/types';
import { useStore } from '../../state/store';

interface InfoState {
  /** null = IB does not know the contract. Missing = not loaded (yet). */
  infos: Record<string, ContractInfo | null>;
}

/** Exposed as `window.__tape.contractInfo` for screenshots (see debug.ts). */
export const useInfoStore = create<InfoState>()(() => ({ infos: {} }));
const inflight = new Set<string>();

function request(contract: ContractRef): void {
  const key = contractKey(contract);
  if (inflight.has(key) || key in useInfoStore.getState().infos) return;
  inflight.add(key);
  window.tape
    .getContractInfo(contract)
    .then(
      (info) => useInfoStore.setState((s) => ({ infos: { ...s.infos, [key]: info } })),
      () => undefined,
    )
    .finally(() => inflight.delete(key));
}

/** Contract details for an instrument: undefined while unknown, null when IB has no definition. */
export function useContractInfo(contract: ContractRef): ContractInfo | null | undefined {
  const key = contractKey(contract);
  const info = useInfoStore((s) => s.infos[key]);
  const connected = useMarketDataAvailable();
  useEffect(() => {
    if (connected) request(contract);
    // The key identifies the contract; the object identity may change on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);
  return info;
}
