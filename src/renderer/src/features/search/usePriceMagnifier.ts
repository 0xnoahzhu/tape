// IB's price magnifier of a search result (100 when it is quoted in pence, cents or agorot), from
// the contract details. Looked up only for the rows that need it: a price in another currency.

import { useEffect, useState } from 'react';
import { contractKey } from '@shared/contract';
import type { ContractRef } from '@shared/types';

/** By listing; null when the details do not carry it (cached before Tape kept it). */
const known = new Map<string, number | null>();

const keyOf = (c: ContractRef) => `${contractKey(c)}|${c.conId ?? ''}`;

/** The magnifier of `contract`, undefined while unknown; pass null to look nothing up. */
export function usePriceMagnifier(contract: ContractRef | null): number | undefined {
  const key = contract ? keyOf(contract) : '';
  const [, setLoaded] = useState('');

  useEffect(() => {
    if (!contract || known.has(key)) return;
    let alive = true;
    window.tape.getContractInfo(contract).then(
      (info) => {
        if (!info) return;
        known.set(key, info.priceMagnifier ?? null);
        if (alive) setLoaded(key);
      },
      // Not connected or unknown to IB: the unit then follows the exchange (listing.ts).
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // The key identifies the listing; the object identity changes with every search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (key && known.get(key)) || undefined;
}
