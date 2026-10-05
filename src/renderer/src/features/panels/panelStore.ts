// Per device (localStorage): which panels float, whether they are collapsed to their bar, and
// where the expanded panel and the bar were left. A panel that floated at quit floats again at
// launch. Positions are relative to the content area and fitted into it when shown (model.ts), so
// a smaller window moves a panel inside without forgetting where the user put it.

import { create } from 'zustand';
import { PANEL_IDS, type PanelId, type Point, type Rect } from './model';

export interface PanelPrefs {
  /** In the main window as a floating panel (else docked in its right column). */
  floating: boolean;
  /** A floating panel shrunk to its bar. */
  collapsed: boolean;
  /** The expanded panel's last rectangle (null: the default place). */
  rect: Rect | null;
  /** The bar's last position (null: the bottom-right corner). */
  bar: Point | null;
}

export type PanelsPrefs = Record<PanelId, PanelPrefs>;

const STORAGE_KEY = 'tape.floatingPanels';

const DOCKED: PanelPrefs = { floating: false, collapsed: false, rect: null, bar: null };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const LIMIT = 100_000;
const inRange = (n: number) => Math.round(Math.min(LIMIT, Math.max(-LIMIT, n)));

function parsePoint(raw: unknown): Point | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return finite(r.x) && finite(r.y) ? { x: inRange(r.x), y: inRange(r.y) } : null;
}

function parseRect(raw: unknown): Rect | null {
  const p = parsePoint(raw);
  if (!p) return null;
  const r = raw as Record<string, unknown>;
  return finite(r.width) && finite(r.height) && r.width > 0 && r.height > 0 ? { ...p, width: inRange(r.width), height: inRange(r.height) } : null;
}

/** Stored preferences; anything missing or invalid is docked, expanded and at the default place. */
export function parsePanels(raw: unknown): PanelsPrefs {
  const out = { ticket: { ...DOCKED }, strategy: { ...DOCKED } };
  if (!raw || typeof raw !== 'object') return out;
  for (const id of PANEL_IDS) {
    const p = (raw as Record<string, unknown>)[id];
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    out[id] = { floating: r.floating === true, collapsed: r.collapsed === true, rect: parseRect(r.rect), bar: parsePoint(r.bar) };
  }
  return out;
}

function load(): PanelsPrefs {
  try {
    return parsePanels(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return parsePanels(null);
  }
}

function save(p: PanelsPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: the panels simply are not remembered.
  }
}

interface PanelStore {
  panels: PanelsPrefs;
  /** Pops a panel out (floating, expanded) or docks it back in its column. */
  setFloating(id: PanelId, floating: boolean): void;
  /** Collapses a floating panel to its bar or expands it (nothing for a docked panel). */
  setCollapsed(id: PanelId, collapsed: boolean): void;
  setRect(id: PanelId, rect: Rect): void;
  setBar(id: PanelId, bar: Point): void;
  /** Collapses every floating panel (Tape locked). */
  collapseAll(): void;
}

export const usePanels = create<PanelStore>()((set, get) => {
  const patch = (id: PanelId, p: Partial<PanelPrefs>) => {
    const prev = get().panels[id];
    const next = { ...prev, ...p };
    if ((Object.keys(p) as (keyof PanelPrefs)[]).every((k) => prev[k] === next[k])) return;
    set((s) => ({ panels: { ...s.panels, [id]: next } }));
    save(get().panels);
  };
  return {
    panels: load(),
    setFloating: (id, floating) => patch(id, { floating, collapsed: false }),
    setCollapsed: (id, collapsed) => {
      if (get().panels[id].floating) patch(id, { collapsed });
    },
    setRect: (id, rect) => patch(id, { rect }),
    setBar: (id, bar) => patch(id, { bar }),
    collapseAll: () => {
      for (const id of PANEL_IDS) if (get().panels[id].floating) patch(id, { collapsed: true });
    },
  };
});

/** Whether panel `id` floats and is expanded / collapsed (selectors). */
export const isFloating = (id: PanelId) => (s: PanelStore) => s.panels[id].floating;
export const isCollapsed = (id: PanelId) => (s: PanelStore) => s.panels[id].floating && s.panels[id].collapsed;
