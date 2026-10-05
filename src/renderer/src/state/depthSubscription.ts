// The Level 2 book has one subscription (main keeps one depth line; IB allows three): the depth
// view and the floating ticket's depth block share it. Each owner names the instrument it wants
// (null: none); the subscription is the newest owner's wish, and it is released when nobody
// wants one. Owners follow the selected instrument, so they never want different books for long.

import { contractKey } from '@shared/contract';
import type { ContractRef } from '@shared/types';

const owners = new Map<string, ContractRef>();
/** The key last sent (null: released; undefined: nothing sent yet). */
let sentKey: string | null | undefined;

/** The instrument the subscription should follow: the newest owner's. */
export function wantedDepth(all: ReadonlyMap<string, ContractRef>): ContractRef | null {
  let last: ContractRef | null = null;
  for (const c of all.values()) last = c;
  return last;
}

/**
 * Sets `owner`'s wish and updates the subscription when it changes (`force`: send again anyway,
 * e.g. after a reconnect). Rejects with main's error for the request that was sent.
 */
export async function setDepthOwner(owner: string, contract: ContractRef | null, force = false): Promise<void> {
  owners.delete(owner);
  if (contract) owners.set(owner, contract);
  const want = wantedDepth(owners);
  const key = want ? contractKey(want) : null;
  if (!force && key === sentKey) return;
  sentKey = key;
  await window.tape.setDepthSubscription(want);
}
