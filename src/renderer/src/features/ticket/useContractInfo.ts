// Contract details (minimum tick, multiplier) for the ticket, cached per instrument.

import { useEffect, useState } from 'react';
import { contractKey } from '@shared/contract';
import type { ContractInfo, ContractRef } from '@shared/types';
import { useStore } from '../../state/store';

const cache = new Map<string, ContractInfo>();
const inflight = new Map<string, Promise<ContractInfo | null>>();

function lookup(key: string, contract: ContractRef): Promise<ContractInfo | null> {
  let p = inflight.get(key);
  if (!p) {
    p = window.tape.getContractInfo(contract).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Resolves contract details; undefined until known (or when IB cannot resolve the contract). */
export function useContractInfo(contract: ContractRef): ContractInfo | undefined {
  const key = contractKey(contract);
  const connected = useStore((s) => s.connection.status === 'connected');
  const [state, setState] = useState<{ key: string; info: ContractInfo } | null>(() => {
    const hit = cache.get(key);
    return hit ? { key, info: hit } : null;
  });

  useEffect(() => {
    const hit = cache.get(key);
    if (hit) {
      setState({ key, info: hit });
      return;
    }
    if (!connected) return;
    let alive = true;
    lookup(key, contract)
      .then((info) => {
        // Only successful lookups are cached: a null may just mean "not connected yet".
        if (!info) return;
        cache.set(key, info);
        if (alive) setState({ key, info });
      })
      .catch(() => {
        // Falls back to a 0.01 tick; the ticket stays usable.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);

  return state?.key === key ? state.info : undefined;
}
