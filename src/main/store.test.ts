import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultWatchlists } from '@shared/defaults';

// createStore only needs a few `app` members; everything else is plain fs.
const env = vi.hoisted(() => ({ dir: '', locale: 'en-US', ready: true }));
vi.mock('electron', () => ({
  app: {
    getPath: () => env.dir,
    getLocale: () => env.locale,
    getPreferredSystemLanguages: () => [env.locale],
    isReady: () => env.ready,
    whenReady: () => Promise.resolve(),
  },
}));

const { createStore } = await import('./store');

const read = (name: string) => JSON.parse(readFileSync(join(env.dir, name), 'utf8'));

describe('createStore', () => {
  beforeEach(() => {
    env.dir = mkdtempSync(join(tmpdir(), 'tape-store-'));
    env.locale = 'en-US';
  });
  afterEach(() => rmSync(env.dir, { recursive: true, force: true }));

  it('first launch: defaults, language from the locale, settings saved', () => {
    env.locale = 'zh-CN';
    const store = createStore();
    expect(store.getSettings().appearance.language).toBe('zh');
    expect(store.getWatchlists()).toEqual(defaultWatchlists());
    expect(store.getNotifications()).toEqual([]);
    store.flush();
    expect(read('settings.json').appearance.language).toBe('zh');
  });

  it('keeps the saved language on later launches', () => {
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ appearance: { language: 'en', theme: 'dark' } }));
    env.locale = 'zh-CN';
    const s = createStore().getSettings();
    expect(s.appearance.language).toBe('en');
    expect(s.appearance.theme).toBe('dark');
  });

  it('updateSettings merges, persists and notifies with (next, prev)', () => {
    const store = createStore();
    const calls: Array<[string, string]> = [];
    store.onSettingsChanged((next, prev) => calls.push([prev.appearance.theme, next.appearance.theme]));
    const next = store.updateSettings({ appearance: { theme: 'light' } });
    expect(next.appearance.theme).toBe('light');
    expect(store.getSettings()).toBe(next);
    expect(calls).toEqual([['system', 'light']]);
    store.flush();
    expect(read('settings.json').appearance.theme).toBe('light');
  });

  it('does not notify when nothing changes and stops after unsubscribe', () => {
    const store = createStore();
    const listener = vi.fn();
    const off = store.onSettingsChanged(listener);
    store.updateSettings({ appearance: { theme: 'system' } });
    store.updateSettings({ connection: { port: 'nope' as never } });
    expect(listener).not.toHaveBeenCalled();
    off();
    store.updateSettings({ appearance: { theme: 'dark' } });
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener does not stop the others', () => {
    const store = createStore();
    const second = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.onSettingsChanged(() => {
      throw new Error('boom');
    });
    store.onSettingsChanged(second);
    store.updateSettings({ trading: { defaultQty: 5 } });
    expect(second).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('validates watchlists and alerts coming from the renderer', () => {
    const store = createStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.setWatchlists('garbage' as never);
    expect(store.getWatchlists()).toEqual(defaultWatchlists());
    store.setWatchlists([{ id: 'mine', name: 'Mine', groups: [] }]);
    expect(store.getWatchlists().map((l) => l.id)).toEqual(['main', 'idx', 'mine']);
    store.setPriceAlerts([{ id: 'x' } as never]);
    expect(store.getPriceAlerts()).toEqual([]);
    warn.mockRestore();
  });

  it('flush writes every changed file and nothing else', () => {
    const store = createStore();
    store.flush();
    store.setNav([{ t: 1, netLiq: 100 }]);
    store.setWindowBounds({ width: 1300, height: 800, x: 5, y: 6 });
    store.flush();
    expect(read('nav.json')).toEqual([{ t: 1, netLiq: 100 }]);
    expect(read('window.json')).toEqual({ width: 1300, height: 800, x: 5, y: 6 });
    expect(existsSync(join(env.dir, 'alerts.json'))).toBe(false);
    expect(readdirSync(env.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('falls back to defaults and keeps a backup when a file is corrupt', () => {
    writeFileSync(join(env.dir, 'settings.json'), '{oops');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createStore();
    error.mockRestore();
    expect(store.getSettings().connection.port).toBe(4002);
    expect(readdirSync(env.dir).some((f) => /^settings\.corrupt-\d+\.json$/.test(f))).toBe(true);
  });
});
