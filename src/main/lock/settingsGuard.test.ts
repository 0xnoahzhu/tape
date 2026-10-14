import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { autoLockMinutes, loosensLock } from '@shared/lock';
import type { DeepPartial, Settings } from '@shared/types';
import { applySettingsPatch } from '../storeSchema';
import { createSettingsGuard, patchLoosensLock, PIN_FIRST_MESSAGE, PIN_NEEDED_MESSAGE } from './settingsGuard';

function setup(opts: { pin?: boolean; lock?: Partial<Settings['lock']> } = {}) {
  const base = defaultSettings('en');
  let settings: Settings = { ...base, lock: { ...base.lock, ...opts.lock } };
  const store = {
    getSettings: () => settings,
    updateSettings: vi.fn((patch: DeepPartial<Settings>) => (settings = applySettingsPatch(settings, patch))),
  };
  /** Tokens main handed out for the PIN; each is taken once. */
  const tokens = new Set(['pin-token']);
  const lock = { hasPin: () => opts.pin ?? true, authorize: vi.fn((t: string | null) => t != null && tokens.delete(t)) };
  return { guard: createSettingsGuard({ store, lock }), store, lock, settings: () => settings };
}

describe('loosensLock', () => {
  const at = (autoLock: Settings['lock']['autoLock'], customMinutes = 90, unlockWith: Settings['lock']['unlockWith'] = 'pin') => ({ autoLock, customMinutes, unlockWith });

  it('counts a longer auto-lock, Never, and biometrics where the PIN alone unlocked', () => {
    expect(autoLockMinutes(at('never'))).toBe(Infinity);
    expect(autoLockMinutes(at('custom', 5))).toBe(5);
    expect(loosensLock(at('15'), at('60'))).toBe(true);
    expect(loosensLock(at('60'), at('never'))).toBe(true);
    expect(loosensLock(at('60'), at('custom', 90))).toBe(true);
    expect(loosensLock(at('custom', 90), at('custom', 91))).toBe(true);
    expect(loosensLock(at('60'), at('60', 90, 'biometric'))).toBe(true);
  });

  it('does not count changes that tighten the lock or keep it as it is', () => {
    expect(loosensLock(at('60'), at('15'))).toBe(false);
    expect(loosensLock(at('never'), at('60'))).toBe(false);
    expect(loosensLock(at('60'), at('custom', 5))).toBe(false);
    expect(loosensLock(at('custom', 90), at('custom', 90))).toBe(false);
    expect(loosensLock(at('60', 90, 'biometric'), at('60', 90, 'pin'))).toBe(false);
    // customMinutes only counts while Custom is chosen.
    expect(loosensLock(at('60', 90), at('60', 1440))).toBe(false);
  });
});

describe('settings guard', () => {
  it('refuses a patch that weakens the lock while a PIN exists', () => {
    const t = setup({ lock: { autoLock: '15', unlockWith: 'pin' } });
    for (const lock of [{ autoLock: 'never' }, { autoLock: '60' }, { unlockWith: 'biometric' }, { autoLock: 'custom' }] as const) {
      expect(() => t.guard.update({ lock })).toThrow(PIN_NEEDED_MESSAGE);
    }
    expect(t.store.updateSettings).not.toHaveBeenCalled();
    expect(t.settings().lock).toMatchObject({ autoLock: '15', unlockWith: 'pin' });
  });

  it('lets changes that tighten the lock, and everything else, through', () => {
    const t = setup({ lock: { autoLock: '60', unlockWith: 'biometric' } });
    t.guard.update({ lock: { autoLock: '15' } });
    t.guard.update({ lock: { unlockWith: 'pin', sound: false } });
    t.guard.update({ appearance: { theme: 'dark' } });
    // An invalid value keeps the current one, so it weakens nothing.
    t.guard.update({ lock: { autoLock: 'forever' as never } });
    expect(t.settings().lock).toMatchObject({ autoLock: '15', unlockWith: 'pin', sound: false });
    expect(t.settings().appearance.theme).toBe('dark');
  });

  it('needs nothing without a PIN (the lock is off)', () => {
    const t = setup({ pin: false, lock: { autoLock: '15' } });
    t.guard.update({ lock: { autoLock: 'never' } });
    expect(t.settings().lock.autoLock).toBe('never');
    t.guard.updateLock({ autoLock: '60' }, null);
    expect(t.settings().lock.autoLock).toBe('60');
  });

  it('applies a weaker lock with a PIN token, once', () => {
    const t = setup({ lock: { autoLock: '15', unlockWith: 'pin' } });
    expect(() => t.guard.updateLock({ autoLock: 'never' }, null)).toThrow(PIN_FIRST_MESSAGE);
    expect(() => t.guard.updateLock({ autoLock: 'never' }, 'guessed')).toThrow(PIN_FIRST_MESSAGE);
    expect(() => t.guard.updateLock({ autoLock: 'never' }, 42)).toThrow(PIN_FIRST_MESSAGE);
    t.guard.updateLock({ autoLock: 'never', unlockWith: 'biometric' }, 'pin-token');
    expect(t.settings().lock).toMatchObject({ autoLock: 'never', unlockWith: 'biometric' });
    expect(() => t.guard.updateLock({ autoLock: '60' }, 'pin-token')).toThrow(PIN_FIRST_MESSAGE);
  });

  it('changes only the lock preferences through updateLockSettings', () => {
    const t = setup({ lock: { autoLock: '15' } });
    t.guard.updateLock({ autoLock: '30', appearance: { theme: 'dark' } } as never, 'pin-token');
    expect(t.store.updateSettings).toHaveBeenCalledWith({ lock: { autoLock: '30', appearance: { theme: 'dark' } } });
    expect(t.settings().appearance.theme).toBe('system');
    expect(t.settings().lock.autoLock).toBe('30');
  });

  it('tells which patches weaken the lock', () => {
    const s = { ...defaultSettings(), lock: { ...defaultSettings().lock, autoLock: '30' as const } };
    expect(patchLoosensLock(s, { lock: { autoLock: '60' } })).toBe(true);
    expect(patchLoosensLock(s, { lock: { autoLock: '15' } })).toBe(false);
    expect(patchLoosensLock(s, { appearance: { theme: 'dark' } })).toBe(false);
    expect(patchLoosensLock(s, null)).toBe(false);
    expect(patchLoosensLock(s, { lock: 'never' })).toBe(false);
  });
});
