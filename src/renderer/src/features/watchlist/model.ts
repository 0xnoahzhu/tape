// Pure watchlist operations. Every function returns new objects and never mutates its input,
// so results can be written to the store and sent to the main process as they are.

import { contractKey } from '@shared/contract';
import type { ContractRef, Lang, LocalizedName, SymbolMatch, WatchItem, WatchGroup, Watchlist } from '@shared/types';
import { rankMatches } from '../search/listing';
import { groupPrefKey } from './prefs';

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

/** The current list: the remembered one while it exists, else the first list (the fallback is never saved). */
export function currentListOf(lists: Watchlist[], id: string | null | undefined): Watchlist | undefined {
  return lists.find((l) => l.id === id) ?? lists[0];
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

/**
 * Puts an instrument into one group of a list:
 * - 'added' (addItem: unknown group → first group, no groups → a default group) when the list lacks it;
 * - 'moved' there, out of every other group, keeping the stored item (its name), when it is elsewhere in the list;
 * - null when there is nothing to do: it is already only there, or the group is gone.
 */
export function placeItem(
  list: Watchlist,
  groupId: string | undefined,
  item: WatchItem,
  defaultGroupName: LocalizedName,
  groupIdForNew: string = newId('g'),
): { list: Watchlist; change: 'added' | 'moved' | null } {
  const key = itemKey(item);
  if (!listHas(list, key)) {
    const next = addItem(list, groupId, item, defaultGroupName, groupIdForNew);
    return { list: next, change: next === list ? null : 'added' };
  }
  const target = list.groups.find((g) => g.id === groupId);
  if (!target) return { list, change: null };
  const holds = (g: WatchGroup) => g.items.some((i) => itemKey(i) === key);
  if (!list.groups.some((g) => g !== target && holds(g))) return { list, change: null };
  // The stored item moves (the target keeps its own when it already has one).
  const kept = list.groups.flatMap((g) => g.items).find((i) => itemKey(i) === key) ?? item;
  return {
    list: {
      ...list,
      groups: list.groups.map((g) => {
        if (g === target) return holds(g) ? g : { ...g, items: [...g.items, kept] };
        return holds(g) ? { ...g, items: g.items.filter((i) => itemKey(i) !== key) } : g;
      }),
    },
    change: 'moved',
  };
}

export interface StarRow {
  /** undefined: the list has no group yet (picking it creates its default group). */
  group: WatchGroup | undefined;
  /** The instrument is in this group. */
  checked: boolean;
}

export interface StarSection {
  list: Watchlist;
  rows: StarRow[];
}

/**
 * The chart star's picker for `contract`: every list that accepts it (Indices: indices only),
 * already holds it, or is in `keep` (the lists shown when the picker opened, so a stock unchecked
 * in Indices keeps its section until the picker closes), in list order, with its groups in order,
 * checked where it is; a list without groups gets one unchecked row for its default group.
 * Membership is by contractKey (another conId or exchange of the same instrument is the same).
 */
export function starSections(lists: Watchlist[], contract: ContractRef, keep: readonly string[] = []): StarSection[] {
  const key = contractKey(contract);
  return lists
    .filter((l) => listAccepts(l, contract) || listHas(l, key) || keep.includes(l.id))
    .map((l) => ({
      list: l,
      rows: l.groups.length ? l.groups.map((g) => ({ group: g, checked: g.items.some((i) => itemKey(i) === key) })) : [{ group: undefined, checked: false }],
    }));
}

/**
 * A click on one group row of the star's picker:
 * - a group holding the instrument: 'removed' from the whole list (removeFromList);
 * - otherwise placeItem: 'added' (unknown group → first group, no groups → a default group) or
 *   'moved' there from the list's other groups, keeping the stored item (its name);
 * - null when nothing changed (the group is gone while the list has it).
 * `groupId` is the group it is in now (only for 'added' / 'moved').
 */
export function toggleInGroup(
  list: Watchlist,
  groupId: string | undefined,
  item: WatchItem,
  defaultGroupName: LocalizedName,
  groupIdForNew: string = newId('g'),
): { list: Watchlist; change: 'added' | 'moved' | 'removed' | null; groupId?: string } {
  const key = itemKey(item);
  if (list.groups.find((g) => g.id === groupId)?.items.some((i) => itemKey(i) === key)) return { list: removeFromList(list, key), change: 'removed' };
  const r = placeItem(list, groupId, item, defaultGroupName, groupIdForNew);
  if (!r.change) return { list, change: null };
  return { ...r, groupId: r.list.groups.find((g) => g.items.some((i) => itemKey(i) === key))?.id };
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

/**
 * Collapsed-group preferences (prefs.ts) without the entries of groups `list` no longer has.
 * Returns `closed` itself when there is nothing to drop.
 */
export function pruneClosedGroups(closed: Record<string, boolean>, list: Watchlist): Record<string, boolean> {
  const prefix = groupPrefKey(list.id, '');
  const live = new Set(list.groups.map((g) => groupPrefKey(list.id, g.id)));
  const stale = Object.keys(closed).filter((k) => k.startsWith(prefix) && !live.has(k));
  if (!stale.length) return closed;
  const next = { ...closed };
  for (const k of stale) delete next[k];
  return next;
}

// ---------------------------------------------------------------------------
// Lists

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
