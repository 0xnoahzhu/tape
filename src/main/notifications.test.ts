import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { TapeEvent } from '@shared/ipc';
import type { AppNotification, Settings } from '@shared/types';
import type { MainContext } from './context';

const os = vi.hoisted(() => ({ supported: true, shown: [] as Array<{ options: Record<string, unknown>; emitter: EventEmitter }> }));
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
      os.shown.push({ options: this.options, emitter: this });
    }
  }
  return { Notification };
});
vi.mock('./appearance', () => ({ iconImage: () => null }));

const { createNotifier } = await import('./notifications');

const aapl = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' } as const;
const text = (s: string) => ({ en: s, zh: `${s} (zh)` });

function setup(patch: (s: Settings) => Settings = (s) => s) {
  let settings = patch(defaultSettings('en'));
  let list: AppNotification[] = [];
  const events: TapeEvent[] = [];
  const showMainWindow = vi.fn();
  const win = { webContents: { isLoading: () => false, once: vi.fn() } };
  const lock = { locked: false };
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
    notifier: createNotifier(ctx),
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
    expect(os.shown[0].options).toMatchObject({ id: n.id, title: 'Filled (zh)', body: '100 AAPL (zh)', silent: false });
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
});
