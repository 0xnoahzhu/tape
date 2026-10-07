import { describe, expect, it } from 'vitest';
import { COLUMNS, DEFAULT_COLUMNS, type ColumnId } from './columns';
import {
  MAX_COLUMN_WIDTH,
  clampWidth,
  compareValues,
  dropSlot,
  gridTemplate,
  heldOrder,
  liveWidths,
  moveColumn,
  moveColumnBy,
  moveColumnToSlot,
  nextSort,
  removeColumn,
  resetColumnWidth,
  sanitizeColumns,
  sanitizePrefs,
  sanitizeWidths,
  sameOrder,
  setColumnWidth,
  sizeColumn,
  slotTarget,
  sortBy,
  toggleColumn,
  tracksWidth,
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
    expect(sanitizePrefs({})).toEqual({ columns: null, sort: null, widths: {} });
    expect(sanitizePrefs({ sort: { id: 'value', dir: 'desc' } })).toEqual({ columns: null, sort: { id: 'value', dir: 'desc' }, widths: {} });
    // Not shown with the default columns, a wrong direction, an unknown column.
    expect(sanitizePrefs({ sort: { id: 'bid', dir: 'asc' } })?.sort).toBeNull();
    expect(sanitizePrefs({ sort: { id: 'value', dir: 'up' } })?.sort).toBeNull();
    expect(sanitizePrefs({ sort: { id: 'nope', dir: 'asc' } })?.sort).toBeNull();
    expect(sanitizePrefs({ columns: ['bid', 'ask'], sort: { id: 'bid', dir: 'asc' } })).toEqual({
      columns: ['symbol', 'bid', 'ask'],
      sort: { id: 'bid', dir: 'asc' },
      widths: {},
    });
    expect(sanitizePrefs({ columns: 'bid', sort: null })).toEqual({ columns: null, sort: null, widths: {} });
  });

  it('reads what a version without widths stored as before', () => {
    // tape.positions.v1 as 0.8.x wrote it: { columns, sort } or only { sort }.
    expect(sanitizePrefs({ columns: ['symbol', 'quantity', 'bid'], sort: { id: 'bid', dir: 'desc' } })).toEqual({
      columns: ['symbol', 'quantity', 'bid'],
      sort: { id: 'bid', dir: 'desc' },
      widths: {},
    });
    expect(sanitizePrefs({ sort: { id: 'dayPnl', dir: 'asc' } })).toEqual({ columns: null, sort: { id: 'dayPnl', dir: 'asc' }, widths: {} });
  });

  it('reads stored widths: unknown ids and non-numbers dropped, each clamped, hidden columns kept', () => {
    expect(sanitizeWidths(undefined)).toEqual({});
    expect(sanitizeWidths(null)).toEqual({});
    expect(sanitizeWidths([120])).toEqual({});
    expect(sanitizeWidths('quantity:120')).toEqual({});
    expect(sanitizeWidths({ quantity: 120.4, nope: 200, bid: '90', ask: null, price: Number.NaN, value: 1e9, weight: 3 })).toEqual({
      quantity: 120,
      value: MAX_COLUMN_WIDTH,
      weight: COLUMNS.weight.width,
    });
    expect(sanitizeWidths({ lastPx: 150 }, { lastPx: 'last' })).toEqual({ last: 150 });
    // A width of a column that is not shown stays, for when it is shown again.
    expect(sanitizePrefs({ columns: ['quantity'], widths: { quantity: 100, delta: 90 } })?.widths).toEqual({ quantity: 100, delta: 90 });
    expect(sanitizePrefs({ widths: { quantity: 100, nope: 90 } })).toEqual({ columns: null, sort: null, widths: { quantity: 100 } });
  });
});

describe('column widths', () => {
  it('clamps a width between the catalog width and the maximum, in whole px', () => {
    expect(clampWidth('quantity', 10)).toBe(COLUMNS.quantity.width);
    expect(clampWidth('quantity', 130.6)).toBe(131);
    expect(clampWidth('quantity', 5000)).toBe(MAX_COLUMN_WIDTH);
    expect(clampWidth('symbol', 150)).toBe(COLUMNS.symbol.width);
    for (const id of Object.keys(COLUMNS) as ColumnId[]) expect(COLUMNS[id].width).toBeLessThan(MAX_COLUMN_WIDTH);
  });

  it('sets and resets a width; unchanged widths come back as they are', () => {
    const none = {};
    const one = setColumnWidth(none, 'value', 150);
    expect(one).toEqual({ value: 150 });
    expect(setColumnWidth(one, 'value', 150.2)).toBe(one);
    expect(setColumnWidth(one, 'quantity', 1)).toEqual({ value: 150, quantity: COLUMNS.quantity.width });
    expect(resetColumnWidth(one, 'value')).toEqual({});
    expect(resetColumnWidth(one, 'quantity')).toBe(one);
    expect(one).toEqual({ value: 150 });
  });

  it('draws the default tracks without widths, a sized column at its width', () => {
    const defs = DEFAULT_COLUMNS.slice(0, 3).map((id) => COLUMNS[id]);
    // The table as it always was: Symbol 2fr, the others 1fr, none under its minimum.
    expect(gridTemplate(defs, {})).toBe('minmax(200px,2fr) minmax(72px,1fr) minmax(84px,1fr)');
    expect(gridTemplate(defs, { quantity: 140, bid: 99 })).toBe('minmax(200px,2fr) 140px minmax(84px,1fr)');
    expect(gridTemplate(defs, { symbol: 260 })).toBe('260px minmax(72px,1fr) minmax(84px,1fr)');
    expect(tracksWidth(defs, {})).toBe(200 + 72 + 84);
    expect(tracksWidth(defs, { quantity: 140, bid: 99 })).toBe(200 + 140 + 84);
  });

  it('keeps the columns left of a sized one at their drawn widths, so its edge follows the pointer', () => {
    // The default columns in a card with spare width: each column drawn wider than its minimum.
    const defs = DEFAULT_COLUMNS.map((id) => COLUMNS[id]);
    const left = { symbol: 361.6, quantity: 152.8, avgPrice: 164.8, price: 164.8 };
    const live = liveWidths({}, 'value', 266.8, left);
    // Every track up to Value is fixed, so Value's right edge does not move with the spare width;
    // the columns right of it share what it took.
    expect(gridTemplate(defs, live)).toBe(
      '361.6px 152.8px 164.8px 164.8px 266.8px minmax(72px,1fr) minmax(104px,1fr) minmax(96px,1fr)',
    );
    expect(tracksWidth(defs, live)).toBeCloseTo(361.6 + 152.8 + 164.8 + 164.8 + 266.8 + 72 + 104 + 96);
    // A width of the column itself in `left` or in the stored widths gives way to the live one.
    expect(liveWidths({ value: 120 }, 'value', 266.8, { ...left, value: 176.8 }).value).toBe(266.8);

    // Released: the columns that shared the spare width keep their drawn widths, in whole px.
    expect(sizeColumn({}, 'value', 266.8, left)).toEqual({ symbol: 362, quantity: 153, avgPrice: 165, price: 165, value: 267 });
  });

  it('fixes no column left of a sized one that is at its minimum, over the maximum or already sized', () => {
    const widths = { avgPrice: 120 };
    // Scrolling sideways: every unsized track at its catalog width keeps sharing.
    expect(sizeColumn(widths, 'value', 150, { symbol: 200, quantity: 72.2, avgPrice: 120, price: 84 })).toEqual({ avgPrice: 120, value: 150 });
    // A very wide card: Symbol's share over the maximum stays a share.
    expect(sizeColumn({}, 'quantity', 100, { symbol: 900 })).toEqual({ quantity: 100 });
    // A stored width is not replaced by a drawn one; unknown ids are ignored.
    expect(sizeColumn(widths, 'value', 150, { avgPrice: 180, nope: 300 } as never)).toEqual({ avgPrice: 120, value: 150 });
    // Nothing changes: the same object back.
    const same = { quantity: 100 };
    expect(sizeColumn(same, 'quantity', 100.2, { symbol: 200 })).toBe(same);
    expect(sizeColumn(same, 'quantity', 100)).toBe(same);
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

  it('finds the slot a dragged header lands in, never before Symbol', () => {
    // Header midpoints of Symbol, Qty, Price, Value.
    const mids = [100, 260, 360, 460];
    expect(dropSlot(mids, 10)).toBe(1);
    expect(dropSlot(mids, 250)).toBe(1);
    expect(dropSlot(mids, 270)).toBe(2);
    expect(dropSlot(mids, 400)).toBe(3);
    expect(dropSlot(mids, 900)).toBe(4);
    expect(dropSlot(mids, 10, 200)).toBe(1);
    // Scrolled sideways: Symbol spans 0–200 and Qty and Price lie under it, Value right of it.
    const scrolled = [100, 40, 160, 260];
    expect(dropSlot(scrolled, 120)).toBe(2);
    // Over Symbol, the pointer counts as at its right edge: before Value, not between the hidden columns.
    expect(dropSlot(scrolled, 116, 200)).toBe(3);
    expect(dropSlot(scrolled, 10, 200)).toBe(3);
    expect(dropSlot(scrolled, 270, 200)).toBe(4);
    expect(dropSlot([100], 500)).toBe(1);
    expect(dropSlot([], 500)).toBe(1);
  });

  it('moves a dropped column to its slot; a slot at its own edges keeps it', () => {
    expect(slotTarget(cols, 'value', 1)).toBe(1);
    expect(moveColumnToSlot(cols, 'value', 1)).toEqual(['symbol', 'value', 'quantity', 'price']);
    expect(moveColumnToSlot(cols, 'quantity', 4)).toEqual(['symbol', 'price', 'value', 'quantity']);
    expect(moveColumnToSlot(cols, 'quantity', 3)).toEqual(['symbol', 'price', 'quantity', 'value']);
    expect(moveColumnToSlot(cols, 'price', 4)).toEqual(['symbol', 'quantity', 'value', 'price']);
    expect(moveColumnToSlot(cols, 'price', 0)).toEqual(['symbol', 'price', 'quantity', 'value']);
    expect(slotTarget(cols, 'price', 2)).toBeNull();
    expect(slotTarget(cols, 'price', 3)).toBeNull();
    expect(moveColumnToSlot(cols, 'price', 3)).toBe(cols);
    expect(moveColumnToSlot(cols, 'value', 99)).toBe(cols);
    expect(moveColumnToSlot(cols, 'symbol', 3)).toBe(cols);
    expect(moveColumnToSlot(cols, 'bid', 1)).toBe(cols);
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
