// Contract between the lock service and the platform biometric providers
// (Touch ID on macOS, Windows Hello on Windows).

import type { BrowserWindow } from 'electron';

export type BiometricKind = 'touchId' | 'windowsHello';

/** Why biometrics cannot be used right now; shown in Settings and on the lock screen. */
export type BiometricUnavailableReason =
  | 'unsupported' // platform without a provider (Linux)
  | 'noHardware' // no sensor / camera, or the sensor is not reachable (e.g. lid closed)
  | 'notEnrolled' // supported but not set up for this user
  | 'disabledByPolicy' // turned off by the administrator / group policy
  | 'error'; // the check itself failed (detail in `detail`)

export type BiometricAvailability =
  | { kind: BiometricKind; available: true }
  | { kind: BiometricKind | null; available: false; reason: BiometricUnavailableReason; detail?: string };

export type BiometricResult =
  | { ok: true }
  | { ok: false; reason: 'canceled' | 'failed' | 'busy' | 'unavailable' | 'timeout' | 'error'; detail?: string };

export interface BiometricProvider {
  readonly kind: BiometricKind;
  /** Cheap enough to call when Settings or the lock screen opens; never throws. */
  availability(): Promise<BiometricAvailability>;
  /**
   * Shows the OS prompt over `win` and resolves once the user has answered. Resolves `{ ok: true }`
   * only when the OS verified the user. Never throws; a second call while one is pending resolves
   * `{ ok: false, reason: 'busy' }`.
   */
  verify(reason: string, win: BrowserWindow | null): Promise<BiometricResult>;
  /** Optional warm-up when the app locks (e.g. start a helper process) so the prompt opens fast. */
  prepare?(): void;
  /** Releases whatever `prepare` started; called on unlock and on quit. */
  dispose?(): void;
}
