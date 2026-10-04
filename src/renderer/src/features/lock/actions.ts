// Locking from the top bar, ⌘L / Ctrl+L and the menu.

import { errorText } from '../../state/orderActions';
import { isCovered, useStore } from '../../state/store';

/** Locks now; without a PIN, asks for one first and locks once it is saved. */
export function requestLock(): void {
  const s = useStore.getState();
  if (isCovered(s)) return;
  if (!s.lock.hasPin) {
    s.setPinDialog({ mode: 'set', lockAfter: true });
    return;
  }
  window.tape.lock().catch((err: unknown) => s.showToast(errorText(err), 'error'));
}

/**
 * While the lock screen is up, keys typed outside it (the app behind it is inert, so that is the
 * page body) reach no shortcut handler: this capture listener on window runs before every other
 * one. Typing a character there moves the focus to the PIN input, which then receives it.
 */
export function installLockKeyGuard(focusPin: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!isCovered(useStore.getState())) return;
    if (e.target instanceof Element && e.target.closest('[data-lock-root]')) return;
    e.stopImmediatePropagation();
    if (!e.metaKey && !e.ctrlKey && !e.altKey) focusPin();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
