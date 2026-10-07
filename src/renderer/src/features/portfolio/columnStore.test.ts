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
