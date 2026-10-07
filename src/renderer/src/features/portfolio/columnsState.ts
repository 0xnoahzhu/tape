// The Positions table's column choice and sort (pure): which columns show in which order, the
// stored preferences and how they are read back, the sort cycle, the comparator and the row
// order held while the pointer is over the rows. Persisted by columnStore.ts.

import type { Lang } from '@shared/types';
import { DEFAULT_COLUMNS, PINNED, isColumnId, type CellValue, type ColumnId } from './columns';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  id: ColumnId;
  dir: SortDir;
}

/** What is stored: the shown columns (null = the default set) and the sort (null = by size). */
export interface ColumnPrefs {
  columns: ColumnId[] | null;
  sort: SortState | null;
}

/**
 * Renamed column ids (old → new), so a stored choice keeps a column across a rename. Empty so far;
 * an id that is neither a column nor here is dropped.
 */
export const COLUMN_ALIASES: Readonly<Record<string, ColumnId>> = {};

/**
 * A stored column list: renamed ids mapped, unknown and repeated ids dropped, Symbol first. Columns
 * added to the catalog later are not added to it (like the dashboard's layout). Anything that is
 * not an array is null (the default set).
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

/**
 * Stored preferences ({ columns, sort }); null when there are none to read. A sort is kept only on
 * a shown column with a valid direction.
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
  return { columns, sort };
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
