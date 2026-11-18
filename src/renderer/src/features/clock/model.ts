// Where the clock widget sits (per device, localStorage): its offsets from the corner of the content
// area nearest to where it was left, so a resized window keeps it by that corner, and fitted inside
// the area when shown (a smaller window moves it in without forgetting where the user put it).

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** Offsets (px) of the widget's nearest edges from the area's `corner`. */
export interface ClockPlace {
  corner: Corner;
  dx: number;
  dy: number;
}

/** Space kept between the widget and the area's edges. */
export const CLOCK_MARGIN = 8;

/** The first place: the bottom-left corner (below the watchlist's rows, clear of the order ticket's controls). */
export const DEFAULT_PLACE: ClockPlace = { corner: 'sw', dx: 16, dy: 16 };

const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];
const LIMIT = 100_000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored place; anything missing or invalid is the default. */
export function parsePlace(raw: unknown): ClockPlace {
  if (!raw || typeof raw !== 'object') return DEFAULT_PLACE;
  const r = raw as Record<string, unknown>;
  if (!CORNERS.includes(r.corner as Corner) || !finite(r.dx) || !finite(r.dy)) return DEFAULT_PLACE;
  const fit = (n: number) => Math.round(Math.min(LIMIT, Math.max(0, n)));
  return { corner: r.corner as Corner, dx: fit(r.dx), dy: fit(r.dy) };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The widget's top-left within the area, kept inside it (by the margin where the area allows). */
export function clampPoint(p: Point, size: Size, area: Size): Point {
  return {
    x: Math.round(clamp(p.x, CLOCK_MARGIN, Math.max(CLOCK_MARGIN, area.width - CLOCK_MARGIN - size.width))),
    y: Math.round(clamp(p.y, CLOCK_MARGIN, Math.max(CLOCK_MARGIN, area.height - CLOCK_MARGIN - size.height))),
  };
}

/** The widget's top-left for a place, in an area, for its size. */
export function placePoint(place: ClockPlace, size: Size, area: Size): Point {
  const right = place.corner === 'ne' || place.corner === 'se';
  const bottom = place.corner === 'sw' || place.corner === 'se';
  const x = right ? area.width - place.dx - size.width : place.dx;
  const y = bottom ? area.height - place.dy - size.height : place.dy;
  return clampPoint({ x, y }, size, area);
}

/** The place of a widget left at top-left `p`: offsets from the corner its center is nearest. */
export function pointPlace(p: Point, size: Size, area: Size): ClockPlace {
  const right = p.x + size.width / 2 > area.width / 2;
  const bottom = p.y + size.height / 2 > area.height / 2;
  const corner: Corner = `${bottom ? 's' : 'n'}${right ? 'e' : 'w'}`;
  return {
    corner,
    dx: Math.max(0, Math.round(right ? area.width - p.x - size.width : p.x)),
    dy: Math.max(0, Math.round(bottom ? area.height - p.y - size.height : p.y)),
  };
}
