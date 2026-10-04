// Picks the biometric provider for this platform: Touch ID on macOS, Windows Hello on Windows,
// none on Linux. Development builds can use a fake provider instead, so screenshots and manual
// tests never pop a real system prompt:
//
//   TAPE_FAKE_BIOMETRICS=[touchId:|windowsHello:]ok|fail|cancel|unavailable
//
// (the kind defaults to the platform's; ignored in packaged builds).

import type { BiometricKind, BiometricProvider, BiometricResult } from './types';
import { createTouchIdProvider } from './touchId';
import { createWindowsHelloProvider } from './windowsHello';

export type FakeBiometricMode = 'ok' | 'fail' | 'cancel' | 'unavailable';

export interface BiometricsOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  fake?: string | undefined;
}

export function createBiometrics({ platform, isPackaged, fake }: BiometricsOptions): BiometricProvider | null {
  const parsed = !isPackaged && fake ? parseFake(fake, platform) : null;
  if (parsed) return createFakeBiometrics(parsed.kind, parsed.mode);
  if (platform === 'darwin') return createTouchIdProvider();
  if (platform === 'win32') return createWindowsHelloProvider();
  return null;
}

export function parseFake(value: string, platform: NodeJS.Platform): { kind: BiometricKind; mode: FakeBiometricMode } | null {
  const [a, b] = value.trim().split(':');
  const kinds: readonly string[] = ['touchId', 'windowsHello'];
  const modes: readonly string[] = ['ok', 'fail', 'cancel', 'unavailable'];
  const kind = (b !== undefined ? a : platform === 'win32' ? 'windowsHello' : 'touchId') as BiometricKind;
  const mode = (b !== undefined ? b : a) as FakeBiometricMode;
  return kinds.includes(kind) && modes.includes(mode) ? { kind, mode } : null;
}

/** Answers after a short delay as a real prompt would; never shows anything. */
export function createFakeBiometrics(kind: BiometricKind, mode: FakeBiometricMode, delayMs = 400): BiometricProvider {
  let pending = false;
  return {
    kind,
    async availability() {
      return mode === 'unavailable' ? { kind, available: false, reason: 'notEnrolled', detail: 'TAPE_FAKE_BIOMETRICS=unavailable' } : { kind, available: true };
    },
    async verify(): Promise<BiometricResult> {
      if (pending) return { ok: false, reason: 'busy' };
      if (mode === 'unavailable') return { ok: false, reason: 'unavailable' };
      pending = true;
      await new Promise((r) => setTimeout(r, delayMs));
      pending = false;
      if (mode === 'ok') return { ok: true };
      return { ok: false, reason: mode === 'cancel' ? 'canceled' : 'failed' };
    },
  };
}
