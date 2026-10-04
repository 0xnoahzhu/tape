// Touch ID on macOS through Electron's systemPreferences (LocalAuthentication underneath).
//
// canPromptTouchID() is silent and cheap, but only a boolean: false covers no sensor, nothing
// enrolled, biometric lockout and a closed lid without a Touch ID keyboard, so it is reported as
// 'noHardware' and the UI words it as "not available or not set up". promptTouchID() rejects with
// localized text only (no code), so every rejection is reported as 'canceled' (never as a wrong
// PIN). The system sheet is not attached to the window and cannot be cancelled programmatically.

import { systemPreferences } from 'electron';
import type { BiometricAvailability, BiometricProvider, BiometricResult } from './types';

export function createTouchIdProvider(): BiometricProvider {
  let pending = false;
  const canPrompt = (): boolean => {
    try {
      return systemPreferences.canPromptTouchID();
    } catch {
      return false;
    }
  };

  return {
    kind: 'touchId',
    async availability(): Promise<BiometricAvailability> {
      return canPrompt()
        ? { kind: 'touchId', available: true }
        : { kind: 'touchId', available: false, reason: 'noHardware', detail: 'canPromptTouchID() is false (no sensor, not enrolled, locked out or lid closed)' };
    },
    async verify(reason): Promise<BiometricResult> {
      if (pending) return { ok: false, reason: 'busy' };
      if (!canPrompt()) return { ok: false, reason: 'unavailable' };
      pending = true;
      try {
        // macOS shows "<App> is trying to <reason>."
        await systemPreferences.promptTouchID(reason);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: 'canceled', detail: err instanceof Error ? err.message : String(err) };
      } finally {
        pending = false;
      }
    },
  };
}
