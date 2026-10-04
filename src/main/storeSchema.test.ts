import { describe, expect, it } from 'vitest';
import { defaultSettings, defaultWatchlists } from '@shared/defaults';
import type { AppNotification } from '@shared/types';
import {
  MAX_NOTIFICATIONS,
  applySettingsPatch,
  hadReadOnlyMode,
  languageFromLocale,
  loadSettings,
  sameData,
  sanitizeAlerts,
  sanitizeContract,
  sanitizeNav,
  sanitizeNotifications,
  sanitizeWatchlists,
  sanitizeWindowBounds,
} from './storeSchema';

describe('loadSettings', () => {
  const defaults = defaultSettings('en');

  it('returns the defaults for empty or non-object input', () => {
    expect(loadSettings({}, defaults)).toEqual(defaults);
    expect(loadSettings(null, defaults)).toEqual(defaults);
    expect(loadSettings([1, 2], defaults)).toEqual(defaults);
  });

  it('deep-merges saved values over the defaults', () => {
    const s = loadSettings({ connection: { port: 4001 }, appearance: { theme: 'light' }, notifications: { system: { fill: false } } }, defaults);
    expect(s.connection.port).toBe(4001);
    expect(s.connection.host).toBe(defaults.connection.host);
    expect(s.appearance.theme).toBe('light');
    expect(s.appearance.language).toBe('en');
    expect(s.notifications.system.fill).toBe(false);
    expect(s.notifications.system.order).toBe(true);
  });

  it('drops unknown keys at every level', () => {
    const s = loadSettings({ bogus: 1, connection: { port: 4001, extra: 'x' }, notifications: { system: { nope: true } } }, defaults) as unknown as Record<string, Record<string, unknown>>;
    expect('bogus' in s).toBe(false);
    expect('extra' in s.connection).toBe(false);
    expect('nope' in (s.notifications.system as Record<string, unknown>)).toBe(false);
  });

  it('loads files saved with the removed read-only setting', () => {
    const saved = { connection: { mode: 'tws', host: '10.0.0.2', port: 7497, clientId: 21, autoConnect: false, autoReconnect: false, readOnly: true } };
    const s = loadSettings(saved, defaults);
    expect(s.connection).toEqual({ mode: 'tws', host: '10.0.0.2', port: 7497, clientId: 21, autoConnect: false, autoReconnect: false });
    expect('readOnly' in s.connection).toBe(false);
    // A patch that still carries it changes nothing.
    expect(applySettingsPatch(s, { connection: { readOnly: false } })).toEqual(s);
  });

  it('tells whether the removed read-only setting was on', () => {
    expect(hadReadOnlyMode({ connection: { readOnly: true } })).toBe(true);
    // Coerced like the setting was.
    expect(hadReadOnlyMode({ connection: { readOnly: 'true' } })).toBe(true);
    expect(hadReadOnlyMode({ connection: { readOnly: 1 } })).toBe(true);
    expect(hadReadOnlyMode({ connection: { readOnly: false } })).toBe(false);
    expect(hadReadOnlyMode({ connection: { readOnly: 'yes' } })).toBe(false);
    expect(hadReadOnlyMode({ connection: {} })).toBe(false);
    expect(hadReadOnlyMode({ connection: true })).toBe(false);
    expect(hadReadOnlyMode({ readOnly: true })).toBe(false);
    expect(hadReadOnlyMode(null)).toBe(false);
  });

  it('coerces types and falls back on garbage', () => {
    const s = loadSettings(
      {
        connection: { port: '4001', clientId: 12.6, autoConnect: 'false', autoReconnect: 0, host: '  localhost ', mode: 'nope' },
        trading: { confirmOrders: 'yes', defaultQty: 'abc' },
        appearance: { theme: 'blue', language: 'fr', upColor: 'us' },
      },
      defaults,
    );
    expect(s.connection.port).toBe(4001);
    expect(s.connection.clientId).toBe(13);
    expect(s.connection.autoConnect).toBe(false);
    expect(s.connection.autoReconnect).toBe(false);
    expect(s.connection.host).toBe('localhost');
    expect(s.connection.mode).toBe(defaults.connection.mode);
    expect(s.trading.confirmOrders).toBe(defaults.trading.confirmOrders);
    expect(s.trading.defaultQty).toBe(defaults.trading.defaultQty);
    expect(s.appearance.theme).toBe('system');
    expect(s.appearance.language).toBe('en');
    expect(s.appearance.upColor).toBe('us');
  });

  it('clamps numbers into range', () => {
    const hi = loadSettings({ connection: { port: 70000, clientId: 5e12 }, trading: { defaultQty: 0 }, apiLog: { keepDays: 1000 } }, defaults);
    expect(hi.connection.port).toBe(65535);
    expect(hi.connection.clientId).toBe(999_999_999);
    expect(hi.trading.defaultQty).toBe(1);
    expect(hi.apiLog.keepDays).toBe(90);
    const lo = loadSettings({ connection: { port: -3, clientId: -1 }, apiLog: { keepDays: 10 } }, defaults);
    expect(lo.connection.port).toBe(1);
    expect(lo.connection.clientId).toBe(0);
    expect(lo.apiLog.keepDays).toBe(7);
  });

  it('rejects empty or whitespace host names', () => {
    expect(loadSettings({ connection: { host: '' } }, defaults).connection.host).toBe('127.0.0.1');
    expect(loadSettings({ connection: { host: 'a b' } }, defaults).connection.host).toBe('127.0.0.1');
  });

  it('gives settings saved before the lock screen existed its defaults', () => {
    const s = loadSettings({ appearance: { theme: 'dark' } }, defaults);
    expect(s.lock).toEqual({ autoLock: '60', customMinutes: 90, unlockWith: 'biometric', sound: true });
  });

  it('validates the lock preferences', () => {
    const s = loadSettings({ lock: { autoLock: 'custom', customMinutes: '5000', unlockWith: 'face', sound: 0, pin: '123456' } }, defaults);
    expect(s.lock).toEqual({ autoLock: 'custom', customMinutes: 1440, unlockWith: 'biometric', sound: false });
    expect(loadSettings({ lock: { autoLock: 45, customMinutes: 0 } }, defaults).lock).toMatchObject({ autoLock: '60', customMinutes: 1 });
    expect(loadSettings({ lock: { autoLock: 'never', unlockWith: 'pin' } }, defaults).lock).toMatchObject({ autoLock: 'never', unlockWith: 'pin' });
  });
});

describe('applySettingsPatch', () => {
  const current = { ...defaultSettings('zh'), connection: { ...defaultSettings().connection, port: 4001 } };

  it('merges a partial patch and keeps everything else', () => {
    const next = applySettingsPatch(current, { appearance: { theme: 'dark' } });
    expect(next.appearance.theme).toBe('dark');
    expect(next.appearance.language).toBe('zh');
    expect(next.connection.port).toBe(4001);
  });

  it('keeps the current value (not the default) when the patch is invalid', () => {
    const next = applySettingsPatch(current, { appearance: { theme: 'neon' as never }, connection: { host: 42 as never } });
    expect(next).toEqual(current);
    expect(sameData(next, current)).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(current);
    applySettingsPatch(current, { notifications: { system: { fill: false } } });
    expect(JSON.stringify(current)).toBe(before);
  });

  it('never takes a PIN through a settings patch', () => {
    const next = applySettingsPatch(current, { lock: { autoLock: '15', pin: '000000', hash: 'x' } as never });
    expect(next.lock.autoLock).toBe('15');
    expect(JSON.stringify(next)).not.toMatch(/000000|hash/);
  });

  it('tolerates a non-object patch', () => {
    expect(applySettingsPatch(current, null)).toEqual(current);
    expect(applySettingsPatch(current, 'x')).toEqual(current);
  });
});

describe('languageFromLocale', () => {
  it('maps zh locales to zh and everything else to en', () => {
    expect(languageFromLocale('zh-CN')).toBe('zh');
    expect(languageFromLocale('zh-Hant-TW')).toBe('zh');
    expect(languageFromLocale('ZH')).toBe('zh');
    expect(languageFromLocale('en-US')).toBe('en');
    expect(languageFromLocale('de')).toBe('en');
    expect(languageFromLocale('')).toBe('en');
    expect(languageFromLocale(undefined)).toBe('en');
  });
});

describe('sanitizeContract', () => {
  it('keeps known fields and drops the rest', () => {
    const c = sanitizeContract({ symbol: 'AAPL', secType: 'OPT', exchange: 'SMART', currency: 'USD', strike: 230, right: 'C', lastTradeDate: '20261016', multiplier: 100, conId: 123, junk: 1 });
    expect(c).toEqual({ symbol: 'AAPL', secType: 'OPT', exchange: 'SMART', currency: 'USD', strike: 230, right: 'C', lastTradeDate: '20261016', multiplier: 100, conId: 123 });
  });

  it('rejects contracts without symbol or with an unknown secType', () => {
    expect(sanitizeContract({ symbol: '', secType: 'STK', exchange: 'SMART', currency: 'USD' })).toBeNull();
    expect(sanitizeContract({ symbol: 'X', secType: 'ABC', exchange: 'SMART', currency: 'USD' })).toBeNull();
    expect(sanitizeContract('AAPL')).toBeNull();
  });

  it('filters invalid combo legs', () => {
    const c = sanitizeContract({
      symbol: 'SPX',
      secType: 'BAG',
      exchange: 'SMART',
      currency: 'USD',
      comboLegs: [{ conId: 1, ratio: 1, action: 'BUY', exchange: 'SMART' }, { conId: 'x', ratio: 1, action: 'BUY' }],
    });
    expect(c?.comboLegs).toEqual([{ conId: 1, ratio: 1, action: 'BUY', exchange: 'SMART' }]);
  });
});

describe('sanitizeWatchlists', () => {
  const defaults = defaultWatchlists();

  it('returns null for non-arrays', () => {
    expect(sanitizeWatchlists({}, defaults)).toBeNull();
  });

  it('keeps valid lists unchanged', () => {
    expect(sanitizeWatchlists(defaults, defaults)).toEqual(defaults);
  });

  it('restores deleted built-in lists and their names', () => {
    const user = { id: 'mine', name: 'Mine', groups: [] };
    const renamedMain = { ...defaults[0], name: 'Hacked', builtin: false };
    const out = sanitizeWatchlists([renamedMain, user], defaults)!;
    expect(out.map((l) => l.id)).toEqual(['main', 'idx', 'mine']);
    expect(out[0].name).toEqual(defaults[0].name);
    expect(out[0].builtin).toBe(true);
  });

  it('keeps the groups of built-in lists as saved (renamed, deleted)', () => {
    const [main, idx] = defaults;
    const edited = { ...main, groups: [{ ...main.groups[0], name: 'Chips' }, main.groups[2]] };
    const out = sanitizeWatchlists([edited, idx], defaults)!;
    expect(out[0].name).toEqual(main.name);
    expect(out[0].groups.map((g) => g.id)).toEqual(['g-tech', 'g-etf']);
    expect(out[0].groups[0].name).toBe('Chips');
    expect(out[0].groups[0].items).toEqual(main.groups[0].items);
    // A saved file read again (relaunch) is unchanged.
    expect(sanitizeWatchlists(JSON.parse(JSON.stringify(out)), defaults)).toEqual(out);
  });

  it('drops invalid items, groups and duplicate ids', () => {
    const out = sanitizeWatchlists(
      [
        {
          id: 'mine',
          name: 'Mine',
          groups: [
            { id: 'g', name: { en: 'G', zh: 'G (zh)' }, items: [{ contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' } }, { contract: null }, 3] },
            { id: 'g', name: 'dup', items: [] },
            { name: 'no id', items: [] },
          ],
        },
        { id: 'mine', name: 'dup', groups: [] },
        { id: 'x' },
      ],
      [],
    )!;
    expect(out).toHaveLength(1);
    expect(out[0].groups).toHaveLength(1);
    expect(out[0].groups[0].items).toEqual([{ contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' } }]);
  });

  it('does not let user lists claim to be built in', () => {
    const out = sanitizeWatchlists([{ id: 'mine', name: 'Mine', builtin: true, groups: [] }], [])!;
    expect(out[0].builtin).toBeUndefined();
  });
});

describe('sanitizeAlerts', () => {
  const contract = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' };

  it('keeps valid alerts and defaults booleans', () => {
    const out = sanitizeAlerts([{ id: 'a', contract, condition: 'above', price: 240, createdAt: 1 }]);
    expect(out).toEqual([{ id: 'a', contract, condition: 'above', price: 240, repeat: false, createdAt: 1, active: true }]);
  });

  it('drops invalid alerts', () => {
    expect(sanitizeAlerts([{ id: 'a', contract, condition: 'sideways', price: 1, createdAt: 1 }, { id: 'b', contract, condition: 'below', price: NaN, createdAt: 1 }])).toEqual([]);
    expect(sanitizeAlerts('nope')).toBeNull();
  });
});

describe('sanitizeNotifications', () => {
  const n = (i: number): AppNotification => ({ id: `n${i}`, t: i, kind: 'sys', title: { en: 'T', zh: 'T' }, body: { en: 'B', zh: 'B' }, read: false });

  it('sorts newest first and caps the list', () => {
    const out = sanitizeNotifications(Array.from({ length: MAX_NOTIFICATIONS + 20 }, (_, i) => n(i)))!;
    expect(out).toHaveLength(MAX_NOTIFICATIONS);
    expect(out[0].t).toBe(MAX_NOTIFICATIONS + 19);
  });

  it('drops entries with unknown kinds or missing text', () => {
    expect(sanitizeNotifications([{ ...n(1), kind: 'spam' }, { ...n(2), title: 'x' }, n(3)])).toEqual([n(3)]);
  });
});

describe('sanitizeNav and sanitizeWindowBounds', () => {
  it('sorts NAV points and drops invalid ones', () => {
    expect(sanitizeNav([{ t: 2, netLiq: 2 }, { t: 1, netLiq: 1 }, { t: 3 }])).toEqual([
      { t: 1, netLiq: 1 },
      { t: 2, netLiq: 2 },
    ]);
  });

  it('validates window bounds', () => {
    expect(sanitizeWindowBounds({ width: 1440.4, height: 900, x: 10, y: 20, maximized: false })).toEqual({ width: 1440, height: 900, x: 10, y: 20, maximized: false });
    expect(sanitizeWindowBounds({ width: 50, height: 99999 })).toEqual({ width: 200, height: 20000 });
    expect(sanitizeWindowBounds({ width: 'a', height: 1 })).toBeNull();
  });
});
