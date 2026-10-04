import { describe, expect, it } from 'vitest';
import { contractKey, index, stock } from '@shared/contract';
import { defaultWatchlists } from '@shared/defaults';
import type { ContractRef, SymbolMatch, Watchlist } from '@shared/types';
import {
  addItem,
  clampMenu,
  createGroup,
  createList,
  deleteList,
  kindTag,
  listAccepts,
  listContracts,
  listHas,
  listItemCount,
  listKeys,
  looksLikeTicker,
  moveItem,
  normalizeMatch,
  normalizeTicker,
  removeItem,
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
  it('normalizes stock and index contracts', () => {
    expect(normalizeMatch({ symbol: 'AAPL', secType: 'STK', exchange: 'NASDAQ', currency: 'USD', conId: 265598 })).toEqual({
      symbol: 'AAPL',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
      primaryExchange: 'NASDAQ',
      conId: 265598,
    });
    expect(normalizeMatch({ symbol: 'SPX', secType: 'IND', exchange: '', primaryExchange: 'CBOE', currency: 'USD' })).toEqual({
      symbol: 'SPX',
      secType: 'IND',
      exchange: 'CBOE',
      currency: 'USD',
    });
  });

  it('tags kinds', () => {
    expect(kindTag(stock('SPY'), 'SPDR S&P 500 ETF TRUST')).toBe('ETF');
    expect(kindTag(stock('AAPL'), 'APPLE INC')).toBe('STK');
    expect(kindTag(index('SPX', 'CBOE'), 'S&P 500 Stock Index')).toBe('IND');
    expect(kindTag({ ...stock('AAPL'), currency: 'MXN' }, 'APPLE INC')).toBe('STK MXN');
  });

  it('ranks USD listings first, exact symbol first, drops duplicates, listed and unsupported types', () => {
    const matches = [
      match({ symbol: 'AAPL', currency: 'MXN', exchange: 'MEXI' }, 'APPLE INC'),
      match({ symbol: 'AAPB' }, 'GRANITESHARES 2X LONG AAPL'),
      match({ symbol: 'AAPL', primaryExchange: 'NASDAQ' }, 'APPLE INC'),
      match({ symbol: 'AAPL', primaryExchange: 'BVL' }, 'APPLE INC'),
      match({ symbol: 'AAPL', secType: 'CASH' }, 'nope'),
      match({ symbol: 'NVDA' }, 'NVIDIA CORP'),
    ];
    const out = suggestionsFrom(matches, 'aapl', new Set([contractKey(stock('NVDA'))]));
    expect(out.map((s) => `${s.contract.symbol}:${s.contract.currency}:${s.kind}`)).toEqual(['AAPL:USD:STK', 'AAPB:USD:STK', 'AAPL:MXN:STK MXN']);
    expect(out[0]).toMatchObject({ name: 'APPLE INC', contract: { primaryExchange: 'NASDAQ', exchange: 'SMART' } });
  });

  it('keeps US share classes ahead of foreign exact matches', () => {
    const foreign = ['CAD', 'GBP', 'AUD', 'RON', 'EUR', 'CHF'].map((currency) => match({ symbol: 'BRK', currency, exchange: 'SMART' }, `BRK ${currency}`));
    const matches = [...foreign, match({ symbol: 'BRK B', primaryExchange: 'NYSE' }, 'BERKSHIRE HATHAWAY INC-CL B'), match({ symbol: 'BRK A', primaryExchange: 'NYSE' }, 'BERKSHIRE HATHAWAY INC-CL A')];
    expect(suggestionsFrom(matches, 'BRK', new Set()).map((s) => contractKey(s.contract))).toEqual(['STK:BRK B', 'STK:BRK A', 'STK:BRK:CAD', 'STK:BRK:GBP', 'STK:BRK:AUD', 'STK:BRK:RON']);
  });

  it('drops corporate-action listings', () => {
    const matches = [
      match({ symbol: 'BABA', primaryExchange: 'NYSE' }, 'ALIBABA GROUP HOLDING-SP ADR'),
      match({ symbol: 'BABA.TEN', primaryExchange: 'CORPACT' }, 'ALIBABA GROUP HOLDING-SP ADR'),
      match({ symbol: 'BABA.TEN3', primaryExchange: 'CORPACT' }, 'ALIBABA GROUP HOLDING-SP ADR'),
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
