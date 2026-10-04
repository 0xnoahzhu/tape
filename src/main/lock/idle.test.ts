import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoLockMs, createIdleWatcher } from './idle';

const MIN = 60_000;

describe('auto-lock', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  function setup(limit: number | null = 15 * MIN) {
    let idle = 0;
    const state = { limit, locks: 0 };
    const w = createIdleWatcher({ idleSeconds: () => idle, now: Date.now, limitMs: () => state.limit, onIdle: () => state.locks++ }, 15_000);
    w.start();
    return { w, state, setIdle: (s: number) => void (idle = s) };
  }

  it('locks once the system idle time reaches the limit', () => {
    const t = setup();
    t.setIdle(14 * 60);
    vi.advanceTimersByTime(15_000);
    expect(t.state.locks).toBe(0);
    t.setIdle(15 * 60);
    vi.advanceTimersByTime(15_000);
    expect(t.state.locks).toBe(1);
  });

  it('does nothing while auto-lock is off (Never, no PIN or already locked)', () => {
    const t = setup(null);
    t.setIdle(24 * 3600);
    vi.advanceTimersByTime(60_000);
    expect(t.state.locks).toBe(0);
  });

  it('counts time asleep as idle, although waking up resets the system idle time', () => {
    const t = setup();
    t.setIdle(5 * 60);
    vi.advanceTimersByTime(15_000);
    t.w.check(); // before suspend
    // Asleep for 20 minutes: the timer does not run, then the wake-up key press makes idle 0.
    vi.setSystemTime(Date.now() + 20 * MIN);
    t.setIdle(0);
    t.w.check(); // on resume
    expect(t.state.locks).toBe(1);
  });

  it('does not count a short sleep that stays under the limit', () => {
    const t = setup();
    t.setIdle(60);
    vi.advanceTimersByTime(15_000);
    vi.setSystemTime(Date.now() + 5 * MIN);
    t.setIdle(0);
    t.w.check();
    expect(t.state.locks).toBe(0);
  });

  it('stops', () => {
    const t = setup();
    t.w.stop();
    t.setIdle(3600);
    vi.advanceTimersByTime(60_000);
    expect(t.state.locks).toBe(0);
  });

  it('reads the configured time', () => {
    expect(autoLockMs({ autoLock: '15', customMinutes: 90 })).toBe(15 * MIN);
    expect(autoLockMs({ autoLock: '60', customMinutes: 90 })).toBe(60 * MIN);
    expect(autoLockMs({ autoLock: 'custom', customMinutes: 90 })).toBe(90 * MIN);
    expect(autoLockMs({ autoLock: 'never', customMinutes: 90 })).toBeNull();
  });
});
