// Focus handling for controls that remove the focused element.

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

function focusLost(): boolean {
  const el = document.activeElement;
  return el == null || el === document.body || el === document.documentElement;
}
