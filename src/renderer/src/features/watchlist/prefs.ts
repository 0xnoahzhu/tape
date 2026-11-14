// Per-device watchlist view preferences kept in localStorage: the tab shown and the rows' sort.
// Storage can be unavailable, so every access is guarded.

import type { WatchSort } from './model';

const TAB_KEY = 'tape.watchlist.tab';
const SORT_KEY = 'tape.watchlist.sort';

export function loadTab(): string | null {
  try {
    return window.localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

export function saveTab(tab: string): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Not persisted; the view still works for this session.
  }
}

/** The saved sort; null (the tabs' own order) when there is none or it is not one. */
export function loadSort(): WatchSort {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(SORT_KEY) ?? 'null');
    if (v && typeof v === 'object') {
      const { by, dir } = v as Record<string, unknown>;
      if ((by === 'symbol' || by === 'change') && (dir === 'asc' || dir === 'desc')) return { by, dir };
    }
  } catch {
    // Unreadable: the tabs' own order.
  }
  return null;
}

export function saveSort(sort: WatchSort): void {
  try {
    window.localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    // Not persisted; the sort lasts for this session.
  }
}
