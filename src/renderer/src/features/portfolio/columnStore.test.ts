import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLUMNS } from './columns';

/** A localStorage stand-in (vitest runs without a DOM). */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

async function freshStore() {
  vi.resetModules();
  return (await import('./columnStore')).usePositionColumns;
}

const KEY = 'tape.positions.v1';

describe('remembered columns and sort', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts from the default columns, stores changes and forgets them on reset', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    let store = await freshStore();
    expect(store.getState()).toMatchObject({ columns: null, sort: null, editorOpen: false });
    store.getState().toggle('bid');
    store.getState().moveBy('bid', -1);
    store.getState().cycleSort('bid');
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({
      columns: [...DEFAULT_COLUMNS.slice(0, -1), 'bid', 'dayPnl'],
      sort: { id: 'bid', dir: 'asc' },
    });

    store = await freshStore();
    expect(store.getState().columns).toContain('bid');
    expect(store.getState().sort).toEqual({ id: 'bid', dir: 'asc' });

    store.getState().reset();
    expect(storage.data.has(KEY)).toBe(false);
    expect(store.getState()).toMatchObject({ columns: null, sort: null });
  });

  it('stores a sort of the default columns without the column list', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await freshStore();
    store.getState().cycleSort('dayPnl');
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ sort: { id: 'dayPnl', dir: 'asc' } });
    store.getState().cycleSort('dayPnl');
    store.getState().cycleSort('dayPnl');
    // Back to no sort and the default columns: nothing to store.
    expect(storage.data.has(KEY)).toBe(false);
    // A hidden column cannot be sorted.
    store.getState().cycleSort('bid');
    expect(store.getState().sort).toBeNull();
  });

  it('drops the sort when its column is hidden', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const store = await freshStore();
    store.getState().cycleSort('value');
    store.getState().remove('value');
    expect(store.getState().sort).toBeNull();
    expect(store.getState().columns).not.toContain('value');
  });

  it('ignores what it cannot read', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: '{oops' }));
    expect((await freshStore()).getState()).toMatchObject({ columns: null, sort: null });
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: JSON.stringify({ columns: ['nope', 'bid'], sort: { id: 'ask', dir: 'asc' } }) }));
    expect((await freshStore()).getState()).toMatchObject({ columns: ['symbol', 'bid'], sort: null });
  });

  it('keeps changes for the session when storage fails', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    });
    const store = await freshStore();
    store.getState().toggle('ask');
    expect(store.getState().columns).toContain('ask');
  });

  it('remembers column widths across a restart, without writing out the default columns', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    let store = await freshStore();
    expect(store.getState().widths).toEqual({});
    store.getState().setWidth('value', 151.4);
    store.getState().setWidth('quantity', 1);
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ sort: null, widths: { value: 151, quantity: 72 } });

    // A new app start reads them back (localStorage lives in the Electron profile).
    store = await freshStore();
    expect(store.getState()).toMatchObject({ columns: null, sort: null, widths: { value: 151, quantity: 72 } });

    // A double-click on the edge: the default width again.
    store.getState().resetWidth('value');
    store.getState().resetWidth('quantity');
    expect(store.getState().widths).toEqual({});
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('stores the widths the columns left of a sized one were drawn at, and forgets them on reset', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    let store = await freshStore();
    // Symbol and Qty took a share of the spare width; Avg is at its minimum.
    store.getState().setWidth('price', 140.4, { symbol: 340.2, quantity: 110, avgPrice: 84 });
    expect(JSON.parse(storage.data.get(KEY)!).widths).toEqual({ symbol: 340, quantity: 110, price: 140 });
    store = await freshStore();
    expect(store.getState().widths).toEqual({ symbol: 340, quantity: 110, price: 140 });
    store.getState().reset();
    expect(store.getState().widths).toEqual({});
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('keeps a hidden column\'s width for when it is shown again; reset forgets widths too', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await freshStore();
    store.getState().toggle('bid');
    store.getState().setWidth('bid', 130);
    store.getState().toggle('bid');
    expect(store.getState().columns).not.toContain('bid');
    expect(JSON.parse(storage.data.get(KEY)!).widths).toEqual({ bid: 130 });
    store.getState().toggle('bid');
    expect(store.getState().widths).toEqual({ bid: 130 });

    store.getState().reset();
    expect(storage.data.has(KEY)).toBe(false);
    expect(store.getState()).toMatchObject({ columns: null, sort: null, widths: {} });
  });

  it('reads what a version without widths or a grouping stored', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: JSON.stringify({ columns: ['symbol', 'value', 'bid'], sort: { id: 'bid', dir: 'desc' } }) }));
    expect((await freshStore()).getState()).toMatchObject({ columns: ['symbol', 'value', 'bid'], sort: { id: 'bid', dir: 'desc' }, widths: {}, groupBy: 'underlying' });
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: JSON.stringify({ widths: { nope: 90, value: 'wide', bid: 120 } }) }));
    expect((await freshStore()).getState()).toMatchObject({ columns: null, sort: null, widths: { bid: 120 } });
  });

  it('moves a dropped header to its slot, the order the editor shows', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await freshStore();
    store.getState().moveToSlot('dayPnl', 1);
    expect(store.getState().columns).toEqual(['symbol', 'dayPnl', ...DEFAULT_COLUMNS.slice(1, -1)]);
    expect(JSON.parse(storage.data.get(KEY)!).columns).toEqual(store.getState().columns);
    // Dropped where it is: nothing changes.
    const before = store.getState().columns;
    store.getState().moveToSlot('dayPnl', 2);
    store.getState().moveToSlot('symbol', 4);
    expect(store.getState().columns).toBe(before);
  });

  it('remembers the grouping, writing it out only when it is not by underlying', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    let store = await freshStore();
    expect(store.getState().groupBy).toBe('underlying');
    store.getState().setGroupBy('sector');
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ sort: null, groupBy: 'sector' });
    store = await freshStore();
    expect(store.getState().groupBy).toBe('sector');
    // Other changes keep it.
    store.getState().cycleSort('value');
    store.getState().toggle('bid');
    store.getState().setWidth('bid', 120);
    expect(JSON.parse(storage.data.get(KEY)!).groupBy).toBe('sector');
    store.getState().setGroupBy('none');
    store = await freshStore();
    expect(store.getState().groupBy).toBe('none');
    // Back to by underlying with nothing else changed: nothing to store.
    store.getState().reset();
    store.getState().setGroupBy('sector');
    store.getState().setGroupBy('underlying');
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('collapses groups for the session only; reset expands them and groups by underlying again', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await freshStore();
    store.getState().toggleGroup('u:STK:AAPL');
    store.getState().toggleGroup('s:Technology');
    expect(store.getState().collapsed).toEqual({ 'u:STK:AAPL': true, 's:Technology': true });
    expect(storage.data.has(KEY)).toBe(false);
    store.getState().toggleGroup('u:STK:AAPL');
    expect(store.getState().collapsed).toEqual({ 's:Technology': true });
    // Switching the grouping keeps them (each grouping has its own keys).
    store.getState().setGroupBy('sector');
    expect(store.getState().collapsed).toEqual({ 's:Technology': true });
    store.getState().reset();
    expect(store.getState()).toMatchObject({ groupBy: 'underlying', collapsed: {} });
    expect(storage.data.has(KEY)).toBe(false);
    expect((await freshStore()).getState().collapsed).toEqual({});
  });

  it('does not store the editor, and closeTransient closes it', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await freshStore();
    store.getState().setEditorOpen(true);
    expect(storage.data.size).toBe(0);
    store.getState().closeTransient();
    expect(store.getState().editorOpen).toBe(false);
  });
});
