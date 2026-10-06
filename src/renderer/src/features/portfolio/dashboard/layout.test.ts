import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultLayout, dropSide, moveWidget, removeWidget, sanitizeLayout, setSpan, toggleWidget, type Layout } from './layout';

const ids = (l: Layout) => l.map((w) => w.id);

describe('dashboard layout', () => {
  it('defaults to every widget at its catalog span, in four rows of three columns', () => {
    const l = defaultLayout();
    expect(ids(l)).toEqual(['eq', 'alloc', 'margin', 'greeks', 'conc', 'contrib', 'expiry', 'fills', 'events', 'bench']);
    expect(l.map((w) => w.span)).toEqual([2, 1, 1, 1, 1, 2, 1, 1, 1, 1]);
    expect(l.reduce((n, w) => n + w.span, 0)).toBe(12);
  });

  it('sanitizes a stored layout', () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout({ id: 'eq' })).toBeNull();
    expect(sanitizeLayout([])).toEqual([]);
    expect(
      sanitizeLayout([{ id: 'bench', span: 3 }, { id: 'nope', span: 1 }, { id: 'eq', span: 7 }, { id: 'bench', span: 1 }, 'x', null, { id: 'alloc' }]),
    ).toEqual([
      { id: 'bench', span: 3 },
      { id: 'eq', span: 2 },
      { id: 'alloc', span: 1 },
    ]);
  });

  it('moves the dragged widget into the place of the target', () => {
    const l = defaultLayout();
    // Backwards: before the target.
    expect(ids(moveWidget(l, 'bench', 'eq')).slice(0, 2)).toEqual(['bench', 'eq']);
    // Forwards: after the target, so a widget can step past its right neighbour.
    expect(ids(moveWidget(l, 'eq', 'alloc')).slice(0, 2)).toEqual(['alloc', 'eq']);
    expect(ids(moveWidget(l, 'eq', 'greeks')).slice(0, 4)).toEqual(['alloc', 'margin', 'greeks', 'eq']);
    // The "Add widget" tile: after the last widget.
    expect(ids(moveWidget(l, 'eq', 'end')).at(-1)).toBe('eq');
    expect(moveWidget(l, 'bench', 'end')).toBe(l);
    expect(moveWidget(l, 'eq', 'eq')).toBe(l);
    expect(moveWidget(l, 'eq', 'nope' as never)).toBe(l);
    expect(moveWidget(l, 'nope' as never, 'eq')).toBe(l);
    // Every move keeps the widgets and their spans.
    const moved = moveWidget(l, 'contrib', 'alloc');
    expect([...moved].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...l].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('says on which side of the target the drop lands', () => {
    const l = defaultLayout();
    expect(dropSide(l, 'bench', 'eq')).toBe('before');
    expect(dropSide(l, 'eq', 'alloc')).toBe('after');
    expect(dropSide(l, 'eq', 'end')).toBe('after');
    expect(dropSide(l, 'bench', 'end')).toBeNull();
    expect(dropSide(l, 'eq', 'eq')).toBeNull();
    expect(dropSide(l, null, 'eq')).toBeNull();
    expect(dropSide(l, 'eq', null)).toBeNull();
  });

  it('changes spans, removes and toggles widgets without touching the input', () => {
    const l = defaultLayout();
    const wide = setSpan(l, 'margin', 3);
    expect(wide.find((w) => w.id === 'margin')?.span).toBe(3);
    expect(l.find((w) => w.id === 'margin')?.span).toBe(1);
    expect(setSpan(l, 'margin', 1)).toBe(l);
    const without = removeWidget(l, 'events');
    expect(ids(without)).not.toContain('events');
    expect(removeWidget(without, 'events')).toBe(without);
    expect(toggleWidget(without, 'events').at(-1)).toEqual({ id: 'events', span: 1 });
    expect(ids(toggleWidget(l, 'eq'))).not.toContain('eq');
    expect(toggleWidget([], 'contrib')).toEqual([{ id: 'contrib', span: 2 }]);
  });
});

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
  return (await import('./layoutStore')).useDashboardLayout;
}

describe('remembered dashboard layout', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts from the default, stores changes and forgets them on reset', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    let store = await freshStore();
    expect(store.getState().stored).toBeNull();
    store.getState().setSpan('eq', 2);
    expect(storage.data.size).toBe(0);
    store.getState().remove('events');
    store.getState().move('bench', 'eq');
    expect(JSON.parse(storage.data.get('tape.dash.v1')!)[0]).toEqual({ id: 'bench', span: 1 });

    store = await freshStore();
    expect(ids(store.getState().stored!)).not.toContain('events');
    expect(store.getState().stored![0].id).toBe('bench');

    store.getState().reset();
    expect(storage.data.has('tape.dash.v1')).toBe(false);
    expect(store.getState().stored).toBeNull();
  });

  it('keeps an empty layout and ignores what it cannot read', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'tape.dash.v1': '[]' }));
    expect((await freshStore()).getState().stored).toEqual([]);
    vi.stubGlobal('localStorage', memoryStorage({ 'tape.dash.v1': '{oops' }));
    expect((await freshStore()).getState().stored).toBeNull();
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
    expect(store.getState().stored).toBeNull();
    store.getState().toggle('eq');
    expect(ids(store.getState().stored!)).not.toContain('eq');
  });

  it('does not persist edit mode, the catalog or a drag; closeTransient ends them', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await freshStore();
    store.getState().setEdit(true);
    store.getState().setPickerOpen(true);
    store.getState().setDrag('eq');
    store.getState().setOver('alloc');
    expect(storage.data.size).toBe(0);
    store.getState().closeTransient();
    expect(store.getState()).toMatchObject({ edit: false, pickerOpen: false, drag: null, over: null });
  });
});
