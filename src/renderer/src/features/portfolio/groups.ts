// The Positions table's groups (pure): which group a row belongs to (its underlying, so a stock sits
// with its options, or its sector), the order of the groups and of the rows within them, and which
// row carries an underlying's next-event chip. Groups are structure only: a group row shows its
// name, its count and its chip, never a sum (IB sends no group figures, and Tape adds none up).
//
// A group of one row draws no group row: the position row stands for its group (it carries the
// chip), so a stock-only portfolio does not show every row twice. Without grouping every row stands
// for itself. Futures and futures options are their own group (underlyingOf returns them); an
// option on a non-USD stock goes with the stock in its currency.

import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, Lang } from '@shared/types';
import { rowSize, underlyingOf, type PositionRow } from './calc';
import { COLUMNS, PINNED, applies, rowId, type CellCtx, type CellValue } from './columns';
import { sortBy, type GroupBy, type OrderGroup, type SortState } from './columnsState';
import { underlyingKey } from './exposure';

/**
 * The group a row belongs to: 'u:' and its underlying's contract key (an option goes under its
 * stock or index), 's:' and its sector key; without grouping 'r:' and the row's own id (the chips
 * count each row as its own group).
 */
export function groupKey(row: PositionRow, by: GroupBy): string {
  if (by === 'sector') return `s:${row.sector}`;
  if (by === 'none') return `r:${rowId(row)}`;
  return `u:${contractKey(underlyingOf(row.position.contract))}`;
}

export interface RowGroup {
  /** groupKey ('' for the one group of an ungrouped table). */
  key: string;
  kind: GroupBy;
  /** The underlying's label ("AAPL"), the sector key (messages.ts → sectorLabel names it), or ''. */
  label: string;
  underlying?: ContractRef;
  /** The group's rows in the order they came (the table's: largest |value| first). */
  ctxs: CellCtx[];
}

/** The rows by group, in the order each group's first row came; without grouping one group of all. */
export function groupRows(ctxs: readonly CellCtx[], by: GroupBy): RowGroup[] {
  if (by === 'none') return [{ key: '', kind: 'none', label: '', ctxs: [...ctxs] }];
  const out = new Map<string, RowGroup>();
  for (const c of ctxs) {
    const key = groupKey(c.row, by);
    let g = out.get(key);
    if (!g) {
      if (by === 'sector') g = { key, kind: by, label: c.row.sector, ctxs: [] };
      else {
        const underlying = underlyingOf(c.row.position.contract);
        g = { key, kind: by, label: contractLabel(underlying), underlying, ctxs: [] };
      }
      out.set(key, g);
    }
    g.ctxs.push(c);
  }
  return [...out.values()];
}

/** Ties keep IB's contract order (conId), so equal values never swap places. */
export function byConId(a: CellCtx, b: CellCtx): number {
  return (a.row.position.contract.conId ?? 0) - (b.row.position.contract.conId ?? 0) || a.row.key.localeCompare(b.row.key);
}

/** A group's size for the default order: its largest row's (calc.ts → rowSize: |Value| in the account currency). */
function groupSize(g: RowGroup): number {
  return g.ctxs.reduce((most, c) => Math.max(most, rowSize(c.row)), -1);
}

/**
 * The order to draw groups and rows in. Without a sort the groups whose largest position is the
 * largest come first, and the rows keep the order they came in (largest first). A sort orders the
 * rows within each group as the flat table did (blanks last, ties by conId) and the groups: Symbol by
 * their label (`labelOf`: a sector's name in the user's language), any other column by the group's
 * first row once sorted (its best member: Value descending puts the group of the largest position
 * first, Expiry ascending the group with the soonest expiry). Ties go by group key.
 */
export function orderGroups(groups: readonly RowGroup[], sort: SortState | null, lang: Lang, labelOf: (g: RowGroup) => string): OrderGroup[] {
  const def = sort ? COLUMNS[sort.id] : null;
  if (!sort || !def) {
    return groups
      .map((g) => ({ g, size: groupSize(g) }))
      .sort((a, b) => b.size - a.size || a.g.key.localeCompare(b.g.key))
      .map(({ g }) => ({ key: g.key, ids: g.ctxs.map((c) => rowId(c.row)) }));
  }
  const valueOf = (c: CellCtx): CellValue => (applies(def, c.row) ? (def.sortValue ?? def.value)(c) : undefined);
  const sorted = groups.map((g) => ({ g, ctxs: sortBy(g.ctxs, valueOf, def.sort, sort.dir, lang, byConId) }));
  type Sorted = (typeof sorted)[number];
  const groupValue = def.id === PINNED ? (s: Sorted): CellValue => labelOf(s.g) : (s: Sorted): CellValue => (s.ctxs.length ? valueOf(s.ctxs[0]) : undefined);
  return sortBy(sorted, groupValue, def.id === PINNED ? 'text' : def.sort, sort.dir, lang, (a, b) => a.g.key.localeCompare(b.g.key)).map((s) => ({
    key: s.g.key,
    ids: s.ctxs.map((c) => rowId(c.row)),
  }));
}

/**
 * Where each underlying's next event (`events`, by underlying key) shows: on its group row when
 * grouped by underlying with two or more rows; otherwise on its stock row (a lone row, a sector
 * group, no grouping), or on each of its option rows when no stock of it is held.
 */
export function chipTargets<E>(groups: readonly RowGroup[], by: GroupBy, events: ReadonlyMap<string, E>): { groups: Map<string, E>; rows: Map<string, E> } {
  const out = { groups: new Map<string, E>(), rows: new Map<string, E>() };
  if (!events.size) return out;
  const loose = new Map<string, CellCtx[]>();
  for (const g of groups) {
    if (by === 'underlying' && g.underlying && g.ctxs.length > 1) {
      const e = events.get(contractKey(g.underlying));
      if (e) out.groups.set(g.key, e);
      continue;
    }
    for (const c of g.ctxs) {
      const key = underlyingKey(c.row.position.contract);
      if (!events.has(key)) continue;
      const list = loose.get(key);
      if (list) list.push(c);
      else loose.set(key, [c]);
    }
  }
  for (const [key, ctxs] of loose) {
    const stocks = ctxs.filter((c) => c.row.position.contract.secType === 'STK');
    const options = ctxs.filter((c) => c.row.position.contract.secType === 'OPT' || c.row.position.contract.secType === 'FOP');
    for (const c of stocks.length ? stocks : options) out.rows.set(rowId(c.row), events.get(key)!);
  }
  return out;
}
