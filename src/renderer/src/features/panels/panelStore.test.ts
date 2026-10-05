import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePanels } from './panelStore';

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

const KEY = 'tape.floatingPanels';

async function freshStore() {
  vi.resetModules();
  return (await import('./panelStore')).usePanels;
}

describe('remembered panels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads what was saved and repairs the rest', () => {
    const p = parsePanels({
      ticket: { floating: true, collapsed: true, rect: { x: 10.4, y: 20, width: 900, height: 600 }, bar: { x: 5, y: 6 } },
      strategy: { floating: 'yes', rect: { x: 1, y: 2, width: -5, height: 10 }, bar: { x: 'a' } },
      other: { floating: true },
    });
    expect(p.ticket).toEqual({ floating: true, collapsed: true, rect: { x: 10, y: 20, width: 900, height: 600 }, bar: { x: 5, y: 6 } });
    expect(p.strategy).toEqual({ floating: false, collapsed: false, rect: null, bar: null });
    expect(parsePanels(null)).toEqual(parsePanels(undefined));
    expect(parsePanels('x').ticket.floating).toBe(false);
  });

  it('a panel floating at quit floats again at launch, where it was left', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    let usePanels = await freshStore();
    usePanels.getState().setFloating('ticket', true);
    usePanels.getState().setRect('ticket', { x: 30, y: 60, width: 900, height: 560 });
    usePanels.getState().setCollapsed('ticket', true);
    usePanels.getState().setBar('ticket', { x: 12, y: 400 });
    expect(JSON.parse(storage.data.get(KEY)!).ticket).toMatchObject({ floating: true, collapsed: true });

    usePanels = await freshStore();
    expect(usePanels.getState().panels.ticket).toEqual({ floating: true, collapsed: true, rect: { x: 30, y: 60, width: 900, height: 560 }, bar: { x: 12, y: 400 } });
    expect(usePanels.getState().panels.strategy.floating).toBe(false);
  });

  it('works without storage (blocked or throwing): nothing is remembered', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const usePanels = await freshStore();
    expect(usePanels.getState().panels.ticket.floating).toBe(false);
    expect(() => usePanels.getState().setFloating('ticket', true)).not.toThrow();
    expect(usePanels.getState().panels.ticket.floating).toBe(true);
  });
});

describe('floating and collapsing', () => {
  let usePanels: Awaited<ReturnType<typeof freshStore>>;
  beforeEach(async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    usePanels = await freshStore();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pops out expanded and docks back expanded, keeping the places', () => {
    const s = () => usePanels.getState();
    s().setFloating('ticket', true);
    s().setRect('ticket', { x: 1, y: 2, width: 800, height: 500 });
    s().setCollapsed('ticket', true);
    s().setFloating('ticket', false);
    expect(s().panels.ticket).toMatchObject({ floating: false, collapsed: false, rect: { x: 1, y: 2, width: 800, height: 500 } });
    s().setFloating('ticket', true);
    expect(s().panels.ticket).toMatchObject({ floating: true, collapsed: false });
  });

  it('never collapses a docked panel', () => {
    usePanels.getState().setCollapsed('strategy', true);
    expect(usePanels.getState().panels.strategy.collapsed).toBe(false);
  });

  it('collapseAll (the lock) collapses the floating panels only', () => {
    usePanels.getState().setFloating('ticket', true);
    usePanels.getState().collapseAll();
    expect(usePanels.getState().panels.ticket.collapsed).toBe(true);
    expect(usePanels.getState().panels.strategy.collapsed).toBe(false);
  });
});
