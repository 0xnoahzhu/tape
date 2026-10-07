// Portfolio page UI state. Kept in a feature-local store so the selected tab survives page
// switches (App remounts the page each time).

import { create } from 'zustand';

export type PortfolioTab = 'dash' | 'pos';

interface PortfolioUi {
  tab: PortfolioTab;
  setTab(tab: PortfolioTab): void;
}

export const usePortfolioUi = create<PortfolioUi>()((set) => ({
  tab: 'dash',
  setTab: (tab) => set({ tab }),
}));
