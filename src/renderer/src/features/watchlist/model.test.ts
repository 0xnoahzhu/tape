import { describe, expect, it } from 'vitest';
import { contractKey, index, option, stock } from '@shared/contract';
import { defaultWatchlists } from '@shared/defaults';
import type { ContractRef, SymbolMatch, Watchlist } from '@shared/types';
import {
  ALL_TAB,
  addItem,
  allDrop,
  canDeleteGroup,
  clampMenu,
  createGroup,
  deleteGroup,
  dropIndex,
  fitTabs,
  fitColumns,
  mostWidth,
  SYMBOL_MIN_W,
  COL_MAX_W,
  COL_MIN_W,
  COL_WIDTHS,
  clampColWidth,
  columnsTemplate,
  DEFAULT_COLUMNS,
  moveColumn,
  sanitizeColumns,
  heldKeys,
  nextWatchSort,
  sortRows,
  tabDropIndex,
  groupNameTaken,
  listContracts,
  listHas,
  listItemCount,
  listKeys,
  looksLikeTicker,
  moveGroupTo,
  moveItem,
  moveItemTo,
  neighborGroupId,
  normalizeMatch,
  normalizeTicker,
  removeFromList,
  removeItem,
  renameGroup,
  resolveTab,
  setItemName,
  starRows,
  suggestionsFrom,
  tabRows,
  tabsListOf,
  targetGroupOf,
  tickerItems,
  tickerListOf,
  toggleInTab,
  toggleInTicker,
} from './model';

const DEFAULT = { en: 'Default', zh: '默认' };
const lists = defaultWatchlists();
const main = tabsListOf(lists)!;
const idx = tickerListOf(lists)!;
/** One tab only. */
const single: Watchlist = { id: 'one', name: 'One', groups: [{ id: 'g1', name: 'One', items: [{ contract: stock('IBM') }] }] };
/** AAPL in two tabs. */
const twice = addItem(main, 'g-etf', { contract: stock('AAPL'), name: 'Apple' }, DEFAULT);

const match = (contract: Partial<ContractRef> & { symbol: string }, description = ''): SymbolMatch => ({
  contract: { secType: 'STK', exchange: 'SMART', currency: 'USD', ...contract } as ContractRef,
  description,
  derivativeSecTypes: [],
});

describe('list queries', () => {
  it('counts and flattens items', () => {
    expect(listItemCount(main)).toBe(9);
    expect(listContracts(main).map((c) => c.symbol)).toEqual(['AAPL', 'NVDA', 'MSFT', 'AMD', 'META', 'AMZN', 'TSLA', 'SPY', 'QQQ']);
    expect(listKeys(idx).has('IND:SPX')).toBe(true);
    expect(listHas(main, 'STK:TSLA')).toBe(true);
    expect(listHas(main, 'STK:GOOG')).toBe(false);
  });

  it('dedupes contracts that appear in several tabs', () => {
    expect(listContracts(twice)).toHaveLength(listContracts(main).length);
    expect(listKeys(twice).size).toBe(9);
  });

  it('finds the tabs list and the ticker list', () => {
    expect(main.id).toBe('main');
    expect(idx.id).toBe('idx');
    expect(tabsListOf([])).toBeUndefined();
  });
});

describe('item operations', () => {
  it('adds to the chosen tab, else the first; a tab never holds it twice, other tabs may', () => {
    const goog = { contract: stock('GOOG'), name: 'Alphabet' };
    const a = addItem(main, 'g-etf', goog, DEFAULT);
    expect(a.groups.find((g) => g.id === 'g-etf')!.items.at(-1)).toEqual(goog);
    const b = addItem(main, 'missing', goog, DEFAULT);
    expect(b.groups[0].items.at(-1)).toEqual(goog);
    expect(addItem(main, 'g-tech', { contract: stock('AAPL') }, DEFAULT)).toBe(main);
    expect(twice.groups.find((g) => g.id === 'g-etf')!.items.map((i) => i.contract.symbol)).toEqual(['SPY', 'QQQ', 'AAPL']);
    expect(main.groups[0].items).toHaveLength(6); // input untouched
  });

  it('creates a default group in a list without groups', () => {
    const empty: Watchlist = { id: 'e', name: 'E', groups: [] };
    const next = addItem(empty, undefined, { contract: stock('IBM') }, DEFAULT, 'g1');
    expect(next.groups).toEqual([{ id: 'g1', name: DEFAULT, items: [{ contract: stock('IBM') }] }]);
  });

  it('removes from one group', () => {
    const next = removeItem(main, 'g-tech', 'STK:NVDA');
    expect(listHas(next, 'STK:NVDA')).toBe(false);
    expect(listItemCount(next)).toBe(8);
    expect(removeItem(main, 'g-auto', 'STK:NVDA').groups[0].items).toHaveLength(6);
  });

  it('moves between groups', () => {
    const next = moveItem(main, 'g-tech', 'g-auto', 'STK:NVDA');
    expect(next.groups.find((g) => g.id === 'g-tech')!.items.map((i) => i.contract.symbol)).not.toContain('NVDA');
    expect(next.groups.find((g) => g.id === 'g-auto')!.items.map((i) => i.contract.symbol)).toEqual(['TSLA', 'NVDA']);
    expect(listItemCount(next)).toBe(listItemCount(main));
    expect(moveItem(main, 'g-tech', 'g-tech', 'STK:NVDA')).toBe(main);
    expect(moveItem(main, 'g-tech', 'nope', 'STK:NVDA')).toBe(main);
    expect(moveItem(main, 'g-auto', 'g-etf', 'STK:NVDA')).toBe(main);
  });

  it('moves an item to a place in its own group or another one (dragged)', () => {
    const syms = (l: Watchlist, g: string) => l.groups.find((x) => x.id === g)!.items.map((i) => i.contract.symbol);
    const tech = syms(main, 'g-tech');
    // Within its group: to the top, and to the end.
    const top = moveItemTo(main, 'g-tech', 'STK:NVDA', 'g-tech', 0);
    expect(syms(top, 'g-tech')).toEqual(['NVDA', ...tech.filter((s) => s !== 'NVDA')]);
    const end = moveItemTo(main, 'g-tech', 'STK:NVDA', 'g-tech', 99);
    expect(syms(end, 'g-tech')).toEqual([...tech.filter((s) => s !== 'NVDA'), 'NVDA']);
    // Into another group, before its first item.
    const across = moveItemTo(main, 'g-tech', 'STK:NVDA', 'g-auto', 0);
    expect(syms(across, 'g-auto')).toEqual(['NVDA', 'TSLA']);
    expect(syms(across, 'g-tech')).not.toContain('NVDA');
    expect(listItemCount(across)).toBe(listItemCount(main));
    // Missing item or group: unchanged.
    expect(moveItemTo(main, 'g-auto', 'STK:NVDA', 'g-etf', 0)).toBe(main);
    expect(moveItemTo(main, 'g-tech', 'STK:NVDA', 'nope', 0)).toBe(main);
  });

  it('moves a group to a place among the others (dragged)', () => {
    const ids = (l: Watchlist) => l.groups.map((g) => g.id);
    const all = ids(main);
    const last = all.at(-1)!;
    expect(ids(moveGroupTo(main, last, 0))).toEqual([last, ...all.slice(0, -1)]);
    expect(ids(moveGroupTo(main, all[0], 99))).toEqual([...all.slice(1), all[0]]);
    expect(moveGroupTo(main, 'nope', 0)).toBe(main);
  });

  it('places a drop before a box when the pointer is on its upper half, after it on the lower', () => {
    const rows = [
      { top: 0, bottom: 50 },
      { top: 50, bottom: 100 },
      { top: 100, bottom: 150 },
    ];
    expect(dropIndex(rows, -10)).toBe(0);
    expect(dropIndex(rows, 20)).toBe(0);
    expect(dropIndex(rows, 30)).toBe(1);
    expect(dropIndex(rows, 120)).toBe(2);
    expect(dropIndex(rows, 140)).toBe(3);
    expect(dropIndex([], 10)).toBe(0);
  });

  it('sets a name only when the item exists', () => {
    const next = setItemName(main, 'STK:AMD', 'Advanced Micro Devices');
    expect(next.groups[0].items.find((i) => i.contract.symbol === 'AMD')!.name).toBe('Advanced Micro Devices');
    expect(setItemName(main, 'STK:ZZZ', 'x')).toBe(main);
  });
});

describe('tabs', () => {
  it('resolves the tab shown: a tab the list has, else All', () => {
    expect(resolveTab(main, 'g-etf')).toBe('g-etf');
    expect(resolveTab(main, 'gone')).toBe(ALL_TAB);
    expect(resolveTab(main, null)).toBe(ALL_TAB);
    expect(resolveTab(main, ALL_TAB)).toBe(ALL_TAB);
  });

  it('resolves the target tab, else the first', () => {
    expect(targetGroupOf(main, 'g-etf')?.id).toBe('g-etf');
    expect(targetGroupOf(main, 'missing')?.id).toBe('g-tech');
    expect(targetGroupOf(main, undefined)?.id).toBe('g-tech');
    expect(targetGroupOf({ id: 'e', name: 'E', groups: [] }, 'g')).toBeUndefined();
  });

  it("lists a tab's symbols, and on All every symbol once, shown for the first tab that has it", () => {
    expect(tabRows(main, 'g-etf').map((r) => [r.groupId, r.item.contract.symbol])).toEqual([
      ['g-etf', 'SPY'],
      ['g-etf', 'QQQ'],
    ]);
    const all = tabRows(twice, ALL_TAB);
    expect(all.map((r) => r.item.contract.symbol)).toEqual(['AAPL', 'NVDA', 'MSFT', 'AMD', 'META', 'AMZN', 'TSLA', 'SPY', 'QQQ']);
    expect(all[0].groupId).toBe('g-tech');
    expect(tabRows(main, 'gone')).toEqual([]);
  });

  it('drops a row on All into the tab of its neighbours, its own tab between two', () => {
    const others = (key: string) => tabRows(main, ALL_TAB).filter((r) => contractKey(r.item.contract) !== key);
    // NVDA (Tech) after TSLA (Auto, the 6th of the other rows): into Auto, after TSLA.
    expect(allDrop(main, others('STK:NVDA'), 6, 'STK:NVDA', 'g-tech')).toEqual({ groupId: 'g-auto', index: 1 });
    // Between AMZN (Tech) and TSLA (Auto): it stays in Tech, at its end.
    expect(allDrop(main, others('STK:NVDA'), 5, 'STK:NVDA', 'g-tech')).toEqual({ groupId: 'g-tech', index: 5 });
    // TSLA (Auto) between AMZN and SPY: Auto has no other row, so the tab before it (Tech) takes it.
    expect(allDrop(main, others('STK:TSLA'), 6, 'STK:TSLA', 'g-auto')).toEqual({ groupId: 'g-tech', index: 6 });
    // SPY (ETF) between AMZN (Tech) and TSLA (Auto): Tech, after AMZN.
    expect(allDrop(main, others('STK:SPY'), 6, 'STK:SPY', 'g-etf')).toEqual({ groupId: 'g-tech', index: 6 });
    // At the very top: before the first row, in its tab.
    expect(allDrop(main, others('STK:QQQ'), 0, 'STK:QQQ', 'g-etf')).toEqual({ groupId: 'g-tech', index: 0 });
    expect(allDrop(single, [], 0, 'STK:IBM', 'g1')).toBeNull();
  });
});

describe('sorting the rows', () => {
  it('cycles a header: symbol A–Z, Z–A, own order; a number biggest, smallest, own order', () => {
    expect(nextWatchSort(null, 'symbol')).toEqual({ by: 'symbol', dir: 'asc' });
    expect(nextWatchSort({ by: 'symbol', dir: 'asc' }, 'symbol')).toEqual({ by: 'symbol', dir: 'desc' });
    expect(nextWatchSort({ by: 'symbol', dir: 'desc' }, 'symbol')).toBeNull();
    expect(nextWatchSort(null, 'pct')).toEqual({ by: 'pct', dir: 'desc' });
    expect(nextWatchSort({ by: 'pct', dir: 'desc' }, 'pct')).toEqual({ by: 'pct', dir: 'asc' });
    expect(nextWatchSort({ by: 'pct', dir: 'asc' }, 'pct')).toBeNull();
    expect(nextWatchSort({ by: 'symbol', dir: 'desc' }, 'chg')).toEqual({ by: 'chg', dir: 'desc' });
  });

  it('sorts by symbol or by a number, rows without one last, ties in the tab order', () => {
    const rows = tabRows(main, 'g-tech'); // AAPL NVDA MSFT AMD META AMZN
    const sym = (rs: ReturnType<typeof tabRows>) => rs.map((r) => r.item.contract.symbol);
    expect(sym(sortRows(rows, null, () => undefined))).toEqual(['AAPL', 'NVDA', 'MSFT', 'AMD', 'META', 'AMZN']);
    expect(sym(sortRows(rows, { by: 'symbol', dir: 'asc' }, () => undefined))).toEqual(['AAPL', 'AMD', 'AMZN', 'META', 'MSFT', 'NVDA']);
    expect(sym(sortRows(rows, { by: 'symbol', dir: 'desc' }, () => undefined))).toEqual(['NVDA', 'MSFT', 'META', 'AMZN', 'AMD', 'AAPL']);
    const chg: Record<string, number> = { 'STK:AAPL': 1.3, 'STK:NVDA': -2.1, 'STK:MSFT': 0.4, 'STK:AMD': 1.9 };
    const of = (k: string) => chg[k];
    // META and AMZN have no value: last, in the tab's order, either way.
    expect(sym(sortRows(rows, { by: 'pct', dir: 'desc' }, of))).toEqual(['AMD', 'AAPL', 'MSFT', 'NVDA', 'META', 'AMZN']);
    expect(sym(sortRows(rows, { by: 'pct', dir: 'asc' }, of))).toEqual(['NVDA', 'MSFT', 'AAPL', 'AMD', 'META', 'AMZN']);
  });

  it('holds the drawn order: kept rows keep their places, new ones come last', () => {
    expect(heldKeys(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['a', 'b', 'c']);
    expect(heldKeys(['a', 'b', 'c'], ['d', 'c', 'a'])).toEqual(['a', 'c', 'd']);
    expect(heldKeys([], ['x', 'y'])).toEqual(['x', 'y']);
  });
});

describe('columns', () => {
  it('makes saved columns whole: known ones in order, missing ones after, widths in range', () => {
    expect(sanitizeColumns(null)).toEqual(DEFAULT_COLUMNS);
    expect(sanitizeColumns({ order: ['pct', 'nope', 'pct', 'last'], widths: { pct: 999, last: 10, chg: 'x' }, symbol: 20 })).toEqual({
      order: ['pct', 'last', 'chg'],
      widths: { last: COL_MIN_W, chg: COL_WIDTHS.chg, pct: COL_MAX_W },
      symbol: SYMBOL_MIN_W,
    });
  });

  it('moves the columns after Symbol among themselves', () => {
    expect(moveColumn(DEFAULT_COLUMNS, 'pct', 0).order).toEqual(['pct', 'last', 'chg']);
    expect(moveColumn(DEFAULT_COLUMNS, 'last', 9).order).toEqual(['chg', 'pct', 'last']);
    expect(clampColWidth(20)).toBe(COL_MIN_W);
    expect(clampColWidth(70.4)).toBe(70);
    expect(columnsTemplate(DEFAULT_COLUMNS)).toBe('minmax(44px,64px) minmax(52px,64px) minmax(44px,50px) minmax(52px,1fr)');
  });

  it('gives room left to right up to the set widths, the rest to the rightmost column', () => {
    // Set widths 64 | 64 / 50 / 54, least 44 | 52 / 44 / 52, gaps 6: all as set needs 232 + 18 = 250.
    expect(fitColumns(DEFAULT_COLUMNS, 300, 6)).toEqual([64, 64, 50, 104]);
    expect(fitColumns(DEFAULT_COLUMNS, 250, 6)).toEqual([64, 64, 50, 54]);
  });

  it('narrows from the right: the last column first, Symbol last', () => {
    expect(fitColumns(DEFAULT_COLUMNS, 248, 6)).toEqual([64, 64, 50, 52]);
    expect(fitColumns(DEFAULT_COLUMNS, 242, 6)).toEqual([64, 64, 44, 52]);
    expect(fitColumns(DEFAULT_COLUMNS, 230, 6)).toEqual([64, 52, 44, 52]);
    expect(fitColumns(DEFAULT_COLUMNS, 220, 6)).toEqual([54, 52, 44, 52]);
    // The order counts, not the column: Chg % first here, so Chg is the one at the right edge.
    expect(fitColumns(moveColumn(DEFAULT_COLUMNS, 'chg', 2), 242, 6)).toEqual([64, 64, 52, 44]);
    expect(fitColumns(DEFAULT_COLUMNS, 0, 6)).toBeNull();
  });

  it('caps a column at what the row leaves it beside the others at their least', () => {
    // 250 - 18 gaps - (44 + 44 + 52) for the others.
    expect(mostWidth(DEFAULT_COLUMNS, 'last', 250, 6)).toBe(92);
    expect(mostWidth(DEFAULT_COLUMNS, 'symbol', 250, 6)).toBe(84);
    expect(mostWidth(DEFAULT_COLUMNS, 'last', 999, 6)).toBe(COL_MAX_W);
  });
});

describe('the tab bar', () => {
  it('shows every tab that fits, the rest in a dropdown after them', () => {
    expect(fitTabs([60, 60, 60], 200, 70)).toBe(3);
    expect(fitTabs([60, 60, 60], 179, 70)).toBe(1);
    expect(fitTabs([60, 60, 60, 60], 190, 70)).toBe(2);
    expect(fitTabs([60, 60, 60], 60, 70)).toBe(0);
    expect(fitTabs([], 10, 70)).toBe(0);
  });

  it('places a tab dropped on the bar among the bar tabs, in the dropdown after them', () => {
    // Three tabs on the bar, the rest in the dropdown.
    expect(tabDropIndex('bar', 1, 3, true)).toBe(1);
    expect(tabDropIndex('bar', 3, 3, false)).toBe(3);
    // From the bar into the dropdown: two other tabs stay on the bar before it.
    expect(tabDropIndex('menu', 0, 3, true)).toBe(2);
    expect(tabDropIndex('menu', 2, 3, true)).toBe(4);
    // Within the dropdown: after all three bar tabs.
    expect(tabDropIndex('menu', 0, 3, false)).toBe(3);
    // Check with moveGroupTo: Swing (last) into the dropdown's top, after Tech, Auto, ETF on the bar.
    const tabs = createGroup(createGroup(main, 'Semis', 'gs'), 'Swing', 'gw');
    expect(moveGroupTo(tabs, 'gw', tabDropIndex('menu', 0, 3, false)).groups.map((g) => g.id)).toEqual(['g-tech', 'g-auto', 'g-etf', 'gw', 'gs']);
    // Tech from the bar to the dropdown's end.
    expect(moveGroupTo(tabs, 'g-tech', tabDropIndex('menu', 2, 3, true)).groups.map((g) => g.id)).toEqual(['g-auto', 'g-etf', 'gs', 'gw', 'g-tech']);
  });
});

describe('the chart star picker and the ticker', () => {
  it('offers every tab, checked where the instrument is', () => {
    expect(starRows(twice, stock('AAPL')).map((r) => [r.group.id, r.checked])).toEqual([
      ['g-tech', true],
      ['g-auto', false],
      ['g-etf', true],
    ]);
  });

  it('adds to an unchecked tab, takes out of a checked one; other tabs keep theirs', () => {
    const aapl = { contract: stock('AAPL'), name: 'Apple' };
    const added = toggleInTab(main, 'g-auto', aapl);
    expect(added.change).toBe('added');
    expect(added.list.groups.find((g) => g.id === 'g-auto')!.items.map((i) => i.contract.symbol)).toEqual(['TSLA', 'AAPL']);
    const removed = toggleInTab(added.list, 'g-tech', aapl);
    expect(removed.change).toBe('removed');
    expect(removed.list.groups[0].items.map((i) => i.contract.symbol)).not.toContain('AAPL');
    expect(listHas(removed.list, 'STK:AAPL')).toBe(true);
    expect(toggleInTab(main, 'gone', aapl)).toEqual({ list: main, change: null });
  });

  it('puts an index on the ticker or takes it off', () => {
    expect(tickerItems(idx).map((i) => i.contract.symbol)).toEqual(['SPX', 'NDX', 'INDU', 'RUT', 'VIX', 'TNX', 'DX']);
    expect(tickerItems(undefined)).toEqual([]);
    const vix = idx.groups[0].items.find((i) => i.contract.symbol === 'VIX')!;
    const off = toggleInTicker(idx, vix, DEFAULT);
    expect(off.change).toBe('removed');
    expect(listHas(off.list, contractKey(vix.contract))).toBe(false);
    const on = toggleInTicker(off.list, vix, DEFAULT);
    expect(on.change).toBe('added');
    expect(tickerItems(on.list).at(-1)!.contract.symbol).toBe('VIX');
  });
});

describe('list and group operations', () => {
  it('creates tabs with trimmed names', () => {
    expect(createGroup(main, '  Chips ', 'g9').groups.at(-1)).toEqual({ id: 'g9', name: 'Chips', items: [] });
    expect(createGroup(main, '   ')).toBe(main);
  });

  it('does not create a group with a name the list already has', () => {
    expect(createGroup(main, 'etf')).toBe(main);
    expect(createGroup(main, ' 科技 ')).toBe(main); // the zh name of the built-in Tech group
  });

  it('detects group names taken by another group', () => {
    expect(groupNameTaken(main, ' tech ')).toBe(true);
    expect(groupNameTaken(main, '汽车')).toBe(true);
    expect(groupNameTaken(main, 'Chips')).toBe(false);
    expect(groupNameTaken(main, '   ')).toBe(false);
    // A group does not collide with its own name.
    expect(groupNameTaken(main, 'Tech', 'g-tech')).toBe(false);
    expect(groupNameTaken(main, 'ETF', 'g-tech')).toBe(true);
  });

  it('renames groups with trimmed, unique names', () => {
    const next = renameGroup(main, 'g-etf', '  Funds ', 'en');
    expect(next.groups.find((g) => g.id === 'g-etf')!.name).toBe('Funds');
    expect(next.groups.map((g) => g.id)).toEqual(['g-tech', 'g-auto', 'g-etf']);
    expect(next.groups[0]).toBe(main.groups[0]);
    expect(main.groups[2].name).toBe('ETF'); // input untouched
    expect(renameGroup(main, 'g-etf', '   ', 'en')).toBe(main);
    expect(renameGroup(main, 'g-etf', 'ETF', 'en')).toBe(main);
    expect(renameGroup(main, 'g-etf', 'tech', 'en')).toBe(main);
    expect(renameGroup(main, 'g-etf', '汽车', 'en')).toBe(main);
    expect(renameGroup(main, 'nope', 'Funds', 'en')).toBe(main);
    // Changing only the case of its own name is a rename.
    expect(renameGroup(main, 'g-etf', 'Etf', 'en').groups[2].name).toBe('Etf');
  });

  it('turns a localized group name into a plain string once renamed', () => {
    expect(renameGroup(main, 'g-tech', 'Chips', 'zh').groups[0].name).toBe('Chips');
    expect(renameGroup(main, 'g-tech', '芯片', 'zh').groups[0].name).toBe('芯片');
    // Confirming the name it already shows keeps it localized.
    expect(renameGroup(main, 'g-tech', 'Tech', 'en')).toBe(main);
    expect(renameGroup(main, 'g-tech', '科技', 'zh')).toBe(main);
    // The other language's name, typed in this language, becomes the name in both.
    expect(renameGroup(main, 'g-tech', 'Tech', 'zh').groups[0].name).toBe('Tech');
  });

  it('deletes groups with their symbols but keeps the last group', () => {
    const next = deleteGroup(main, 'g-tech');
    expect(next.groups.map((g) => g.id)).toEqual(['g-auto', 'g-etf']);
    expect(listHas(next, 'STK:AAPL')).toBe(false);
    expect(listItemCount(next)).toBe(3);
    expect(main.groups).toHaveLength(3); // input untouched
    expect(deleteGroup(main, 'nope')).toBe(main);
    const last = deleteGroup(deleteGroup(main, 'g-tech'), 'g-auto');
    expect(canDeleteGroup(last)).toBe(false);
    expect(deleteGroup(last, 'g-etf')).toBe(last);
    expect(canDeleteGroup(single)).toBe(false);
    expect(canDeleteGroup(main)).toBe(true);
    const empty: Watchlist = { id: 'e', name: 'E', groups: [] };
    expect(deleteGroup(empty, 'g')).toBe(empty);
  });

  it("finds the group that takes a deleted group's place", () => {
    expect(neighborGroupId(main, 'g-tech')).toBe('g-auto');
    expect(neighborGroupId(main, 'g-auto')).toBe('g-etf');
    expect(neighborGroupId(main, 'g-etf')).toBe('g-auto'); // the last group: the previous one
    expect(neighborGroupId(main, 'nope')).toBeUndefined();
    expect(neighborGroupId(single, 'g1')).toBeUndefined();
  });

});

describe('symbol search', () => {
  it('normalizes stock and index contracts, keeping the route main chose', () => {
    expect(normalizeMatch({ symbol: 'AAPL', secType: 'STK', exchange: 'SMART', primaryExchange: 'NASDAQ', currency: 'USD', conId: 265598 })).toEqual({
      symbol: 'AAPL',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
      primaryExchange: 'NASDAQ',
      conId: 265598,
    });
    // SMART does not reach MEXI listings (IB error 200): the MXN line stays on MEXI so it can be quoted.
    expect(normalizeMatch({ symbol: 'AAPL', secType: 'STK', exchange: 'MEXI', primaryExchange: 'MEXI', currency: 'MXN', conId: 38708077 })).toEqual({
      symbol: 'AAPL',
      secType: 'STK',
      exchange: 'MEXI',
      currency: 'MXN',
      primaryExchange: 'MEXI',
      conId: 38708077,
    });
    expect(normalizeMatch({ symbol: 'ZZZ', secType: 'STK', exchange: '', currency: '' })).toEqual({ symbol: 'ZZZ', secType: 'STK', exchange: 'SMART', currency: 'USD' });
    expect(normalizeMatch({ symbol: 'SPX', secType: 'IND', exchange: '', primaryExchange: 'CBOE', currency: 'USD' })).toEqual({
      symbol: 'SPX',
      secType: 'IND',
      exchange: 'CBOE',
      currency: 'USD',
    });
  });

  it('ranks the US listing first, drops duplicates, listed and unsupported types', () => {
    const matches = [
      match({ symbol: 'AAPL', currency: 'MXN', exchange: 'MEXI' }, 'APPLE INC'),
      match({ symbol: 'AAPB' }, 'GRANITESHARES 2X LONG AAPL'),
      match({ symbol: 'AAPL', primaryExchange: 'NASDAQ' }, 'APPLE INC'),
      match({ symbol: 'AAPL', primaryExchange: 'BVL' }, 'APPLE INC'),
      match({ symbol: 'AAPL', secType: 'CASH' }, 'nope'),
      match({ symbol: 'NVDA' }, 'NVIDIA CORP'),
    ];
    const out = suggestionsFrom(matches, 'aapl', new Set([contractKey(stock('NVDA'))]));
    // The USD line on BVL shares the US listing's key: only the US listing is offered.
    expect(out.map((s) => `${s.contract.symbol}:${s.contract.currency}`)).toEqual(['AAPL:USD', 'AAPB:USD', 'AAPL:MXN']);
    expect(out[0]).toMatchObject({ name: 'APPLE INC', contract: { primaryExchange: 'NASDAQ', exchange: 'SMART' } });
    expect(out[2].contract).toMatchObject({ exchange: 'MEXI', primaryExchange: 'MEXI' });
  });

  it('keeps US share classes ahead of at most two foreign exact matches', () => {
    const foreign = ['CAD', 'GBP', 'AUD', 'RON', 'EUR', 'CHF'].map((currency) => match({ symbol: 'BRK', currency, exchange: 'SMART' }, `BRK ${currency}`));
    const matches = [...foreign, match({ symbol: 'BRK B', primaryExchange: 'NYSE' }, 'BERKSHIRE HATHAWAY INC-CL B'), match({ symbol: 'BRK A', primaryExchange: 'NYSE' }, 'BERKSHIRE HATHAWAY INC-CL A')];
    expect(suggestionsFrom(matches, 'BRK', new Set()).map((s) => contractKey(s.contract))).toEqual(['STK:BRK B', 'STK:BRK A', 'STK:BRK:CAD', 'STK:BRK:GBP']);
  });

  it('drops corporate-action and delisted listings', () => {
    const matches = [
      match({ symbol: 'BABA', primaryExchange: 'NYSE' }, 'ALIBABA GROUP HOLDING-SP ADR'),
      match({ symbol: 'BABA.TEN', primaryExchange: 'CORPACT' }, 'ALIBABA GROUP HOLDING-SP ADR'),
      match({ symbol: 'BABA.TEN3', primaryExchange: 'CORPACT' }, 'ALIBABA GROUP HOLDING-SP ADR'),
      match({ symbol: 'BABA.OLD', primaryExchange: 'VALUE' }, 'ALIBABA GROUP HOLDING-SP ADR'),
    ];
    expect(suggestionsFrom(matches, 'BABA', new Set()).map((s) => s.contract.symbol)).toEqual(['BABA']);
  });

  it('limits suggestions and omits empty names', () => {
    const many = Array.from({ length: 10 }, (_, i) => match({ symbol: `A${i}` }, i === 0 ? '  ' : `Co ${i}`));
    const out = suggestionsFrom(many, 'A', new Set());
    expect(out).toHaveLength(6);
    expect(out[0].name).toBeUndefined();
  });

  it('recognizes typed tickers', () => {
    expect(looksLikeTicker('aapl')).toBe(true);
    expect(looksLikeTicker('BRK B')).toBe(true);
    expect(looksLikeTicker('BF.B')).toBe(true);
    expect(looksLikeTicker('googl')).toBe(true);
    expect(looksLikeTicker('')).toBe(false);
    expect(looksLikeTicker('netflix')).toBe(false);
    expect(looksLikeTicker('123')).toBe(false);
    expect(looksLikeTicker('apple inc ltd corp')).toBe(false);
    expect(looksLikeTicker('苹果')).toBe(false);
    expect(normalizeTicker('  brk   b ')).toBe('BRK B');
  });
});

describe('clampMenu', () => {
  it('keeps the menu inside the panel', () => {
    expect(clampMenu(40, 100, 196, 300, 272, 800)).toEqual({ x: 40, y: 100 });
    expect(clampMenu(200, 700, 196, 300, 272, 800)).toEqual({ x: 68, y: 492 });
    expect(clampMenu(-5, -5, 196, 300, 272, 800)).toEqual({ x: 8, y: 8 });
    // Taller than the panel: pinned to the top margin.
    expect(clampMenu(10, 100, 196, 900, 272, 800)).toEqual({ x: 10, y: 8 });
  });
});
