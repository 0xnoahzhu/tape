// Applies main's lock state to the store. Locking closes whatever was open on top of the app
// (dialogs, the bell, popovers, the search dropdown, the positions table's column editor) and drops
// a pending order review, which is never sent: after unlocking, the user starts again from a clean
// screen. Floating panels collapse to their bars (and stay so after the unlock).
//
// Every lock (the lock button, ⌘L, the menu, the idle auto-lock and its check on sleep and wake)
// arrives here as main's `lock` event, so the lock sound plays here. The snapshot at launch does not
// come through: starting locked is silent.

import type { LockState } from '@shared/types';
import { lockClack } from '../features/lock/clack';
import { usePanels } from '../features/panels/panelStore';
import { usePositionColumns } from '../features/portfolio/columnStore';
import { useStore } from './store';

export function applyLockState(state: LockState): void {
  const prev = useStore.getState().lock;
  if (state.locked && !prev.locked) {
    if (useStore.getState().settings.lock.sound) lockClack();
    closeTransientUi();
    usePanels.getState().collapseAll();
    // Locked again while the unlock animation was still playing: that screen (fading out) is replaced.
    useStore.setState((s) => ({ unlocking: false, lockSeq: s.lockSeq + 1 }));
  }
  useStore.setState((s) => ({ lock: state, biometricsSeen: s.biometricsSeen || state.biometrics.available }));
}

export function closeTransientUi(): void {
  useStore.setState({ bellOpen: false, pendingOrder: null, confirm: null, cancelAll: null, alertForm: null, pinDialog: null });
  usePositionColumns.getState().closeTransient();
  if (typeof document === 'undefined') return;
  // The search dropdown closes on blur; popovers and context menus close on a click outside them.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}
