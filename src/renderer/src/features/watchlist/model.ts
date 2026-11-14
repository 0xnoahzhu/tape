// Pure watchlist operations. Every function returns new objects and never mutates its input,
// so results can be written to the store and sent to the main process as they are.
//
// The watchlist is one level of tabs: the groups of the tabs list (shared/defaults.ts →
// TABS_LIST_ID), with "All" before them. A symbol may be in several tabs, once per tab; All shows
// each symbol once. The ticker list (TICKER_LIST_ID) holds the top bar's indices.

import { contractKey, contractLabel } from '@shared/contract';
import { TABS_LIST_ID, TICKER_LIST_ID } from '@shared/defaults';
import type { ContractRef, Lang, LocalizedName, SymbolMatch, WatchItem, WatchGroup, Watchlist } from '@shared/types';
import { rankMatches } from '../search/listing';

/** The tab that shows every symbol of the watchlist once. */
export const ALL_TAB = 'all';
/** Number of search suggestions shown under the add-symbol input (as in the design). */
export const MAX_SUGGESTIONS = 6;

export const itemKey = (item: WatchItem): string => contractKey(item.contract);

export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function listItemCount(list: Watchlist): number {
  return list.groups.reduce((n, g) => n + g.items.length, 0);
}

/** Every instrument of a list, in display order, without duplicates. */
export function listContracts(list: Watchlist): ContractRef[] {
  const seen = new Set<string>();
  const out: ContractRef[] = [];
  for (const g of list.groups) {
    for (const item of g.items) {
      const k = itemKey(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item.contract);
    }
  }
  return out;
}

export function listKeys(list: Watchlist): Set<string> {
  return new Set(list.groups.flatMap((g) => g.items.map(itemKey)));
}

export function listHas(list: Watchlist, key: string): boolean {
  return list.groups.some((g) => g.items.some((i) => itemKey(i) === key));
}

export function groupHas(group: WatchGroup, key: string): boolean {
  return group.items.some((i) => itemKey(i) === key);
}

/** The tabs list and the ticker list of the saved lists (shared/defaults.ts). */
export const tabsListOf = (lists: Watchlist[]): Watchlist | undefined => lists.find((l) => l.id === TABS_LIST_ID);
export const tickerListOf = (lists: Watchlist[]): Watchlist | undefined => lists.find((l) => l.id === TICKER_LIST_ID);

/**
 * Appends an item to a group (the first group when `groupId` is unknown). A list without
 * groups gets one named `defaultGroupName`. A group never holds an item twice; other groups may
 * hold it too.
 */
export function addItem(list: Watchlist, groupId: string | undefined, item: WatchItem, defaultGroupName: LocalizedName, groupIdForNew: string = newId('g')): Watchlist {
  if (!list.groups.length) return { ...list, groups: [{ id: groupIdForNew, name: defaultGroupName, items: [item] }] };
  const target = list.groups.find((g) => g.id === groupId) ?? list.groups[0];
  if (groupHas(target, itemKey(item))) return list;
  return { ...list, groups: list.groups.map((g) => (g.id === target.id ? { ...g, items: [...g.items, item] } : g)) };
}

export function removeItem(list: Watchlist, groupId: string, key: string): Watchlist {
  return { ...list, groups: list.groups.map((g) => (g.id === groupId ? { ...g, items: g.items.filter((i) => itemKey(i) !== key) } : g)) };
}

/** Moves an item to the end of another group (out of `fromGroupId`); a group that has it already keeps its own place. */
export function moveItem(list: Watchlist, fromGroupId: string, toGroupId: string, key: string): Watchlist {
  if (fromGroupId === toGroupId) return list;
  const item = list.groups.find((g) => g.id === fromGroupId)?.items.find((i) => itemKey(i) === key);
  if (!item || !list.groups.some((g) => g.id === toGroupId)) return list;
  return {
    ...list,
    groups: list.groups.map((g) => {
      if (g.id === fromGroupId) return { ...g, items: g.items.filter((i) => itemKey(i) !== key) };
      if (g.id === toGroupId) return { ...g, items: [...g.items.filter((i) => itemKey(i) !== key), item] };
      return g;
    }),
  };
}

/**
 * Moves the instrument `key` out of group `fromGroupId` to position `index` of group `toGroupId`
 * (counted among that group's other items: 0 first, their count last); the same group reorders it.
 * Unchanged when either group or the item is missing.
 */
export function moveItemTo(list: Watchlist, fromGroupId: string, key: string, toGroupId: string, index: number): Watchlist {
  const item = list.groups.find((g) => g.id === fromGroupId)?.items.find((i) => itemKey(i) === key);
  if (!item || !list.groups.some((g) => g.id === toGroupId)) return list;
  const groups = list.groups.map((g) => (g.id === fromGroupId ? { ...g, items: g.items.filter((i) => itemKey(i) !== key) } : g));
  return {
    ...list,
    groups: groups.map((g) => {
      if (g.id !== toGroupId) return g;
      const items = g.items.filter((i) => itemKey(i) !== key);
      const at = Math.max(0, Math.min(items.length, Math.round(index)));
      return { ...g, items: [...items.slice(0, at), item, ...items.slice(at)] };
    }),
  };
}

/** Moves group `groupId` to position `index` among the other groups (0 first, their count last). */
export function moveGroupTo(list: Watchlist, groupId: string, index: number): Watchlist {
  const group = list.groups.find((g) => g.id === groupId);
  if (!group) return list;
  const rest = list.groups.filter((g) => g.id !== groupId);
  const at = Math.max(0, Math.min(rest.length, Math.round(index)));
  return { ...list, groups: [...rest.slice(0, at), group, ...rest.slice(at)] };
}

/**
 * How many tabs of the tab bar fit (the first ones, in order): all of them when their widths
 * (`tabs`, each with its gap) fit `room`, else as many as fit with the dropdown of the others
 * (`moreWidth`) after them, at least none.
 */
export function fitTabs(tabs: readonly number[], room: number, moreWidth: number): number {
  const total = tabs.reduce((a, b) => a + b, 0);
  if (total <= room) return tabs.length;
  let used = moreWidth;
  let n = 0;
  while (n < tabs.length && used + tabs[n] <= room) used += tabs[n++];
  return n;
}

// ---------------------------------------------------------------------------
// Sorting the rows

/** The watchlist's columns after Symbol (always first): last price, today's change and change in %. */
export const WATCH_COLS = ['last', 'chg', 'pct'] as const;
export type WatchCol = (typeof WATCH_COLS)[number];
export type WatchSortBy = 'symbol' | WatchCol;

/** Default widths (px) of the columns after Symbol and of Symbol, and the range they are sized in. */
export const COL_WIDTHS: Readonly<Record<WatchCol, number>> = { last: 64, chg: 50, pct: 54 };
export const SYMBOL_W = 64;
export const COL_MIN_W = 36;
export const COL_MAX_W = 180;
export const SYMBOL_MIN_W = 44;
/**
 * How far each column gives way in a narrow panel: its usual figures whole ("582.75", "+5.35",
 * "+12.34%" in the rows' fonts). The watchlist's least width (pages/TradePage.tsx) fits them all.
 */
export const COL_FIT_W: Readonly<Record<WatchCol, number>> = { last: 52, chg: 44, pct: 52 };

/** The columns' order after Symbol and the widths of all of them, as the user set them. */
export interface WatchColumns {
  order: WatchCol[];
  widths: Record<WatchCol, number>;
  symbol: number;
}

export const DEFAULT_COLUMNS: WatchColumns = { order: [...WATCH_COLS], widths: { ...COL_WIDTHS }, symbol: SYMBOL_W };

export const clampColWidth = (w: number, min = COL_MIN_W): number => Math.round(Math.min(COL_MAX_W, Math.max(min, Number.isFinite(w) ? w : min)));

/** Saved columns made whole: known columns in their saved order, any missing one after them, widths in range (else the default). */
export function sanitizeColumns(raw: unknown): WatchColumns {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const saved = Array.isArray(o.order) ? o.order.filter((c, i, a): c is WatchCol => WATCH_COLS.includes(c as WatchCol) && a.indexOf(c) === i) : [];
  const widths = { ...COL_WIDTHS };
  const w = o.widths && typeof o.widths === 'object' ? (o.widths as Record<string, unknown>) : {};
  for (const c of WATCH_COLS) if (typeof w[c] === 'number') widths[c] = clampColWidth(w[c] as number);
  const symbol = typeof o.symbol === 'number' ? clampColWidth(o.symbol, SYMBOL_MIN_W) : SYMBOL_W;
  return { order: [...saved, ...WATCH_COLS.filter((c) => !saved.includes(c))], widths, symbol };
}

/** The columns' widths from left to right (Symbol first) as set, and the least each gives way to. */
function setAndLeast(cols: WatchColumns): { sets: number[]; mins: number[] } {
  const sets = [cols.symbol, ...cols.order.map((c) => cols.widths[c])];
  const mins = [Math.min(SYMBOL_MIN_W, cols.symbol), ...cols.order.map((c) => Math.min(COL_FIT_W[c], cols.widths[c]))];
  return { sets, mins };
}

/** The grid columns before the row is measured: every column as set, the last one taking any room left. */
export function columnsTemplate(cols: WatchColumns): string {
  const { sets, mins } = setAndLeast(cols);
  return sets.map((w, i) => (i === sets.length - 1 ? `minmax(${mins[i]}px,1fr)` : `minmax(${mins[i]}px,${w}px)`)).join(' ');
}

/** The columns' widths from left to right, Symbol first, and the columns with them. */
const widthsOf = (cols: WatchColumns): number[] => [cols.symbol, ...cols.order.map((c) => cols.widths[c])];
function withWidths(cols: WatchColumns, ws: readonly number[]): WatchColumns {
  const widths = { ...cols.widths };
  cols.order.forEach((c, i) => (widths[c] = ws[i + 1]));
  return { ...cols, symbol: ws[0], widths };
}

/**
 * The columns fitted to a row `room` px wide (gaps of `gap` px between them); the widths are the
 * columns' state, kept as they are fitted. Short of room, the rightmost column narrows first, down
 * to the least it gives way to (COL_FIT_W, Symbol SYMBOL_MIN_W, or its width when less), then the
 * next one left, Symbol last. With room to spare, only the rightmost column widens. So narrowing
 * takes from the right, and widening again gives only to the rightmost column. `cols` itself when
 * nothing changes (or the row is not measured yet).
 */
export function reconcileColumns(cols: WatchColumns, room: number, gap: number): WatchColumns {
  if (!(room > 0)) return cols;
  const ws = widthsOf(cols);
  const { mins } = setAndLeast(cols);
  const total = ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
  if (total === room) return cols;
  if (total < room) {
    ws[ws.length - 1] += room - total;
  } else {
    let short = total - room;
    for (let i = ws.length - 1; i >= 0 && short > 0; i--) {
      const take = Math.min(short, Math.max(0, ws[i] - mins[i]));
      ws[i] -= take;
      short -= take;
    }
  }
  return withWidths(cols, ws);
}

/**
 * Sets a column's width (`col`, or Symbol), the rightmost column giving or taking the difference so
 * the row stays as wide: as wide as asked within COL_MIN_W..COL_MAX_W (Symbol SYMBOL_MIN_W..), and
 * no wider than the rightmost column can give down to its least. The rightmost column itself is not
 * sized this way: it takes the row's room left.
 */
export function resizeColumn(cols: WatchColumns, col: WatchCol | 'symbol', width: number): WatchColumns {
  const ws = widthsOf(cols);
  const at = col === 'symbol' ? 0 : cols.order.indexOf(col) + 1;
  const last = ws.length - 1;
  if (at < 0 || at === last) return cols;
  const lastMin = Math.min(COL_FIT_W[cols.order[last - 1]], ws[last]);
  const w = Math.min(clampColWidth(width, col === 'symbol' ? SYMBOL_MIN_W : COL_MIN_W), ws[at] + ws[last] - lastMin);
  if (w === ws[at]) return cols;
  ws[last] += ws[at] - w;
  ws[at] = w;
  return withWidths(cols, ws);
}

/** Moves column `col` to `index` among the other columns after Symbol. */
export function moveColumn(cols: WatchColumns, col: WatchCol, index: number): WatchColumns {
  const rest = cols.order.filter((c) => c !== col);
  const at = Math.max(0, Math.min(rest.length, Math.round(index)));
  return { ...cols, order: [...rest.slice(0, at), col, ...rest.slice(at)] };
}

/** The rows' order: by a column, either way; null keeps the tab's own order. */
export type WatchSort = { by: WatchSortBy; dir: 'asc' | 'desc' } | null;

/**
 * A click on a column's header: Symbol A–Z, then Z–A; a number biggest first, then smallest
 * first; a third click goes back to the tab's own order. Another header starts over.
 */
export function nextWatchSort(cur: WatchSort, by: WatchSortBy): WatchSort {
  const first = by === 'symbol' ? 'asc' : 'desc';
  if (cur?.by !== by) return { by, dir: first };
  return cur.dir === first ? { by, dir: first === 'asc' ? 'desc' : 'asc' } : null;
}

/**
 * `rows` in `sort`'s order (stable: equal ones keep the tab's order). By Symbol: the contract's
 * label, ignoring case. By a number: `valueOf` (the column's value for a row's key); rows without
 * one come last either way.
 */
export function sortRows(rows: readonly TabRow[], sort: WatchSort, valueOf: (key: string) => number | undefined): TabRow[] {
  if (!sort) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  const keyed = rows.map((r, i) => ({ r, i, label: contractLabel(r.item.contract), v: sort.by === 'symbol' ? undefined : valueOf(itemKey(r.item)) }));
  keyed.sort((a, b) => {
    if (sort.by === 'symbol') return sign * a.label.localeCompare(b.label, 'en', { sensitivity: 'base', numeric: true }) || a.i - b.i;
    const ha = a.v != null && Number.isFinite(a.v);
    const hb = b.v != null && Number.isFinite(b.v);
    if (ha !== hb) return ha ? -1 : 1;
    return (ha ? sign * (a.v! - b.v!) : 0) || a.i - b.i;
  });
  return keyed.map((k) => k.r);
}

/**
 * The order rows are drawn in while a re-sort is held back (the pointer over the list, or a
 * second not yet over): the drawn keys that are still there keep their places, new ones come
 * last in the wanted order.
 */
export function heldKeys(drawn: readonly string[], wanted: readonly string[]): string[] {
  const live = new Set(wanted);
  const kept = drawn.filter((k) => live.has(k));
  const had = new Set(kept);
  return [...kept, ...wanted.filter((k) => !had.has(k))];
}

/**
 * Where a tab dragged on the tab bar or in its dropdown lands among the other tabs (moveGroupTo's
 * index): at `index` among the other tabs on the bar, or at `index` among the other tabs in the
 * dropdown, which come after them. `shown`: the tabs on the bar (the first ones); `fromBar`: the
 * dragged tab is one of them.
 */
export function tabDropIndex(where: 'bar' | 'menu', index: number, shown: number, fromBar: boolean): number {
  return where === 'bar' ? index : shown - (fromBar ? 1 : 0) + index;
}

/**
 * Where a drag at height `y` lands among boxes in order (rows, or groups), each given by its top
 * and bottom (any one frame): the number of them whose middle is above `y`, so a pointer on a box's
 * upper half goes before it and on its lower half after it.
 */
export function dropIndex(boxes: ReadonlyArray<{ top: number; bottom: number }>, y: number): number {
  let n = 0;
  for (const b of boxes) if ((b.top + b.bottom) / 2 < y) n++;
  return n;
}

/** Sets the display name of every occurrence of an instrument in one list. */
export function setItemName(list: Watchlist, key: string, name: LocalizedName): Watchlist {
  if (!listHas(list, key)) return list;
  return { ...list, groups: list.groups.map((g) => ({ ...g, items: g.items.map((i) => (itemKey(i) === key ? { ...i, name } : i)) })) };
}

/** The current list: the remembered one while it exists, else the first list (the fallback is never saved). */
/** The tab to show: `tab` while the list still has that group (or it is All), else All. */
export function resolveTab(list: Watchlist, tab: string | null | undefined): string {
  return tab && list.groups.some((g) => g.id === tab) ? tab : ALL_TAB;
}

/** A row of a tab: the item and the group it is shown for (in All, the first group holding it). */
export interface TabRow {
  groupId: string;
  item: WatchItem;
}

/** The rows of `tab`: one group's items, or for All every symbol once, in tab order. */
export function tabRows(list: Watchlist, tab: string): TabRow[] {
  if (tab !== ALL_TAB) return (list.groups.find((g) => g.id === tab)?.items ?? []).map((item) => ({ groupId: tab, item }));
  const seen = new Set<string>();
  const out: TabRow[] = [];
  for (const g of list.groups) {
    for (const item of g.items) {
      const k = itemKey(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ groupId: g.id, item });
    }
  }
  return out;
}

/**
 * Where a row (`key`, shown for group `ownGroupId`) dropped at `index` among All's other rows
 * lands: in the group of a neighbour, right after the row before it (or before the row after it,
 * at the top). Between two groups the row's own group wins, so a row stays in its tab when it can.
 * `others`: All's rows without the dragged one. The index is counted among the group's other
 * items, as moveItemTo takes it. Null without other rows.
 */
export function allDrop(list: Watchlist, others: readonly TabRow[], index: number, key: string, ownGroupId: string): { groupId: string; index: number } | null {
  if (!others.length) return null;
  const at = Math.max(0, Math.min(others.length, index));
  const before = others[at - 1];
  const after = others[at];
  const pos = (r: TabRow) =>
    (list.groups.find((g) => g.id === r.groupId)?.items ?? [])
      .filter((i) => itemKey(i) !== key)
      .findIndex((i) => itemKey(i) === itemKey(r.item));
  if (after && (!before || (after.groupId === ownGroupId && before.groupId !== ownGroupId))) return { groupId: after.groupId, index: Math.max(0, pos(after)) };
  return { groupId: before.groupId, index: pos(before) + 1 };
}

/** The group "Add symbol" adds to: the remembered target while the list has it, else the first group (undefined: no groups). */
export function targetGroupOf(list: Watchlist, groupId: string | undefined): WatchGroup | undefined {
  return list.groups.find((g) => g.id === groupId) ?? list.groups[0];
}

/** Removes an instrument from every group of a list; the list itself when it does not have it. */
export function removeFromList(list: Watchlist, key: string): Watchlist {
  if (!listHas(list, key)) return list;
  return { ...list, groups: list.groups.map((g) => (g.items.some((i) => itemKey(i) === key) ? { ...g, items: g.items.filter((i) => itemKey(i) !== key) } : g)) };
}

/** A row of the chart star's picker: a tab, checked when it holds the instrument. */
export interface StarRow {
  group: WatchGroup;
  checked: boolean;
}

/** The chart star's picker for `contract`: every tab, in order, checked where it is (by contractKey). */
export function starRows(list: Watchlist, contract: ContractRef): StarRow[] {
  const key = contractKey(contract);
  return list.groups.map((group) => ({ group, checked: groupHas(group, key) }));
}

/**
 * A click on a tab of the star's picker: a tab holding the instrument loses it ('removed'), any
 * other tab gets it at its end ('added'); the other tabs keep theirs. Null when the tab is gone.
 */
export function toggleInTab(list: Watchlist, groupId: string, item: WatchItem): { list: Watchlist; change: 'added' | 'removed' | null } {
  const group = list.groups.find((g) => g.id === groupId);
  if (!group) return { list, change: null };
  const key = itemKey(item);
  if (groupHas(group, key)) return { list: removeItem(list, groupId, key), change: 'removed' };
  return { list: { ...list, groups: list.groups.map((g) => (g === group ? { ...g, items: [...g.items, item] } : g)) }, change: 'added' };
}

/** The ticker's indices: every item of the ticker list once, in order. */
export function tickerItems(list: Watchlist | undefined): WatchItem[] {
  return list ? tabRows(list, ALL_TAB).map((r) => r.item) : [];
}

/** Puts an index on the ticker (at its end), or takes it off when it is there. */
export function toggleInTicker(list: Watchlist, item: WatchItem, defaultGroupName: LocalizedName): { list: Watchlist; change: 'added' | 'removed' } {
  const key = itemKey(item);
  if (listHas(list, key)) return { list: removeFromList(list, key), change: 'removed' };
  const last = list.groups[list.groups.length - 1];
  return { list: addItem(list, last?.id, item, defaultGroupName), change: 'added' };
}

// ---------------------------------------------------------------------------
// Groups

/** Every spelling of a name: a localized built-in name is taken in both languages. */
const spellings = (name: LocalizedName): string[] => (typeof name === 'string' ? [name] : [name.en, name.zh]);

/**
 * Whether another group of the list already has `name` (trimmed, ignoring case, in either
 * language of a localized name). `exceptId` is the group being renamed.
 */
export function groupNameTaken(list: Watchlist, name: string, exceptId?: string): boolean {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return false;
  return list.groups.some((g) => g.id !== exceptId && spellings(g.name).some((s) => s.trim().toLocaleLowerCase() === wanted));
}

/** Adds an empty group. Empty names and names another group has are ignored. */
export function createGroup(list: Watchlist, name: string, id: string = newId('g')): Watchlist {
  const trimmed = name.trim();
  if (!trimmed || groupNameTaken(list, trimmed)) return list;
  const group: WatchGroup = { id, name: trimmed, items: [] };
  return { ...list, groups: [...list.groups, group] };
}

/**
 * Renames a group. The name is trimmed; an empty name, a name another group has, or the name the
 * group already shows in `lang` leaves the list unchanged. A localized built-in name becomes a
 * plain string, shown as typed in both languages.
 */
export function renameGroup(list: Watchlist, groupId: string, name: string, lang: Lang): Watchlist {
  const trimmed = name.trim();
  const group = list.groups.find((g) => g.id === groupId);
  if (!group || !trimmed || groupNameTaken(list, trimmed, groupId)) return list;
  const shown = typeof group.name === 'string' ? group.name : group.name[lang];
  if (shown === trimmed) return list;
  return { ...list, groups: list.groups.map((g) => (g === group ? { ...g, name: trimmed } : g)) };
}

/** A list keeps at least one group (new symbols go into one), so its last group stays. */
export function canDeleteGroup(list: Watchlist): boolean {
  return list.groups.length > 1;
}

/** Deletes a group with its symbols, unless it is the last group of the list. */
export function deleteGroup(list: Watchlist, groupId: string): Watchlist {
  if (!canDeleteGroup(list) || !list.groups.some((g) => g.id === groupId)) return list;
  return { ...list, groups: list.groups.filter((g) => g.id !== groupId) };
}

/** The group that takes a deleted group's place on screen: the next one, else the previous one. */
export function neighborGroupId(list: Watchlist, groupId: string): string | undefined {
  const i = list.groups.findIndex((g) => g.id === groupId);
  if (i < 0) return undefined;
  return (list.groups[i + 1] ?? list.groups[i - 1])?.id;
}

// ---------------------------------------------------------------------------
// Symbol search

export interface Suggestion {
  contract: ContractRef;
  /** Company / index name from the search description. */
  name?: string;
}

/** Instrument types the watchlist accepts from symbol search. */
const SEARCHABLE = new Set(['STK', 'IND']);

/**
 * Normalizes a search result into a contract suitable for quotes and persistence. A stock keeps
 * the routing the main process chose: SMART, or its own exchange where SMART does not reach it
 * (MEXI, SEHK …; contracts.ts → routeMatch).
 */
export function normalizeMatch(c: ContractRef): ContractRef {
  const currency = c.currency || 'USD';
  if (c.secType === 'STK') {
    const exchange = c.exchange || 'SMART';
    const primaryExchange = c.primaryExchange || (exchange !== 'SMART' ? exchange : undefined);
    return {
      symbol: c.symbol,
      secType: 'STK',
      exchange,
      currency,
      ...(primaryExchange ? { primaryExchange } : {}),
      ...(c.conId ? { conId: c.conId } : {}),
    };
  }
  return {
    symbol: c.symbol,
    secType: c.secType,
    exchange: c.exchange || c.primaryExchange || 'SMART',
    currency,
    ...(c.conId ? { conId: c.conId } : {}),
  };
}

/**
 * Turns IB search results into suggestions: stocks and indices not yet in the list, ranked and
 * deduplicated like the top bar search (US listings first, at most two foreign listings next to
 * US ones, no corporate-action or delisted lines; search/listing.ts).
 */
export function suggestionsFrom(matches: SymbolMatch[], query: string, exclude: Set<string>, limit: number = MAX_SUGGESTIONS): Suggestion[] {
  const candidates = matches
    .filter((m) => SEARCHABLE.has(m.contract.secType))
    .map((m) => ({ ...m, contract: normalizeMatch(m.contract) }))
    .filter((m) => !exclude.has(contractKey(m.contract)));
  return rankMatches(candidates, query, limit).map((m) => {
    const name = m.description?.trim() || undefined;
    return { contract: m.contract, ...(name ? { name } : {}) };
  });
}

/**
 * A typed string that can be offered as a US ticker without IB search: up to 5 characters
 * plus an optional share class ("AAPL", "BRK B", "BF.B"), not a company name ("netflix").
 */
export function looksLikeTicker(query: string): boolean {
  const t = normalizeTicker(query);
  return /^[A-Z0-9]{1,5}([. ][A-Z]{1,2})?$/.test(t) && /[A-Z]/.test(t);
}

export function normalizeTicker(query: string): string {
  return query.trim().toUpperCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Context menu placement

/** Keeps a menu of size w×h placed at (x, y) inside a panel of size panelW×panelH. */
export function clampMenu(x: number, y: number, w: number, h: number, panelW: number, panelH: number, margin = 8): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, panelW - w - margin)),
    y: Math.max(margin, Math.min(y, panelH - h - margin)),
  };
}
