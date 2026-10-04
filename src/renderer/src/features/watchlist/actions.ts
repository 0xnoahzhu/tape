// Writes watchlist changes: optimistic store update, then persistence in the main process
// (which broadcasts the saved lists back as a `watchlists` event).

import { contractKey } from '@shared/contract';
import type { ContractRef, Watchlist } from '@shared/types';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { useWatchlistMessages } from './messages';
import { setItemName } from './model';

export function commitWatchlists(next: Watchlist[]): void {
  if (next === useStore.getState().watchlists) return;
  useStore.setState({ watchlists: next });
  window.tape.saveWatchlists(next).catch((err: unknown) => {
    useStore.getState().showToast(useWatchlistMessages.now().saveFailed(errorText(err)), 'error');
  });
}

/** Applies `fn` to the latest lists (never a stale render-time copy) and commits the result. */
export function updateWatchlists(fn: (lists: Watchlist[]) => Watchlist[]): void {
  commitWatchlists(fn(useStore.getState().watchlists));
}

/** Applies `fn` to one list, if it still exists. */
export function updateList(id: string, fn: (list: Watchlist) => Watchlist): void {
  updateWatchlists((lists) => {
    const list = lists.find((l) => l.id === id);
    if (!list) return lists;
    const next = fn(list);
    return next === list ? lists : lists.map((l) => (l.id === id ? next : l));
  });
}

/**
 * Items added without a search description (typed ticker, empty IB description) get their
 * name from contract details when IB knows the contract. Failures leave the name empty.
 */
export function fillMissingName(listId: string, contract: ContractRef): void {
  window.tape.getContractInfo(contract).then(
    (info) => {
      const name = info?.longName?.trim();
      if (name) updateList(listId, (l) => setItemName(l, contractKey(contract), name));
    },
    () => undefined,
  );
}
