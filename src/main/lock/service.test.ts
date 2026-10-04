import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { LockState, Settings } from '@shared/types';
import { memoryLockStore, type LockData } from './lockFile';
import { hashPin } from './pin';
import { createLockService, type LockServiceDeps } from './service';
import type { BiometricProvider, BiometricResult } from './types';

const FAST = { N: 1024, r: 8, p: 1 };

async function withPin(pin = '246810', extra: Partial<LockData> = {}): Promise<LockData> {
  return { pin: await hashPin(pin, FAST), failures: 0, retryAt: null, ...extra };
}

function fakeProvider(result: BiometricResult = { ok: true }, available = true) {
  const verify = vi.fn(async (_reason: string) => result);
  const provider: BiometricProvider = {
    kind: 'touchId',
    availability: async () => (available ? { kind: 'touchId', available: true } : { kind: 'touchId', available: false, reason: 'notEnrolled' }),
    verify,
  };
  return { provider, verify };
}

function setup(data?: LockData, opts: Partial<LockServiceDeps> & { lock?: Partial<Settings['lock']>; failWrites?: boolean; startAt?: number } = {}) {
  const mem = memoryLockStore(data);
  const writes = { count: 0 };
  const store = Object.assign(mem, {
    write: (d: LockData) => {
      writes.count++;
      if (opts.failWrites) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      mem.data = structuredClone(d);
    },
  });
  let t = opts.startAt ?? 1_700_000_000_000;
  let mono = 5_000;
  const settings = { ...defaultSettings().lock, ...opts.lock };
  const states: LockState[] = [];
  const svc = createLockService({
    store,
    biometrics: null,
    lockSettings: () => settings,
    lang: () => 'en',
    getWindow: () => null,
    idleSeconds: () => 0,
    now: () => t,
    monoNow: () => mono,
    hashCost: FAST,
    ...opts,
  });
  svc.onChange((s) => states.push(s));
  return {
    svc,
    store,
    writes,
    states,
    settings,
    advance: (ms: number) => void ((t += ms), (mono += ms)),
    /** Changes the wall clock only (the user sets the system time). */
    setClock: (ms: number) => void (t += ms),
    now: () => t,
  };
}

describe('lock service', () => {
  it('is unlocked and cannot lock without a PIN', () => {
    const { svc } = setup();
    expect(svc.getState()).toMatchObject({ hasPin: false, locked: false });
    expect(svc.lock()).toBe(false);
    expect(svc.isLocked()).toBe(false);
  });

  it('starts locked whenever a PIN exists', async () => {
    const { svc } = setup(await withPin());
    expect(svc.getState()).toMatchObject({ hasPin: true, locked: true });
  });

  it('sets a PIN, locks and unlocks with it', async () => {
    const { svc, store, states } = setup();
    await svc.setPin('135790', null);
    expect(store.data.pin).not.toBeNull();
    expect(JSON.stringify(store.data)).not.toContain('135790');
    expect(svc.lock()).toBe(true);
    expect(states.at(-1)).toMatchObject({ hasPin: true, locked: true });
    expect(await svc.unlockWithPin('000000')).toMatchObject({ ok: false, reason: 'wrongPin', failures: 1, retryAt: null });
    expect(svc.isLocked()).toBe(true);
    expect(await svc.unlockWithPin('135790')).toEqual({ ok: true });
    expect(svc.isLocked()).toBe(false);
    expect(store.data.failures).toBe(0);
  });

  it('refuses attempts after five wrong PINs, persists the wait and doubles it', async () => {
    const t = setup(await withPin('111111'));
    for (let i = 1; i <= 4; i++) expect(await t.svc.unlockWithPin('999999')).toMatchObject({ reason: 'wrongPin', failures: i, retryAt: null });
    expect(await t.svc.unlockWithPin('999999')).toEqual({ ok: false, reason: 'wrongPin', failures: 5, retryAt: t.now() + 30_000 });
    expect(t.store.data).toMatchObject({ failures: 5, retryAt: t.now() + 30_000 });
    // Even the right PIN is refused (without checking) until the wait is over.
    expect(await t.svc.unlockWithPin('111111')).toEqual({ ok: false, reason: 'throttled', retryAt: t.now() + 30_000 });
    expect(t.store.data.failures).toBe(5);
    t.advance(30_000);
    expect(await t.svc.unlockWithPin('999999')).toMatchObject({ reason: 'wrongPin', failures: 6, retryAt: t.now() + 60_000 });

    // A relaunch reads the counter back: still throttled.
    const again = setup(t.store.data, { startAt: t.now() + 10_000 });
    expect(again.svc.getState()).toMatchObject({ locked: true, failures: 6, retryAt: t.now() + 60_000 });
    expect(await again.svc.unlockWithPin('111111')).toMatchObject({ reason: 'throttled' });
    again.advance(60_000);
    expect(await again.svc.unlockWithPin('111111')).toEqual({ ok: true });
    expect(again.store.data).toMatchObject({ failures: 0, retryAt: null });
  });

  it('checks concurrent attempts one at a time', async () => {
    const t = setup(await withPin('111111', { failures: 4 }));
    const results = await Promise.all([t.svc.unlockWithPin('000001'), t.svc.unlockWithPin('000002'), t.svc.unlockWithPin('111111')]);
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['wrongPin', 'throttled', 'throttled']);
    expect(t.store.data.failures).toBe(5);
  });

  it('unlocks with biometrics only when chosen and verified', async () => {
    const ok = fakeProvider({ ok: true });
    const t = setup(await withPin(), { biometrics: ok.provider });
    expect(await t.svc.unlockWithBiometrics()).toEqual({ ok: true });
    expect(ok.verify).toHaveBeenCalledWith('unlock Tape', null);
    expect(t.svc.isLocked()).toBe(false);

    const pinOnly = setup(await withPin(), { biometrics: fakeProvider().provider, lock: { unlockWith: 'pin' } });
    expect(await pinOnly.svc.unlockWithBiometrics()).toEqual({ ok: false, reason: 'biometric', failure: 'unavailable' });
    expect(pinOnly.svc.isLocked()).toBe(true);

    const canceled = setup(await withPin(), { biometrics: fakeProvider({ ok: false, reason: 'canceled' }).provider });
    expect(await canceled.svc.unlockWithBiometrics()).toEqual({ ok: false, reason: 'biometric', failure: 'canceled' });
    expect(canceled.svc.getState()).toMatchObject({ locked: true, failures: 0 });

    const off = setup(await withPin(), { biometrics: fakeProvider({ ok: true }, false).provider });
    expect(await off.svc.unlockWithBiometrics()).toEqual({ ok: false, reason: 'biometric', failure: 'unavailable' });
    expect(off.svc.getState().biometrics).toEqual({ kind: 'touchId', available: false, reason: 'notEnrolled' });
  });

  it('reports no biometrics on platforms without a provider', async () => {
    const t = setup(await withPin());
    expect(t.svc.getState().biometrics).toEqual({ kind: null, available: false, reason: 'unsupported' });
    expect(await t.svc.unlockWithBiometrics()).toMatchObject({ ok: false, failure: 'unavailable' });
  });

  it('changes the PIN only with a fresh single-use token', async () => {
    const t = setup(await withPin('111111'));
    await t.svc.unlockWithPin('111111');
    await expect(t.svc.setPin('222222', null)).rejects.toThrow(/current PIN/);
    await expect(t.svc.setPin('222222', 'made-up')).rejects.toThrow(/current PIN/);
    expect(await t.svc.verifyPin('000000')).toMatchObject({ ok: false, reason: 'wrongPin' });
    const v = await t.svc.verifyPin('111111');
    if (!v.ok) throw new Error('expected a token');
    await t.svc.setPin('222222', v.token);
    await expect(t.svc.setPin('333333', v.token)).rejects.toThrow(/current PIN/);
    t.svc.lock();
    expect(await t.svc.unlockWithPin('111111')).toMatchObject({ ok: false });
    expect(await t.svc.unlockWithPin('222222')).toEqual({ ok: true });
  });

  it('expires tokens', async () => {
    const t = setup(await withPin('111111'));
    await t.svc.unlockWithPin('111111');
    const v = await t.svc.verifyPin('111111');
    if (!v.ok) throw new Error('expected a token');
    t.advance(5 * 60_000 + 1);
    await expect(t.svc.setPin('222222', v.token)).rejects.toThrow();
  });

  it('accepts a biometric token for a change, but removal needs the PIN', async () => {
    const t = setup(await withPin('111111'), { biometrics: fakeProvider().provider });
    await t.svc.unlockWithPin('111111');
    const bio = await t.svc.verifyBiometrics();
    if (!bio.ok) throw new Error('expected a token');
    await expect(t.svc.removePin(bio.token)).rejects.toThrow(/current PIN/);
    const bio2 = await t.svc.verifyBiometrics();
    if (!bio2.ok) throw new Error('expected a token');
    await t.svc.setPin('444444', bio2.token);
    const pin = await t.svc.verifyPin('444444');
    if (!pin.ok) throw new Error('expected a token');
    expect(await t.svc.removePin(pin.token)).toMatchObject({ hasPin: false, locked: false });
    expect(t.store.data.pin).toBeNull();
    expect(t.svc.lock()).toBe(false);
  });

  it('rejects malformed PINs', async () => {
    const { svc } = setup();
    await expect(svc.setPin('12345', null)).rejects.toThrow(/6 characters/);
    await expect(svc.setPin('abc de', null)).rejects.toThrow(/6 characters/);
    await expect(svc.setPin(123456 as never, null)).rejects.toThrow(/6 characters/);
  });

  it('takes any six characters as the PIN', async () => {
    const { svc } = setup();
    await svc.setPin('Ab#9密🔑', null);
    svc.lock();
    expect(await svc.unlockWithPin('ab#9密🔑')).toMatchObject({ ok: false, reason: 'wrongPin' });
    expect(await svc.unlockWithPin('Ab#9密🔑')).toEqual({ ok: true });
  });

  it('auto-locks after the configured idle time once a PIN exists', async () => {
    vi.useFakeTimers();
    try {
      let idle = 0;
      const t = setup(await withPin('111111'), { idleSeconds: () => idle, idleTickMs: 15_000, lock: { autoLock: '15' } });
      await t.svc.unlockWithPin('111111');
      t.svc.startAutoLock();
      idle = 14 * 60;
      vi.advanceTimersByTime(15_000);
      expect(t.svc.isLocked()).toBe(false);
      idle = 15 * 60;
      vi.advanceTimersByTime(15_000);
      expect(t.svc.isLocked()).toBe(true);
      t.svc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never auto-locks with Never or without a PIN', async () => {
    vi.useFakeTimers();
    try {
      const never = setup(await withPin('111111'), { idleSeconds: () => 86_400, idleTickMs: 15_000, lock: { autoLock: 'never' } });
      await never.svc.unlockWithPin('111111');
      const noPin = setup(undefined, { idleSeconds: () => 86_400, idleTickMs: 15_000 });
      never.svc.startAutoLock();
      noPin.svc.startAutoLock();
      vi.advanceTimersByTime(60_000);
      expect(never.svc.isLocked()).toBe(false);
      expect(noPin.svc.isLocked()).toBe(false);
      never.svc.dispose();
      noPin.svc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when lock.json is unreadable, and recovers when it can be read again', async () => {
    const bio = fakeProvider({ ok: true });
    const t = setup({ pin: null, failures: 0, retryAt: null, unreadable: true }, { biometrics: bio.provider });
    expect(t.svc.getState()).toMatchObject({ hasPin: true, locked: true });
    expect(t.svc.hasPin()).toBe(true);
    expect(await t.svc.unlockWithPin('246810')).toEqual({ ok: false, reason: 'pinUnreadable' });
    expect(await t.svc.unlockWithBiometrics()).toEqual({ ok: false, reason: 'pinUnreadable' });
    expect(bio.verify).not.toHaveBeenCalled();
    expect(await t.svc.verifyPin('246810')).toEqual({ ok: false, reason: 'pinUnreadable' });
    await expect(t.svc.setPin('135790', null)).rejects.toThrow(/Forgot PIN/);
    expect(t.svc.isLocked()).toBe(true);
    expect(t.writes.count).toBe(0);

    // The cause passed (e.g. antivirus released the file): the next attempt reads it again.
    t.store.data = await withPin('246810');
    expect(await t.svc.unlockWithPin('246810')).toEqual({ ok: true });
    expect(t.svc.getState()).toMatchObject({ hasPin: true, locked: false });
  });

  it('keeps the backoff and lets the right PIN in when lock.json cannot be written', async () => {
    const t = setup(await withPin('111111', { failures: 1 }), { failWrites: true });
    expect(await t.svc.unlockWithPin('111111')).toEqual({ ok: true });
    expect(t.svc.getState()).toMatchObject({ locked: false, failures: 0 });

    t.svc.lock();
    for (let i = 1; i <= 4; i++) expect(await t.svc.unlockWithPin('999999')).toMatchObject({ reason: 'wrongPin', failures: i });
    expect(await t.svc.unlockWithPin('999999')).toMatchObject({ reason: 'wrongPin', failures: 5, retryAt: t.now() + 30_000 });
    expect(await t.svc.unlockWithPin('111111')).toEqual({ ok: false, reason: 'throttled', retryAt: t.now() + 30_000 });
    expect(t.writes.count).toBeGreaterThan(5);
    // A PIN change that cannot be saved is still an error.
    t.advance(30_000);
    expect(await t.svc.unlockWithPin('111111')).toEqual({ ok: true });
    const v = await t.svc.verifyPin('111111');
    if (!v.ok) throw new Error('expected a token');
    await expect(t.svc.setPin('222222', v.token)).rejects.toThrow(/ENOSPC/);
  });

  it('does not end a wait when the system clock is set forward', async () => {
    const t = setup(await withPin('111111', { failures: 4 }));
    expect(await t.svc.unlockWithPin('999999')).toMatchObject({ reason: 'wrongPin', failures: 5 });
    t.setClock(60 * 60_000);
    expect(await t.svc.unlockWithPin('111111')).toMatchObject({ ok: false, reason: 'throttled' });
    expect(t.svc.getState().retryAt).toBe(t.now() + 30_000);
    t.advance(30_000);
    expect(await t.svc.unlockWithPin('111111')).toEqual({ ok: true });

    // A relaunch during a wait carries it over to the monotonic clock as well.
    const again = setup(await withPin('111111', { failures: 5, retryAt: 1_700_000_000_000 + 20_000 }));
    again.setClock(60 * 60_000);
    expect(await again.svc.unlockWithPin('111111')).toMatchObject({ reason: 'throttled' });
    again.advance(20_000);
    expect(await again.svc.unlockWithPin('111111')).toEqual({ ok: true });
  });

  it('does not let biometrics stand in for the PIN with "PIN only"', async () => {
    const bio = fakeProvider({ ok: true });
    const t = setup(await withPin('111111'), { biometrics: bio.provider, lock: { unlockWith: 'pin' } });
    await t.svc.unlockWithPin('111111');
    expect(await t.svc.verifyBiometrics()).toEqual({ ok: false, reason: 'biometric', failure: 'unavailable' });
    expect(bio.verify).not.toHaveBeenCalled();
  });

  it('starts biometrics as "checking" and only warms them up when chosen', async () => {
    const prepare = vi.fn();
    const make = () => ({ ...fakeProvider().provider, prepare });
    const pinOnly = setup(await withPin('111111'), { biometrics: make(), lock: { unlockWith: 'pin' } });
    expect(pinOnly.svc.getState().biometrics).toEqual({ kind: 'touchId', available: false, reason: 'checking' });
    pinOnly.svc.startAutoLock();
    await pinOnly.svc.unlockWithPin('111111');
    pinOnly.svc.lock();
    expect(prepare).not.toHaveBeenCalled();
    pinOnly.svc.dispose();

    const chosen = setup(await withPin('111111'), { biometrics: make() });
    chosen.svc.startAutoLock();
    expect(prepare).toHaveBeenCalledTimes(1);
    await chosen.svc.unlockWithPin('111111');
    chosen.svc.lock();
    expect(prepare).toHaveBeenCalledTimes(2);
    chosen.svc.dispose();
  });

  it('drops an availability answer that arrives after the provider was disposed', async () => {
    let answer: (a: { kind: 'touchId'; available: false; reason: 'error' }) => void = () => undefined;
    const provider: BiometricProvider = {
      kind: 'touchId',
      availability: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'touchId', available: true })
        .mockImplementationOnce(() => new Promise((r) => (answer = r))),
      verify: async () => ({ ok: true }),
      dispose: vi.fn(),
    };
    const t = setup(await withPin('111111'), { biometrics: provider });
    await t.svc.refreshBiometrics();
    const pending = t.svc.refreshBiometrics();
    await t.svc.unlockWithPin('111111');
    answer({ kind: 'touchId', available: false, reason: 'error' });
    await pending;
    expect(t.svc.getState().biometrics).toEqual({ kind: 'touchId', available: true });
  });
});
