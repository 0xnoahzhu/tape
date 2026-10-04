// Feature-local UI preferences: timeframe and indicator chips (remembered in
// localStorage) plus the activity panel tab (kept for the session only).

import { create } from 'zustand';
import type { Timeframe } from '@shared/types';
import { DEFAULT_MAS, MA_PERIODS, TIMEFRAMES, type MaPeriod } from './chartMath';

export type ActivityTab = 'pos' | 'open';

interface ChartPrefs {
  timeframe: Timeframe;
  /** Moving averages shown, in MA_PERIODS order. */
  mas: readonly MaPeriod[];
  showVol: boolean;
  activityTab: ActivityTab;
  setTimeframe(tf: Timeframe): void;
  toggleMa(period: MaPeriod): void;
  toggleVol(): void;
  setActivityTab(tab: ActivityTab): void;
}

const STORAGE_KEY = 'tape.chart.prefs';

export type PersistedChartPrefs = Pick<ChartPrefs, 'timeframe' | 'mas' | 'showVol'>;

/**
 * Stored preferences, with defaults for anything missing or invalid. Before there were several
 * moving averages the store had a single `showMa` flag (MA20): on (the default) becomes the new
 * default set, off stays off (no moving averages).
 */
export function parseChartPrefs(raw: unknown): PersistedChartPrefs {
  const fallback: PersistedChartPrefs = { timeframe: '1D', mas: DEFAULT_MAS, showVol: true };
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Record<string, unknown>;
  const stored = r.mas;
  return {
    timeframe: TIMEFRAMES.includes(r.timeframe as Timeframe) ? (r.timeframe as Timeframe) : fallback.timeframe,
    mas: Array.isArray(stored) ? MA_PERIODS.filter((p) => stored.includes(p)) : r.showMa === false ? [] : fallback.mas,
    showVol: typeof r.showVol === 'boolean' ? r.showVol : fallback.showVol,
  };
}

/** `mas` with `period` switched on or off, in MA_PERIODS order. */
export function toggledMas(mas: readonly MaPeriod[], period: MaPeriod): MaPeriod[] {
  return MA_PERIODS.filter((p) => (p === period ? !mas.includes(p) : mas.includes(p)));
}

function load(): PersistedChartPrefs {
  try {
    return parseChartPrefs(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return parseChartPrefs(null);
  }
}

function save(p: PersistedChartPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: preferences simply are not remembered.
  }
}

export const useChartPrefs = create<ChartPrefs>()((set, get) => {
  const persist = () => {
    const { timeframe, mas, showVol } = get();
    save({ timeframe, mas, showVol });
  };
  return {
    ...load(),
    activityTab: 'pos',
    setTimeframe: (timeframe) => {
      set({ timeframe });
      persist();
    },
    toggleMa: (period) => {
      set((s) => ({ mas: toggledMas(s.mas, period) }));
      persist();
    },
    toggleVol: () => {
      set((s) => ({ showVol: !s.showVol }));
      persist();
    },
    setActivityTab: (activityTab) => set({ activityTab }),
  };
});
