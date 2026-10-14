// Focus handling for controls that remove the focused element, and for dialogs and menus that
// give the keys back to the ticket or panel they were opened from.

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

type FocusTarget = () => HTMLElement | null | undefined;

/**
 * Moves focus to `target()` once the caller's next render is committed. For keyboard actions
 * that unmount the focused element (an inline editor closed with Enter / Escape, a deleted
 * row's button): focus left on <body> hands the next Enter to global shortcuts such as the order
 * ticket's submit (useTicketKeys). Nothing happens when focus has already moved elsewhere.
 */
export function useRefocus(): (target: FocusTarget) => void {
  const pending = useRef<FocusTarget | null>(null);
  // Re-renders the caller, so a request is handled even when nothing else changed.
  const [, setRequests] = useState(0);

  useLayoutEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    if (!focusLost()) return;
    target()?.focus();
  });

  return useCallback((target: FocusTarget) => {
    pending.current = target;
    setRequests((n) => n + 1);
  }, []);
}

type FocusDoc = Pick<Document, 'activeElement' | 'body' | 'documentElement'>;

function focusLost(doc: FocusDoc = document): boolean {
  const el = doc.activeElement;
  return el == null || el === doc.body || el === doc.documentElement;
}

/**
 * Where keys typed with the focus in `el` belong: the docked order ticket (its root carries
 * data-ticket-keys, features/ticket/useTicketKeys.ts) or a floating panel (data-panel-root), whose
 * keys work only while the focus is in them. null: neither (the page, a dialog).
 */
export function keysHome(el: Element | null | undefined): HTMLElement | null {
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest<HTMLElement>('[data-ticket-keys],[data-panel-root]');
}

/**
 * Gives `home` (keysHome) the focus back when it was left on the page: a dialog or menu that took
 * it closed (its focused element went with it), so B / S / ↑ / ↓ / ⏎ reach the ticket again without
 * another click. Nothing happens when the focus is somewhere else or `home` is gone. True when it did.
 */
export function giveKeysBack(home: HTMLElement | null | undefined, doc: FocusDoc = document): boolean {
  if (!home?.isConnected || !focusLost(doc)) return false;
  home.focus({ preventScroll: true });
  return true;
}
