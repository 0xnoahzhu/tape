// Applies main's lock state to the store. Locking closes whatever was open on top of the app
// (dialogs, the bell, popovers, the search dropdown) and drops a pending order review, which is
// never sent: after unlocking, the user starts again from a clean screen. Floating panels collapse
// to their bars (and stay so after the unlock).

import type { LockState } from '@shared/types';
import { usePanels } from '../features/panels/panelStore';
import { useStore } from './store';

export function applyLockState(state: LockState): void {
  const prev = useStore.getState().lock;
  if (state.locked && !prev.locked) {
    closeTransientUi();
    usePanels.getState().collapseAll();
    // Locked again while the unlock animation was still playing: that screen (fading out) is replaced.
    useStore.setState((s) => ({ unlocking: false, lockSeq: s.lockSeq + 1 }));
  }
  useStore.setState((s) => ({ lock: state, biometricsSeen: s.biometricsSeen || state.biometrics.available }));
}

export function closeTransientUi(): void {
  useStore.setState({ bellOpen: false, pendingOrder: null, confirm: null, alertForm: null, pinDialog: null });
  if (typeof document === 'undefined') return;
  // The search dropdown closes on blur; popovers and context menus close on a click outside them.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}
