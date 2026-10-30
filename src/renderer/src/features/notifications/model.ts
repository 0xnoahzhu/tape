// Pure helpers for the bell panel.

import { maskAccountIds } from '@shared/accountMask';
import { resolveTimeTokens, type Clock } from '@shared/timeFormat';
import type { NotificationView } from '@shared/ipc';
import type { AppNotification, ConnectionState, Lang, VaultState } from '@shared/types';
import type { Page } from '../../state/store';
import type { NotificationsMessages } from './messages';

export type NotificationFilter = 'all' | 'unread' | 'trade' | 'conn';
export const NOTIFICATION_FILTERS: readonly NotificationFilter[] = ['all', 'unread', 'trade', 'conn'];

export function matchesFilter(n: AppNotification, filter: NotificationFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'unread':
      return !n.read;
    case 'trade':
      return n.kind === 'fill' || n.kind === 'order';
    case 'conn':
      return n.kind === 'conn';
  }
}

/** Filtered notifications, newest first. */
export function filterNotifications(list: AppNotification[], filter: NotificationFilter): AppNotification[] {
  return list.filter((n) => matchesFilter(n, filter)).sort((a, b) => b.t - a.t);
}

/**
 * Where opening a notification leads (orders/navigation.ts → openNotificationTarget): an option
 * risk alert to the option chain, a fill to Portfolio › Trades, an order update to Portfolio ›
 * Orders; any other notification about an instrument, a cancelled or rejected order's too
 * (`orderDone`: Orders does not list it), leaves Settings for the chart, and on another page only
 * selects the instrument (null: the page stays, design nt.items open). The bell holds the shown
 * account's notices only (main/store.ts), so its orders and fills are the ones the lists show.
 */
export function notificationTarget(n: Pick<AppNotification, 'kind' | 'orderDone'>, page: Page): NotificationView | null {
  switch (n.kind) {
    case 'opt':
      return 'opt';
    case 'fill':
      return 'trades';
    case 'order':
      if (!n.orderDone) return 'orders';
      break;
  }
  return page === 'set' ? 'chart' : null;
}

/**
 * Critical notifications (an order rejected, the connection lost, an option at risk) that arrived
 * with this list update: in `next`, unread and not in `prev`. Newest first.
 */
export function newCriticalNotifications(prev: AppNotification[], next: AppNotification[]): AppNotification[] {
  const seen = new Set(prev.map((n) => n.id));
  return next.filter((n) => n.critical && !n.read && !seen.has(n.id)).sort((a, b) => b.t - a.t);
}

export function unreadCount(list: AppNotification[]): number {
  let n = 0;
  for (const x of list) if (!x.read) n++;
  return n;
}

/** "now", "5m ago", "2h ago", "3d ago" (design ago()). */
export function relativeTime(t: number, now: number, m: Pick<NotificationsMessages, 'now' | 'minutesAgo' | 'hoursAgo' | 'daysAgo'>): string {
  const minutes = Math.round((now - t) / 60_000);
  if (minutes < 1) return m.now;
  if (minutes < 60) return m.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return m.hoursAgo(hours);
  return m.daysAgo(Math.round(hours / 24));
}

/** The account ids a notice may name (shared/accountMask.ts): the login's, the shown account's, its own. */
export function knownAccountIds(s: { connection: Pick<ConnectionState, 'accounts' | 'account'>; vault: Pick<VaultState, 'account'> }, n: Pick<AppNotification, 'account'>): Array<string | null | undefined> {
  return [...s.connection.accounts, s.connection.account, s.vault.account, n.account];
}

/**
 * Title and body in a language, with their clock times (stored as tokens) in `clock`'s format.
 * `hideIds` (Settings › Privacy & Security hides account IDs: knownAccountIds) are left out, also
 * of notices stored before: a tag keeps PAPER / LIVE alone, as a notice posted now has it, and any
 * other mention reads "—". Null: shown.
 */
export function notificationText(n: Pick<AppNotification, 'title' | 'body'>, lang: Lang, clock: Clock, hideIds: Iterable<string | null | undefined> | null = null): { title: string; body: string } {
  const text = (s: string) => {
    const resolved = resolveTimeTokens(s, clock);
    return hideIds ? maskAccountIds(resolved, hideIds) : resolved;
  };
  return { title: text(n.title[lang]), body: text(n.body[lang]) };
}

/** Full date and time of a notification or alert trigger: "2026-10-05 09:41:07 AM", "2026-10-05 下午 02:35:07". */
export function stampText(t: number, clock: Clock): string {
  return clock.time(t, { date: 'ymd', seconds: true });
}
