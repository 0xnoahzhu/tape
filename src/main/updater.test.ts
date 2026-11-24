import { describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@shared/types';
import { CHECK_EVERY_MS, createUpdater, FIRST_CHECK_MS, NOT_AVAILABLE_MESSAGE, NOT_READY_MESSAGE, shortError, type UpdaterBackend } from './updater';

type Listener = (...args: never[]) => void;

function fakeBackend() {
  const listeners = new Map<string, Listener[]>();
  const fire = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => (l as (...a: unknown[]) => void)(...args));
  let resolveCheck: (() => void) | null = null;
  let rejectCheck: ((err: Error) => void) | null = null;
  const backend = {
    on: (event: string, l: Listener) => listeners.set(event, [...(listeners.get(event) ?? []), l]),
    checkForUpdates: vi.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolveCheck = res;
          rejectCheck = rej;
        }),
    ),
    downloadUpdate: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
  };
  return {
    backend: backend as unknown as UpdaterBackend & typeof backend,
    fire,
    finish: () => resolveCheck?.(),
    fail: (err: Error) => rejectCheck?.(err),
  };
}

function setup(withBackend = true, autoOn = true) {
  const f = fakeBackend();
  const states: UpdateState[] = [];
  const auto = { on: autoOn };
  const timers: Array<{ fn: () => void; ms: number; repeat: boolean }> = [];
  const updater = createUpdater({
    backend: withBackend ? f.backend : null,
    auto: () => auto.on,
    emit: (s) => states.push(s),
    now: () => 1_000,
    setTimer: (fn, ms) => timers.push({ fn, ms, repeat: false }),
    setRepeat: (fn, ms) => timers.push({ fn, ms, repeat: true }),
  });
  return { ...f, updater, states, auto, timers };
}

describe('createUpdater', () => {
  it('is off without a backend: no checks, install refused', async () => {
    const t = setup(false);
    expect(t.updater.getState()).toEqual({ status: 'off' });
    t.updater.start();
    expect(t.timers).toEqual([]);
    expect(await t.updater.check()).toEqual({ status: 'off' });
    expect(() => t.updater.install()).toThrow(NOT_READY_MESSAGE);
  });

  it('checks shortly after launch, then every few hours', () => {
    const t = setup();
    expect(t.updater.getState()).toEqual({ status: 'idle', checkedAt: null });
    t.updater.start();
    expect(t.timers.map(({ ms, repeat }) => ({ ms, repeat }))).toEqual([
      { ms: FIRST_CHECK_MS, repeat: false },
      { ms: CHECK_EVERY_MS, repeat: true },
    ]);
    t.timers[0].fn();
    expect(t.backend.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('reports up to date with the time of the check', async () => {
    const t = setup();
    const done = t.updater.check();
    t.fire('checking-for-update');
    t.fire('update-not-available');
    t.finish();
    expect(await done).toEqual({ status: 'idle', checkedAt: 1_000 });
    expect(t.states.map((s) => s.status)).toEqual(['checking', 'idle']);
  });

  it('joins a check already running', () => {
    const t = setup();
    void t.updater.check();
    void t.updater.check();
    expect(t.backend.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('with automatic updates on, downloads a new version, reports whole percents, then is ready', () => {
    const t = setup();
    void t.updater.check();
    t.fire('checking-for-update');
    t.fire('update-available', { version: '1.2.0' });
    t.fire('download-progress', { percent: 10.2 });
    t.fire('download-progress', { percent: 10.9 });
    t.fire('download-progress', { percent: 55.5 });
    t.fire('update-downloaded', { version: '1.2.0' });
    expect(t.backend.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(t.states).toEqual([
      { status: 'checking' },
      { status: 'downloading', version: '1.2.0', percent: 0 },
      { status: 'downloading', version: '1.2.0', percent: 10 },
      { status: 'downloading', version: '1.2.0', percent: 55 },
      { status: 'ready', version: '1.2.0' },
    ]);
  });

  it('with automatic updates off, reports a new version and downloads it only when asked', () => {
    const t = setup(true, false);
    expect(() => t.updater.download()).toThrow(NOT_AVAILABLE_MESSAGE);
    t.fire('update-available', { version: '1.2.0' });
    expect(t.updater.getState()).toEqual({ status: 'available', version: '1.2.0' });
    expect(t.backend.downloadUpdate).not.toHaveBeenCalled();
    t.updater.download();
    expect(t.backend.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(t.updater.getState()).toEqual({ status: 'downloading', version: '1.2.0', percent: 0 });
  });

  it('turning automatic updates on downloads the available version', () => {
    const t = setup(true, false);
    t.updater.autoChanged();
    t.fire('update-available', { version: '1.2.0' });
    t.updater.autoChanged();
    expect(t.backend.downloadUpdate).not.toHaveBeenCalled();
    t.auto.on = true;
    t.updater.autoChanged();
    expect(t.backend.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(t.updater.getState().status).toBe('downloading');
  });

  it('checks again while a version is available (a newer one may have come)', () => {
    const t = setup(true, false);
    t.fire('update-available', { version: '1.2.0' });
    void t.updater.check();
    expect(t.backend.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('reports a download that fails to start', async () => {
    const t = setup(true, false);
    t.backend.downloadUpdate.mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    t.fire('update-available', { version: '1.2.0' });
    t.updater.download();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.updater.getState()).toEqual({ status: 'error', message: 'disk full', checkedAt: 1_000 });
  });

  it('installs only once an update is ready', () => {
    const t = setup();
    expect(() => t.updater.install()).toThrow(NOT_READY_MESSAGE);
    t.fire('update-downloaded', { version: '1.2.0' });
    t.updater.install();
    expect(t.backend.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('does not check again while downloading or ready, and a later error keeps it ready', async () => {
    const t = setup();
    t.fire('update-available', { version: '1.2.0' });
    expect((await t.updater.check()).status).toBe('downloading');
    t.fire('update-downloaded', { version: '1.2.0' });
    expect((await t.updater.check()).status).toBe('ready');
    expect(t.backend.checkForUpdates).not.toHaveBeenCalled();
    t.fire('error', new Error('offline'));
    expect(t.updater.getState()).toEqual({ status: 'ready', version: '1.2.0' });
  });

  it('reports a failed check with its first line, keeping the last successful check time', async () => {
    const t = setup();
    let done = t.updater.check();
    t.fire('update-not-available');
    t.finish();
    await done;
    done = t.updater.check();
    t.fire('checking-for-update');
    t.fail(new Error('HttpError: 404\nHeaders: {...}'));
    expect(await done).toEqual({ status: 'error', message: 'HttpError: 404', checkedAt: 1_000 });
  });
});

describe('shortError', () => {
  it('keeps the first line, at most 200 characters', () => {
    expect(shortError(new Error('a\nb'))).toBe('a');
    expect(shortError('x'.repeat(300))).toHaveLength(200);
    expect(shortError(new Error(''))).toBe('Update failed');
  });
});
