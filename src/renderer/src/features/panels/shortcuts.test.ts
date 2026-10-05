import { describe, expect, it } from 'vitest';
import { index, stock } from '@shared/contract';
import { useStore } from '../../state/store';
import { barSide, claimPanelKeys, dockBack, panelKeysOwner, popOut, revealPanel, setCollapsed } from './actions';
import { barShortcutSide, escapePanel, panelKeyAction, type ShortcutKey } from './shortcuts';

const key = (k: string, patch: Partial<ShortcutKey> = {}): ShortcutKey => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, defaultPrevented: false, editable: false, ...patch });

describe('B / S on the floating ticket’s bar', () => {
  const trade = () => ({ ...useStore.getState(), page: 'trade' as const, view: 'chart' as const, symbol: stock('AAPL') });

  it('picks the side while the ticket is collapsed to its bar', () => {
    expect(barShortcutSide(key('b'), trade(), true)).toBe('BUY');
    expect(barShortcutSide(key('S'), trade(), true)).toBe('SELL');
    expect(barShortcutSide(key('s'), { ...trade(), view: 'depth' }, true)).toBe('SELL');
  });

  it('does nothing when expanded or docked, typing, off the ticket’s views, with a dialog, an index or a modify', () => {
    const s = trade();
    expect(barShortcutSide(key('b'), s, false)).toBeNull();
    expect(barShortcutSide(key('b', { editable: true }), s, true)).toBeNull();
    expect(barShortcutSide(key('b', { metaKey: true }), s, true)).toBeNull();
    expect(barShortcutSide(key('b', { defaultPrevented: true }), s, true)).toBeNull();
    expect(barShortcutSide(key('b'), { ...s, page: 'ord' }, true)).toBeNull();
    expect(barShortcutSide(key('b'), { ...s, view: 'opt' }, true)).toBeNull();
    expect(barShortcutSide(key('b'), { ...s, confirm: { title: '', rows: [], label: '', run: () => undefined } }, true)).toBeNull();
    expect(barShortcutSide(key('b'), { ...s, symbol: index('SPX', 'CBOE') }, true)).toBeNull();
    expect(barShortcutSide(key('b'), { ...s, ticket: { ...s.ticket, modifyingOrderId: 3 } }, true)).toBeNull();
    expect(barShortcutSide(key('x'), s, true)).toBeNull();
  });
});

describe('Esc in a floating panel', () => {
  const trade = () => ({ ...useStore.getState(), page: 'trade' as const, view: 'chart' as const, symbol: stock('AAPL') });

  it('in a field leaves the field (also when the field handled it), then the next Esc collapses the panel', () => {
    const s = trade();
    // The quantity field blurs itself on Esc (preventDefault); the panel takes the focus.
    expect(panelKeyAction(key('Escape', { editable: true, defaultPrevented: true }), false, s)).toBe('leaveField');
    expect(panelKeyAction(key('Escape', { editable: true }), false, s)).toBe('leaveField');
    // The next Esc goes to the panel itself.
    expect(panelKeyAction(key('Escape'), false, s)).toBe('collapse');
  });

  it('leaves a menu’s Esc to the menu, dialogs and the lock screen to themselves; ⏎ expands the bar', () => {
    const s = trade();
    expect(panelKeyAction(key('Escape', { defaultPrevented: true }), false, s)).toBeNull();
    expect(panelKeyAction(key('Escape'), false, { ...s, confirm: { title: '', rows: [], label: '', run: () => undefined } })).toBeNull();
    expect(panelKeyAction(key('Escape'), false, { ...s, bellOpen: true })).toBeNull();
    expect(panelKeyAction(key('Escape', { isComposing: true, editable: true }), false, s)).toBeNull();
    expect(panelKeyAction(key('Enter'), true, s)).toBe('expand');
    expect(panelKeyAction(key('Enter', { editable: true }), true, s)).toBeNull();
    expect(panelKeyAction(key('Escape'), true, s)).toBeNull();
    expect(panelKeyAction(key('Enter'), false, s)).toBeNull();
  });

  it('with nothing focused collapses the panel the user works in (pressed in, or expanded by B / S)', () => {
    const s = trade();
    const floating = { ticket: { floating: true, collapsed: false, rect: null, bar: null }, strategy: { floating: false, collapsed: false, rect: null, bar: null } };
    expect(escapePanel(key('Escape'), true, s, floating, 'ticket')).toBe('ticket');
    // Nobody holds it (the user pressed on the page since), or the key goes to a control.
    expect(escapePanel(key('Escape'), true, s, floating, null)).toBeNull();
    expect(escapePanel(key('Escape'), false, s, floating, 'ticket')).toBeNull();
    expect(escapePanel(key('Escape', { defaultPrevented: true }), true, s, floating, 'ticket')).toBeNull();
    // Collapsed or docked already, off its page, or a dialog / the bell open.
    expect(escapePanel(key('Escape'), true, s, { ...floating, ticket: { ...floating.ticket, collapsed: true } }, 'ticket')).toBeNull();
    expect(escapePanel(key('Escape'), true, s, { ...floating, ticket: { ...floating.ticket, floating: false } }, 'ticket')).toBeNull();
    expect(escapePanel(key('Escape'), true, { ...s, page: 'ord' }, floating, 'ticket')).toBeNull();
    expect(escapePanel(key('Escape'), true, { ...s, bellOpen: true }, floating, 'ticket')).toBeNull();
    expect(escapePanel(key('x'), true, s, floating, 'ticket')).toBeNull();
  });

  it('expanding a panel (B / S on its bar, Modify, a quote) gives it Esc; a docked panel never holds it', () => {
    useStore.setState({ page: 'trade', view: 'chart', symbol: stock('AAPL') });
    claimPanelKeys(null);
    popOut('ticket');
    setCollapsed('ticket', true);
    barSide('SELL');
    expect(panelKeysOwner()).toBe('ticket');
    dockBack('ticket');
    claimPanelKeys(null);
    revealPanel('ticket');
    expect(panelKeysOwner()).toBeNull();
  });
});
