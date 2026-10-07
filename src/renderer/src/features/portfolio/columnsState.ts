// The Positions table's column choice, grouping and sort (pure): which columns show in which order
// and how wide (and the width a dragged edge gives), how the rows are grouped, the stored preferences
// and how they are read back, when a header press becomes a drag, where a header dragged across the
// table lands and how fast it scrolls the card at its sides, the sort cycle, the comparator and the
// group and row order held while the pointer is over the rows. Persisted by columnStore.ts; the
// groups themselves are groups.ts.

import type { Lang } from '@shared/types';
import { COLUMNS, DEFAULT_COLUMNS, PINNED, isColumnId, type CellValue, type ColumnDef, type ColumnId } from './columns';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  id: ColumnId;
  dir: SortDir;
}

/**
 * Widths in px the user gave columns by dragging a header's right edge. A column not in it has no
 * width of its own: it shares the spare width with the others (the default look).
 */
export type ColumnWidths = Readonly<Partial<Record<ColumnId, number>>>;

/**
 * How the table groups its rows: by underlying (a stock with its options), by sector (IB's industry,
 * options with their stock's), or not at all.
 */
export type GroupBy = 'underlying' | 'sector' | 'none';
export const GROUP_BYS: readonly GroupBy[] = ['underlying', 'sector', 'none'];
export const DEFAULT_GROUP_BY: GroupBy = 'underlying';

/**
 * What is stored: the shown columns (null = the default set), the sort (null = by size), the
 * widths the user set (of hidden columns too, so showing one again brings its width back) and the
 * grouping.
 */
export interface ColumnPrefs {
  columns: ColumnId[] | null;
  sort: SortState | null;
  widths: ColumnWidths;
  groupBy: GroupBy;
}

/**
 * Renamed column ids (old → new), so a stored choice keeps a column across a rename. Empty so far;
 * an id that is neither a column nor here is dropped.
 */
export const COLUMN_ALIASES: Readonly<Record<string, ColumnId>> = {};

/**
 * A stored column list: renamed ids mapped, unknown and repeated ids dropped, Symbol first. Columns
 * added to the catalog later are not added to it. Anything that is not an array is null (the
 * default set).
 */
export function sanitizeColumns(raw: unknown, aliases: Readonly<Record<string, ColumnId>> = COLUMN_ALIASES): ColumnId[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ColumnId[] = [PINNED];
  for (const v of raw) {
    const id = typeof v === 'string' ? (aliases[v] ?? v) : v;
    if (isColumnId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The widest a column can be dragged (px); the narrowest is its catalog width. */
export const MAX_COLUMN_WIDTH = 640;

/** A column's width in whole px, between its catalog width (its minimum) and MAX_COLUMN_WIDTH. */
export function clampWidth(id: ColumnId, w: number): number {
  return Math.max(COLUMNS[id].width, Math.min(MAX_COLUMN_WIDTH, Math.round(w)));
}

/**
 * Stored widths: renamed ids mapped, unknown ids and anything but a finite number dropped, each
 * clamped (a catalog width raised since keeps its new minimum). Anything that is not an object is
 * none. Hidden columns keep theirs.
 */
export function sanitizeWidths(raw: unknown, aliases: Readonly<Record<string, ColumnId>> = COLUMN_ALIASES): ColumnWidths {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<ColumnId, number>> = {};
  for (const [key, w] of Object.entries(raw)) {
    const id = aliases[key] ?? key;
    if (isColumnId(id) && typeof w === 'number' && Number.isFinite(w)) out[id] = clampWidth(id, w);
  }
  return out;
}

/** Sets a column's width (clamped); unchanged widths come back as they are. */
export function setColumnWidth(widths: ColumnWidths, id: ColumnId, w: number): ColumnWidths {
  const next = clampWidth(id, w);
  return widths[id] === next ? widths : { ...widths, [id]: next };
}

/**
 * The widths drawn while a column is sized by its right edge: the column at `w`, and the columns
 * left of it at the widths they were drawn at when the edge was pressed (`left`), so the spare width
 * the column takes or gives back goes to the columns right of it and its edge stays under the pointer.
 */
export function liveWidths(widths: ColumnWidths, id: ColumnId, w: number, left: ColumnWidths): ColumnWidths {
  return { ...widths, ...left, [id]: w };
}

/**
 * A column sized by dragging its right edge to `w` (clamped), with `left` the widths the columns left
 * of it were drawn at (liveWidths). Those that took a share of the spare width (drawn wider than their
 * catalog width, at most MAX_COLUMN_WIDTH, without a width of their own) keep that width too, so the
 * column stays where it was let go instead of the columns left of it sharing out what it took or gave
 * back. Columns at their catalog width (a table that scrolls sideways) keep sharing. Unchanged widths
 * come back as they are.
 */
export function sizeColumn(widths: ColumnWidths, id: ColumnId, w: number, left: ColumnWidths = {}): ColumnWidths {
  let next = widths;
  for (const [key, lw] of Object.entries(left)) {
    if (key === id || !isColumnId(key) || next[key] !== undefined || typeof lw !== 'number') continue;
    const drawn = Math.round(lw);
    if (drawn > COLUMNS[key].width && drawn <= MAX_COLUMN_WIDTH) next = setColumnWidth(next, key, drawn);
  }
  return setColumnWidth(next, id, w);
}

/**
 * The width a column's right edge dragged from `x0` to `x` sizes it to (clampWidth), the column drawn
 * `w0` wide at the press. A column drawn wider than the maximum (its share of a very wide card) is
 * sized only once the pointer brings it within the maximum: null until then, so a nudge never snaps
 * it down to the maximum.
 */
export function dragWidth(id: ColumnId, w0: number, x0: number, x: number): number | null {
  const w = w0 + x - x0;
  return w0 <= MAX_COLUMN_WIDTH || w <= MAX_COLUMN_WIDTH ? clampWidth(id, w) : null;
}

/** Gives a column back its default width (it shares the spare width again). */
export function resetColumnWidth(widths: ColumnWidths, id: ColumnId): ColumnWidths {
  if (widths[id] === undefined) return widths;
  const next: Partial<Record<ColumnId, number>> = { ...widths };
  delete next[id];
  return next;
}

/**
 * The table's grid tracks. A column the user sized is that wide; the others share the spare width
 * (Symbol twice as much as the others) and none gets narrower than its catalog width. Without
 * widths this is the table as it always was.
 */
export function gridTemplate(defs: readonly ColumnDef[], widths: ColumnWidths): string {
  return defs.map((d, i) => (widths[d.id] !== undefined ? `${widths[d.id]}px` : `minmax(${d.width}px,${i ? 1 : 2}fr)`)).join(' ');
}

/** The tracks' smallest total width (px, without gaps): narrower than that, the table scrolls sideways. */
export function tracksWidth(defs: readonly ColumnDef[], widths: ColumnWidths): number {
  return defs.reduce((sum, d) => sum + (widths[d.id] ?? d.width), 0);
}

/**
 * Stored preferences ({ columns, sort, widths, groupBy }); null when there are none to read. A sort
 * is kept only on a shown column with a valid direction. What an older version stored (no widths,
 * no grouping) reads as it did, grouped by underlying.
 */
export function sanitizePrefs(raw: unknown): ColumnPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const columns = sanitizeColumns(r.columns);
  const shown = columns ?? DEFAULT_COLUMNS;
  let sort: SortState | null = null;
  if (r.sort && typeof r.sort === 'object') {
    const { id, dir } = r.sort as Record<string, unknown>;
    const known = typeof id === 'string' ? (COLUMN_ALIASES[id] ?? id) : id;
    if (isColumnId(known) && shown.includes(known) && (dir === 'asc' || dir === 'desc')) sort = { id: known, dir };
  }
  const groupBy = GROUP_BYS.find((g) => g === r.groupBy) ?? DEFAULT_GROUP_BY;
  return { columns, sort, widths: sanitizeWidths(r.widths), groupBy };
}

/** Adds a column at the end, or removes a shown one. Symbol stays. */
export function toggleColumn(cols: readonly ColumnId[], id: ColumnId): readonly ColumnId[] {
  if (id === PINNED) return cols;
  return cols.includes(id) ? cols.filter((c) => c !== id) : [...cols, id];
}

export function removeColumn(cols: readonly ColumnId[], id: ColumnId): readonly ColumnId[] {
  return id === PINNED || !cols.includes(id) ? cols : cols.filter((c) => c !== id);
}

/**
 * Moves a shown column to index `to` of the list without it (clamped behind Symbol, which never
 * moves). Unchanged lists come back as they are.
 */
export function moveColumn(cols: readonly ColumnId[], id: ColumnId, to: number): readonly ColumnId[] {
  const from = cols.indexOf(id);
  if (id === PINNED || from < 0) return cols;
  const rest = cols.filter((c) => c !== id);
  const at = Math.max(1, Math.min(rest.length, Math.round(to)));
  if (at === from) return cols;
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Moves a shown column one place up (-1) or down (+1). */
export function moveColumnBy(cols: readonly ColumnId[], id: ColumnId, delta: -1 | 1): readonly ColumnId[] {
  const from = cols.indexOf(id);
  return from < 0 ? cols : moveColumn(cols, id, from + delta);
}

/**
 * The slot a header dragged across the table lands in, for the pointer at `x` over columns whose
 * header midpoints are `mids` (in column order): before the first column whose midpoint is right of
 * it, or after the last (slot = the number of columns). Symbol's midpoint is left out (it is sticky,
 * so it can lie over columns scrolled under it), and nothing lands before Symbol. `floor` (Symbol's
 * right edge) is the furthest left the pointer counts: over Symbol, the columns scrolled under it lie
 * left of the pointer, so a header never lands among columns out of view.
 */
export function dropSlot(mids: readonly number[], x: number, floor = -Infinity): number {
  const at = Math.max(x, floor);
  let slot = 1;
  for (let i = 1; i < mids.length; i++) if (mids[i] < at) slot++;
  return Math.min(slot, Math.max(1, mids.length));
}

/**
 * The index for moveColumn that drops a shown column in `slot` (as dropSlot gives it, counted in
 * the list with the column still in it); null when the column would stay where it is (a slot at
 * either of its own edges) or cannot move.
 */
export function slotTarget(cols: readonly ColumnId[], id: ColumnId, slot: number): number | null {
  const from = cols.indexOf(id);
  if (id === PINNED || from < 0) return null;
  const at = Math.max(1, Math.min(cols.length, Math.round(slot)));
  if (at === from || at === from + 1) return null;
  return at > from ? at - 1 : at;
}

/** Moves a shown column to a slot of the list (a header dropped between two others). */
export function moveColumnToSlot(cols: readonly ColumnId[], id: ColumnId, slot: number): readonly ColumnId[] {
  const to = slotTarget(cols, id, slot);
  return to == null ? cols : moveColumn(cols, id, to);
}

/**
 * A press on a header becomes a drag that moves its column once the pointer has gone further than
 * this sideways (px); a press released before is a click (a sort).
 */
export const REORDER_SLOP = 4;

/** The pointer pressed on a header at `x0` and now at `x` drags the header. */
export const startsReorder = (x0: number, x: number): boolean => Math.abs(x - x0) > REORDER_SLOP;

/** A header's horizontal extent (px, all in one frame, e.g. viewport x). */
export interface Span {
  left: number;
  right: number;
}

/**
 * Where a header dragged to `x` lands among the headers `cells` (in column order, Symbol first): the
 * slot (dropSlot, Symbol's right edge the floor) and the x its mark is drawn at, in the middle of the
 * `gap` before the slot's column (after the last column for the last slot), never over Symbol (a
 * column scrolled partly under it is marked just right of Symbol's edge). Null where the column
 * already is (slotTarget) and without headers.
 */
export function dropMark(cells: readonly Span[], x: number, cols: readonly ColumnId[], id: ColumnId, gap: number): { slot: number; x: number } | null {
  if (!cells.length) return null;
  const floor = cells[0].right;
  const slot = dropSlot(cells.map((r) => (r.left + r.right) / 2), x, floor);
  if (slotTarget(cols, id, slot) == null) return null;
  const edge = slot < cells.length ? cells[slot].left - gap / 2 : cells[cells.length - 1].right + gap / 2;
  return { slot, x: Math.max(edge, floor + 1) };
}

/**
 * How far a card scrolls sideways in a frame (px, negative = left) while a header pressed at `x0` is
 * dragged to `x`: within `edge` px of the view's left side `from` (Symbol's right edge) while the
 * header is dragged leftwards, or of its right side `to` while it is dragged rightwards, the faster
 * the closer to that side (or past it), up to `max`; else 0. A header pressed near a side and dragged
 * away from it does not scroll the card.
 */
export function edgeScroll(x: number, x0: number, from: number, to: number, edge: number, max: number): number {
  if (x < x0 && x < from + edge) return -Math.ceil(max * Math.min(1, (from + edge - x) / edge));
  if (x > x0 && x > to - edge) return Math.ceil(max * Math.min(1, (x - (to - edge)) / edge));
  return 0;
}

/** A header click: ascending, then descending, then no sort (the default order). */
export function nextSort(cur: SortState | null, id: ColumnId): SortState | null {
  if (cur?.id !== id) return { id, dir: 'asc' };
  return cur.dir === 'asc' ? { id, dir: 'desc' } : null;
}

const blank = (v: CellValue): boolean => v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));

const collators = new Map<Lang, Intl.Collator>();
function collator(lang: Lang): Intl.Collator {
  let c = collators.get(lang);
  if (!c) {
    c = new Intl.Collator(lang === 'zh' ? 'zh' : 'en', { numeric: true, sensitivity: 'base' });
    collators.set(lang, c);
  }
  return c;
}

/**
 * Compares two cell values in a direction. Blanks (no value, or the column does not apply) sort
 * last in both directions; text compares by the language's collation with numbers inside it
 * read as numbers ("A2" before "A10").
 */
export function compareValues(a: CellValue, b: CellValue, type: 'num' | 'text', dir: SortDir, lang: Lang = 'en'): number {
  const ba = blank(a);
  const bb = blank(b);
  if (ba || bb) return ba === bb ? 0 : ba ? 1 : -1;
  const cmp = type === 'num' ? Number(a) - Number(b) : collator(lang).compare(String(a), String(b));
  return dir === 'asc' ? cmp : -cmp;
}

/**
 * Sorts by one column. Ties keep the order `tieBreak` gives (the table: by conId); the sort is
 * stable, so with no tie-break they keep the input order.
 */
export function sortBy<T>(
  items: readonly T[],
  valueOf: (t: T) => CellValue,
  type: 'num' | 'text',
  dir: SortDir,
  lang: Lang = 'en',
  tieBreak: (a: T, b: T) => number = () => 0,
): T[] {
  const keyed = items.map((item) => ({ item, v: valueOf(item) }));
  keyed.sort((a, b) => compareValues(a.v, b.v, type, dir, lang) || tieBreak(a.item, b.item));
  return keyed.map((k) => k.item);
}

/**
 * The order drawn while it is held (the pointer is over the rows): the drawn rows keep their
 * places, rows that went away are dropped and new ones come last, in the wanted order.
 */
export function heldOrder(drawn: readonly string[], wanted: readonly string[]): string[] {
  const live = new Set(wanted);
  const kept = drawn.filter((id) => live.has(id));
  const known = new Set(kept);
  return [...kept, ...wanted.filter((id) => !known.has(id))];
}

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/** The drawn order of a grouped table: the groups in order, each with its row ids in order. */
export interface OrderGroup {
  key: string;
  ids: readonly string[];
}

/**
 * heldOrder for groups: the drawn groups keep their places, and within each group its drawn rows
 * keep theirs. Groups and rows that went away are dropped; new groups come last, and new rows last
 * in their group (a row that moved to another group shows in its new one), in the wanted order.
 */
export function heldGroups(drawn: readonly OrderGroup[], wanted: readonly OrderGroup[]): OrderGroup[] {
  const before = new Map(drawn.map((g) => [g.key, g.ids]));
  const now = new Map(wanted.map((g) => [g.key, g.ids]));
  return heldOrder(
    drawn.map((g) => g.key),
    wanted.map((g) => g.key),
  ).map((key) => ({ key, ids: heldOrder(before.get(key) ?? [], now.get(key) ?? []) }));
}

export const sameGroups = (a: readonly OrderGroup[], b: readonly OrderGroup[]): boolean =>
  a.length === b.length && a.every((g, i) => g.key === b[i].key && sameOrder(g.ids, b[i].ids));
