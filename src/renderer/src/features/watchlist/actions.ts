// Writes watchlist changes: optimistic store update, then persistence in the main process
// (which broadcasts the saved lists back as a `watchlists` event).

import { contractKey } from '@shared/contract';
import type { ContractRef, Watchlist } from '@shared/types';
import { currentLang, nameOf } from '../../i18n';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { useWatchlistMessages } from './messages';
import { canDeleteGroup, deleteGroup, neighborGroupId, setItemName } from './model';

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
 * Deletes a group with its symbols, after a confirmation when it has any. The last group of a
 * list stays (model.ts → canDeleteGroup). Quotes of the removed symbols are released by the
 * panel's subscription set, the group's collapsed state by GroupList. `onDeleted` gets the group
 * now shown in its place (e.g. to move focus there).
 */
export function askDeleteGroup(listId: string, groupId: string, onDeleted?: (neighborId: string | undefined) => void): void {
  const list = useStore.getState().watchlists.find((l) => l.id === listId);
  const group = list?.groups.find((g) => g.id === groupId);
  if (!list || !group || !canDeleteGroup(list)) return;
  const run = () => {
    // From the latest list: a confirmation can be answered after the list changed elsewhere.
    const current = useStore.getState().watchlists.find((l) => l.id === listId);
    if (!current?.groups.some((g) => g.id === groupId) || !canDeleteGroup(current)) return;
    const neighborId = neighborGroupId(current, groupId);
    updateList(listId, (l) => deleteGroup(l, groupId));
    onDeleted?.(neighborId);
  };
  if (!group.items.length) {
    run();
    return;
  }
  const m = useWatchlistMessages.now();
  const lang = currentLang();
  const name = nameOf(group.name, lang);
  useStore.getState().ask({
    title: m.deleteGroup,
    rows: [
      { label: m.group, value: name },
      { label: m.list, value: nameOf(list.name, lang) },
      { label: m.symbols, value: String(group.items.length) },
    ],
    note: m.deleteGroupNote(name, group.items.length),
    label: m.delete,
    danger: true,
    run,
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
