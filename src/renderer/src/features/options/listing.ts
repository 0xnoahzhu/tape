// Strikes that are actually listed in each expiration. reqSecDefOptParams returns one strike
// list per trading class, but monthly, quarterly and LEAPS expirations list only part of it
// (e.g. AAPL 332.5 trades in the weeklies only). IB answers 200 "no security definition" for
// such a contract; the desk confirms that with a contract details lookup and then leaves the
// strike out of that expiration for the rest of the session.

import { useEffect } from 'react';
import { create } from 'zustand';
import { contractKey } from '@shared/contract';
import type { ContractRef, Quote } from '@shared/types';
import type { ChainExpiry } from './chain';
import type { NewLeg } from './strategies';

/** Identifies a strike of one expiration (both rights). */
export const strikeKey = (tradingClass: string | undefined, expiry: string | undefined, strike: number | undefined): string =>
  `${tradingClass ?? ''}|${expiry ?? ''}|${strike ?? ''}`;

const useListing = create<{ unlisted: ReadonlySet<string> }>()(() => ({ unlisted: new Set<string>() }));

/** Strikes known not to be listed in their expiration (strikeKey). */
export const useUnlisted = (): ReadonlySet<string> => useListing((s) => s.unlisted);

/** The chain without the strikes known not to be listed in each expiration. */
export function dropUnlisted(expiries: ChainExpiry[], unlisted: ReadonlySet<string>): ChainExpiry[] {
  if (!unlisted.size) return expiries;
  return expiries.map((e) => {
    const strikes = e.strikes.filter((k) => !unlisted.has(strikeKey(e.tradingClass, e.expiry, k)));
    return strikes.length === e.strikes.length ? e : { ...e, strikes };
  });
}

const checks = new Map<string, Promise<boolean>>();

/**
 * Whether an option contract exists, from IB's contract details (cached by the main process).
 * A missing contract marks its strike unlisted. A failed lookup (e.g. while disconnected)
 * counts as listed and is asked again next time.
 */
export function isListed(c: ContractRef): Promise<boolean> {
  const key = strikeKey(c.tradingClass, c.lastTradeDate, c.strike);
  let check = checks.get(key);
  if (!check) {
    check = window.tape.getContractInfo(c).then(
      (info) => {
        if (!info) useListing.setState((s) => ({ unlisted: new Set(s.unlisted).add(key) }));
        return !!info;
      },
      () => {
        checks.delete(key);
        return true;
      },
    );
    checks.set(key, check);
  }
  return check;
}

/** Confirms the "no security definition" (200) answers among `contracts`, which drops those strikes. */
export function useUnlistedProbe(contracts: ContractRef[], quotes: Record<string, Quote>): void {
  useEffect(() => {
    for (const c of contracts) if (quotes[contractKey(c)]?.error?.code === 200) void isListed(c);
  }, [contracts, quotes]);
}

/** Template rebuilds before the legs are taken as they are. */
const MAX_ROUNDS = 4;

/**
 * Builds strategy legs until every option leg sits on a listed strike: `build` gets the strikes
 * known to be unlisted and runs again whenever checking the legs finds new ones.
 */
export async function buildListed(build: (unlisted: ReadonlySet<string>) => NewLeg[], contractOf: (leg: NewLeg) => ContractRef): Promise<NewLeg[]> {
  let legs = build(useListing.getState().unlisted);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const listed = await Promise.all(legs.filter((l) => l.right !== 'S').map((l) => isListed(contractOf(l))));
    if (listed.every(Boolean)) break;
    legs = build(useListing.getState().unlisted);
  }
  return legs;
}
