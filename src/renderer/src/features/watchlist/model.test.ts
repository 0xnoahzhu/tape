import { describe, expect, it } from 'vitest';
import { contractKey, index, stock } from '@shared/contract';
import { defaultWatchlists } from '@shared/defaults';
import type { ContractRef, SymbolMatch, Watchlist } from '@shared/types';
import {
  addItem,
  canDeleteGroup,
  clampMenu,
  createGroup,
  createList,
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
  pruneClosedGroups,
  removeItem,
  renameGroup,
  renameList,
  setItemName,
  suggestionsFrom,
} from './model';

const DEFAULT = { en: 'Default', zh: '默认' };
const lists = defaultWatchlists();
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
