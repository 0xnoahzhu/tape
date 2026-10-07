// Portfolio page UI state. Kept in a feature-local store so the selected tab survives page
// switches (App remounts the page each time).

import { create } from 'zustand';
import { useStore } from '../../state/store';

/** Positions, working orders, today's trades. */
export type PortfolioTab = 'pos' | 'ord' | 'fill';

interface PortfolioUi {
  tab: PortfolioTab;
  setTab(tab: PortfolioTab): void;
}

export const usePortfolioUi = create<PortfolioUi>()((set) => ({
  tab: 'pos',
  setTab: (tab) => set({ tab }),
}));

/**
 * Opens the Portfolio page on a tab (⌘1 Positions, ⌘3 and the menu's Orders, "All orders ›",
 * notification clicks), or on the tab it last showed.
 */
export function showPortfolio(tab?: PortfolioTab): void {
  if (tab) usePortfolioUi.getState().setTab(tab);
  useStore.getState().setPage('acct');
}
