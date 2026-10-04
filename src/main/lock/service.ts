// The lock: main is the only authority on whether Tape is locked, on the PIN and on biometrics.
// The renderer draws LockState and asks to unlock; IPC methods it must not use while locked are
// refused in index.ts (LOCK_POLICY).
//
// * The app starts locked whenever a PIN exists, so quitting and reopening does not bypass it.
//   An unreadable lock.json fails closed: locked, no PIN accepted, the file left alone (Forgot PIN
//   deletes it).
// * The wrong-PIN counter applies in memory even when lock.json cannot be written, and a wait
//   follows a monotonic clock too, so setting the system clock forward does not end it early.
// * PIN checks are serialized, so concurrent attempts cannot slip past the backoff.
// * A PIN change or removal needs a fresh, single-use token from verifyPin / verifyBiometrics.

import { randomBytes } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { Lang, LockBiometrics, LockState, PinCheckFailure, Settings, UnlockResult, VerifyResult } from '@shared/types';
import { createIdleWatcher, autoLockMs, type IdleWatcher } from './idle';
import type { LockData, LockStore } from './lockFile';
import { effectiveRetryAt, hashPin, isValidPin, MAX_WAIT_MS, PIN_RULE_MESSAGE, retryAtAfter, verifyPin, waitAfter } from './pin';
import type { BiometricProvider } from './types';

/** How long a verification token stays valid. */
export const TOKEN_TTL_MS = 5 * 60_000;

/** The reason shown in the OS prompt (macOS: "<App> is trying to <reason>."). */
const BIOMETRIC_REASON: Record<'unlock' | 'change', Record<Lang, string>> = {
  unlock: { en: 'unlock Tape', zh: '解锁 Tape' },
  change: { en: 'change the Tape PIN', zh: '修改 Tape 的 PIN' },
};

export interface LockServiceDeps {
  store: LockStore;
  biometrics: BiometricProvider | null;
  lockSettings(): Settings['lock'];
  lang(): Lang;
  getWindow(): BrowserWindow | null;
  /** Seconds since the last system-wide input (powerMonitor.getSystemIdleTime). */
  idleSeconds(): number;
  now?: () => number;
  /** A monotonic clock in ms (performance.now); tests inject one. */
  monoNow?: () => number;
  idleTickMs?: number;
  /** scrypt cost for new PINs (tests use a cheap one). */
  hashCost?: { N: number; r: number; p: number };
}

export type LockListener = (state: LockState, prev: LockState) => void;

export interface LockService {
  getState(): LockState;
  isLocked(): boolean;
  hasPin(): boolean;
  /** Locks when a PIN exists; returns whether Tape is locked afterwards. */
  lock(): boolean;
  unlockWithPin(pin: string): Promise<UnlockResult>;
  unlockWithBiometrics(): Promise<UnlockResult>;
  verifyPin(pin: string): Promise<VerifyResult>;
  verifyBiometrics(): Promise<VerifyResult>;
  setPin(pin: string, token: string | null): Promise<LockState>;
  removePin(token: string): Promise<LockState>;
  /** Re-reads whether Touch ID / Windows Hello can be used (lid, keyboard and enrolment change). */
  refreshBiometrics(): Promise<LockState>;
  /** Starts the auto-lock timer (after app ready). */
  startAutoLock(): void;
  /** Runs an auto-lock check now (resume from sleep, before suspend). */
  checkIdle(): void;
  onChange(listener: LockListener): () => void;
  dispose(): void;
}

export function createLockService(deps: LockServiceDeps): LockService {
  const now = deps.now ?? Date.now;
  const mono = deps.monoNow ?? (() => performance.now());
  const provider = deps.biometrics;
  let data: LockData = deps.store.read();
  /** A PIN exists, or may exist (lock.json unreadable). */
  const pinExists = () => data.pin != null || !!data.unreadable;
  let locked = pinExists();
  // 'checking' until the first availability check answers (Windows Hello's helper takes seconds to start).
  let biometrics: LockBiometrics = provider ? { kind: provider.kind, available: false, reason: 'checking' } : { kind: null, available: false, reason: 'unsupported' };
  /** Bumped when the provider is disposed: an availability answer that started before is stale. */
  let providerGen = 0;
  /** Monotonic deadline of the current wait (0: none); wall-clock changes cannot shorten it. */
  let monoUntil = 0;
  {
    const left = data.retryAt != null ? data.retryAt - now() : 0;
    if (left > 0) monoUntil = mono() + Math.min(left, MAX_WAIT_MS);
  }
  const tokens = new Map<string, { expires: number; method: 'pin' | 'biometric' }>();
  const listeners = new Set<LockListener>();
  let last = snapshot();
  let queue: Promise<unknown> = Promise.resolve();

  /** When the next attempt is allowed (wall-clock ms), or null: the later of lock.json's time and the monotonic deadline. */
  function currentRetryAt(): number | null {
    const t = now();
    const wall = effectiveRetryAt(data.retryAt, t);
    const left = monoUntil - mono();
    const monoAt = left > 0 ? t + Math.ceil(left) : null;
    if (wall == null) return monoAt;
    return monoAt == null ? wall : Math.max(wall, monoAt);
  }

  function snapshot(): LockState {
    return { hasPin: pinExists(), locked, biometrics, failures: data.failures, retryAt: currentRetryAt() };
  }

  function changed(): void {
    const next = snapshot();
    if (JSON.stringify(next) === JSON.stringify(last)) return;
    const prev = last;
    last = next;
    for (const l of [...listeners]) {
      try {
        l(next, prev);
      } catch (err) {
        console.error('[lock] listener failed:', err);
      }
    }
  }

  /** PIN changes: persisted first, so a change that could not be saved is reported as an error. */
  function save(next: LockData): void {
    deps.store.write(next);
    data = next;
  }

  /**
   * The wrong-PIN counter: applied in memory first and persisted on a best-effort basis, so a disk
   * that cannot be written neither turns the backoff off nor keeps the right PIN from unlocking.
   */
  function record(next: LockData): void {
    data = next;
    try {
      deps.store.write(next);
    } catch (err) {
      console.error('[lock] could not save the wrong-PIN counter:', err);
    }
  }

  /** Runs PIN checks one at a time. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function issueToken(method: 'pin' | 'biometric'): string {
    const t = now();
    for (const [k, v] of tokens) if (v.expires <= t) tokens.delete(k);
    const token = randomBytes(24).toString('base64url');
    tokens.set(token, { expires: t + TOKEN_TTL_MS, method });
    return token;
  }

  function takeToken(token: string | null, methods: ReadonlyArray<'pin' | 'biometric'>): boolean {
    if (!token) return false;
    const entry = tokens.get(token);
    tokens.delete(token);
    return !!entry && entry.expires > now() && methods.includes(entry.method);
  }

  function clearFailures(): void {
    monoUntil = 0;
    if (data.unreadable) return;
    if (data.failures !== 0 || data.retryAt != null) record({ ...data, failures: 0, retryAt: null });
  }

  /** lock.json was unreadable: try again (the cause may have been passing, e.g. a file held by antivirus). */
  function reread(): void {
    if (!data.unreadable) return;
    const fresh = deps.store.read();
    if (fresh.unreadable) return;
    data = fresh;
    const left = data.retryAt != null ? data.retryAt - now() : 0;
    if (left > 0) monoUntil = Math.max(monoUntil, mono() + Math.min(left, MAX_WAIT_MS));
    // The file is gone meanwhile: no PIN, as at launch.
    if (!data.pin) unlock();
    changed();
  }

  function checkPin(pin: string): Promise<{ ok: true } | PinCheckFailure> {
    return serial(async () => {
      reread();
      if (data.unreadable) return { ok: false, reason: 'pinUnreadable' } as const;
      if (!data.pin) return { ok: false, reason: 'noPin' } as const;
      const retryAt = currentRetryAt();
      if (retryAt != null) return { ok: false, reason: 'throttled', retryAt } as const;
      const pinRecord = data.pin;
      if (isValidPin(pin) && (await verifyPin(pin, pinRecord))) {
        clearFailures();
        changed();
        return { ok: true } as const;
      }
      const failures = data.failures + 1;
      const wait = waitAfter(failures);
      const next = retryAtAfter(failures, now());
      if (wait > 0) monoUntil = mono() + wait;
      record({ ...data, failures, retryAt: next });
      changed();
      return { ok: false, reason: 'wrongPin', failures, retryAt: next } as const;
    });
  }

  const biometricsChosen = () => deps.lockSettings().unlockWith === 'biometric';

  function unlock(): void {
    if (!locked) return;
    locked = false;
    tokens.clear();
    disposeProvider();
    changed();
  }

  function disposeProvider(): void {
    providerGen++;
    provider?.dispose?.();
  }

  async function refreshBiometrics(): Promise<LockState> {
    if (provider) {
      const gen = providerGen;
      let next: LockBiometrics;
      try {
        const a = await provider.availability();
        next = a.available ? { kind: provider.kind, available: true } : { kind: provider.kind, available: false, reason: a.reason };
      } catch {
        next = { kind: provider.kind, available: false, reason: 'error' };
      }
      // Disposed meanwhile (unlocked with the PIN): the answer says nothing about the hardware.
      if (gen === providerGen) biometrics = next;
    }
    changed();
    return snapshot();
  }

  async function biometricCheck(purpose: 'unlock' | 'change'): Promise<{ ok: true } | { ok: false; reason: 'biometric'; failure: 'unavailable' | 'canceled' | 'failed' | 'busy' | 'timeout' | 'error' }> {
    if (!provider) return { ok: false, reason: 'biometric', failure: 'unavailable' };
    const state = await refreshBiometrics();
    if (!state.biometrics.available) return { ok: false, reason: 'biometric', failure: 'unavailable' };
    // Unlocked with the PIN while availability was being checked: no prompt.
    if (purpose === 'unlock' && !locked) return { ok: false, reason: 'biometric', failure: 'canceled' };
    // macOS prefixes "<App> is trying to"; Windows Hello shows the text as a sentence.
    const reason = BIOMETRIC_REASON[purpose][deps.lang()];
    const res = await provider.verify(provider.kind === 'windowsHello' ? reason[0].toUpperCase() + reason.slice(1) : reason, deps.getWindow());
    return res.ok ? { ok: true } : { ok: false, reason: 'biometric', failure: res.reason };
  }

  const idle: IdleWatcher = createIdleWatcher(
    {
      idleSeconds: deps.idleSeconds,
      now,
      limitMs: () => (locked || !pinExists() ? null : autoLockMs(deps.lockSettings())),
      onIdle: () => void service.lock(),
    },
    deps.idleTickMs,
  );

  const service: LockService = {
    getState: snapshot,
    isLocked: () => locked,
    hasPin: pinExists,

    lock() {
      if (!pinExists()) return false;
      if (locked) return true;
      locked = true;
      tokens.clear();
      changed();
      // Touch ID / Windows Hello only when chosen (Windows: the helper costs a PowerShell process).
      if (biometricsChosen()) {
        provider?.prepare?.();
        void refreshBiometrics();
      }
      return true;
    },

    async unlockWithPin(pin) {
      if (!locked) return { ok: true };
      const res = await checkPin(pin);
      if (res.ok) unlock();
      return res;
    },

    async unlockWithBiometrics() {
      if (!locked) return { ok: true };
      reread();
      if (data.unreadable) return { ok: false, reason: 'pinUnreadable' };
      if (!biometricsChosen()) return { ok: false, reason: 'biometric', failure: 'unavailable' };
      const res = await biometricCheck('unlock');
      // A late answer (the PIN was entered meanwhile) changes nothing.
      if (res.ok && locked) {
        clearFailures();
        unlock();
      }
      return res;
    },

    async verifyPin(pin) {
      const res = await checkPin(pin);
      return res.ok ? { ok: true, token: issueToken('pin') } : res;
    },

    async verifyBiometrics() {
      if (data.unreadable) return { ok: false, reason: 'pinUnreadable' };
      if (!data.pin) return { ok: false, reason: 'noPin' };
      // "PIN only" is enforced here too: biometrics then cannot stand in for the PIN.
      if (!biometricsChosen()) return { ok: false, reason: 'biometric', failure: 'unavailable' };
      const res = await biometricCheck('change');
      return res.ok ? { ok: true, token: issueToken('biometric') } : res;
    },

    async setPin(pin, token) {
      if (!isValidPin(pin)) throw new Error(PIN_RULE_MESSAGE);
      if (data.unreadable) throw new Error('The lock PIN cannot be read; use Forgot PIN to reset Tape');
      if (data.pin && !takeToken(token, ['pin', 'biometric'])) throw new Error('Verify the current PIN first');
      const newRecord = await hashPin(pin, deps.hashCost);
      save({ pin: newRecord, failures: 0, retryAt: null });
      monoUntil = 0;
      changed();
      return snapshot();
    },

    async removePin(token) {
      if (data.unreadable) throw new Error('The lock PIN cannot be read; use Forgot PIN to reset Tape');
      if (!data.pin) return snapshot();
      if (!takeToken(token, ['pin'])) throw new Error('Enter the current PIN first');
      save({ pin: null, failures: 0, retryAt: null });
      monoUntil = 0;
      unlock();
      changed();
      return snapshot();
    },

    refreshBiometrics,
    startAutoLock() {
      idle.start();
      // Started locked (a PIN exists): warm up the biometric prompt as lock() does.
      if (locked && biometricsChosen()) provider?.prepare?.();
    },
    checkIdle: () => idle.check(),

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    dispose() {
      idle.stop();
      disposeProvider();
    },
  };
  return service;
}
