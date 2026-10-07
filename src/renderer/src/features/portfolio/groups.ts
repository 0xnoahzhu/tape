// The Positions table's groups (pure): which group a row belongs to (its underlying, so a stock sits
// with its options, or its sector), what a group row shows in each column (the rows' sum where a
// sum means something, columns.ts → agg), the order of the groups and of the rows within them, the
// toolbar's "Top 3 = 41% of net liq" and which row carries an underlying's next-event chip.
//
// A group of one row draws no group row: the position row stands for its group (it carries the chip
// and the % NLV accent), so a stock-only portfolio does not show every row twice. Without grouping
// every row stands for itself. Futures and futures options are their own group (underlyingOf
// returns them); an option on a non-USD stock goes with the stock in its currency.

import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, Lang } from '@shared/types';
import { underlyingOf, type PositionRow } from './calc';
import { COLUMNS, PINNED, applies, rowId, type CellCtx, type CellValue, type ColumnDef } from './columns';
import { sortBy, type GroupBy, type OrderGroup, type SortState } from './columnsState';
import { underlyingKey } from './exposure';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Share of net liquidation (%) from which a group's or a lone row's % NLV is highlighted. */
export const CONCENTRATION_FLAG = 20;

/** A net share of net liquidation at or above CONCENTRATION_FLAG, long or short. */
export const isConcentrated = (weight: number | null | undefined): boolean => finite(weight) && Math.abs(weight) >= CONCENTRATION_FLAG;

/**
 * The group a row belongs to: 'u:' and its underlying's contract key (an option goes under its
 * stock or index), 's:' and its sector key; without grouping 'r:' and the row's own id (the Top 3
 * and the chips count each row as its own group).
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

/** Whether rows are in more than one currency. */
const mixesCurrencies = (ctxs: readonly CellCtx[]): boolean => new Set(ctxs.map((c) => c.row.position.contract.currency ?? '')).size > 1;

/**
 * Whether a group's sum of a column is in the account currency, not the rows' own: a 'money'
 * column over rows in more than one currency (aggregate converts each with its FX rate).
 */
export function inAccountCurrency(def: ColumnDef, ctxs: readonly CellCtx[]): boolean {
  return def.agg === 'money' && mixesCurrencies(ctxs.filter((c) => applies(def, c.row)));
}

/**
 * What a group row shows in a column: the sum of the rows the column applies to (columns.ts →
 * agg); a 'money' column whose rows are in more than one currency adds them up in the account
 * currency, each × its FX rate (inAccountCurrency). null (an empty cell) when the column does not
 * add up, applies to none of the rows, or mixes underlyings ('units'); undefined ("—") while a row's
 * value (or, across currencies, its rate) is unknown, never a partial sum.
 */
export function aggregate(def: ColumnDef, ctxs: readonly CellCtx[]): number | null | undefined {
  if (!def.agg) return null;
  const rows = ctxs.filter((c) => applies(def, c.row));
  if (!rows.length) return null;
  if (def.agg === 'units' && new Set(rows.map((c) => underlyingKey(c.row.position.contract))).size > 1) return null;
  const base = def.agg === 'money' && mixesCurrencies(rows);
  let sum = 0;
  for (const c of rows) {
    const v = def.value(c);
    if (!finite(v)) return undefined;
    if (!base) sum += v;
    else if (finite(c.row.fx)) sum += v * c.row.fx;
    else return undefined;
  }
  return sum;
}

/** Ties keep IB's contract order (conId), so equal values never swap places. */
export function byConId(a: CellCtx, b: CellCtx): number {
  return (a.row.position.contract.conId ?? 0) - (b.row.position.contract.conId ?? 0) || a.row.key.localeCompare(b.row.key);
}

/** Σ |value in the account currency| of a group's rows (the value where the rate is unknown). */
function groupSize(g: RowGroup): number {
  let sum = 0;
  for (const c of g.ctxs) {
    const v = c.row.valueBase ?? c.row.value;
    if (finite(v)) sum += Math.abs(v);
  }
  return sum;
}

/**
 * The order to draw groups and rows in. Without a sort the largest groups come first (Σ |value|)
 * and the rows keep the order they came in. A sort orders the rows within each group as the flat
 * table did (blanks last, ties by conId) and the groups: Symbol by their label (`labelOf`: a
 * sector's name in the user's language), a column that adds up by the group's sum (blank, as an
 * empty or "—" group cell, last), any other column by the group's first row once sorted (its best
 * member: by DTE ascending, the group with the soonest expiry first). Ties go by group key.
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
  const groupValue =
    def.id === PINNED
      ? (s: Sorted): CellValue => labelOf(s.g)
      : def.agg
        ? (s: Sorted): CellValue => aggregate(def, s.g.ctxs) ?? undefined
        : (s: Sorted): CellValue => (s.ctxs.length ? valueOf(s.ctxs[0]) : undefined);
  return sortBy(sorted, groupValue, def.id === PINNED ? 'text' : def.sort, sort.dir, lang, (a, b) => a.g.key.localeCompare(b.g.key)).map((s) => ({
    key: s.g.key,
    ids: s.ctxs.map((c) => rowId(c.row)),
  }));
}

/**
 * The toolbar's "Top 3 = 41% of net liq": the `n` largest groups' shares of net liquidation added
 * up, each group's share being |Σ its rows' signed % NLV| (net, as its group row shows: a short call
 * against the stock lowers it). Without grouping each row is its own group. `n` is the number
 * counted (fewer when there are fewer groups); undefined without rows or while a row's share is
 * unknown (net liquidation or its exchange rate missing).
 */
export function topShare(rows: readonly PositionRow[], by: GroupBy, n = 3): { n: number; pct: number } | undefined {
  if (!rows.length) return undefined;
  const sums = new Map<string, number>();
  for (const r of rows) {
    if (!finite(r.weight)) return undefined;
    const key = groupKey(r, by);
    sums.set(key, (sums.get(key) ?? 0) + r.weight);
  }
  const top = [...sums.values()]
    .map(Math.abs)
    .sort((a, b) => b - a)
    .slice(0, n);
  return { n: top.length, pct: top.reduce((s, v) => s + v, 0) };
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
