// The Positions table's columns and sort, per device: localStorage 'tape.positions.v1' holds
// { columns, sort } (read and written in try/catch). A missing or unreadable value is the default
// set without a sort; Reset removes the key. A list the user changed keeps its columns: columns added
// to the catalog later are not added to it. The column editor's open state is not stored, and
// locking closes the editor (state/lockActions.ts).

import { create } from 'zustand';
import { DEFAULT_COLUMNS, type ColumnId } from './columns';
import { moveColumn, moveColumnBy, nextSort, removeColumn, sanitizePrefs, toggleColumn, type ColumnPrefs, type SortState } from './columnsState';

export const POSITIONS_STORAGE_KEY = 'tape.positions.v1';

const NONE: ColumnPrefs = { columns: null, sort: null };

/** The stored preferences, or the defaults. */
export function loadPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(POSITIONS_STORAGE_KEY);
    return (raw == null ? null : sanitizePrefs(JSON.parse(raw))) ?? NONE;
  } catch {
    return NONE;
  }
}

function savePrefs(p: ColumnPrefs): void {
  try {
    if (!p.columns && !p.sort) localStorage.removeItem(POSITIONS_STORAGE_KEY);
    // The default set is not written out, so it follows later defaults until the user changes it.
    else localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(p.columns ? p : { sort: p.sort }));
  } catch {
    // Storage unavailable: the choice holds for this session only.
  }
}

interface PositionColumnsStore {
  /** The user's columns in order; null = the default set (nothing stored). */
  columns: ColumnId[] | null;
  sort: SortState | null;
  /** The column editor is open. */
  editorOpen: boolean;
  /** Shows a column at the end, or hides a shown one. */
  toggle(id: ColumnId): void;
  remove(id: ColumnId): void;
  /** Moves a shown column to index `to` of the list without it (Symbol stays first). */
  move(id: ColumnId, to: number): void;
  moveBy(id: ColumnId, delta: -1 | 1): void;
  /** A header click: ascending, descending, no sort. */
  cycleSort(id: ColumnId): void;
  /** Back to the default columns, without a sort (removes the stored preferences). */
  reset(): void;
  setEditorOpen(open: boolean): void;
  /** Closes the editor (Tape locked). */
  closeTransient(): void;
}

export const usePositionColumns = create<PositionColumnsStore>()((set, get) => {
  const commit = (next: ColumnPrefs) => {
    savePrefs(next);
    set(next);
  };
  /** Applies a change to the shown columns; hiding the sorted column drops the sort. */
  const change = (edit: (cols: readonly ColumnId[]) => readonly ColumnId[]) => {
    const { columns, sort } = get();
    const base = columns ?? DEFAULT_COLUMNS;
    const next = edit(base);
    if (next === base) return;
    commit({ columns: [...next], sort: sort && next.includes(sort.id) ? sort : null });
  };
  return {
    ...loadPrefs(),
    editorOpen: false,
    toggle: (id) => change((c) => toggleColumn(c, id)),
    remove: (id) => change((c) => removeColumn(c, id)),
    move: (id, to) => change((c) => moveColumn(c, id, to)),
    moveBy: (id, delta) => change((c) => moveColumnBy(c, id, delta)),
    cycleSort: (id) => {
      const { columns, sort } = get();
      if (!(columns ?? DEFAULT_COLUMNS).includes(id)) return;
      commit({ columns, sort: nextSort(sort, id) });
    },
    reset: () => commit(NONE),
    setEditorOpen: (editorOpen) => set({ editorOpen }),
    closeTransient: () => set({ editorOpen: false }),
  };
});

/** The columns to draw: the stored ones or the default set. */
export function useShownColumns(): readonly ColumnId[] {
  return usePositionColumns((s) => s.columns) ?? DEFAULT_COLUMNS;
}
