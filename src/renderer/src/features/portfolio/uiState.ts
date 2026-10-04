// Portfolio page UI state. Kept in a feature-local store so the selected tab, chart mode and
// range survive page switches (App remounts the page each time).

import { create } from 'zustand';
import type { EquityMode, RangeKey } from './calc';

export type PortfolioTab = 'dash' | 'pos' | 'perf';

interface PortfolioUi {
  tab: PortfolioTab;
  mode: EquityMode;
  range: RangeKey;
  setTab(tab: PortfolioTab): void;
  setMode(mode: EquityMode): void;
  setRange(range: RangeKey): void;
}

export const usePortfolioUi = create<PortfolioUi>()((set) => ({
  tab: 'dash',
  mode: 'value',
  range: 'YTD',
  setTab: (tab) => set({ tab }),
  setMode: (mode) => set({ mode }),
  setRange: (range) => set({ range }),
}));
