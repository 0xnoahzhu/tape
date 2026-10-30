// Pure helpers for the notification list (no Electron), used by notifications.ts.

import type { NewNotification, NotificationView } from '@shared/ipc';
import { NOTIFICATION_KINDS } from '@shared/defaults';
import { dndActive } from '@shared/dnd';
import type { AppNotification, NotificationKind, Settings } from '@shared/types';
import { CRITICAL_KINDS, capNotifications, isObject, sanitizeContract, sanitizeLocalizedText, sanitizeNoticeAccount } from './storeSchema';

/** Validates a notification request (it may come from the renderer). Returns null when invalid. */
export function sanitizeNewNotification(raw: unknown): NewNotification | null {
  if (!isObject(raw) || !NOTIFICATION_KINDS.includes(raw.kind as NotificationKind)) return null;
  const title = sanitizeLocalizedText(raw.title);
  const body = sanitizeLocalizedText(raw.body);
  if (!title || !body) return null;
  const n: NewNotification = { kind: raw.kind as NotificationKind, title, body };
  const contract = raw.contract === undefined ? null : sanitizeContract(raw.contract);
  if (contract) n.contract = contract;
  if (raw.orderDone === true && n.kind === 'order') n.orderDone = true;
  // A price alert or a system notice is never critical, whoever asks (the renderer can).
  if (raw.critical === true && CRITICAL_KINDS.includes(n.kind)) n.critical = true;
  const account = sanitizeNoticeAccount(raw.account, n.kind);
  if (account) n.account = account;
  return n;
}

export function createNotification(n: NewNotification, id: string, t: number): AppNotification {
  const item: AppNotification = { id, t, kind: n.kind, title: n.title, body: n.body, read: false };
  if (n.contract) item.contract = n.contract;
  if (n.orderDone) item.orderDone = true;
  if (n.critical) item.critical = true;
  if (n.account) item.account = n.account;
  return item;
}

/** Newest first, capped. */
export function prependNotification(list: AppNotification[], item: AppNotification): AppNotification[] {
  return capNotifications([item, ...list]);
}

/** Returns the same array when nothing changed, so callers can skip persisting. */
export function markNotificationsRead(list: AppNotification[], ids: string[] | 'all'): AppNotification[] {
  const wanted = ids === 'all' ? null : new Set(ids);
  let changed = false;
  const next = list.map((n) => {
    if (n.read || (wanted && !wanted.has(n.id))) return n;
    changed = true;
    return { ...n, read: true };
  });
  return changed ? next : list;
}

/**
 * Whether an OS notification should be shown. Do-not-disturb holds back everything but a
 * `critical` notification (an order rejected, the connection to IB lost, an option at risk), the
 * test and the sound samples included; the per-kind rule applies to every real notification, a
 * critical one too (turning a kind off is asked for in Settings). `force` (the test notification)
 * ignores the per-kind rule.
 */
export function shouldShowSystem(settings: Settings, kind: NotificationKind, force = false, critical = false, now: number = Date.now()): boolean {
  const n = settings.notifications;
  return (critical || !dndActive(n, now)) && (force || n.system[kind]);
}

/**
 * Where a click on a notification about an instrument leads: an option risk alert to the option
 * chain, a fill to Portfolio › Trades, an order update to Portfolio › Orders (a cancelled or
 * rejected order, `orderDone`, is not listed there: the chart), anything else to the chart. Only
 * the account the data folder serves has its notices shown (store.ts), so its orders and fills are
 * the ones Orders and Trades list.
 */
export function viewForKind(kind: NotificationKind, orderDone = false): NotificationView {
  switch (kind) {
    case 'opt':
      return 'opt';
    case 'fill':
      return 'trades';
    case 'order':
      return orderDone ? 'chart' : 'orders';
    default:
      return 'chart';
  }
}
