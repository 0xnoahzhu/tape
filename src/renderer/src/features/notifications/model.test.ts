import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { AppNotification, NotificationKind } from '@shared/types';
import { useNotificationsMessages } from './messages';
import { alertInstrumentParts, filterNotifications, opensTradePage, relativeTime, unreadCount } from './model';

const n = (id: string, kind: NotificationKind, t: number, read = false): AppNotification => ({
  id,
  t,
  kind,
  read,
  title: { en: id, zh: id },
  body: { en: '', zh: '' },
});

const list = [n('fill', 'fill', 5), n('order', 'order', 1, true), n('price', 'price', 4), n('conn', 'conn', 3, true), n('opt', 'opt', 2)];

describe('filterNotifications', () => {
  it('filters by tab and sorts newest first', () => {
    expect(filterNotifications(list, 'all').map((x) => x.id)).toEqual(['fill', 'price', 'conn', 'opt', 'order']);
    expect(filterNotifications(list, 'unread').map((x) => x.id)).toEqual(['fill', 'price', 'opt']);
    expect(filterNotifications(list, 'trade').map((x) => x.id)).toEqual(['fill', 'order']);
    expect(filterNotifications(list, 'conn').map((x) => x.id)).toEqual(['conn']);
  });

  it('counts unread', () => {
    expect(unreadCount(list)).toBe(3);
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000;
  const en = useNotificationsMessages.for('en');
  const zh = useNotificationsMessages.for('zh');

  it('matches the design wording', () => {
    expect(relativeTime(now - 20_000, now, en)).toBe('now');
    expect(relativeTime(now - 5 * 60_000, now, en)).toBe('5m ago');
    expect(relativeTime(now - 2 * 3_600_000, now, en)).toBe('2h ago');
    expect(relativeTime(now - 3 * 86_400_000, now, en)).toBe('3d ago');
    expect(relativeTime(now - 20_000, now, zh)).toBe('刚刚');
    expect(relativeTime(now - 5 * 60_000, now, zh)).toBe('5 分钟前');
    expect(relativeTime(now - 2 * 3_600_000, now, zh)).toBe('2 小时前');
  });
});

describe('opensTradePage', () => {
  it('keeps the current page except for option notifications and Settings', () => {
    expect(opensTradePage('fill', 'ord')).toBe(false);
    expect(opensTradePage('price', 'acct')).toBe(false);
    expect(opensTradePage('order', 'trade')).toBe(false);
    expect(opensTradePage('fill', 'set')).toBe(true);
    expect(opensTradePage('opt', 'ord')).toBe(true);
  });
});

describe('alertInstrumentParts', () => {
  it('moves option details to the sub line and keeps other labels whole', () => {
    expect(alertInstrumentParts(option('AAPL', '20261016', 230, 'C'))).toEqual({ symbol: 'AAPL', detail: '10/16 230 Call' });
    expect(alertInstrumentParts(stock('AAPL'))).toEqual({ symbol: 'AAPL', detail: '' });
    expect(alertInstrumentParts({ symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' })).toEqual({ symbol: 'EUR.USD', detail: '' });
    expect(alertInstrumentParts({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', localSymbol: 'ESZ6', lastTradeDate: '20261218' })).toEqual({
      symbol: 'ESZ6',
      detail: '',
    });
  });
});
