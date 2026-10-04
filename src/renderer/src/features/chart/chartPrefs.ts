// Feature-local UI preferences: timeframe and indicator chips (remembered in
// localStorage) plus the activity panel tab (kept for the session only).

import { create } from 'zustand';
import type { Timeframe } from '@shared/types';
import { TIMEFRAMES } from './chartMath';

export type ActivityTab = 'pos' | 'open';

interface ChartPrefs {
  timeframe: Timeframe;
  showMa: boolean;
  showVol: boolean;
  activityTab: ActivityTab;
  setTimeframe(tf: Timeframe): void;
  toggleMa(): void;
  toggleVol(): void;
  setActivityTab(tab: ActivityTab): void;
}

const STORAGE_KEY = 'tape.chart.prefs';

type Persisted = Pick<ChartPrefs, 'timeframe' | 'showMa' | 'showVol'>;

function load(): Persisted {
  const fallback: Persisted = { timeframe: '1D', showMa: true, showVol: true };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Persisted> | null;
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      timeframe: TIMEFRAMES.includes(raw.timeframe as Timeframe) ? (raw.timeframe as Timeframe) : fallback.timeframe,
      showMa: typeof raw.showMa === 'boolean' ? raw.showMa : fallback.showMa,
      showVol: typeof raw.showVol === 'boolean' ? raw.showVol : fallback.showVol,
    };
  } catch {
    return fallback;
  }
}

function save(p: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: preferences simply are not remembered.
  }
}

export const useChartPrefs = create<ChartPrefs>()((set, get) => {
  const persist = () => {
    const { timeframe, showMa, showVol } = get();
    save({ timeframe, showMa, showVol });
  };
  return {
    ...load(),
    activityTab: 'pos',
    setTimeframe: (timeframe) => {
      set({ timeframe });
      persist();
    },
    toggleMa: () => {
      set((s) => ({ showMa: !s.showMa }));
      persist();
    },
    toggleVol: () => {
      set((s) => ({ showVol: !s.showVol }));
      persist();
    },
    setActivityTab: (activityTab) => set({ activityTab }),
  };
});
