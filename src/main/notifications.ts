// In-app notification list (persisted, shown in the bell) plus OS notifications.

import { randomUUID } from 'node:crypto';
import { Notification } from 'electron';
import type { NewNotification } from '@shared/ipc';
import { SOUND_CATEGORIES, type SoundCategory } from '@shared/notificationSounds';
import { createClock, resolveTimeTokens } from '@shared/timeFormat';
import type { AppNotification, NotificationKind } from '@shared/types';
import type { MainContext, Notifier } from './context';
import { iconImage, iconPath } from './appearance';
import { createMessages } from './i18n';
import {
  createNotification,
  markNotificationsRead,
  prependNotification,
  sanitizeNewNotification,
  shouldShowSystem,
  viewForKind,
} from './notificationModel';
import { notificationSound, soundFile, soundOptions } from './notificationSound';
import { createSoundPlayer, type SoundPlayer } from './soundPlayer';
import { showAndEmit } from './showAndEmit';

const m = createMessages({
  en: {
    testTitle: 'Test notification',
    testBody: 'If a system notification appeared, everything is set up.',
    sampleTitle: {
      order: 'Sound sample: Order notifications',
      fill: 'Sound sample: Fill notifications',
      other: 'Sound sample: Other notifications',
    },
    sampleBody: 'This is how these notifications sound.',
    // While Tape is locked the OS notification says only what happened, never the symbol, side,
    // quantity or price: it shows on the screen of a computer left alone. The bell keeps the text.
    locked: {
      fill: 'New fill',
      order: 'Order update',
      rejected: 'Order rejected',
      attention: 'Order needs attention',
      price: 'Alert triggered',
      opt: 'Option risk alert',
      conn: 'Connection update',
      lost: 'Connection to IB lost',
      sys: '1 new notification',
    },
    lockedBody: 'Tape is locked. Unlock it to see the details.',
  },
  zh: {
    testTitle: '测试通知',
    testBody: '如果你看到了系统通知，说明配置正确。',
    sampleTitle: { order: '提示音试听：下单通知', fill: '提示音试听：成交通知', other: '提示音试听：其他通知' },
    sampleBody: '这类通知的提示音就是这样。',
    locked: {
      fill: '新成交',
      order: '订单更新',
      rejected: '订单被拒',
      attention: '订单需要处理',
      price: '提醒已触发',
      opt: '期权风险提醒',
      conn: '连接状态变化',
      lost: '与 IB 的连接已中断',
      sys: '1 条新通知',
    },
    lockedBody: 'Tape 已锁定，解锁后查看详情。',
  },
});

type LockedText = keyof ReturnType<typeof m>['locked'];

/**
 * The generic title of a notification shown while Tape is locked. A critical order notice is a
 * rejection when the order is done (orders.ts marks both), otherwise a cancel or modify IB refused,
 * or an order left unconfirmed by a closing connection: the order is still there, so it needs a look.
 */
function lockedTitle(item: AppNotification): LockedText {
  if (item.kind === 'order' && item.critical) return item.orderDone ? 'rejected' : 'attention';
  if (item.kind === 'conn' && item.critical) return 'lost';
  return item.kind;
}

/** OS notifications kept alive so their click handlers survive garbage collection. */
const MAX_LIVE = 50;

/** The kind a sound sample of each category is posted as. */
const SAMPLE_KIND: Record<SoundCategory, NotificationKind> = { order: 'order', fill: 'fill', other: 'sys' };

/** A sound sample is removed from Notification Center / Action Center after this long. */
export const SAMPLE_LIFETIME_MS = 6000;

/** `platform` is process.platform (tests pass another one, and a fake player). */
export function createNotifier(ctx: MainContext, platform: string = process.platform, player: SoundPlayer = createSoundPlayer()): Notifier {
  const live = new Set<Notification>();
  /** The sound sample still shown, closed when the next one is posted. */
  let sample: { os: Notification; timer: ReturnType<typeof setTimeout> } | null = null;

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

  function showSystem(item: AppNotification): Notification | null {
    if (!Notification.isSupported()) return null;
    const settings = ctx.store.getSettings();
    const lang = settings.appearance.language;
    // Clock times in the stored texts follow the time format set now.
    const clock = createClock(settings.appearance.timeFormat, lang);
    // macOS always shows the app icon; elsewhere pass the theme-matched one.
    const dark = ctx.appearance.isDark();
    const icon = platform === 'darwin' ? null : iconImage(dark, 'window');
    const locked = ctx.lock.isLocked();
    const title = locked ? m(lang).locked[lockedTitle(item)] : resolveTimeTokens(item.title[lang], clock);
    const body = locked ? m(lang).lockedBody : resolveTimeTokens(item.body[lang], clock);
    const sound = notificationSound(settings, item.kind, platform);
    const file = soundFile(platform, sound);
    const os = new Notification({
      id: item.id,
      groupId: item.kind,
      title,
      body,
      ...(icon ? { icon } : {}),
      // silent (macOS: Tape plays the sound on 'show'), toastXml with the same title, body and icon (Windows).
      ...soundOptions(platform, sound, { title, body, iconPath: platform === 'win32' ? iconPath(dark, 'window') : null }),
    });
    const release = () => live.delete(os);
    os.on('click', () => {
      release();
      // Behind the lock the click only shows the window (the OS text was generic): the notice stays
      // unread in the bell.
      if (!ctx.lock.isLocked()) markRead([item.id]);
      // Orders and Trades list the connected login's accounts: another account's notice opens the chart.
      const otherAccount = !!item.account && !ctx.ib.getState().accounts.includes(item.account);
      if (item.contract) showAndEmit(ctx, { type: 'openContract', contract: item.contract, view: viewForKind(item.kind, item.orderDone, otherAccount) });
      else ctx.showMainWindow();
    });
    os.on('close', release);
    os.on('failed', (_event, error) => {
      release();
      console.warn('[notifications] OS notification failed:', error);
    });
    // Posted (not 'failed', e.g. notifications not allowed): the sound goes with it.
    if (file) os.once('show', () => player.play(file));
    live.add(os);
    if (live.size > MAX_LIVE) live.delete(live.values().next().value!);
    os.show();
    return os;
  }

  /** Removes the sound sample from the OS notification list (so it is not taken for a real event later). */
  function closeSample(): void {
    if (!sample) return;
    clearTimeout(sample.timer);
    sample.os.close();
    sample = null;
  }

  return {
    notify(raw) {
      const n = sanitizeNewNotification(raw);
      if (!n) throw new Error('Invalid notification');
      const item = add(n);
      if (shouldShowSystem(ctx.store.getSettings(), item.kind, false, item.critical)) showSystem(item);
      return item;
    },
    markRead(ids) {
      if (ids !== 'all' && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) return;
      markRead(ids);
    },
    test(category) {
      if (category === undefined) {
        const item = add({ kind: 'sys', title: m.both((t) => t.testTitle), body: m.both((t) => t.testBody) });
        // The test always tries the OS notification (unless do-not-disturb), even if 'sys' is off.
        if (shouldShowSystem(ctx.store.getSettings(), item.kind, true)) showSystem(item);
        return;
      }
      if (!SOUND_CATEGORIES.includes(category)) throw new Error('Invalid sound category');
      // A sound sample: shown like the test (do-not-disturb wins), but not kept in the list.
      const kind = SAMPLE_KIND[category];
      if (!shouldShowSystem(ctx.store.getSettings(), kind, true)) return;
      const text = { kind, title: m.both((t) => t.sampleTitle[category]), body: m.both((t) => t.sampleBody) };
      closeSample();
      const os = showSystem(createNotification(text, randomUUID(), Date.now()));
      if (!os) return;
      const timer = setTimeout(() => {
        if (sample?.os === os) closeSample();
      }, SAMPLE_LIFETIME_MS);
      sample = { os, timer };
    },
  };
}
