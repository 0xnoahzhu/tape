import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { createClock, NEW_YORK_ZONE, TOKEN_CLOCK } from '@shared/timeFormat';
import type { AppNotification, NotificationKind } from '@shared/types';
import { useNotificationsMessages } from './messages';
import { alertInstrumentParts, filterNotifications, notificationTarget, notificationText, relativeTime, stampText, unreadCount } from './model';

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

describe('notificationTarget', () => {
  it('opens fills in Portfolio › Trades, order updates in › Orders and option alerts in the chain, from any page', () => {
    for (const page of ['acct', 'trade', 'set'] as const) {
      expect(notificationTarget({ kind: 'fill' }, page, ['DU1'])).toBe('trades');
      expect(notificationTarget({ kind: 'order' }, page, ['DU1'])).toBe('orders');
      expect(notificationTarget({ kind: 'opt' }, page, ['DU1'])).toBe('opt');
    }
  });

  it('leaves Settings for the chart, and otherwise only selects the instrument', () => {
    expect(notificationTarget({ kind: 'price' }, 'set', ['DU1'])).toBe('chart');
    expect(notificationTarget({ kind: 'price' }, 'acct', ['DU1'])).toBeNull();
    expect(notificationTarget({ kind: 'price' }, 'trade', ['DU1'])).toBeNull();
    expect(notificationTarget({ kind: 'sys' }, 'trade', ['DU1'])).toBeNull();
  });

  it('opens Orders or Trades only for a notice of the connected login’s accounts', () => {
    // A paper notice after the switch to live: its order and fill are not in the live lists.
    const paperFill = { kind: 'fill' as const, account: 'DUP899854' };
    const paperOrder = { kind: 'order' as const, account: 'DUP899854' };
    expect(notificationTarget(paperFill, 'acct', ['U18630011'])).toBeNull();
    expect(notificationTarget(paperOrder, 'trade', ['U18630011'])).toBeNull();
    expect(notificationTarget(paperOrder, 'set', ['U18630011'])).toBe('chart');
    // Back on paper, or another account of the same login: listed.
    expect(notificationTarget(paperFill, 'acct', ['DUP899854'])).toBe('trades');
    expect(notificationTarget(paperOrder, 'acct', ['U1', 'DUP899854'])).toBe('orders');
    // The option chain is no account's list.
    expect(notificationTarget({ kind: 'opt', account: 'DUP899854' }, 'acct', ['U18630011'])).toBe('opt');
  });

  it('treats a cancelled or rejected order like any other notice: Orders does not list it', () => {
    expect(notificationTarget({ kind: 'order', orderDone: true }, 'set', ['DU1'])).toBe('chart');
    expect(notificationTarget({ kind: 'order', orderDone: true }, 'acct', ['DU1'])).toBeNull();
    expect(notificationTarget({ kind: 'order', orderDone: true }, 'trade', ['DU1'])).toBeNull();
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

describe('notification times', () => {
  const close = Date.UTC(2026, 9, 9, 20);
  const gtd = TOKEN_CLOCK.time(close, { timeZone: NEW_YORK_ZONE, zone: 'ET', date: 'md' });
  const stored = { title: { en: 'Buy 100 AAPL submitted', zh: '买入 100 AAPL 已提交' }, body: { en: `Limit 226.95 · GTD ${gtd} · awaiting fill`, zh: `限价 226.95 · GTD ${gtd} · 等待成交` } };

  it('shows stored clock times in the format chosen now', () => {
    expect(notificationText(stored, 'en', createClock('12h', 'en')).body).toBe('Limit 226.95 · GTD 10/09 04:00 PM ET · awaiting fill');
    expect(notificationText(stored, 'zh', createClock('12h', 'zh'))).toEqual({ title: '买入 100 AAPL 已提交', body: '限价 226.95 · GTD 10/09 下午 04:00 ET · 等待成交' });
    expect(notificationText(stored, 'en', createClock('24h', 'en')).body).toBe('Limit 226.95 · GTD 10/09 16:00 ET · awaiting fill');
  });

  it('leaves account ids out of stored notices while Settings › Privacy hides them', () => {
    const tagged = {
      title: { en: 'Buy 100 AAPL submitted · LIVE U18630011', zh: '买入 100 AAPL 已提交 · 实盘 U18630011' },
      body: { en: 'Connected to account DUP899854', zh: '已连接账户 DUP899854' },
    };
    const clock = createClock('12h', 'en');
    expect(notificationText(tagged, 'en', clock)).toEqual({ title: 'Buy 100 AAPL submitted · LIVE U18630011', body: 'Connected to account DUP899854' });
    expect(notificationText(tagged, 'en', clock, false)).toEqual({ title: 'Buy 100 AAPL submitted · LIVE', body: 'Connected to account —' });
    expect(notificationText(tagged, 'zh', clock, false)).toEqual({ title: '买入 100 AAPL 已提交 · 实盘', body: '已连接账户 —' });
  });

  it('keeps texts stored before tokens existed as they are', () => {
    const old = { title: { en: 'a', zh: 'a' }, body: { en: 'GTD 10/09 16:00 ET', zh: 'GTD 10/09 16:00 ET' } };
    expect(notificationText(old, 'en', createClock('12h', 'en')).body).toBe('GTD 10/09 16:00 ET');
  });

  it('stamps the full date and time', () => {
    const t = new Date(2026, 9, 5, 9, 41, 7).getTime();
    expect(stampText(t, createClock('12h', 'en'))).toBe('2026-10-05 09:41:07 AM');
    expect(stampText(t, createClock('12h', 'zh'))).toBe('2026-10-05 上午 09:41:07');
    expect(stampText(t, createClock('24h', 'zh'))).toBe('2026-10-05 09:41:07');
  });
});
