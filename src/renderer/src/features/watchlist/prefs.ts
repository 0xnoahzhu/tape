// Per-device watchlist view preferences kept in localStorage: the current list and
// which groups are collapsed. Storage can be unavailable, so every access is guarded.

const CURRENT_KEY = 'tape.watchlist.current';
const CLOSED_KEY = 'tape.watchlist.closedGroups';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; the view still works for this session.
  }
}

export function loadCurrentListId(): string | null {
  return read(CURRENT_KEY);
}

export function saveCurrentListId(id: string): void {
  write(CURRENT_KEY, id);
}

/** Collapsed groups keyed by `${listId}:${groupId}`. */
export function loadClosedGroups(): Record<string, boolean> {
  const raw = read(CLOSED_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function saveClosedGroups(closed: Record<string, boolean>): void {
  write(CLOSED_KEY, JSON.stringify(closed));
}

export const groupPrefKey = (listId: string, groupId: string): string => `${listId}:${groupId}`;
