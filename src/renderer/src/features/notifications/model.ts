// Pure helpers for the bell panel.

import { contractLabel } from '@shared/contract';
import type { AppNotification, ContractRef, NotificationKind } from '@shared/types';
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
 * Whether opening a notification's instrument switches to the Trade page (design nt.items open):
 * option notifications open the option chain and Settings gives way; any other page stays.
 */
export function opensTradePage(kind: NotificationKind, page: Page): boolean {
  return kind === 'opt' || page === 'set';
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
