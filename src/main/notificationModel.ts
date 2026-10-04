// Pure helpers for the notification list (no Electron), used by notifications.ts.

import type { NewNotification } from '@shared/ipc';
import { NOTIFICATION_KINDS } from '@shared/defaults';
import type { AppNotification, NotificationKind, Settings } from '@shared/types';
import { capNotifications, isObject, sanitizeContract, sanitizeLocalizedText } from './storeSchema';

/** Validates a notification request (it may come from the renderer). Returns null when invalid. */
export function sanitizeNewNotification(raw: unknown): NewNotification | null {
  if (!isObject(raw) || !NOTIFICATION_KINDS.includes(raw.kind as NotificationKind)) return null;
  const title = sanitizeLocalizedText(raw.title);
  const body = sanitizeLocalizedText(raw.body);
  if (!title || !body) return null;
  const n: NewNotification = { kind: raw.kind as NotificationKind, title, body };
  const contract = raw.contract === undefined ? null : sanitizeContract(raw.contract);
  if (contract) n.contract = contract;
  return n;
}

export function createNotification(n: NewNotification, id: string, t: number): AppNotification {
  const item: AppNotification = { id, t, kind: n.kind, title: n.title, body: n.body, read: false };
  if (n.contract) item.contract = n.contract;
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
 * Whether an OS notification should be shown. Do-not-disturb always wins; `force`
 * (the test notification) ignores the per-kind rule.
 */
export function shouldShowSystem(settings: Settings, kind: NotificationKind, force = false): boolean {
  const { dnd, system } = settings.notifications;
  return !dnd && (force || system[kind]);
}

/** The view opened when a notification about an instrument is clicked. */
export function viewForKind(kind: NotificationKind): 'opt' | 'chart' {
  return kind === 'opt' ? 'opt' : 'chart';
}
