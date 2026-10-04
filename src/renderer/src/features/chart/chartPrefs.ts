// Feature-local UI preferences: interval, range, favorite intervals and ranges (the toolbar's
// chips) and indicator chips (remembered in localStorage) plus the activity panel tab (kept for
// the session only).
//
// The interval is one for all instruments (switching symbols keeps it), as before. Stored
// interval keys are the timeframe keys of the history service; the daily and longer ones keep
// their original names ('1D', '1W', '1M', '1Y', shown as D, W, M, Y), so preferences saved before
// the picker existed keep their interval, and their toolbar becomes the default favorites.

import { create } from 'zustand';
import { isTimeframe } from '@shared/timeframes';
import type { Timeframe } from '@shared/types';
import { DEFAULT_MAS, MA_PERIODS, type MaPeriod } from './chartMath';
import { isChartRange, rangeTimeframe, type ChartRange } from './ranges';
import { DEFAULT_FAVORITES, parseFavorites, toggleFavorite, type Favorites, type PickerItem } from './timeframePicker';

export type ActivityTab = 'pos' | 'open';

interface ChartPrefs {
  timeframe: Timeframe;
  /** The range the view is fitted to, until the user pans or zooms (null: none). */
  range: ChartRange | null;
  favorites: Favorites;
  /** Moving averages shown, in MA_PERIODS order. */
  mas: readonly MaPeriod[];
  showVol: boolean;
  activityTab: ActivityTab;
  /** Picks an interval (ends a range). */
  setTimeframe(tf: Timeframe): void;
  /** Picks a range and the interval it is shown with (in a plot `plotWidth` pixels wide, when known). */
  setRange(range: ChartRange, nowMs?: number, plotWidth?: number): void;
  /** The view left the range (a pan or zoom); the interval stays. */
  clearRange(): void;
  toggleFavorite(item: PickerItem): void;
  toggleMa(period: MaPeriod): void;
  toggleVol(): void;
  setActivityTab(tab: ActivityTab): void;
}

const STORAGE_KEY = 'tape.chart.prefs';

export type PersistedChartPrefs = Pick<ChartPrefs, 'timeframe' | 'range' | 'favorites' | 'mas' | 'showVol'>;

/**
 * Stored preferences, with defaults for anything missing or invalid. Before there were several
 * moving averages the store had a single `showMa` flag (MA20): on (the default) becomes the new
 * default set, off stays off (no moving averages). Before the picker there were no favorites:
 * the default favorites are the toolbar of that time.
 */
export function parseChartPrefs(raw: unknown): PersistedChartPrefs {
  const fallback: PersistedChartPrefs = { timeframe: '1D', range: null, favorites: DEFAULT_FAVORITES, mas: DEFAULT_MAS, showVol: true };
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Record<string, unknown>;
  const stored = r.mas;
  return {
    timeframe: isTimeframe(r.timeframe) ? r.timeframe : fallback.timeframe,
    range: isChartRange(r.range) ? r.range : null,
    favorites: parseFavorites(r.favorites),
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
    const { timeframe, range, favorites, mas, showVol } = get();
    save({ timeframe, range, favorites, mas, showVol });
  };
  return {
    ...load(),
    activityTab: 'pos',
    setTimeframe: (timeframe) => {
      set({ timeframe, range: null });
      persist();
    },
    setRange: (range, nowMs = Date.now(), plotWidth) => {
      set({ range, timeframe: rangeTimeframe(range, nowMs, plotWidth) });
      persist();
    },
    clearRange: () => {
      if (get().range === null) return;
      set({ range: null });
      persist();
    },
    toggleFavorite: (item) => {
      set((s) => ({ favorites: toggleFavorite(s.favorites, item) }));
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
