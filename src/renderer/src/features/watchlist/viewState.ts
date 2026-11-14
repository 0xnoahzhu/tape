// Watchlist view state: the tab shown (remembered per device, prefs.ts) and the tab "Add symbol"
// adds to while All is shown (this session only; the chart star's picker sets it too). Kept in a
// store so it survives collapsing the panel and switching pages.

import { create } from 'zustand';
import { ALL_TAB } from './model';
import { loadTab, saveTab } from './prefs';

interface WatchlistView {
  /** Remembered tab: All or a group id; may be stale (resolve with model.ts → resolveTab). */
  tab: string;
  /** The tab "Add symbol" adds to on All; may be stale (model.ts → targetGroupOf). */
  target: string | undefined;
  /** Shows a tab; a group tab becomes the target too. */
  selectTab(tab: string): void;
  setTarget(groupId: string): void;
}

export const useWatchlistView = create<WatchlistView>()((set) => ({
  tab: loadTab() ?? ALL_TAB,
  target: undefined,
  selectTab: (tab) => {
    saveTab(tab);
    set(tab === ALL_TAB ? { tab } : { tab, target: tab });
  },
  setTarget: (groupId) => set({ target: groupId }),
}));
