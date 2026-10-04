// Pure watchlist operations. Every function returns new objects and never mutates its input,
// so results can be written to the store and sent to the main process as they are.

import { contractKey } from '@shared/contract';
import type { ContractRef, LocalizedName, SymbolMatch, WatchItem, WatchGroup, Watchlist } from '@shared/types';

/** The built-in Indices list only accepts indices. */
export const INDEX_LIST_ID = 'idx';
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

/** Whether `contract` may be added to `list` from another list. */
export function listAccepts(list: Watchlist, contract: ContractRef): boolean {
  return list.id !== INDEX_LIST_ID || contract.secType === 'IND';
}

/**
 * Appends an item to a group (the first group when `groupId` is unknown). A list without
 * groups gets one named `defaultGroupName`. Items already in the list are not added twice.
 */
export function addItem(list: Watchlist, groupId: string | undefined, item: WatchItem, defaultGroupName: LocalizedName, groupIdForNew: string = newId('g')): Watchlist {
  if (listHas(list, itemKey(item))) return list;
  if (!list.groups.length) return { ...list, groups: [{ id: groupIdForNew, name: defaultGroupName, items: [item] }] };
  const target = list.groups.find((g) => g.id === groupId) ?? list.groups[0];
  return { ...list, groups: list.groups.map((g) => (g.id === target.id ? { ...g, items: [...g.items, item] } : g)) };
}

export function removeItem(list: Watchlist, groupId: string, key: string): Watchlist {
  return { ...list, groups: list.groups.map((g) => (g.id === groupId ? { ...g, items: g.items.filter((i) => itemKey(i) !== key) } : g)) };
}

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

/** Sets the display name of every occurrence of an instrument in one list. */
export function setItemName(list: Watchlist, key: string, name: LocalizedName): Watchlist {
  if (!listHas(list, key)) return list;
  return { ...list, groups: list.groups.map((g) => ({ ...g, items: g.items.map((i) => (itemKey(i) === key ? { ...i, name } : i)) })) };
}

export function createGroup(list: Watchlist, name: string, id: string = newId('g')): Watchlist {
  const trimmed = name.trim();
  if (!trimmed) return list;
  const group: WatchGroup = { id, name: trimmed, items: [] };
  return { ...list, groups: [...list.groups, group] };
}

export function createList(lists: Watchlist[], name: string, defaultGroupName: LocalizedName, id: string = newId('w'), groupId: string = newId('g')): Watchlist[] {
  const trimmed = name.trim();
  if (!trimmed) return lists;
  return [...lists, { id, name: trimmed, groups: [{ id: groupId, name: defaultGroupName, items: [] }] }];
}

/** Renames a user list. Built-in lists and empty names are ignored. */
export function renameList(lists: Watchlist[], id: string, name: string): Watchlist[] {
  const trimmed = name.trim();
  const list = lists.find((l) => l.id === id);
  if (!trimmed || !list || list.builtin || list.name === trimmed) return lists;
  return lists.map((l) => (l === list ? { ...l, name: trimmed } : l));
}

/** Deletes a user list. Built-in lists cannot be deleted. */
export function deleteList(lists: Watchlist[], id: string): Watchlist[] {
  return lists.filter((l) => l.id !== id || l.builtin);
}

// ---------------------------------------------------------------------------
// Symbol search

export interface Suggestion {
  contract: ContractRef;
  /** Company / index name from the search description. */
  name?: string;
  /** Short type tag: STK, ETF, IND (plus the currency when it is not USD). */
  kind: string;
}

/** Instrument types the watchlist accepts from symbol search. */
const SEARCHABLE = new Set(['STK', 'IND']);

/** Normalizes a search result into a contract suitable for quotes and persistence. */
export function normalizeMatch(c: ContractRef): ContractRef {
  const currency = c.currency || 'USD';
  if (c.secType === 'STK') {
    const primaryExchange = c.primaryExchange || (c.exchange && c.exchange !== 'SMART' ? c.exchange : undefined);
    return {
      symbol: c.symbol,
      secType: 'STK',
      exchange: 'SMART',
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

export function kindTag(contract: ContractRef, description?: string): string {
  const base = contract.secType === 'STK' && description && /\bETF\b/i.test(description) ? 'ETF' : contract.secType;
  return contract.currency && contract.currency !== 'USD' ? `${base} ${contract.currency}` : base;
}

/** Temporary corporate-action listings (tender offers, conversions such as "BABA.TEN"). */
const isCorporateAction = (c: ContractRef): boolean => c.primaryExchange === 'CORPACT' || c.exchange === 'CORPACT';

/**
 * Turns IB search results into suggestions: stocks and indices only, USD listings first
 * (exact symbol first within each currency tier), one row per instrument key, excluding
 * corporate-action listings and instruments already in the list.
 */
export function suggestionsFrom(matches: SymbolMatch[], query: string, exclude: Set<string>, limit: number = MAX_SUGGESTIONS): Suggestion[] {
  const q = query.trim().toUpperCase();
  const rank = (m: SymbolMatch) => ((m.contract.currency || 'USD') === 'USD' ? 0 : 2) + (m.contract.symbol.toUpperCase() === q ? 0 : 1);
  const sorted = matches
    .filter((m) => SEARCHABLE.has(m.contract.secType) && !isCorporateAction(m.contract))
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.m);
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const m of sorted) {
    const contract = normalizeMatch(m.contract);
    const key = contractKey(contract);
    if (seen.has(key) || exclude.has(key)) continue;
    seen.add(key);
    const name = m.description?.trim() || undefined;
    out.push({ contract, ...(name ? { name } : {}), kind: kindTag(contract, name) });
    if (out.length >= limit) break;
  }
  return out;
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
