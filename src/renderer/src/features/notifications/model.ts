// Pure helpers for the bell panel.

import { contractLabel } from '@shared/contract';
import { resolveTimeTokens, type Clock } from '@shared/timeFormat';
import type { NotificationView } from '@shared/ipc';
import type { AppNotification, ContractRef, Lang } from '@shared/types';
import { maskAccounts } from '../../lib/account';
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
 * selects the instrument (null: the page stays, design nt.items open). So does a fill or order
 * notice of an account the connected login does not manage (`accounts`; an earlier session's, paper
 * or live): Orders and Trades list the connected login's, so its order or fill is not there.
 */
export function notificationTarget(n: Pick<AppNotification, 'kind' | 'orderDone' | 'account'>, page: Page, accounts: readonly string[]): NotificationView | null {
  const listed = !n.account || accounts.includes(n.account);
  switch (n.kind) {
    case 'opt':
      return 'opt';
    case 'fill':
      if (listed) return 'trades';
      break;
    case 'order':
      if (!n.orderDone && listed) return 'orders';
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

/** The id of an account tag in a notice's title ("PAPER DUP899854", "实盘 U18630011"): orders.ts, riskWatcher.ts. */
const TAGGED_ID_RE = /(PAPER|LIVE|模拟|实盘) (?:D[A-Z]{1,2}|U|F)\d{5,}\b/g;

/**
 * Title and body in a language, with their clock times (stored as tokens) in `clock`'s format. While
 * Settings › Privacy hides account IDs (`showAccountId` false) they are left out of notices stored
 * before: a tag keeps PAPER / LIVE alone, as a notice posted now has it, and any other id reads "—".
 */
export function notificationText(n: Pick<AppNotification, 'title' | 'body'>, lang: Lang, clock: Clock, showAccountId = true): { title: string; body: string } {
  const text = (s: string) => {
    const resolved = resolveTimeTokens(s, clock);
    return showAccountId ? resolved : maskAccounts(resolved.replace(TAGGED_ID_RE, '$1'), false);
  };
  return { title: text(n.title[lang]), body: text(n.body[lang]) };
}

/** Full date and time of a notification or alert trigger: "2026-10-05 09:41:07 AM", "2026-10-05 下午 02:35:07". */
export function stampText(t: number, clock: Clock): string {
  return clock.time(t, { date: 'ymd', seconds: true });
}

/**
 * A price alert's instrument split for the bell list: options keep the symbol in the narrow
 * column and move "10/16 230 Call" to the sub line; anything else shows its full label
 * ("AAPL", "EUR.USD", "ESZ6") in the column and no detail.
 */
export function alertInstrumentParts(c: ContractRef): { symbol: string; detail: string } {
  const label = contractLabel(c);
  if (c.secType !== 'OPT' && c.secType !== 'FOP') return { symbol: label, detail: '' };
  return { symbol: c.symbol, detail: label.slice(c.symbol.length).trim() };
}
