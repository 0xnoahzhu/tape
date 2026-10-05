// The floating panels' keys. B / S while the floating ticket is collapsed to its bar: the side is
// set and the panel expands, so ↑ / ↓ and Enter work in it next. (Docked or expanded, the ticket's
// own shortcuts handle them: ticket/useTicketKeys.ts.) Esc: in a field it leaves the field, then
// collapses the panel; with nothing focused it collapses the panel the user works in.

import { useEffect } from 'react';
import { isTradable } from '@shared/contract';
import type { OrderAction } from '@shared/types';
import { isCovered, useStore, type StoreState } from '../../state/store';
import { barSide, claimPanelKeys, panelKeysOwner, panelShown, setCollapsed } from './actions';
import type { PanelId } from './model';
import { usePanels, type PanelsPrefs } from './panelStore';

export interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** The key goes to a text field (it types there). */
  editable: boolean;
}

type ShortcutState = Pick<StoreState, 'page' | 'view' | 'settings' | 'symbol' | 'ticket' | 'bellOpen' | 'pendingOrder' | 'confirm' | 'alertForm' | 'pinDialog' | 'lock' | 'unlocking'>;

/**
 * The side B / S picks on the ticket's bar, or null when the key is not that shortcut now: the
 * same conditions as the ticket's own (the ticket on screen, nothing open on top, a tradable
 * instrument, not modifying an order, whose side IB keeps).
 */
export function barShortcutSide(e: ShortcutKey, s: ShortcutState, collapsed: boolean): OrderAction | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.editable) return null;
  const side = e.key === 'b' || e.key === 'B' ? 'BUY' : e.key === 's' || e.key === 'S' ? 'SELL' : null;
  if (!side || !collapsed || !panelShown('ticket', s)) return null;
  if (keysTaken(s)) return null;
  if (!isTradable(s.symbol) || s.ticket.modifyingOrderId != null) return null;
  return side;
}

/** A dialog, the bell or the lock screen has the keys. */
const keysTaken = (s: ShortcutState): boolean => !!(s.bellOpen || s.pendingOrder || s.confirm || s.alertForm || s.pinDialog || isCovered(s));

export type PanelKeyAction = 'leaveField' | 'collapse' | 'expand';

/**
 * A key pressed inside a floating panel (its root or anything in it). Esc in a field leaves the
 * field (even when the field handled it: the panel then takes the focus, so the next Esc reaches
 * it); Esc elsewhere collapses the panel, unless something in it (a menu) handled it; ⏎ on the bar
 * expands it.
 */
export function panelKeyAction(e: ShortcutKey, collapsed: boolean, s: ShortcutState): PanelKeyAction | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || keysTaken(s)) return null;
  if (collapsed) return e.key === 'Enter' && !e.editable && !e.defaultPrevented ? 'expand' : null;
  if (e.key !== 'Escape') return null;
  if (e.editable) return 'leaveField';
  return e.defaultPrevented ? null : 'collapse';
}

/**
 * Esc with nothing focused (the key goes to the page): the panel the user works in collapses, when
 * it floats, is expanded and on screen, and nothing else has the keys.
 */
export function escapePanel(e: ShortcutKey, onPage: boolean, s: ShortcutState, panels: PanelsPrefs, owner: PanelId | null): PanelId | null {
  if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.editable || !onPage || !owner) return null;
  const p = panels[owner];
  if (!p.floating || p.collapsed || !panelShown(owner, s) || keysTaken(s)) return null;
  return owner;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Installs B / S for the ticket's bar while it is collapsed (`active`). */
export function useBarKeys(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const side = barShortcutSide(
        shortcutKey(e),
        useStore.getState(),
        usePanels.getState().panels.ticket.floating && usePanels.getState().panels.ticket.collapsed,
      );
      if (!side) return;
      e.preventDefault();
      barSide(side);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

/** The key as the panels' rules see it. */
export function shortcutKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'target'>): ShortcutKey {
  return { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.isComposing, defaultPrevented: e.defaultPrevented, editable: isEditable(e.target) };
}

/**
 * While a floating panel is on screen (`active`): a press outside every panel ends its hold on Esc,
 * and Esc with nothing focused collapses the panel that holds it. Both listen in the capture phase,
 * so they see the page as it was before other handlers (the bell's Esc) change it.
 */
export function usePanelEscape(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-panel-root]')) claimPanelKeys(null);
    };
    const onKey = (e: KeyboardEvent) => {
      const onPage = e.target === document.body || e.target === document.documentElement;
      const id = escapePanel(shortcutKey(e), onPage, useStore.getState(), usePanels.getState().panels, panelKeysOwner());
      if (!id) return;
      e.preventDefault();
      setCollapsed(id, true);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active]);
}
