import { describe, expect, it } from 'vitest';
import { contractKey, index, option, stock } from '@shared/contract';
import { defaultWatchlists } from '@shared/defaults';
import type { ContractRef, SymbolMatch, Watchlist } from '@shared/types';
import {
  addItem,
  canDeleteGroup,
  clampMenu,
  createGroup,
  createList,
  currentListOf,
  deleteGroup,
  deleteList,
  groupNameTaken,
  listAccepts,
  listContracts,
  listHas,
  listItemCount,
  listKeys,
  looksLikeTicker,
  moveItem,
  neighborGroupId,
  normalizeMatch,
  normalizeTicker,
  placeItem,
  pruneClosedGroups,
  removeFromList,
  removeItem,
  renameGroup,
  renameList,
  setItemName,
  starSections,
  suggestionsFrom,
  targetGroupOf,
  toggleInGroup,
} from './model';

const DEFAULT = { en: 'Default', zh: '默认' };
/** A user list: the sample Options watch the defaults of older versions had. */
const SAVED: Watchlist = {
  id: 'w-options',
  name: { en: 'Options watch', zh: '期权观察' },
  groups: [
    {
      id: 'g-hiv',
      name: { en: 'High IV', zh: '高 IV' },
      items: [
        { contract: stock('TSLA'), name: 'Tesla' },
        { contract: stock('NVDA'), name: 'NVIDIA' },
        { contract: stock('AMD'), name: 'AMD' },
      ],
    },
  ],
};
const lists = [...defaultWatchlists(), SAVED];
const main = lists.find((l) => l.id === 'main')!;
const idx = lists.find((l) => l.id === 'idx')!;
const custom = lists.find((l) => !l.builtin)!;

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

  it('dedupes contracts that appear in several groups', () => {
    const twice: Watchlist = { id: 'x', name: 'x', groups: [{ id: 'a', name: 'a', items: [{ contract: stock('AAPL') }] }, { id: 'b', name: 'b', items: [{ contract: stock('AAPL') }] }] };
    expect(listContracts(twice)).toHaveLength(1);
  });

  it('only lets indices into the Indices list', () => {
    expect(listAccepts(idx, stock('AAPL'))).toBe(false);
    expect(listAccepts(idx, index('SPX', 'CBOE'))).toBe(true);
    expect(listAccepts(main, index('SPX', 'CBOE'))).toBe(true);
    expect(listAccepts(custom, stock('AAPL'))).toBe(true);
  });
});

describe('item operations', () => {
  it('adds to the chosen group, else the first, never twice', () => {
    const goog = { contract: stock('GOOG'), name: 'Alphabet' };
    const a = addItem(main, 'g-etf', goog, DEFAULT);
    expect(a.groups.find((g) => g.id === 'g-etf')!.items.at(-1)).toEqual(goog);
    const b = addItem(main, 'missing', goog, DEFAULT);
    expect(b.groups[0].items.at(-1)).toEqual(goog);
    expect(addItem(main, 'g-etf', { contract: stock('AAPL') }, DEFAULT)).toBe(main);
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

  it('sets a name only when the item exists', () => {
    const next = setItemName(main, 'STK:AMD', 'Advanced Micro Devices');
    expect(next.groups[0].items.find((i) => i.contract.symbol === 'AMD')!.name).toBe('Advanced Micro Devices');
    expect(setItemName(main, 'STK:ZZZ', 'x')).toBe(main);
  });
});

describe('current list and target group', () => {
  it('resolves the current list, else the first list', () => {
    expect(currentListOf(lists, 'w-options')?.id).toBe('w-options');
    expect(currentListOf(lists, 'gone')?.id).toBe('main');
    expect(currentListOf(lists, null)?.id).toBe('main');
    expect(currentListOf(lists, undefined)?.id).toBe('main');
    expect(currentListOf([], 'main')).toBeUndefined();
  });

  it('resolves the target group, else the first group', () => {
    expect(targetGroupOf(main, 'g-etf')?.id).toBe('g-etf');
    expect(targetGroupOf(main, 'missing')?.id).toBe('g-tech');
    expect(targetGroupOf(main, undefined)?.id).toBe('g-tech');
    expect(targetGroupOf({ id: 'e', name: 'E', groups: [] }, 'g')).toBeUndefined();
  });
});

describe('the chart star picker', () => {
  const twice: Watchlist = { id: 'x', name: 'x', groups: [{ id: 'a', name: 'a', items: [{ contract: stock('AAPL') }] }, { id: 'b', name: 'b', items: [{ contract: stock('AAPL') }] }] };

  it('removes an instrument from every group of a list', () => {
    const next = removeFromList(twice, 'STK:AAPL');
    expect(listHas(next, 'STK:AAPL')).toBe(false);
    expect(next.groups.map((g) => g.items)).toEqual([[], []]);
    expect(removeFromList(main, 'STK:ZZZ')).toBe(main);
    expect(twice.groups[0].items).toHaveLength(1); // input untouched
  });

  it('adds when the list lacks the instrument', () => {
    const goog = { contract: stock('GOOG'), name: 'Alphabet' };
    const a = placeItem(main, 'g-etf', goog, DEFAULT);
    expect(a.change).toBe('added');
    expect(a.list.groups.find((g) => g.id === 'g-etf')!.items.at(-1)).toEqual(goog);
    const b = placeItem(main, 'missing', goog, DEFAULT);
    expect(b.change).toBe('added');
    expect(b.list.groups.find((g) => g.id === 'g-tech')!.items.at(-1)).toEqual(goog);
    const empty: Watchlist = { id: 'e', name: 'E', groups: [] };
    expect(placeItem(empty, undefined, { contract: stock('IBM') }, DEFAULT, 'g1')).toEqual({
      list: { id: 'e', name: 'E', groups: [{ id: 'g1', name: DEFAULT, items: [{ contract: stock('IBM') }] }] },
      change: 'added',
    });
  });

  it('moves within the list, keeping the stored item', () => {
    const r = placeItem(main, 'g-auto', { contract: stock('NVDA'), name: 'Nvidia Corp' }, DEFAULT);
    expect(r.change).toBe('moved');
    expect(r.list.groups.find((g) => g.id === 'g-tech')!.items.map((i) => i.contract.symbol)).not.toContain('NVDA');
    expect(r.list.groups.find((g) => g.id === 'g-auto')!.items.at(-1)).toEqual({ contract: stock('NVDA'), name: 'NVIDIA' });
    expect(listItemCount(r.list)).toBe(listItemCount(main));
    expect(main.groups[0].items.map((i) => i.contract.symbol)).toContain('NVDA'); // input untouched
    // In two groups: only the target keeps it.
    const d = placeItem(twice, 'b', { contract: stock('AAPL') }, DEFAULT);
    expect(d.change).toBe('moved');
    expect(d.list.groups.map((g) => g.items.length)).toEqual([0, 1]);
  });

  it('does nothing when it is already only there, or the group is gone', () => {
    const a = placeItem(main, 'g-tech', { contract: stock('AAPL') }, DEFAULT);
    expect(a.change).toBeNull();
    expect(a.list).toBe(main);
    const b = placeItem(main, 'nope', { contract: stock('AAPL') }, DEFAULT);
    expect(b.change).toBeNull();
    expect(b.list).toBe(main);
  });

  it('offers every list that accepts it, its groups checked where it is', () => {
    expect(starSections(lists, stock('AAPL')).map((s) => [s.list.id, s.rows.map((r) => [r.group?.id, r.checked])])).toEqual([
      ['main', [['g-tech', true], ['g-auto', false], ['g-etf', false]]],
      ['w-options', [['g-hiv', false]]],
    ]);
    const nvda = starSections(lists, stock('NVDA'));
    expect(nvda.flatMap((s) => s.rows.filter((r) => r.checked).map((r) => `${s.list.id}:${r.group?.id}`))).toEqual(['main:g-tech', 'w-options:g-hiv']);
  });

  it('offers the Indices list for indices, or when it already holds the instrument', () => {
    expect(starSections(lists, index('OEX', 'CBOE')).map((s) => s.list.id)).toEqual(['main', 'idx', 'w-options']);
    const spx = starSections(lists, index('SPX', 'CBOE')).find((s) => s.list.id === 'idx')!;
    expect(spx.rows.map((r) => [r.group?.id, r.checked])).toEqual([
      ['g-us', true],
      ['g-macro', false],
    ]);
    expect(starSections(lists, stock('AAPL')).some((s) => s.list.id === 'idx')).toBe(false);
    // Symbol search can put a stock into Indices: it is offered there so it can be unchecked.
    const held = lists.map((l) => (l.id === 'idx' ? addItem(l, 'g-macro', { contract: stock('GOOG') }, DEFAULT) : l));
    const goog = starSections(held, stock('GOOG')).find((s) => s.list.id === 'idx')!;
    expect(goog.rows.map((r) => [r.group?.id, r.checked])).toEqual([
      ['g-us', false],
      ['g-macro', true],
    ]);
  });

  it('keeps the lists shown when the picker opened, so an unchecked stock can go back into Indices', () => {
    const held = lists.map((l) => (l.id === 'idx' ? addItem(l, 'g-macro', { contract: stock('GOOG') }, DEFAULT) : l));
    const shown = starSections(held, stock('GOOG')).map((s) => s.list.id);
    expect(shown).toEqual(['main', 'idx', 'w-options']);
    const idx = held.find((l) => l.id === 'idx')!;
    const out = toggleInGroup(idx, 'g-macro', { contract: stock('GOOG') }, DEFAULT);
    expect(out.change).toBe('removed');
    const after = held.map((l) => (l === idx ? out.list : l));
    // Closed (no lists kept), Indices is not offered for a stock it no longer holds ...
    expect(starSections(after, stock('GOOG')).map((s) => s.list.id)).toEqual(['main', 'w-options']);
    // ... while open, it stays, unchecked, and one click puts it back.
    const open = starSections(after, stock('GOOG'), shown);
    expect(open.map((s) => s.list.id)).toEqual(shown);
    expect(open.find((s) => s.list.id === 'idx')!.rows.map((r) => [r.group?.id, r.checked])).toEqual([
      ['g-us', false],
      ['g-macro', false],
    ]);
    const back = toggleInGroup(out.list, 'g-macro', { contract: stock('GOOG') }, DEFAULT);
    expect(back.change).toBe('added');
    expect(back.groupId).toBe('g-macro');
    // A kept list that is gone is not offered.
    expect(starSections(after.filter((l) => l.id !== 'idx'), stock('GOOG'), shown).map((s) => s.list.id)).toEqual(['main', 'w-options']);
  });

  it('compares instruments by contractKey', () => {
    const aapl = starSections(lists, { ...stock('AAPL'), conId: 265598, primaryExchange: 'NASDAQ', exchange: 'ISLAND' });
    expect(aapl.find((s) => s.list.id === 'main')!.rows.find((r) => r.group?.id === 'g-tech')!.checked).toBe(true);
    const call = starSections(lists, option('AAPL', '20261016', 230, 'C'));
    expect(call.some((s) => s.rows.some((r) => r.checked))).toBe(false);
  });

  it('has nothing without lists and a default row for a list without groups', () => {
    expect(starSections([], stock('GOOG'))).toEqual([]);
    const empty: Watchlist = { id: 'e', name: 'E', groups: [] };
    expect(starSections([empty], stock('GOOG'))).toEqual([{ list: empty, rows: [{ group: undefined, checked: false }] }]);
  });

  it('checks an unchecked group: adds the instrument there', () => {
    const goog = { contract: stock('GOOG'), name: 'Alphabet' };
    const a = toggleInGroup(main, 'g-etf', goog, DEFAULT);
    expect(a.change).toBe('added');
    expect(a.groupId).toBe('g-etf');
    expect(a.list.groups.find((g) => g.id === 'g-etf')!.items.at(-1)).toEqual(goog);
    expect(main.groups[2].items).toHaveLength(2); // input untouched
    const empty: Watchlist = { id: 'e', name: 'E', groups: [] };
    expect(toggleInGroup(empty, undefined, { contract: stock('IBM') }, DEFAULT, 'g1')).toEqual({
      list: { id: 'e', name: 'E', groups: [{ id: 'g1', name: DEFAULT, items: [{ contract: stock('IBM') }] }] },
      change: 'added',
      groupId: 'g1',
    });
  });

  it('moves it there when the list has it in another group, keeping the stored item', () => {
    const r = toggleInGroup(main, 'g-auto', { contract: stock('NVDA'), name: 'Nvidia Corp' }, DEFAULT);
    expect(r.change).toBe('moved');
    expect(r.groupId).toBe('g-auto');
    expect(r.list.groups.find((g) => g.id === 'g-auto')!.items.at(-1)).toEqual({ contract: stock('NVDA'), name: 'NVIDIA' });
    expect(r.list.groups.find((g) => g.id === 'g-tech')!.items.map((i) => i.contract.symbol)).not.toContain('NVDA');
    expect(listItemCount(r.list)).toBe(listItemCount(main));
  });

  it('unchecks a checked group: takes it out of the list, and one click puts it back', () => {
    const r = toggleInGroup(main, 'g-tech', { contract: stock('AAPL') }, DEFAULT);
    expect(r.change).toBe('removed');
    expect(r.groupId).toBeUndefined();
    expect(listHas(r.list, 'STK:AAPL')).toBe(false);
    expect(listItemCount(r.list)).toBe(8);
    const back = toggleInGroup(r.list, 'g-tech', { contract: stock('AAPL') }, DEFAULT);
    expect(back.change).toBe('added');
    expect(back.groupId).toBe('g-tech');
    // In two groups: out of both.
    expect(toggleInGroup(twice, 'a', { contract: stock('AAPL') }, DEFAULT).list.groups.map((g) => g.items)).toEqual([[], []]);
  });

  it('does nothing for a gone group while the list has it', () => {
    const r = toggleInGroup(main, 'nope', { contract: stock('AAPL') }, DEFAULT);
    expect(r).toEqual({ list: main, change: null });
    expect(r.list).toBe(main);
  });
});

describe('list and group operations', () => {
  it('creates groups and lists with trimmed names', () => {
    expect(createGroup(main, '  Chips ', 'g9').groups.at(-1)).toEqual({ id: 'g9', name: 'Chips', items: [] });
    expect(createGroup(main, '   ')).toBe(main);
    const next = createList(lists, ' Swing ', DEFAULT, 'w9', 'g9');
    expect(next.at(-1)).toEqual({ id: 'w9', name: 'Swing', groups: [{ id: 'g9', name: DEFAULT, items: [] }] });
    expect(createList(lists, '', DEFAULT)).toBe(lists);
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
    expect(canDeleteGroup(custom)).toBe(false);
    expect(canDeleteGroup(main)).toBe(true);
    const empty: Watchlist = { id: 'e', name: 'E', groups: [] };
    expect(deleteGroup(empty, 'g')).toBe(empty);
  });

  it("finds the group that takes a deleted group's place", () => {
    expect(neighborGroupId(main, 'g-tech')).toBe('g-auto');
    expect(neighborGroupId(main, 'g-auto')).toBe('g-etf');
    expect(neighborGroupId(main, 'g-etf')).toBe('g-auto'); // the last group: the previous one
    expect(neighborGroupId(main, 'nope')).toBeUndefined();
    expect(neighborGroupId(custom, custom.groups[0].id)).toBeUndefined();
  });

  it('prunes the collapsed state of deleted groups of one list', () => {
    const closed = { 'main:g-tech': true, 'main:g-etf': true, 'idx:g-us': true, 'mainx:g-tech': true };
    const next = pruneClosedGroups(closed, deleteGroup(main, 'g-tech'));
    expect(next).toEqual({ 'main:g-etf': true, 'idx:g-us': true, 'mainx:g-tech': true });
    expect(closed['main:g-tech']).toBe(true); // input untouched
    expect(pruneClosedGroups(closed, idx)).toBe(closed);
    expect(pruneClosedGroups(next, deleteGroup(main, 'g-tech'))).toBe(next);
  });

  it('renames and deletes user lists only', () => {
    expect(renameList(lists, custom.id, ' IV ').find((l) => l.id === custom.id)!.name).toBe('IV');
    expect(renameList(lists, 'main', 'Mine').find((l) => l.id === 'main')!.name).toEqual(main.name);
    expect(renameList(lists, custom.id, '  ')).toBe(lists);
    const named = renameList(lists, custom.id, 'IV');
    expect(renameList(named, custom.id, 'IV')).toBe(named);
    expect(renameList(lists, 'main', 'Mine')).toBe(lists);
    expect(deleteList(lists, custom.id).map((l) => l.id)).toEqual(['main', 'idx']);
    expect(deleteList(lists, 'idx')).toHaveLength(3);
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
