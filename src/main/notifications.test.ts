import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { TapeEvent } from '@shared/ipc';
import { NEW_YORK_ZONE, TOKEN_CLOCK } from '@shared/timeFormat';
import type { AppNotification, Settings } from '@shared/types';
import type { MainContext } from './context';

const os = vi.hoisted(() => ({ supported: true, shown: [] as Array<{ options: Record<string, unknown>; emitter: EventEmitter; closed: boolean }> }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Notification extends EventEmitter {
    static isSupported = () => os.supported;
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
    }
    show() {
      os.shown.push({ options: this.options, emitter: this, closed: false });
    }
    close() {
      const n = os.shown.find((s) => s.emitter === this);
      if (n) n.closed = true;
      this.emit('close');
    }
  }
  return { Notification };
});
vi.mock('./appearance', () => ({ iconImage: () => null, iconPath: (dark: boolean) => `C:\\Tape\\icon-${dark ? 'dark' : 'light'}-256.png` }));

const { createNotifier, SAMPLE_LIFETIME_MS } = await import('./notifications');

const aapl = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' } as const;
const text = (s: string) => ({ en: s, zh: `${s} (zh)` });

function setup(patch: (s: Settings) => Settings = (s) => s, platform = 'darwin') {
  let settings = patch(defaultSettings('en', platform));
  let list: AppNotification[] = [];
  const events: TapeEvent[] = [];
  const showMainWindow = vi.fn();
  const win = { webContents: { isLoading: () => false, once: vi.fn() } };
  const lock = { locked: false };
  const played: string[] = [];
  const player = { play: (file: string) => void played.push(file) };
  const ctx = {
    lock: { isLocked: () => lock.locked },
    emit: (e: TapeEvent) => events.push(e),
    showMainWindow,
    getMainWindow: () => win,
    appearance: { isDark: () => true },
    store: {
      getSettings: () => settings,
      getNotifications: () => list,
      setNotifications: (l: AppNotification[]) => void (list = l),
    },
  } as unknown as MainContext;
  return {
    notifier: createNotifier(ctx, platform, player),
    played,
    events,
    showMainWindow,
    list: () => list,
    setSettings: (s: Settings) => void (settings = s),
    lock,
  };
}

describe('Notifier', () => {
  beforeEach(() => {
    os.supported = true;
    os.shown.length = 0;
  });

  it('adds to the list, emits and shows an OS notification in the current language', () => {
    const t = setup((s) => ({ ...s, appearance: { ...s.appearance, language: 'zh' } }));
    const n = t.notifier.notify({ kind: 'fill', title: text('Filled'), body: text('100 AAPL') });
    expect(n).toMatchObject({ kind: 'fill', read: false });
    expect(typeof n.id).toBe('string');
    expect(t.list()[0]).toEqual(n);
    expect(t.events).toEqual([{ type: 'notifications', notifications: [n] }]);
    expect(os.shown).toHaveLength(1);
    expect(os.shown[0].options).toMatchObject({ id: n.id, title: 'Filled (zh)', body: '100 AAPL (zh)', silent: true });
    // macOS: the sound is Tape's, once the notification is posted.
    os.shown[0].emitter.emit('show');
    expect(t.played).toEqual(['/System/Library/Sounds/Glass.aiff']);
  });

  it('writes stored clock times in the time format set when the OS notification shows', () => {
    const gtd = TOKEN_CLOCK.time(Date.UTC(2026, 9, 9, 20), { timeZone: NEW_YORK_ZONE, zone: 'ET', date: 'md' });
    const body = { en: `Limit 226.95 · GTD ${gtd}`, zh: `限价 226.95 · GTD ${gtd}` };
    const t = setup();
    const n = t.notifier.notify({ kind: 'order', title: text('Submitted'), body });
    // The list keeps the token; the renderer resolves it whenever it draws the list.
    expect(n.body).toEqual(body);
    expect(os.shown[0].options).toMatchObject({ body: 'Limit 226.95 · GTD 10/09 4:00 PM ET' });
    t.setSettings({ ...defaultSettings('zh'), appearance: { ...defaultSettings('zh').appearance, timeFormat: '24h' } });
    t.notifier.notify({ kind: 'order', title: text('Submitted'), body });
    expect(os.shown[1].options).toMatchObject({ body: '限价 226.95 · GTD 10/09 16:00 ET' });
    t.setSettings({ ...defaultSettings('zh') });
    t.notifier.notify({ kind: 'order', title: text('Submitted'), body });
    expect(os.shown[2].options).toMatchObject({ body: '限价 226.95 · GTD 10/09 下午 4:00 ET' });
  });

  it('respects the per-kind rule, sound and do-not-disturb', () => {
    const t = setup((s) => ({ ...s, notifications: { ...s.notifications, sound: false, system: { ...s.notifications.system, order: false } } }));
    t.notifier.notify({ kind: 'order', title: text('a'), body: text('b') });
    expect(os.shown).toHaveLength(0);
    t.notifier.notify({ kind: 'price', title: text('a'), body: text('b') });
    expect(os.shown[0].options.silent).toBe(true);
    expect(t.list()).toHaveLength(2);
  });

  it('skips the OS notification when unsupported', () => {
    os.supported = false;
    const t = setup();
    t.notifier.notify({ kind: 'conn', title: text('a'), body: text('b') });
    expect(os.shown).toHaveLength(0);
    expect(t.list()).toHaveLength(1);
  });

  it('rejects invalid requests from the renderer', () => {
    const t = setup();
    expect(() => t.notifier.notify({ kind: 'nope', title: 'x', body: 'y' } as never)).toThrow();
    expect(t.list()).toHaveLength(0);
  });

  it('clicking opens the instrument (chart, or option chain for option alerts) and marks it read', () => {
    const t = setup();
    const n = t.notifier.notify({ kind: 'opt', title: text('Risk'), body: text('Delta'), contract: aapl });
    os.shown[0].emitter.emit('click');
    expect(t.showMainWindow).toHaveBeenCalled();
    expect(t.events).toContainEqual({ type: 'openContract', contract: aapl, view: 'opt' });
    expect(t.list().find((x) => x.id === n.id)?.read).toBe(true);
  });

  it('clicking while Tape is locked only shows the window: nothing behind the lock changes', () => {
    const t = setup();
    t.lock.locked = true;
    t.notifier.notify({ kind: 'opt', title: text('Risk'), body: text('Delta'), contract: aapl });
    t.events.length = 0;
    os.shown[0].emitter.emit('click');
    expect(t.showMainWindow).toHaveBeenCalled();
    expect(t.events.some((e) => e.type === 'openContract')).toBe(false);
  });

  it('clicking a notification without an instrument just shows the window', () => {
    const t = setup();
    t.notifier.notify({ kind: 'conn', title: text('Lost'), body: text('Reconnecting') });
    os.shown[0].emitter.emit('click');
    expect(t.showMainWindow).toHaveBeenCalledOnce();
    expect(t.events.some((e) => e.type === 'openContract')).toBe(false);
  });

  it('markRead updates and emits only when something changed', () => {
    const t = setup();
    t.notifier.notify({ kind: 'sys', title: text('a'), body: text('b') });
    t.events.length = 0;
    t.notifier.markRead('all');
    expect(t.list()[0].read).toBe(true);
    expect(t.events).toHaveLength(1);
    t.notifier.markRead('all');
    t.notifier.markRead([42] as never);
    expect(t.events).toHaveLength(1);
  });

  it('test() always tries the OS notification unless do-not-disturb is on', () => {
    const t = setup((s) => ({ ...s, notifications: { ...s.notifications, system: { ...s.notifications.system, sys: false } } }));
    t.notifier.test();
    expect(os.shown).toHaveLength(1);
    expect(os.shown[0].options).toMatchObject({ title: 'Test notification', body: 'If a system notification appeared, everything is set up.' });
    expect(t.list()[0]).toMatchObject({ kind: 'sys', title: { en: 'Test notification' } });

    const s = defaultSettings('en');
    t.setSettings({ ...s, notifications: { ...s.notifications, dnd: true } });
    t.notifier.test();
    expect(os.shown).toHaveLength(1);
    expect(t.list()).toHaveLength(2);
  });

  describe('sounds', () => {
    const notifs = (s: Settings, patch: Partial<Settings['notifications']>): Settings => ({ ...s, notifications: { ...s.notifications, ...patch } });
    const all = ['order', 'fill', 'price', 'opt', 'conn', 'sys'] as const;
    /** Every OS notification so far has been posted (the 'show' event). */
    const posted = () => os.shown.forEach((n) => n.emitter.emit('show'));

    it('macOS: a silent notification, and orders, fills and the rest play their own system sound once posted', () => {
      const t = setup();
      for (const kind of all) t.notifier.notify({ kind, title: text('a'), body: text('b') });
      expect(os.shown.map((n) => [n.options.silent, n.options.sound])).toEqual(all.map(() => [true, undefined]));
      expect(t.played).toEqual([]);
      posted();
      const file = (name: string) => `/System/Library/Sounds/${name}.aiff`;
      expect(t.played).toEqual([file('Tink'), file('Glass'), file('Purr'), file('Purr'), file('Purr'), file('Purr')]);
    });

    it('macOS: no sound when the notification could not be posted', () => {
      const t = setup();
      t.notifier.notify({ kind: 'fill', title: text('a'), body: text('b') });
      os.shown[0].emitter.emit('failed', {}, 'not allowed');
      expect(t.played).toEqual([]);
    });

    it('is silent with the Sound switch off or the category set to None', () => {
      const t = setup((s) => notifs(s, { sounds: { order: 'none', fill: 'Hero', other: 'Pop' } }));
      t.notifier.notify({ kind: 'order', title: text('a'), body: text('b') });
      t.notifier.notify({ kind: 'fill', title: text('a'), body: text('b') });
      t.setSettings(notifs(defaultSettings('en'), { sound: false }));
      t.notifier.notify({ kind: 'fill', title: text('a'), body: text('b') });
      posted();
      expect(os.shown.map((n) => n.options.silent)).toEqual([true, true, true]);
      expect(t.played).toEqual(['/System/Library/Sounds/Hero.aiff']);
    });

    it('makes no sound when do-not-disturb is on or the kind is kept out of the OS', () => {
      const t = setup((s) => notifs(s, { dnd: true }));
      t.notifier.notify({ kind: 'fill', title: text('a'), body: text('b') });
      const s = defaultSettings('en');
      t.setSettings(notifs(s, { system: { ...s.notifications.system, fill: false } }));
      t.notifier.notify({ kind: 'fill', title: text('a'), body: text('b') });
      expect(os.shown).toHaveLength(0);
      expect(t.played).toEqual([]);
      expect(t.list()).toHaveLength(2);
    });

    it('Windows: a toast with the same text, the icon and the sound event; clicks still open the fill', () => {
      const t = setup(undefined, 'win32');
      const n = t.notifier.notify({ kind: 'fill', title: text('Filled <AAPL>'), body: text('100 @ 226.95'), contract: aapl });
      const options = os.shown[0].options;
      expect(options).toMatchObject({ id: n.id, groupId: 'fill', title: 'Filled <AAPL>', silent: false });
      expect(options.toastXml).toBe(
        '<toast><visual><binding template="ToastGeneric"><text>Filled &lt;AAPL&gt;</text><text>100 @ 226.95</text>' +
          '<image id="1" placement="appLogoOverride" hint-crop="none" src="C:\\Tape\\icon-dark-256.png"/></binding></visual>' +
          '<audio src="ms-winsoundevent:Notification.Reminder"/></toast>',
      );
      os.shown[0].emitter.emit('click');
      expect(t.events).toContainEqual({ type: 'openContract', contract: aapl, view: 'trades' });
      t.setSettings(notifs(defaultSettings('en', 'win32'), { sound: false }));
      t.notifier.notify({ kind: 'order', title: text('a'), body: text('b') });
      expect(os.shown[1].options.toastXml).toContain('<audio silent="true"/>');
      posted();
      expect(t.played).toEqual([]);
    });

    it('Linux: no sound option and no toast XML (the notification server decides)', () => {
      const t = setup(undefined, 'linux');
      t.notifier.notify({ kind: 'order', title: text('a'), body: text('b') });
      expect(os.shown[0].options.sound).toBeUndefined();
      expect(os.shown[0].options.toastXml).toBeUndefined();
      posted();
      expect(t.played).toEqual([]);
    });

    it('test(category) posts a sample with the category sound, not kept in the list', () => {
      const s0 = defaultSettings('en');
      const t = setup((s) => notifs(s, { system: { ...s.notifications.system, fill: false } }));
      t.notifier.test('fill');
      t.notifier.test('order');
      t.notifier.test('other');
      posted();
      expect(os.shown.map((n) => n.options.title)).toEqual([
        'Sound sample: Fill notifications',
        'Sound sample: Order notifications',
        'Sound sample: Other notifications',
      ]);
      expect(t.played).toEqual(['Glass', 'Tink', 'Purr'].map((name) => `/System/Library/Sounds/${name}.aiff`));
      expect(t.list()).toHaveLength(0);
      t.setSettings(notifs(s0, { dnd: true }));
      t.notifier.test('fill');
      expect(os.shown).toHaveLength(3);
      expect(() => t.notifier.test('nope' as never)).toThrow('Invalid sound category');
      expect(() => t.notifier.test(null as never)).toThrow('Invalid sound category');
    });

    it('a sample is closed by the next one, and after a few seconds', () => {
      vi.useFakeTimers();
      try {
        const t = setup();
        t.notifier.test('fill');
        t.notifier.test('order');
        expect(os.shown.map((n) => n.closed)).toEqual([true, false]);
        vi.advanceTimersByTime(SAMPLE_LIFETIME_MS - 1);
        expect(os.shown[1].closed).toBe(false);
        vi.advanceTimersByTime(1);
        expect(os.shown[1].closed).toBe(true);
        // A real notification is never closed by Tape.
        t.notifier.notify({ kind: 'fill', title: text('a'), body: text('b') });
        vi.advanceTimersByTime(60_000);
        expect(os.shown[2].closed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
