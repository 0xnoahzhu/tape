import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultLayout, dropSide, moveWidget, removeWidget, sanitizeLayout, setSpan, toggleWidget, type Layout } from './layout';

const ids = (l: Layout) => l.map((w) => w.id);

describe('dashboard layout', () => {
  it('defaults to every widget at its catalog span, in three rows of three columns', () => {
    const l = defaultLayout();
    expect(ids(l)).toEqual(['alloc', 'margin', 'greeks', 'conc', 'contrib', 'expiry', 'fills', 'events']);
    expect(l.map((w) => w.span)).toEqual([1, 1, 1, 1, 2, 1, 1, 1]);
    expect(l.reduce((n, w) => n + w.span, 0)).toBe(9);
  });

  it('sanitizes a stored layout', () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout({ id: 'alloc' })).toBeNull();
    expect(sanitizeLayout([])).toEqual([]);
    expect(
      sanitizeLayout([{ id: 'events', span: 3 }, { id: 'nope', span: 1 }, { id: 'contrib', span: 7 }, { id: 'events', span: 1 }, 'x', null, { id: 'alloc' }]),
    ).toEqual([
      { id: 'events', span: 3 },
      { id: 'contrib', span: 2 },
      { id: 'alloc', span: 1 },
    ]);
  });

  it('drops the removed widgets of older versions from a stored layout', () => {
    // 'eq' (net liquidation curve) and 'bench' (vs. benchmark) are no longer in the catalog.
    expect(
      sanitizeLayout([
        { id: 'eq', span: 2 },
        { id: 'alloc', span: 1 },
        { id: 'bench', span: 1 },
        { id: 'fills', span: 2 },
      ]),
    ).toEqual([
      { id: 'alloc', span: 1 },
      { id: 'fills', span: 2 },
    ]);
    expect(sanitizeLayout([{ id: 'eq' }, { id: 'bench' }])).toEqual([]);
  });

  it('moves the dragged widget into the place of the target', () => {
    const l = defaultLayout();
    // Backwards: before the target.
    expect(ids(moveWidget(l, 'events', 'alloc')).slice(0, 2)).toEqual(['events', 'alloc']);
    // Forwards: after the target, so a widget can step past its right neighbour.
    expect(ids(moveWidget(l, 'alloc', 'margin')).slice(0, 2)).toEqual(['margin', 'alloc']);
    expect(ids(moveWidget(l, 'alloc', 'conc')).slice(0, 4)).toEqual(['margin', 'greeks', 'conc', 'alloc']);
    // The "Add widget" tile: after the last widget.
    expect(ids(moveWidget(l, 'alloc', 'end')).at(-1)).toBe('alloc');
    expect(moveWidget(l, 'events', 'end')).toBe(l);
    expect(moveWidget(l, 'alloc', 'alloc')).toBe(l);
    expect(moveWidget(l, 'alloc', 'nope' as never)).toBe(l);
    expect(moveWidget(l, 'nope' as never, 'alloc')).toBe(l);
    // Every move keeps the widgets and their spans.
    const moved = moveWidget(l, 'contrib', 'alloc');
    expect([...moved].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...l].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('says on which side of the target the drop lands', () => {
    const l = defaultLayout();
    expect(dropSide(l, 'events', 'alloc')).toBe('before');
    expect(dropSide(l, 'alloc', 'margin')).toBe('after');
    expect(dropSide(l, 'alloc', 'end')).toBe('after');
    expect(dropSide(l, 'events', 'end')).toBeNull();
    expect(dropSide(l, 'alloc', 'alloc')).toBeNull();
    expect(dropSide(l, null, 'alloc')).toBeNull();
    expect(dropSide(l, 'alloc', null)).toBeNull();
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
    expect(ids(toggleWidget(l, 'alloc'))).not.toContain('alloc');
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
    store.getState().setSpan('contrib', 2);
    expect(storage.data.size).toBe(0);
    store.getState().remove('expiry');
    store.getState().move('events', 'alloc');
    expect(JSON.parse(storage.data.get('tape.dash.v1')!)[0]).toEqual({ id: 'events', span: 1 });

    store = await freshStore();
    expect(ids(store.getState().stored!)).not.toContain('expiry');
    expect(store.getState().stored![0].id).toBe('events');

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
    store.getState().toggle('alloc');
    expect(ids(store.getState().stored!)).not.toContain('alloc');
  });

  it('loads a layout saved with the removed widgets of older versions', async () => {
    const saved = [
      { id: 'eq', span: 2 },
      { id: 'alloc', span: 1 },
      { id: 'bench', span: 1 },
    ];
    vi.stubGlobal('localStorage', memoryStorage({ 'tape.dash.v1': JSON.stringify(saved) }));
    expect((await freshStore()).getState().stored).toEqual([{ id: 'alloc', span: 1 }]);
  });

  it('does not persist edit mode, the catalog or a drag; closeTransient ends them', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = await freshStore();
    store.getState().setEdit(true);
    store.getState().setPickerOpen(true);
    store.getState().setDrag('alloc');
    store.getState().setOver('margin');
    expect(storage.data.size).toBe(0);
    store.getState().closeTransient();
    expect(store.getState()).toMatchObject({ edit: false, pickerOpen: false, drag: null, over: null });
  });
});
