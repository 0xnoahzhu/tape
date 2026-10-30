import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** A data folder chosen before, serving `account` (vault.json as the store writes it). */
function withVault(account: string | null = 'DU1'): string {
  const vault = join(env.dir, 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'tape-vault.json'), JSON.stringify({ format: 1 }));
  writeFileSync(join(env.dir, 'vault.json'), JSON.stringify({ path: vault, ...(account ? { lastAccount: account } : {}) }));
  return vault;
}

describe('createStore', () => {
  beforeEach(() => {
    env.dir = mkdtempSync(join(tmpdir(), 'tape-store-'));
    env.locale = 'en-US';
  });
  afterEach(() => rmSync(env.dir, { recursive: true, force: true }));

  it('first launch: defaults, language and up / down colours from the locale, settings saved', () => {
    env.locale = 'zh-CN';
    const store = createStore();
    expect(store.getSettings().appearance).toMatchObject({ language: 'zh', upColor: 'cn' });
    expect(store.getWatchlists()).toEqual(defaultWatchlists());
    expect(store.getNotifications()).toEqual([]);
    store.flush();
    expect(read('settings.json').appearance).toMatchObject({ language: 'zh', upColor: 'cn' });
  });

  it('first launch in English: green up, red down (the US convention)', () => {
    env.locale = 'en-US';
    const store = createStore();
    expect(store.getSettings().appearance).toMatchObject({ language: 'en', upColor: 'us' });
    store.flush();
    expect(read('settings.json').appearance.upColor).toBe('us');
  });

  it('keeps the saved language on later launches', () => {
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ appearance: { language: 'en', theme: 'dark' } }));
    env.locale = 'zh-CN';
    const s = createStore().getSettings();
    expect(s.appearance.language).toBe('en');
    expect(s.appearance.theme).toBe('dark');
  });

  it('keeps saved up / down colours on later launches, whatever the locale or language', () => {
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ appearance: { language: 'en', upColor: 'cn' } }));
    env.locale = 'en-US';
    expect(createStore().getSettings().appearance.upColor).toBe('cn');
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ appearance: { language: 'zh', upColor: 'us' } }));
    env.locale = 'zh-CN';
    expect(createStore().getSettings().appearance.upColor).toBe('us');
  });

  it('turns the former open-ended do-not-disturb off and says so once', () => {
    withVault();
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ notifications: { dnd: true, sound: false }, appearance: { language: 'zh' } }));
    const store = createStore();
    expect(store.getSettings().notifications).toMatchObject({ dndUntil: null, sound: false });
    expect(store.getNotifications()).toMatchObject([{ kind: 'sys', read: false, title: { en: 'Do not disturb was turned off', zh: '勿扰模式已关闭' } }]);
    store.flush();
    expect('dnd' in read('settings.json').notifications).toBe(false);
    expect(read('settings.json').notifications.sound).toBe(false);
    expect(createStore().getNotifications()).toHaveLength(1);
  });

  it('posts both notices when both removed switches were on', () => {
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ connection: { readOnly: true }, notifications: { dnd: true } }));
    expect(createStore().getNotifications().map((n) => n.title.en)).toEqual(['Do not disturb was turned off', 'Read-only mode was removed']);
  });

  it('posts nothing for a do-not-disturb that was off', () => {
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ notifications: { dnd: false } }));
    expect(createStore().getNotifications()).toEqual([]);
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
    withVault();
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
    store.setWindowBounds({ width: 1300, height: 800, x: 5, y: 6 });
    store.flush();
    expect(read('window.json')).toEqual({ width: 1300, height: 800, x: 5, y: 6 });
    expect(existsSync(join(env.dir, 'alerts.json'))).toBe(false);
    expect(readdirSync(env.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('posts a notice once when the saved settings had the removed read-only mode on', () => {
    withVault();
    const saved = { connection: { host: '10.0.0.2', port: 7497, readOnly: true }, appearance: { language: 'zh' } };
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify(saved));
    const store = createStore();
    expect(store.getNotifications()).toMatchObject([{ kind: 'sys', read: false, title: { en: 'Read-only mode was removed', zh: '只读模式已移除' } }]);
    expect(store.getNotifications()[0]!.body.en).toContain('“Read-Only API”');
    store.flush();
    // Saved without the key (and nothing else lost), so the next launch posts nothing.
    expect(read('settings.json').connection).toMatchObject({ host: '10.0.0.2', port: 7497 });
    expect('readOnly' in read('settings.json').connection).toBe(false);
    expect(read('settings.json').appearance.language).toBe('zh');
    expect(createStore().getNotifications()).toHaveLength(1);
  });

  it('posts nothing when the removed read-only mode was off', () => {
    writeFileSync(join(env.dir, 'settings.json'), JSON.stringify({ connection: { readOnly: false } }));
    const store = createStore();
    expect(store.getNotifications()).toEqual([]);
    store.flush();
    expect(existsSync(join(env.dir, 'notifications.json'))).toBe(false);
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

describe('createStore: the data folder', () => {
  beforeEach(() => {
    env.dir = mkdtempSync(join(tmpdir(), 'tape-store-'));
    env.locale = 'en-US';
  });
  afterEach(() => rmSync(env.dir, { recursive: true, force: true }));

  const files = (vault: string, account: string) => readdirSync(join(vault, 'accounts', account)).sort();
  const readIn = (vault: string, account: string, name: string) => JSON.parse(readFileSync(join(vault, 'accounts', account, name), 'utf8'));

  it('has none until one is chosen: default watchlists that cannot change, notices for this run only', () => {
    const store = createStore();
    expect(store.getVault()).toEqual({ path: null, status: 'unset', account: null });
    expect(store.vaultProblem()).toBe('Choose a data folder first');
    expect(store.getWatchlists()).toEqual(defaultWatchlists());
    expect(() => store.setWatchlists([{ id: 'mine', name: 'Mine', groups: [] }])).toThrow('Choose a data folder first');
    expect(() => store.setPriceAlerts([])).toThrow('Choose a data folder first');
    store.setAccount('DU1');
    expect(() => store.setWatchlists([])).toThrow('Choose a data folder first');
    store.flush();
    expect(readdirSync(env.dir).sort()).toEqual(['settings.json', 'vault.json']);
  });

  it('an empty folder becomes a data folder; each account keeps its own files', () => {
    const store = createStore();
    const changes: Array<string | null> = [];
    store.onVaultChanged((v) => changes.push(v.account));
    const vault = join(env.dir, 'chosen');
    expect(store.setVaultDir(vault, 'open')).toEqual({ path: vault, status: 'ok', account: null });
    expect(existsSync(join(vault, 'tape-vault.json'))).toBe(true);
    expect(store.vaultProblem()).toBeNull();
    // No account yet: nothing to keep the lists under.
    expect(() => store.setWatchlists([])).toThrow('Connect to IB first: watchlists and price alerts are kept per account');

    store.setAccount('DU1');
    store.setWatchlists([{ id: 'paper', name: 'Paper', groups: [] }]);
    store.setNotifications([{ id: 'n1', t: 1, kind: 'sys', title: { en: 'a', zh: 'a' }, body: { en: 'b', zh: 'b' }, read: false }]);
    store.setAccount('U2');
    // The live account sees none of the paper account's data.
    expect(store.getWatchlists()).toEqual(defaultWatchlists());
    expect(store.getNotifications()).toEqual([]);
    store.setWatchlists([{ id: 'live', name: 'Live', groups: [] }]);
    store.flush();
    expect(files(vault, 'DU1')).toEqual(['notifications.json', 'watchlists.json']);
    expect(readIn(vault, 'DU1', 'watchlists.json').map((l: { id: string }) => l.id)).toContain('paper');
    expect(readIn(vault, 'U2', 'watchlists.json').map((l: { id: string }) => l.id)).not.toContain('paper');
    expect(changes).toEqual([null, 'DU1', 'U2']);

    // The next launch serves the last account until the connection names one.
    const next = createStore();
    expect(next.getVault()).toEqual({ path: vault, status: 'ok', account: 'U2' });
    expect(next.getWatchlists().map((l) => l.id)).toContain('live');
    next.setAccount('DU1');
    expect(next.getNotifications().map((n) => n.id)).toEqual(['n1']);
  });

  it('keeps a notice owed to an earlier login in that account’s list', () => {
    const vault = withVault('U2');
    const store = createStore();
    store.addNotificationFor('DU1', { id: 'late', t: 1, kind: 'order', title: { en: 'a', zh: 'a' }, body: { en: 'b', zh: 'b' }, read: false, account: 'DU1' });
    expect(store.getNotifications()).toEqual([]);
    expect(readIn(vault, 'DU1', 'notifications.json').map((n: { id: string }) => n.id)).toEqual(['late']);
  });

  it('refuses a folder with other files, and moves only into an empty one', () => {
    const vault = withVault();
    const store = createStore();
    store.setWatchlists([{ id: 'mine', name: 'Mine', groups: [] }]);
    const other = join(env.dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'notes.txt'), 'x');
    expect(() => store.setVaultDir(other, 'open')).toThrow('This folder holds other files');
    expect(() => store.setVaultDir(other, 'move')).toThrow('This folder holds other files');
    expect(() => store.setVaultDir(vault, 'open')).toThrow('This is the current data folder');
    expect(store.getVault().path).toBe(vault);

    const moved = join(env.dir, 'moved');
    store.setVaultDir(moved, 'move');
    expect(store.getVault()).toEqual({ path: moved, status: 'ok', account: 'DU1' });
    expect(store.getWatchlists().map((l) => l.id)).toContain('mine');
    // The old folder stays as it was.
    expect(existsSync(join(vault, 'accounts', 'DU1', 'watchlists.json'))).toBe(true);
  });

  it('refuses a folder written by a newer Tape', () => {
    withVault();
    const store = createStore();
    const newer = join(env.dir, 'newer');
    mkdirSync(newer);
    writeFileSync(join(newer, 'tape-vault.json'), JSON.stringify({ format: 99 }));
    expect(() => store.setVaultDir(newer, 'open')).toThrow('written by a newer version of Tape');
  });

  it('a folder that goes away stops everything, is never made again, and is used once it is back', async () => {
    const vault = withVault();
    const store = createStore();
    const changes: string[] = [];
    store.onVaultChanged((v) => changes.push(v.status));
    store.setWatchlists([{ id: 'mine', name: 'Mine', groups: [] }]);
    store.flush();
    rmSync(vault, { recursive: true, force: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A change written now finds the marker gone: it is dropped, and the store looks again.
    store.setWatchlists([{ id: 'other', name: 'Other', groups: [] }]);
    store.flush();
    await Promise.resolve();
    error.mockRestore();
    expect(existsSync(vault)).toBe(false);
    expect(store.getVault().status).toBe('unavailable');
    expect(changes).toEqual(['unavailable']);
    expect(store.vaultProblem()).toContain('The data folder is not available');
    expect(store.getWatchlists()).toEqual(defaultWatchlists());
    expect(() => store.setWatchlists([])).toThrow('The data folder is not available');

    // Still gone: nothing changes. Back (the drive connected again): used again.
    expect(store.recheckVault().status).toBe('unavailable');
    withVault();
    expect(store.recheckVault().status).toBe('ok');
    expect(changes).toEqual(['unavailable', 'ok']);
  });

  it('a chosen folder missing at launch is unavailable, not made again', () => {
    const vault = withVault();
    rmSync(vault, { recursive: true, force: true });
    const store = createStore();
    expect(store.getVault().status).toBe('unavailable');
    store.flush();
    expect(existsSync(vault)).toBe(false);
  });
});
