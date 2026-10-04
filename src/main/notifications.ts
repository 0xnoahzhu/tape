// In-app notification list (persisted, shown in the bell) plus OS notifications.

import { randomUUID } from 'node:crypto';
import { Notification } from 'electron';
import type { NewNotification } from '@shared/ipc';
import { createClock, resolveTimeTokens } from '@shared/timeFormat';
import type { AppNotification } from '@shared/types';
import type { MainContext, Notifier } from './context';
import { iconImage } from './appearance';
import { createMessages } from './i18n';
import {
  createNotification,
  markNotificationsRead,
  prependNotification,
  sanitizeNewNotification,
  shouldShowSystem,
  viewForKind,
} from './notificationModel';
import { showAndEmit } from './showAndEmit';

const m = createMessages({
  en: {
    testTitle: 'Test notification',
    testBody: 'If a system notification appeared, everything is set up.',
  },
  zh: {
    testTitle: '测试通知',
    testBody: '如果你看到了系统通知，说明配置正确。',
  },
});

/** OS notifications kept alive so their click handlers survive garbage collection. */
const MAX_LIVE = 50;

export function createNotifier(ctx: MainContext): Notifier {
  const live = new Set<Notification>();

  function publish(list: AppNotification[]): void {
    ctx.store.setNotifications(list);
    ctx.emit({ type: 'notifications', notifications: ctx.store.getNotifications() });
  }

  function add(n: NewNotification): AppNotification {
    const item = createNotification(n, randomUUID(), Date.now());
    publish(prependNotification(ctx.store.getNotifications(), item));
    return item;
  }

  function markRead(ids: string[] | 'all'): void {
    const list = ctx.store.getNotifications();
    const next = markNotificationsRead(list, ids);
    if (next !== list) publish(next);
  }

  function showSystem(item: AppNotification): void {
    if (!Notification.isSupported()) return;
    const settings = ctx.store.getSettings();
    const lang = settings.appearance.language;
    // Clock times in the stored texts follow the time format set now.
    const clock = createClock(settings.appearance.timeFormat, lang);
    // macOS always shows the app icon; elsewhere pass the theme-matched one.
    const icon = process.platform === 'darwin' ? null : iconImage(ctx.appearance.isDark(), 'window');
    const os = new Notification({
      id: item.id,
      groupId: item.kind,
      title: resolveTimeTokens(item.title[lang], clock),
      body: resolveTimeTokens(item.body[lang], clock),
      silent: !settings.notifications.sound,
      ...(icon ? { icon } : {}),
    });
    const release = () => live.delete(os);
    os.on('click', () => {
      release();
      markRead([item.id]);
      if (item.contract) showAndEmit(ctx, { type: 'openContract', contract: item.contract, view: viewForKind(item.kind) });
      else ctx.showMainWindow();
    });
    os.on('close', release);
    os.on('failed', (_event, error) => {
      release();
      console.warn('[notifications] OS notification failed:', error);
    });
    live.add(os);
    if (live.size > MAX_LIVE) live.delete(live.values().next().value!);
    os.show();
  }

  return {
    notify(raw) {
      const n = sanitizeNewNotification(raw);
      if (!n) throw new Error('Invalid notification');
      const item = add(n);
      if (shouldShowSystem(ctx.store.getSettings(), item.kind)) showSystem(item);
      return item;
    },
    markRead(ids) {
      if (ids !== 'all' && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) return;
      markRead(ids);
    },
    test() {
      const item = add({ kind: 'sys', title: m.both((t) => t.testTitle), body: m.both((t) => t.testBody) });
      // The test always tries the OS notification (unless do-not-disturb), even if 'sys' is off.
      if (shouldShowSystem(ctx.store.getSettings(), item.kind, true)) showSystem(item);
    },
  };
}
