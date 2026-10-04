import { describe, expect, it, vi } from 'vitest';

// The real providers are never asked to prompt here (that would open a system dialog).
vi.mock('electron', () => ({ systemPreferences: { canPromptTouchID: () => false, promptTouchID: vi.fn() } }));

const { createBiometrics, createFakeBiometrics, parseFake } = await import('./biometrics');

describe('biometric providers', () => {
  it('picks the provider by platform', () => {
    expect(createBiometrics({ platform: 'darwin', isPackaged: true })?.kind).toBe('touchId');
    expect(createBiometrics({ platform: 'win32', isPackaged: true })?.kind).toBe('windowsHello');
    expect(createBiometrics({ platform: 'linux', isPackaged: true })).toBeNull();
  });

  it('uses the fake provider only in development builds', async () => {
    const fake = createBiometrics({ platform: 'linux', isPackaged: false, fake: 'windowsHello:ok' });
    expect(fake?.kind).toBe('windowsHello');
    expect(createBiometrics({ platform: 'linux', isPackaged: true, fake: 'ok' })).toBeNull();
    expect(createBiometrics({ platform: 'darwin', isPackaged: false, fake: 'bogus' })?.kind).toBe('touchId');
  });

  it('parses TAPE_FAKE_BIOMETRICS', () => {
    expect(parseFake('ok', 'darwin')).toEqual({ kind: 'touchId', mode: 'ok' });
    expect(parseFake('cancel', 'win32')).toEqual({ kind: 'windowsHello', mode: 'cancel' });
    expect(parseFake('touchId:unavailable', 'win32')).toEqual({ kind: 'touchId', mode: 'unavailable' });
    expect(parseFake('faceId:ok', 'darwin')).toBeNull();
    expect(parseFake('maybe', 'darwin')).toBeNull();
  });

  it('answers like a real prompt', async () => {
    vi.useFakeTimers();
    try {
      const ok = createFakeBiometrics('touchId', 'ok');
      const p = ok.verify('unlock Tape', null);
      expect(await ok.verify('again', null)).toEqual({ ok: false, reason: 'busy' });
      await vi.advanceTimersByTimeAsync(400);
      expect(await p).toEqual({ ok: true });
      const fail = createFakeBiometrics('touchId', 'fail', 0);
      const f = fail.verify('x', null);
      await vi.advanceTimersByTimeAsync(0);
      expect(await f).toEqual({ ok: false, reason: 'failed' });
      const off = createFakeBiometrics('windowsHello', 'unavailable');
      expect(await off.availability()).toMatchObject({ available: false, reason: 'notEnrolled' });
      expect(await off.verify('x', null)).toEqual({ ok: false, reason: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });
});
