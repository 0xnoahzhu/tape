import { describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import { defaultSettings, defaultWatchlists } from '@shared/defaults';
import { DND_MAX_MS } from '@shared/dnd';
import type { AppNotification } from '@shared/types';
import {
  MAX_NOTIFICATIONS,
  applySettingsPatch,
  hadOpenEndedDnd,
  hadReadOnlyMode,
  languageFromLocale,
  loadSettings,
  sameData,
  sanitizeAlertInput,
  sanitizeAlerts,
  sanitizeContract,
  sanitizeNotifications,
  sanitizeWatchlists,
  sanitizeWindowBounds,
} from './storeSchema';

describe('loadSettings', () => {
  const defaults = defaultSettings('en');

  it('notification sounds: saved ids of any platform load, missing or unknown ones take the default', () => {
    // Settings saved before the sound choices existed.
    expect(loadSettings({ notifications: { sound: false } }, defaults).notifications).toEqual({
      ...defaults.notifications,
      sound: false,
    });
    const s = loadSettings({ notifications: { sounds: { order: 'none', fill: 'Notification.Mail', other: 'Bogus' } } }, defaults);
    expect(s.notifications.sounds).toEqual({ order: 'none', fill: 'Notification.Mail', other: 'Purr' });
    const w = defaultSettings('en', 'win32');
    expect(loadSettings({ notifications: { sounds: { fill: 42, other: null } } }, w).notifications.sounds).toEqual(w.notifications.sounds);
    expect(applySettingsPatch(defaults, { notifications: { sounds: { fill: 'Hero' } } }).notifications.sounds).toEqual({ order: 'Tink', fill: 'Hero', other: 'Purr' });
    expect(applySettingsPatch(defaults, { notifications: { sounds: { fill: '../../evil' } } }).notifications.sounds).toEqual(defaults.notifications.sounds);
  });

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

  it('drops the removed options and flow switches, and counts a saved Level 2 on as the user’s choice', () => {
    // Saved before depthSetByUser: Level 2 was off by default, so on was set by the user.
    const on = loadSettings({ features: { depth: true, options: false, flow: false } }, defaults);
    expect(on.features).toEqual({ depth: true, depthSetByUser: true });
    expect(loadSettings({ features: { depth: 'true', options: true } }, defaults).features).toEqual({ depth: true, depthSetByUser: true });
    // Off (or never saved) leaves the choice open, so a check may still turn it on.
    expect(loadSettings({ features: { depth: false, options: true, flow: true } }, defaults).features).toEqual({ depth: false, depthSetByUser: false });
    expect(loadSettings({}, defaults).features).toEqual({ depth: false, depthSetByUser: false });
    // Files written by this version keep what they say: on by a check stays open, off by the user stays chosen.
    expect(loadSettings({ features: { depth: true, depthSetByUser: false } }, defaults).features).toEqual({ depth: true, depthSetByUser: false });
    expect(loadSettings({ features: { depth: false, depthSetByUser: true } }, defaults).features).toEqual({ depth: false, depthSetByUser: true });
    // A patch from the renderer that still names the removed switches changes nothing else.
    expect(applySettingsPatch(on, { features: { options: true } as never })).toEqual(on);
  });

  it('drops the former open-ended do-not-disturb: it loads as off', () => {
    const s = loadSettings({ notifications: { dnd: true, sound: false } }, defaults);
    expect(s.notifications.dndUntil).toBeNull();
    expect('dnd' in s.notifications).toBe(false);
    expect(s.notifications.sound).toBe(false);
  });

  it('tells whether the former open-ended do-not-disturb was on', () => {
    expect(hadOpenEndedDnd({ notifications: { dnd: true } })).toBe(true);
    expect(hadOpenEndedDnd({ notifications: { dnd: 'true' } })).toBe(true);
    expect(hadOpenEndedDnd({ notifications: { dnd: false } })).toBe(false);
    expect(hadOpenEndedDnd({ notifications: { dndUntil: Date.now() + 60_000 } })).toBe(false);
    expect(hadOpenEndedDnd({ notifications: true })).toBe(false);
    expect(hadOpenEndedDnd(null)).toBe(false);
  });

  it('do-not-disturb always has an end: past ends load as off, later ones are cut to the longest offered', () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 9, 14, 15);
      vi.setSystemTime(now);
      const until = (v: unknown) => loadSettings({ notifications: { dndUntil: v } }, defaults).notifications.dndUntil;
      expect(until(now + 3_600_000)).toBe(now + 3_600_000);
      expect(until(String(now + 60_000))).toBe(now + 60_000);
      expect(until(now - 1)).toBeNull();
      expect(until(now)).toBeNull();
      expect(until(null)).toBeNull();
      expect(until(now + 30 * 86_400_000)).toBe(now + DND_MAX_MS);
      expect(until('soon')).toBeNull();
      // A patch from the renderer is held to the same rules.
      const on = applySettingsPatch(defaults, { notifications: { dndUntil: now + 600_000 } });
      expect(on.notifications.dndUntil).toBe(now + 600_000);
      expect(applySettingsPatch(on, { notifications: { dndUntil: Number.MAX_SAFE_INTEGER } }).notifications.dndUntil).toBe(now + DND_MAX_MS);
      expect(applySettingsPatch(on, { notifications: { dndUntil: 'x' as never } }).notifications.dndUntil).toBe(now + 600_000);
      expect(applySettingsPatch(on, { notifications: { dndUntil: null } }).notifications.dndUntil).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('up / down colours follow the language when the file has none (after a Forgot-PIN reset)', () => {
    expect(defaultSettings('en').appearance.upColor).toBe('us');
    expect(defaultSettings('zh').appearance.upColor).toBe('cn');
    // The reset keeps only the language and the theme; the defaults are the system language's.
    expect(loadSettings({ appearance: { language: 'zh', theme: 'dark' } }, defaultSettings('en')).appearance.upColor).toBe('cn');
    expect(loadSettings({ appearance: { language: 'en' } }, defaultSettings('zh')).appearance.upColor).toBe('us');
    // A saved choice stays, whatever the language.
    expect(loadSettings({ appearance: { language: 'en', upColor: 'cn' } }, defaults).appearance.upColor).toBe('cn');
    expect(loadSettings({ appearance: { language: 'zh', upColor: 'us' } }, defaults).appearance.upColor).toBe('us');
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
        trading: { defaultQty: 'abc' },
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
    expect(s.trading.defaultQty).toBe(defaults.trading.defaultQty);
    expect(s.appearance.theme).toBe('system');
    expect(s.appearance.language).toBe('en');
    expect(s.appearance.upColor).toBe('us');
  });

  it('drops the removed "Confirm before sending" switch: every order is reviewed', () => {
    // Files from before the review became mandatory: a saved `false` must not survive.
    const s = loadSettings({ trading: { confirmOrders: false, defaultQty: 500, outsideRthDefault: true } }, defaults);
    expect(s.trading).toEqual({ defaultQty: 500, outsideRthDefault: true });
    expect('confirmOrders' in s.trading).toBe(false);
    // An IPC patch carrying it changes nothing either.
    expect('confirmOrders' in applySettingsPatch(defaults, { trading: { confirmOrders: false } }).trading).toBe(false);
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

  it('defaults the time format to 12-hour, also for settings saved before it existed', () => {
    expect(defaults.appearance.timeFormat).toBe('12h');
    expect(loadSettings({ appearance: { theme: 'dark', language: 'zh', upColor: 'us', showAccountId: false } }, defaults).appearance.timeFormat).toBe('12h');
    expect(loadSettings({ appearance: { timeFormat: '24h' } }, defaults).appearance.timeFormat).toBe('24h');
    for (const bad of ['24', 'h24', 24, true, null, '']) expect(loadSettings({ appearance: { timeFormat: bad } }, defaults).appearance.timeFormat).toBe('12h');
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

  it('changes the time format and keeps it on an invalid patch', () => {
    const h24 = applySettingsPatch(current, { appearance: { timeFormat: '24h' } });
    expect(h24.appearance).toMatchObject({ timeFormat: '24h', language: 'zh', theme: 'system' });
    expect(applySettingsPatch(h24, { appearance: { timeFormat: 'am/pm' as never } }).appearance.timeFormat).toBe('24h');
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

  it('the defaults are the two built-in lists', () => {
    expect(defaults.map((l) => l.id)).toEqual(['main', 'idx']);
  });

  it('keeps a saved list the defaults no longer have (the sample Options watch of older versions)', () => {
    const sample = {
      id: 'w-options',
      name: { en: 'Options watch', zh: '期权观察' },
      groups: [{ id: 'g-hiv', name: { en: 'High IV', zh: '高 IV' }, items: [{ contract: stock('TSLA'), name: 'Tesla' }, { contract: stock('NVDA'), name: 'NVIDIA' }] }],
    };
    expect(sanitizeWatchlists([...defaults, sample], defaults)).toEqual([...defaults, sample]);
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
  const v2 = (over: Record<string, unknown>) => ({ id: 'a', contract, frequency: 'once', active: true, createdAt: 1, ...over });

  it('migrates an alerts.json of Tape 0.11 (condition, price, repeat) and keeps the old fields for a downgrade', () => {
    const out = sanitizeAlerts([
      { id: 'a', contract, condition: 'above', price: 240, createdAt: 1 },
      { id: 'b', contract, condition: 'below', price: 200, repeat: true, createdAt: 2, lastTriggeredAt: 5, active: true },
      { id: 'c', contract, condition: 'below', price: 190, repeat: false, createdAt: 3, lastTriggeredAt: 6, active: false },
    ]);
    expect(out).toEqual([
      { id: 'a', contract, rule: { type: 'priceAbove', value: 240 }, frequency: 'once', active: true, createdAt: 1, condition: 'above', price: 240, repeat: false },
      {
        id: 'b',
        contract,
        rule: { type: 'priceBelow', value: 200 },
        frequency: 'always',
        active: true,
        createdAt: 2,
        lastTriggeredAt: 5,
        condition: 'below',
        price: 200,
        repeat: true,
      },
      {
        id: 'c',
        contract,
        rule: { type: 'priceBelow', value: 190 },
        frequency: 'once',
        active: false,
        createdAt: 3,
        lastTriggeredAt: 6,
        condition: 'below',
        price: 190,
        repeat: false,
      },
    ]);
    // Loading the migrated list again changes nothing.
    expect(sanitizeAlerts(out)).toEqual(out);
  });

  it('drops invalid v1 alerts', () => {
    expect(sanitizeAlerts([{ id: 'a', contract, condition: 'sideways', price: 1, createdAt: 1 }, { id: 'b', contract, condition: 'below', price: NaN, createdAt: 1 }])).toEqual([]);
    expect(sanitizeAlerts([{ id: 'c', contract, condition: 'below', price: -5, createdAt: 1 }])).toEqual([]);
    expect(sanitizeAlerts('nope')).toBeNull();
  });

  it('keeps v2 rules with their frequency, sessions and a clipped note; the old fields only for price rules', () => {
    const [vol, ind] = sanitizeAlerts([
      v2({ rule: { type: 'volumeAbove', shares: 1e7 }, frequency: 'daily', sessions: ['overnight', 'regular', 'bogus'], note: '  May take-profit line, rewritten later  ', lastValue: 1.2e7 }),
      v2({
        id: 'b',
        rule: { type: 'indicator', timeframe: '15m', on: 'close', signal: { ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' } },
        sessions: ['pre', 'regular', 'post'],
        condition: 'above',
      }),
    ])!;
    expect(vol).toEqual({
      id: 'a',
      contract,
      rule: { type: 'volumeAbove', shares: 1e7 },
      frequency: 'daily',
      sessions: ['regular', 'overnight'],
      note: 'May take-profit line',
      active: true,
      createdAt: 1,
      lastValue: 1.2e7,
    });
    // The default sessions are not stored; a stray v1 field on a non-price rule goes.
    expect(ind.sessions).toBeUndefined();
    expect(ind.condition).toBeUndefined();
    expect(sanitizeAlerts([v2({ rule: { type: 'priceAbove', value: 5 }, frequency: 'always' })])![0]).toMatchObject({ condition: 'above', price: 5, repeat: true });
  });

  it('counts the note in code points (CJK and emoji are one each)', () => {
    const [a] = sanitizeAlerts([v2({ rule: { type: 'priceAbove', value: 5 }, note: '止盈线'.repeat(8) + '😀' })])!;
    expect([...a.note!]).toHaveLength(20);
    expect(sanitizeAlerts([v2({ rule: { type: 'priceAbove', value: 5 }, note: '   ' })])![0].note).toBeUndefined();
  });

  it("keeps a newer Tape's rule or frequency as an unsupported row, on or off as written, instead of dropping it", () => {
    const future = { type: 'turnoverRatioAbove', pct: 3, basis: 'float' };
    const out = sanitizeAlerts([v2({ rule: future, frequency: 'weekly', sessions: ['auction'], active: true, note: 'keep me' })]);
    expect(out).toEqual([{ id: 'a', contract, rule: future, frequency: 'weekly', sessions: ['auction'], active: true, createdAt: 1, note: 'keep me', unsupported: true }]);
    // Kept as it is when written again, so the newer Tape still runs it.
    expect(sanitizeAlerts(out)).toEqual(out);
    expect(sanitizeAlerts([v2({ rule: future, active: false })])![0]).toMatchObject({ active: false, unsupported: true });
    // A known rule with a frequency this version does not know: not run as something else.
    expect(sanitizeAlerts([v2({ rule: { type: 'priceAbove', value: 5 }, frequency: 'hourly' })])![0]).toEqual({
      id: 'a',
      contract,
      rule: { type: 'priceAbove', value: 5 },
      frequency: 'hourly',
      active: true,
      createdAt: 1,
      unsupported: true,
    });
    expect(sanitizeAlerts([v2({ rule: { type: 'priceAbove', value: 5 }, frequency: undefined })])![0].frequency).toBe('once');
    // Parameters this version cannot read are kept the same way.
    expect(sanitizeAlerts([v2({ rule: { type: 'windowRise', minutes: 10, pct: 2 } })])![0]).toMatchObject({ unsupported: true, active: true });
    // Not an object or no type: nothing to keep.
    expect(sanitizeAlerts([v2({ rule: 'priceAbove' }), v2({ rule: { value: 3 } })])).toEqual([]);
  });

  it('validates every rule type', () => {
    const ok = (rule: unknown) => sanitizeAlertInput(v2({ rule })) !== null;
    expect(ok({ type: 'dayRise', pct: 5 })).toBe(true);
    expect(ok({ type: 'dayFall', pct: 0 })).toBe(false);
    expect(ok({ type: 'dayFall', pct: 1001 })).toBe(false);
    expect(ok({ type: 'windowFall', minutes: 5, pct: 2 })).toBe(true);
    expect(ok({ type: 'windowFall', minutes: 4, pct: 2 })).toBe(false);
    expect(ok({ type: 'turnoverAbove', amount: 1e9 })).toBe(true);
    expect(ok({ type: 'bidSizeAbove', shares: 0 })).toBe(false);
    expect(ok({ type: 'askBelow', value: Infinity })).toBe(false);
    expect(ok({ type: 'halt', dir: 'resumed' })).toBe(true);
    expect(ok({ type: 'halt', dir: 'paused' })).toBe(false);
    const ind = (signal: unknown, extra: Record<string, unknown> = {}) => ok({ type: 'indicator', timeframe: '1h', on: 'live', signal, ...extra });
    expect(ind({ ind: 'ma', kind: 'price', period: 20, cross: 'up' })).toBe(true);
    expect(ind({ ind: 'ma', kind: 'price', period: 20, cross: 'up' }, { timeframe: '3m' })).toBe(false);
    expect(ind({ ind: 'ma', kind: 'price', period: 251, cross: 'up' })).toBe(false);
    expect(ind({ ind: 'ema', kind: 'lines', fast: 26, slow: 12, cross: 'down' })).toBe(false);
    expect(ind({ ind: 'macd', kind: 'zero', fast: 12, slow: 26, signal: 9, cross: 'down' })).toBe(true);
    expect(ind({ ind: 'kdj', kind: 'level', n: 9, m1: 3, m2: 3, line: 'j', level: 120, cross: 'up' })).toBe(true);
    expect(ind({ ind: 'kdj', kind: 'level', n: 9, m1: 3, m2: 3, line: 'k', level: 120, cross: 'up' })).toBe(false);
    expect(ind({ ind: 'rsi', kind: 'level', period: 6, level: 80, cross: 'up' })).toBe(true);
    expect(ind({ ind: 'rsi', kind: 'lines', fast: 6, slow: 12, cross: 'sideways' })).toBe(false);
    expect(ind({ ind: 'boll', kind: 'band', period: 20, k: 2, band: 'upper', cross: 'up' })).toBe(true);
    expect(ind({ ind: 'boll', kind: 'band', period: 20, k: 6, band: 'upper', cross: 'up' })).toBe(false);
  });

  it('accepts only valid v2 alerts of known types from the renderer', () => {
    expect(sanitizeAlertInput(v2({ rule: { type: 'priceBelow', value: 120 } }))).toMatchObject({ rule: { type: 'priceBelow', value: 120 } });
    expect(sanitizeAlertInput(v2({ rule: { type: 'turnoverRatioAbove', pct: 3 } }))).toBeNull();
    expect(sanitizeAlertInput({ id: 'a', contract, condition: 'above', price: 240, createdAt: 1 })).toBeNull();
    expect(sanitizeAlertInput(v2({ rule: { type: 'priceBelow', value: 120 }, contract: { symbol: 'X' } }))).toBeNull();
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

  it('keeps the critical mark on order, connection and option risk notices only', () => {
    const rejected = { ...n(1), kind: 'order' as const, critical: true as const };
    const lost = { ...n(2), kind: 'conn' as const, critical: true as const };
    expect(sanitizeNotifications([rejected, lost, { ...n(3), kind: 'price', critical: true }, { ...n(4), kind: 'opt', critical: 1 }])).toEqual([
      { ...n(4), kind: 'opt' },
      { ...n(3), kind: 'price' },
      lost,
      rejected,
    ]);
  });

  it('keeps the account on order, fill and option risk notices only', () => {
    const fill = { ...n(1), kind: 'fill' as const, account: 'DUP899854' };
    expect(sanitizeNotifications([fill, { ...n(2), account: 'U1' }, { ...n(3), kind: 'order', account: 42 }])).toEqual([{ ...n(3), kind: 'order' }, n(2), fill]);
  });

  it('keeps a finished order’s mark on order notices only', () => {
    const done = { ...n(1), kind: 'order' as const, orderDone: true as const };
    expect(sanitizeNotifications([done, { ...n(2), orderDone: true }, { ...n(3), kind: 'order', orderDone: 'yes' }])).toEqual([{ ...n(3), kind: 'order' }, n(2), done]);
  });
});

describe('sanitizeWindowBounds', () => {
  it('validates window bounds', () => {
    expect(sanitizeWindowBounds({ width: 1440.4, height: 900, x: 10, y: 20, maximized: false })).toEqual({ width: 1440, height: 900, x: 10, y: 20, maximized: false });
    expect(sanitizeWindowBounds({ width: 50, height: 99999 })).toEqual({ width: 200, height: 20000 });
    expect(sanitizeWindowBounds({ width: 'a', height: 1 })).toBeNull();
  });
});
