import { describe, expect, it } from 'vitest';
import type { ColumnId } from './columns';
import {
  compareValues,
  heldOrder,
  moveColumn,
  moveColumnBy,
  nextSort,
  removeColumn,
  sanitizeColumns,
  sanitizePrefs,
  sameOrder,
  sortBy,
  toggleColumn,
} from './columnsState';

describe('stored column choice', () => {
  it('reads a stored list: unknown and repeated ids dropped, Symbol first', () => {
    expect(sanitizeColumns(null)).toBeNull();
    expect(sanitizeColumns({ columns: ['bid'] })).toBeNull();
    expect(sanitizeColumns([])).toEqual(['symbol']);
    expect(sanitizeColumns(['bid', 'nope', 'quantity', 'bid', 7, null, 'symbol', 'delta'])).toEqual(['symbol', 'bid', 'quantity', 'delta']);
  });

  it('maps renamed ids', () => {
    expect(sanitizeColumns(['lastPx', 'bid'], { lastPx: 'last' })).toEqual(['symbol', 'last', 'bid']);
    // A rename onto a column already listed is not repeated.
    expect(sanitizeColumns(['last', 'lastPx'], { lastPx: 'last' })).toEqual(['symbol', 'last']);
  });

  it('reads stored preferences, keeping a sort only on a shown column', () => {
    expect(sanitizePrefs(null)).toBeNull();
    expect(sanitizePrefs('x')).toBeNull();
    expect(sanitizePrefs([])).toBeNull();
    expect(sanitizePrefs({})).toEqual({ columns: null, sort: null });
    expect(sanitizePrefs({ sort: { id: 'value', dir: 'desc' } })).toEqual({ columns: null, sort: { id: 'value', dir: 'desc' } });
    // Not shown with the default columns, a wrong direction, an unknown column.
    expect(sanitizePrefs({ sort: { id: 'bid', dir: 'asc' } })?.sort).toBeNull();
    expect(sanitizePrefs({ sort: { id: 'value', dir: 'up' } })?.sort).toBeNull();
    expect(sanitizePrefs({ sort: { id: 'nope', dir: 'asc' } })?.sort).toBeNull();
    expect(sanitizePrefs({ columns: ['bid', 'ask'], sort: { id: 'bid', dir: 'asc' } })).toEqual({ columns: ['symbol', 'bid', 'ask'], sort: { id: 'bid', dir: 'asc' } });
    expect(sanitizePrefs({ columns: 'bid', sort: null })).toEqual({ columns: null, sort: null });
  });
});

describe('column edits', () => {
  const cols: ColumnId[] = ['symbol', 'quantity', 'price', 'value'];

  it('shows a column at the end or hides it; Symbol stays', () => {
    expect(toggleColumn(cols, 'bid')).toEqual(['symbol', 'quantity', 'price', 'value', 'bid']);
    expect(toggleColumn(cols, 'price')).toEqual(['symbol', 'quantity', 'value']);
    expect(toggleColumn(cols, 'symbol')).toBe(cols);
    expect(removeColumn(cols, 'quantity')).toEqual(['symbol', 'price', 'value']);
    expect(removeColumn(cols, 'symbol')).toBe(cols);
    expect(removeColumn(cols, 'bid')).toBe(cols);
  });

  it('moves a column, never in front of Symbol', () => {
    expect(moveColumn(cols, 'value', 1)).toEqual(['symbol', 'value', 'quantity', 'price']);
    expect(moveColumn(cols, 'quantity', 3)).toEqual(['symbol', 'price', 'value', 'quantity']);
    expect(moveColumn(cols, 'quantity', 99)).toEqual(['symbol', 'price', 'value', 'quantity']);
    expect(moveColumn(cols, 'value', 0)).toEqual(['symbol', 'value', 'quantity', 'price']);
    expect(moveColumn(cols, 'quantity', 1)).toBe(cols);
    expect(moveColumn(cols, 'symbol', 2)).toBe(cols);
    expect(moveColumn(cols, 'bid', 1)).toBe(cols);
  });

  it('moves a column by one place', () => {
    expect(moveColumnBy(cols, 'price', -1)).toEqual(['symbol', 'price', 'quantity', 'value']);
    expect(moveColumnBy(cols, 'price', 1)).toEqual(['symbol', 'quantity', 'value', 'price']);
    expect(moveColumnBy(cols, 'quantity', -1)).toBe(cols);
    expect(moveColumnBy(cols, 'value', 1)).toBe(cols);
    expect(moveColumnBy(cols, 'symbol', 1)).toBe(cols);
  });
});

describe('sorting', () => {
  it('cycles a header click through ascending, descending and off', () => {
    expect(nextSort(null, 'value')).toEqual({ id: 'value', dir: 'asc' });
    expect(nextSort({ id: 'value', dir: 'asc' }, 'value')).toEqual({ id: 'value', dir: 'desc' });
    expect(nextSort({ id: 'value', dir: 'desc' }, 'value')).toBeNull();
    expect(nextSort({ id: 'value', dir: 'desc' }, 'symbol')).toEqual({ id: 'symbol', dir: 'asc' });
  });

  it('puts blanks last in both directions', () => {
    const values = [3, undefined, 1, Number.NaN, 2, ''];
    const asc = sortBy(values, (v) => v, 'num', 'asc');
    const desc = sortBy(values, (v) => v, 'num', 'desc');
    expect(asc.slice(0, 3)).toEqual([1, 2, 3]);
    expect(desc.slice(0, 3)).toEqual([3, 2, 1]);
    for (const list of [asc, desc]) expect(list.slice(3).every((v) => v === undefined || v === '' || Number.isNaN(v))).toBe(true);
    expect(compareValues(undefined, undefined, 'num', 'asc')).toBe(0);
  });

  it('compares text by collation, numbers inside it as numbers', () => {
    expect(sortBy(['A10', 'a2', 'B1', 'A2'], (v) => v, 'text', 'asc')).toEqual(['a2', 'A2', 'A10', 'B1']);
    expect(compareValues('NASDAQ', 'nasdaq', 'text', 'asc')).toBe(0);
    expect(compareValues('ARCA', 'NYSE', 'text', 'desc')).toBeGreaterThan(0);
    // Chinese by pinyin (jiǎ before yǐ), not by code point.
    expect(sortBy(['乙', '甲'], (v) => v, 'text', 'asc', 'zh')).toEqual(['甲', '乙']);
  });

  it('is stable and breaks ties as asked', () => {
    const rows = [
      { id: 'b', conId: 2, v: 5 },
      { id: 'a', conId: 3, v: 5 },
      { id: 'c', conId: 1, v: 7 },
      { id: 'd', conId: 4, v: 5 },
    ];
    expect(sortBy(rows, (r) => r.v, 'num', 'asc').map((r) => r.id)).toEqual(['b', 'a', 'd', 'c']);
    const byConId = (x: { conId: number }, y: { conId: number }) => x.conId - y.conId;
    expect(sortBy(rows, (r) => r.v, 'num', 'asc', 'en', byConId).map((r) => r.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(sortBy(rows, (r) => r.v, 'num', 'desc', 'en', byConId).map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('held row order', () => {
  it('keeps the drawn rows in place, drops closed ones and adds new ones last', () => {
    expect(heldOrder(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['a', 'b', 'c']);
    expect(heldOrder(['a', 'b', 'c'], ['c', 'd', 'a'])).toEqual(['a', 'c', 'd']);
    expect(heldOrder([], ['x', 'y'])).toEqual(['x', 'y']);
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});
