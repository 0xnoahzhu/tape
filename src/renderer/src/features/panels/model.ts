// Floating panels: the order ticket (Trade › Chart) and the options strategy builder
// (Trade › Options) can leave their right column and float inside the main window, above the page
// content. Pure geometry of the expanded panel and its collapsed bar, in CSS pixels relative to
// the content area (the part of the window under the top bar).

export type PanelId = 'ticket' | 'strategy';

export const PANEL_IDS: readonly PanelId[] = ['ticket', 'strategy'];

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Rect = Point & Size;

/** Distance kept between a panel (or its bar) and the edges of the content area. */
export const MARGIN = 8;

/** Where a new panel opens: under the Trade page's view tabs (46px and the 1px gap), plus the margin. */
export const DEFAULT_TOP = 47 + MARGIN;

/** The approved 16:10 layout: the size a panel opens at when the content area allows. */
export const DEFAULT_SIZE: Size = { width: 1000, height: 625 };

/** Smallest size a user can resize to: about the docked column; shorter content scrolls. */
export const MIN_SIZE: Record<PanelId, Size> = {
  ticket: { width: 340, height: 420 },
  strategy: { width: 384, height: 420 },
};

/** The collapsed bar: one row. */
export const BAR_SIZE: Size = { width: 420, height: 40 };

/** Height of an expanded panel's header (the drag region, with collapse and dock back). */
export const HEADER_H = 36;

/**
 * Below this panel width the content is the docked panel's single column. Narrower, the three
 * columns do not fit: the ticket's ask box and "More" order types, and the strategy's legs (they
 * need the docked builder's width to read "222.50 Put"), would be cut.
 */
export const LANDSCAPE_MIN_WIDTH = 900;

const clampNum = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** The room inside the content area once the margins are taken off (never negative). */
function room(area: Size): Size {
  return { width: Math.max(0, area.width - 2 * MARGIN), height: Math.max(0, area.height - 2 * MARGIN) };
}

/**
 * A panel's size within the content area: at least the minimum (unless the area is smaller: then
 * the area), at most the area.
 */
export function clampSize(size: Size, min: Size, area: Size): Size {
  const r = room(area);
  return {
    width: Math.round(clampNum(size.width, Math.min(min.width, r.width), r.width)),
    height: Math.round(clampNum(size.height, Math.min(min.height, r.height), r.height)),
  };
}

/** A position that keeps a box of `size` inside the content area (the margins included). */
export function clampPoint(p: Point, size: Size, area: Size): Point {
  return {
    x: Math.round(clampNum(p.x, MARGIN, area.width - MARGIN - size.width)),
    y: Math.round(clampNum(p.y, MARGIN, area.height - MARGIN - size.height)),
  };
}

/** A panel rectangle that fits the content area: the size first, then the position. */
export function clampRect(rect: Rect, min: Size, area: Size): Rect {
  const size = clampSize(rect, min, area);
  return { ...clampPoint(rect, size, area), ...size };
}

/**
 * Where a panel opens the first time: the default size (smaller in a small window), over the right
 * part of the content area under the view tabs.
 */
export function defaultRect(area: Size, min: Size): Rect {
  const r = room(area);
  const width = Math.min(DEFAULT_SIZE.width, r.width);
  const height = Math.min(DEFAULT_SIZE.height, area.height - DEFAULT_TOP - MARGIN);
  return clampRect({ x: area.width - MARGIN - width, y: DEFAULT_TOP, width, height }, min, area);
}

/** The panel's rectangle as shown: the remembered one (or the default) fitted into the area. */
export function panelRect(saved: Rect | null, area: Size, min: Size): Rect {
  return saved ? clampRect(saved, min, area) : defaultRect(area, min);
}

/** The bar's size: the default width, narrower in a narrow area. */
export function barSize(area: Size): Size {
  return { width: Math.min(BAR_SIZE.width, room(area).width), height: BAR_SIZE.height };
}

/** The bar's rectangle: its remembered position (default: the bottom-right corner) fitted into the area. */
export function barRect(saved: Point | null, area: Size): Rect {
  const size = barSize(area);
  const p = saved ?? { x: area.width - MARGIN - size.width, y: area.height - MARGIN - size.height };
  return { ...clampPoint(p, size, area), ...size };
}

/** A box dragged by (dx, dy) from where the drag started, kept inside the area. */
export function moveRect(start: Rect, dx: number, dy: number, area: Size): Rect {
  return { ...clampPoint({ x: start.x + dx, y: start.y + dy }, start, area), width: start.width, height: start.height };
}

/** The edges and corners a panel is resized from. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const EDGES: readonly Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export const EDGE_CURSOR: Record<Edge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

/**
 * The rectangle while an edge or corner is dragged by (dx, dy): the opposite edges stay where they
 * are; the size stays between the minimum and the area's edges (margins included).
 */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number, min: Size, area: Size): Rect {
  const r = room(area);
  const minW = Math.min(min.width, r.width);
  const minH = Math.min(min.height, r.height);
  let { x, y, width, height } = start;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  if (edge.includes('e')) width = clampNum(start.width + dx, minW, area.width - MARGIN - start.x);
  if (edge.includes('s')) height = clampNum(start.height + dy, minH, area.height - MARGIN - start.y);
  if (edge.includes('w')) {
    x = clampNum(start.x + dx, MARGIN, right - minW);
    width = right - x;
  }
  if (edge.includes('n')) {
    y = clampNum(start.y + dy, MARGIN, bottom - minH);
    height = bottom - y;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
