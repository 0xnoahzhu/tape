import { describe, expect, it } from 'vitest';
import { COLUMNS, DEFAULT_COLUMNS, type ColumnId } from './columns';
import {
  MAX_COLUMN_WIDTH,
  clampWidth,
  REORDER_SLOP,
  compareValues,
  dragWidth,
  dropMark,
  dropSlot,
  edgeScroll,
  gridTemplate,
  heldGroups,
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
  sameGroups,
  sameOrder,
  setColumnWidth,
  sizeColumn,
  slotTarget,
  sortBy,
  startsReorder,
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
    expect(sanitizePrefs({})).toEqual({ columns: null, sort: null, widths: {}, groupBy: 'underlying' });
    expect(sanitizePrefs({ sort: { id: 'value', dir: 'desc' } })).toEqual({ columns: null, sort: { id: 'value', dir: 'desc' }, widths: {}, groupBy: 'underlying' });
    // Not shown with the default columns, a wrong direction, an unknown column.
    expect(sanitizePrefs({ sort: { id: 'bid', dir: 'asc' } })?.sort).toBeNull();
    expect(sanitizePrefs({ sort: { id: 'value', dir: 'up' } })?.sort).toBeNull();
    expect(sanitizePrefs({ sort: { id: 'nope', dir: 'asc' } })?.sort).toBeNull();
    expect(sanitizePrefs({ columns: ['bid', 'ask'], sort: { id: 'bid', dir: 'asc' } })).toEqual({
      columns: ['symbol', 'bid', 'ask'],
      sort: { id: 'bid', dir: 'asc' },
      widths: {},
      groupBy: 'underlying',
    });
    expect(sanitizePrefs({ columns: 'bid', sort: null })).toEqual({ columns: null, sort: null, widths: {}, groupBy: 'underlying' });
  });

  it('reads the stored grouping; anything else, or none, is by underlying', () => {
    expect(sanitizePrefs({ groupBy: 'sector' })?.groupBy).toBe('sector');
    expect(sanitizePrefs({ groupBy: 'none' })?.groupBy).toBe('none');
    expect(sanitizePrefs({ groupBy: 'underlying' })?.groupBy).toBe('underlying');
    expect(sanitizePrefs({ groupBy: 'industry' })?.groupBy).toBe('underlying');
    expect(sanitizePrefs({ groupBy: 2 })?.groupBy).toBe('underlying');
    expect(sanitizePrefs({ sort: null })?.groupBy).toBe('underlying');
  });

  it('reads what a version without widths stored as before', () => {
    // tape.positions.v1 as 0.8.x wrote it: { columns, sort } or only { sort }.
    expect(sanitizePrefs({ columns: ['symbol', 'quantity', 'bid'], sort: { id: 'bid', dir: 'desc' } })).toEqual({
      columns: ['symbol', 'quantity', 'bid'],
      sort: { id: 'bid', dir: 'desc' },
      widths: {},
      groupBy: 'underlying',
    });
    expect(sanitizePrefs({ sort: { id: 'dayPnl', dir: 'asc' } })).toEqual({ columns: null, sort: { id: 'dayPnl', dir: 'asc' }, widths: {}, groupBy: 'underlying' });
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
    expect(sanitizePrefs({ widths: { quantity: 100, nope: 90 } })).toEqual({ columns: null, sort: null, widths: { quantity: 100 }, groupBy: 'underlying' });
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

  it('sizes a column by the distance its edge was dragged, clamped', () => {
    // Pressed at x 500 on Value's edge, Value drawn 150 wide: 120px right makes it 270.
    expect(dragWidth('value', 150, 500, 620)).toBe(270);
    expect(dragWidth('value', 150, 500, 500)).toBe(150);
    expect(dragWidth('value', 150.4, 500, 459.7)).toBe(110);
    // Never under its catalog width, never over the maximum.
    expect(dragWidth('value', 150, 500, 100)).toBe(COLUMNS.value.width);
    expect(dragWidth('value', 150, 500, 5000)).toBe(MAX_COLUMN_WIDTH);
    // Drawn wider than the maximum (a share of a very wide card): not sized until it is brought within it.
    expect(dragWidth('symbol', 900, 1000, 990)).toBeNull();
    expect(dragWidth('symbol', 900, 1000, 1100)).toBeNull();
    expect(dragWidth('symbol', 900, 1000, 700)).toBe(600);
    expect(dragWidth('symbol', MAX_COLUMN_WIDTH, 1000, 1100)).toBe(MAX_COLUMN_WIDTH);
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

  it('starts a header drag only past a few px sideways; a smaller move is a click', () => {
    expect(startsReorder(100, 100)).toBe(false);
    expect(startsReorder(100, 100 + REORDER_SLOP)).toBe(false);
    expect(startsReorder(100, 100 - REORDER_SLOP)).toBe(false);
    expect(startsReorder(100, 100 + REORDER_SLOP + 1)).toBe(true);
    expect(startsReorder(100, 100 - REORDER_SLOP - 0.5)).toBe(true);
  });

  it('marks where a dragged header lands, in the gap before the slot, never over Symbol', () => {
    // Headers with 12px gaps: Symbol 0–200, Qty 212–284, Price 296–380, Value 392–488.
    const cells = [
      { left: 0, right: 200 },
      { left: 212, right: 284 },
      { left: 296, right: 380 },
      { left: 392, right: 488 },
    ];
    // Value dragged left over Qty's right half: between Qty and Price.
    expect(dropMark(cells, 270, cols, 'value', 12)).toEqual({ slot: 2, x: 290 });
    // ...to Qty's left edge (left of its midpoint): right after Symbol.
    expect(dropMark(cells, 212, cols, 'value', 12)).toEqual({ slot: 1, x: 206 });
    // Over Symbol: as at its right edge.
    expect(dropMark(cells, 40, cols, 'value', 12)).toEqual({ slot: 1, x: 206 });
    // Qty dragged past the last header: after it.
    expect(dropMark(cells, 900, cols, 'quantity', 12)).toEqual({ slot: 4, x: 494 });
    // No mark where the column already is (either of its own edges).
    expect(dropMark(cells, 420, cols, 'value', 12)).toBeNull();
    expect(dropMark(cells, 350, cols, 'value', 12)).toBeNull();
    expect(dropMark(cells, 300, cols, 'price', 12)).toBeNull();
    // Scrolled sideways, Qty partly under Symbol: over Symbol, the first slot in view (after Qty).
    const scrolled = [
      { left: 0, right: 200 },
      { left: 150, right: 222 },
      { left: 234, right: 318 },
      { left: 330, right: 426 },
    ];
    expect(dropMark(scrolled, 100, cols, 'value', 12)).toEqual({ slot: 2, x: 228 });
    expect(dropMark(scrolled, 180, cols, 'price', 12)).toBeNull();
    // Price partly under Symbol too: its slot is marked just right of Symbol's edge, not over it.
    const further = [
      { left: 0, right: 200 },
      { left: 100, right: 172 },
      { left: 184, right: 268 },
      { left: 280, right: 376 },
    ];
    expect(dropMark(further, 100, cols, 'value', 12)).toEqual({ slot: 2, x: 201 });
    expect(dropMark([], 100, cols, 'value', 12)).toBeNull();
    expect(dropMark(cells, 100, cols, 'symbol', 12)).toBeNull();
  });

  it('scrolls the card at the side a header is dragged towards, faster the closer', () => {
    // The view from Symbol's right edge (200) to 1000; 32px zones; up to 16px a frame.
    const step = (x: number, x0: number) => edgeScroll(x, x0, 200, 1000, 32, 16);
    expect(step(600, 500)).toBe(0);
    expect(step(990, 500)).toBe(Math.ceil(16 * (22 / 32)));
    expect(step(1000, 500)).toBe(16);
    expect(step(1200, 500)).toBe(16);
    expect(step(220, 500)).toBe(-Math.ceil(16 * (12 / 32)));
    expect(step(150, 500)).toBe(-16);
    expect(step(232, 500)).toBe(0);
    // Pressed near a side and dragged away from it: no scroll.
    expect(step(980, 990)).toBe(0);
    expect(step(210, 205)).toBe(0);
    expect(step(990, 990)).toBe(0);
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

  it('keeps the drawn groups in place, and the drawn rows in place within each', () => {
    const g = (key: string, ...ids: string[]) => ({ key, ids });
    // The wanted order swapped both the groups and the rows within B: nothing moves.
    expect(heldGroups([g('A', 'a1'), g('B', 'b1', 'b2')], [g('B', 'b2', 'b1'), g('A', 'a1')])).toEqual([g('A', 'a1'), g('B', 'b1', 'b2')]);
    // A closed row and group go, a new row comes last in its group, a new group last.
    expect(heldGroups([g('A', 'a1', 'a2'), g('B', 'b1'), g('C', 'c1')], [g('C', 'c1'), g('D', 'd1'), g('A', 'a3', 'a2')])).toEqual([
      g('A', 'a2', 'a3'),
      g('C', 'c1'),
      g('D', 'd1'),
    ]);
    // A row that moved to another group shows in its new one.
    expect(heldGroups([g('A', 'x', 'a1'), g('B', 'b1')], [g('A', 'a1'), g('B', 'x', 'b1')])).toEqual([g('A', 'a1'), g('B', 'b1', 'x')]);
    expect(heldGroups([], [g('A', 'a1')])).toEqual([g('A', 'a1')]);
    expect(sameGroups([g('A', 'a1', 'a2')], [g('A', 'a1', 'a2')])).toBe(true);
    expect(sameGroups([g('A', 'a1', 'a2')], [g('A', 'a2', 'a1')])).toBe(false);
    expect(sameGroups([g('A', 'a1')], [g('B', 'a1')])).toBe(false);
    expect(sameGroups([g('A', 'a1')], [g('A', 'a1'), g('B')])).toBe(false);
  });
});
