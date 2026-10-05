// Dashboard layout state. The layout is a per-device preference in localStorage ('tape.dash.v1',
// the design's key: a JSON array of { id, span }, read and written in try/catch); a missing or
// invalid value is the default layout, and Reset removes the key. Edit mode, the catalog and the
// drag in progress are not persisted. Locking ends edit mode and closes the catalog
// (state/lockActions.ts).

import { create } from 'zustand';
import { defaultLayout, moveWidget, removeWidget, sanitizeLayout, setSpan, toggleWidget, type Layout, type Span, type WidgetId } from './layout';

export const LAYOUT_STORAGE_KEY = 'tape.dash.v1';

/** The stored layout, or null for the default one. */
export function loadLayout(): Layout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw == null ? null : sanitizeLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveLayout(layout: Layout | null): void {
  try {
    if (layout) localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    else localStorage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    // Storage unavailable: the layout holds for this session only.
  }
}

interface DashboardLayoutStore {
  /** The user's layout; null = the default layout (nothing stored). */
  stored: Layout | null;
  /** Edit mode: widgets show their toolbars and can be dragged. */
  edit: boolean;
  /** The "Add widget" catalog is open. */
  pickerOpen: boolean;
  /** The widget being dragged, and the one under the pointer. */
  drag: WidgetId | null;
  over: WidgetId | null;
  setEdit(edit: boolean): void;
  setPickerOpen(open: boolean): void;
  setDrag(id: WidgetId | null): void;
  setOver(id: WidgetId | null): void;
  /** Ends a drag (drop or cancel). */
  endDrag(): void;
  /** Drops the dragged widget onto `to` (before it). */
  move(from: WidgetId, to: WidgetId): void;
  setSpan(id: WidgetId, span: Span): void;
  remove(id: WidgetId): void;
  /** Adds a widget at its default span, or removes it (the catalog's button). */
  toggle(id: WidgetId): void;
  /** Back to the default layout (removes the stored one). */
  reset(): void;
  /** Leaves edit mode and closes the catalog (Tape locked). */
  closeTransient(): void;
}

/** The default layout (never mutated: every layout change makes a new array). */
const DEFAULT: Layout = defaultLayout();

export const useDashboardLayout = create<DashboardLayoutStore>()((set, get) => {
  /** Applies a change to the current layout; an unchanged layout is not stored. */
  const commit = (change: (layout: Layout) => Layout) => {
    const base = get().stored ?? DEFAULT;
    const next = change(base);
    if (next === base) return;
    saveLayout(next);
    set({ stored: next });
  };
  return {
    stored: loadLayout(),
    edit: false,
    pickerOpen: false,
    drag: null,
    over: null,
    setEdit: (edit) => set(edit ? { edit } : { edit, drag: null, over: null }),
    setPickerOpen: (pickerOpen) => set({ pickerOpen }),
    setDrag: (drag) => set({ drag }),
    setOver: (over) => set((s) => (s.over === over ? s : { over })),
    endDrag: () => set({ drag: null, over: null }),
    move: (from, to) => {
      commit((l) => moveWidget(l, from, to));
      set({ drag: null, over: null });
    },
    setSpan: (id, span) => commit((l) => setSpan(l, id, span)),
    remove: (id) => commit((l) => removeWidget(l, id)),
    toggle: (id) => commit((l) => toggleWidget(l, id)),
    reset: () => {
      saveLayout(null);
      set({ stored: null });
    },
    closeTransient: () => set({ edit: false, pickerOpen: false, drag: null, over: null }),
  };
});

/** The layout to draw: the stored one or the default. */
export function useLayout(): Layout {
  const stored = useDashboardLayout((s) => s.stored);
  return stored ?? DEFAULT;
}
