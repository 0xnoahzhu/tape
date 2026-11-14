// Per-device localStorage keys of features that are gone, removed at startup so they do not linger
// in the Electron profile. Each removal is in try/catch: storage may be missing or refuse access.

/**
 * 'tape.dash.v1': the widget layout of the Portfolio dashboard, which is gone. 'tape.watchlist.current'
 * and 'tape.watchlist.closedGroups': the watchlist's current list and collapsed groups, gone with
 * the lists and sections (the watchlist is one level of tabs since Tape 0.32).
 */
export const RETIRED_STORAGE_KEYS = ['tape.dash.v1', 'tape.watchlist.current', 'tape.watchlist.closedGroups'] as const;

/** Removes the retired keys from `storage` (localStorage by default); a missing or failing storage is left alone. */
export function removeRetiredKeys(storage?: Pick<Storage, 'removeItem'> | null): void {
  let target = storage;
  try {
    // Reading localStorage itself throws where site data is blocked.
    if (target === undefined) target = globalThis.localStorage;
  } catch {
    return;
  }
  if (!target) return;
  for (const key of RETIRED_STORAGE_KEYS) {
    try {
      target.removeItem(key);
    } catch {
      // Storage unavailable: nothing to clean up this time.
    }
  }
}
