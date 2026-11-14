// Per-device watchlist view preferences kept in localStorage: the tab shown, the rows' sort and the
// columns' order and widths. Storage can be unavailable, so every access is guarded.

import { sanitizeColumns, WATCH_COLS, type WatchColumns, type WatchSort } from './model';

const TAB_KEY = 'tape.watchlist.tab';
const SORT_KEY = 'tape.watchlist.sort';
/** v2: Symbol has a width of its own and columns are sized from their right edge; widths start again from the defaults. */
const COLUMNS_KEY = 'tape.watchlist.columns.v2';

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
      if ((by === 'symbol' || WATCH_COLS.includes(by as never)) && (dir === 'asc' || dir === 'desc')) return { by: by as 'symbol', dir };
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

/** The saved columns, made whole (model.ts → sanitizeColumns). */
export function loadColumns(): WatchColumns {
  try {
    return sanitizeColumns(JSON.parse(window.localStorage.getItem(COLUMNS_KEY) ?? 'null'));
  } catch {
    return sanitizeColumns(null);
  }
}

export function saveColumns(cols: WatchColumns): void {
  try {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(cols));
  } catch {
    // Not persisted; the columns last for this session.
  }
}
