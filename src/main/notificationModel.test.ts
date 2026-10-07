import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { AppNotification } from '@shared/types';
import {
  createNotification,
  markNotificationsRead,
  prependNotification,
  sanitizeNewNotification,
  shouldShowSystem,
  viewForKind,
} from './notificationModel';
import { MAX_NOTIFICATIONS } from './storeSchema';

const text = { en: 'Hello', zh: 'Hello (zh)' };
const aapl = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' } as const;

describe('sanitizeNewNotification', () => {
  it('accepts a valid request', () => {
    expect(sanitizeNewNotification({ kind: 'fill', title: text, body: text, contract: aapl })).toEqual({ kind: 'fill', title: text, body: text, contract: aapl });
  });

  it('rejects unknown kinds and malformed text', () => {
    expect(sanitizeNewNotification({ kind: 'spam', title: text, body: text })).toBeNull();
    expect(sanitizeNewNotification({ kind: 'sys', title: 'Hello', body: text })).toBeNull();
    expect(sanitizeNewNotification(undefined)).toBeNull();
  });

  it('keeps a finished order’s mark on order notices only', () => {
    expect(sanitizeNewNotification({ kind: 'order', title: text, body: text, orderDone: true })).toEqual({ kind: 'order', title: text, body: text, orderDone: true });
    expect(sanitizeNewNotification({ kind: 'fill', title: text, body: text, orderDone: true })).toEqual({ kind: 'fill', title: text, body: text });
    expect(sanitizeNewNotification({ kind: 'order', title: text, body: text, orderDone: 1 })).toEqual({ kind: 'order', title: text, body: text });
    expect(createNotification({ kind: 'order', title: text, body: text, orderDone: true }, 'id', 1).orderDone).toBe(true);
  });

  it('drops an invalid contract but keeps the notification', () => {
    expect(sanitizeNewNotification({ kind: 'sys', title: text, body: text, contract: { symbol: 1 } })).toEqual({ kind: 'sys', title: text, body: text });
  });
});

describe('notification list', () => {
  const item = (i: number, read = false): AppNotification => ({ ...createNotification({ kind: 'order', title: text, body: text }, `n${i}`, i), read });

  it('creates unread notifications', () => {
    expect(createNotification({ kind: 'price', title: text, body: text, contract: aapl }, 'id', 42)).toEqual({
      id: 'id',
      t: 42,
      kind: 'price',
      title: text,
      body: text,
      contract: aapl,
      read: false,
    });
  });

  it('prepends and caps', () => {
    const full = Array.from({ length: MAX_NOTIFICATIONS }, (_, i) => item(MAX_NOTIFICATIONS - i));
    const next = prependNotification(full, item(1000));
    expect(next).toHaveLength(MAX_NOTIFICATIONS);
    expect(next[0].id).toBe('n1000');
    expect(next[next.length - 1].id).toBe('n2');
  });

  it('marks selected or all notifications read', () => {
    const list = [item(3), item(2), item(1, true)];
    const some = markNotificationsRead(list, ['n2']);
    expect(some.map((n) => n.read)).toEqual([false, true, true]);
    expect(markNotificationsRead(list, 'all').every((n) => n.read)).toBe(true);
  });

  it('returns the same array when nothing changes', () => {
    const list = [item(1, true), item(2)];
    expect(markNotificationsRead(list, ['n1', 'missing'])).toBe(list);
    const allRead = [item(1, true)];
    expect(markNotificationsRead(allRead, 'all')).toBe(allRead);
  });
});

describe('shouldShowSystem', () => {
  const base = defaultSettings();
  const withRules = (patch: Partial<typeof base.notifications>) => ({ ...base, notifications: { ...base.notifications, ...patch } });

  it('follows the per-kind rule', () => {
    expect(shouldShowSystem(base, 'fill')).toBe(true);
    expect(shouldShowSystem(withRules({ system: { ...base.notifications.system, fill: false } }), 'fill')).toBe(false);
  });

  it('do-not-disturb always wins, even for the forced test', () => {
    expect(shouldShowSystem(withRules({ dnd: true }), 'fill')).toBe(false);
    expect(shouldShowSystem(withRules({ dnd: true }), 'sys', true)).toBe(false);
  });

  it('the test notification ignores a disabled rule', () => {
    expect(shouldShowSystem(withRules({ system: { ...base.notifications.system, sys: false } }), 'sys', true)).toBe(true);
  });

  it('opens the option chain for option alerts, Portfolio › Trades for fills, › Orders for order updates, else the chart', () => {
    expect(viewForKind('opt')).toBe('opt');
    expect(viewForKind('fill')).toBe('trades');
    expect(viewForKind('order')).toBe('orders');
    // A cancelled or rejected order is not on Portfolio › Orders.
    expect(viewForKind('order', true)).toBe('chart');
    expect(viewForKind('price')).toBe('chart');
    expect(viewForKind('conn')).toBe('chart');
  });
});
