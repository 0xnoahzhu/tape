// Settings changes that weaken the lock need the current PIN, checked here in main (the renderer
// only asks for it). While a PIN exists, updateSettings refuses a lock patch that makes the
// auto-lock longer (or Never) or lets Touch ID / Windows Hello unlock where the PIN alone did;
// updateLockSettings applies it with a single-use token from verifyLockPin. Changes that tighten
// the lock (a shorter auto-lock, PIN only, the unlock sound) need nothing.
//
// A guard against a change made in passing at an unlocked Tape, not a boundary: settings.json can
// still be edited by the user account (see README › Lock screen).

import { loosensLock } from '@shared/lock';
import type { DeepPartial, Settings } from '@shared/types';
import type { AppStore } from '../context';
import { applySettingsPatch, isObject } from '../storeSchema';
import type { LockService } from './service';

export const PIN_NEEDED_MESSAGE = 'Enter the current PIN to make the lock weaker';
export const PIN_FIRST_MESSAGE = 'Enter the current PIN first';

/** Whether applying `patch` (untrusted) to `current` weakens the lock. */
export function patchLoosensLock(current: Settings, patch: unknown): boolean {
  if (!isObject(patch) || patch.lock === undefined) return false;
  return loosensLock(current.lock, applySettingsPatch(current, { lock: patch.lock }).lock);
}

export interface SettingsGuard {
  /** updateSettings: refused when it would weaken the lock while a PIN exists. */
  update(patch: DeepPartial<Settings>): Settings;
  /** updateLockSettings: with a PIN, only with a token from verifyLockPin. */
  updateLock(lock: unknown, token: unknown): Settings;
}

export function createSettingsGuard(deps: { store: Pick<AppStore, 'getSettings' | 'updateSettings'>; lock: Pick<LockService, 'hasPin' | 'authorize'> }): SettingsGuard {
  return {
    update(patch) {
      if (deps.lock.hasPin() && patchLoosensLock(deps.store.getSettings(), patch)) throw new Error(PIN_NEEDED_MESSAGE);
      return deps.store.updateSettings(patch);
    },
    updateLock(lock, token) {
      if (deps.lock.hasPin() && !deps.lock.authorize(typeof token === 'string' ? token : null)) throw new Error(PIN_FIRST_MESSAGE);
      // Only the lock preferences, whatever else the call carries.
      return deps.store.updateSettings({ lock: isObject(lock) ? (lock as DeepPartial<Settings['lock']>) : {} });
    },
  };
}
