// Per-device watchlist view preference kept in localStorage: the tab shown. Storage can be
// unavailable, so every access is guarded.

const TAB_KEY = 'tape.watchlist.tab';

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
