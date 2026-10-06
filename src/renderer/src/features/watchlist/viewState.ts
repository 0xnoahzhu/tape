// Watchlist view state: the panel's current list (remembered per device, prefs.ts) and each list's
// "Add symbol" target group (this session only), which the chart star's picker sets too. Kept in a
// store so the panel's chips follow a group picked from the chart, and the target survives
// collapsing the panel and switching pages.

import { create } from 'zustand';
import { loadCurrentListId, saveCurrentListId } from './prefs';

interface WatchlistView {
  /** Remembered current list id; may be stale (resolve with model.ts → currentListOf). */
  currentId: string | null;
  /** Target group per list id: the panel's group chips, a new group, a group picked in the chart star's picker. */
  targets: Readonly<Record<string, string>>;
  selectList(id: string): void;
  setTarget(listId: string, groupId: string): void;
}

export const useWatchlistView = create<WatchlistView>()((set) => ({
  currentId: loadCurrentListId(),
  targets: {},
  selectList: (id) => {
    saveCurrentListId(id);
    set({ currentId: id });
  },
  setTarget: (listId, groupId) => set((s) => (s.targets[listId] === groupId ? s : { targets: { ...s.targets, [listId]: groupId } })),
}));
