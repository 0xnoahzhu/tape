import { describe, expect, it } from 'vitest';
import { createClock, NEW_YORK_ZONE, TOKEN_CLOCK } from '@shared/timeFormat';
import type { AppNotification, NotificationKind } from '@shared/types';
import { useNotificationsMessages } from './messages';
import { filterNotifications, knownAccountIds, newCriticalNotifications, notificationTarget, notificationText, relativeTime, stampText, unreadCount } from './model';

const n = (id: string, kind: NotificationKind, t: number, read = false): AppNotification => ({
  id,
  t,
  kind,
  read,
  title: { en: id, zh: id },
  body: { en: '', zh: '' },
});

const list = [n('fill', 'fill', 5), n('order', 'order', 1, true), n('price', 'price', 4), n('conn', 'conn', 3, true), n('opt', 'opt', 2)];

describe('newCriticalNotifications', () => {
  it('finds the critical notices that just arrived, unread, newest first', () => {
    const rejected = { ...n('rejected', 'order', 10), critical: true as const };
    const lost = { ...n('lost', 'conn', 11), critical: true as const };
    const seen = { ...n('seen', 'conn', 9), critical: true as const };
    const read = { ...n('read', 'opt', 12, true), critical: true as const };
    expect(newCriticalNotifications([seen, ...list], [rejected, lost, read, seen, n('new fill', 'fill', 13), ...list]).map((x) => x.id)).toEqual(['lost', 'rejected']);
    expect(newCriticalNotifications(list, list)).toEqual([]);
  });
});

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
      expect(notificationTarget({ kind: 'fill' }, page)).toBe('trades');
      expect(notificationTarget({ kind: 'order' }, page)).toBe('orders');
      expect(notificationTarget({ kind: 'opt' }, page)).toBe('opt');
    }
  });

  it('leaves Settings for the chart, and otherwise only selects the instrument', () => {
    expect(notificationTarget({ kind: 'price' }, 'set')).toBe('chart');
    expect(notificationTarget({ kind: 'price' }, 'acct')).toBeNull();
    expect(notificationTarget({ kind: 'price' }, 'trade')).toBeNull();
    expect(notificationTarget({ kind: 'sys' }, 'trade')).toBeNull();
  });

  it('treats a cancelled or rejected order like any other notice: Orders does not list it', () => {
    expect(notificationTarget({ kind: 'order', orderDone: true }, 'set')).toBe('chart');
    expect(notificationTarget({ kind: 'order', orderDone: true }, 'acct')).toBeNull();
    expect(notificationTarget({ kind: 'order', orderDone: true }, 'trade')).toBeNull();
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

  it('leaves the known account ids out of stored notices while Settings › Privacy hides them', () => {
    const tagged = {
      title: { en: 'Buy 100 AAPL submitted · LIVE U18630011', zh: '买入 100 AAPL 已提交 · 实盘 U18630011' },
      body: { en: 'Order rejected - reason: account U18630011 is not permitted', zh: '已连接账户 U18630011' },
    };
    const clock = createClock('12h', 'en');
    const ids = knownAccountIds({ connection: { accounts: ['U18630011'], account: 'U18630011' }, vault: { account: 'U18630011' } }, {});
    expect(notificationText(tagged, 'en', clock)).toEqual({ title: 'Buy 100 AAPL submitted · LIVE U18630011', body: 'Order rejected - reason: account U18630011 is not permitted' });
    expect(notificationText(tagged, 'en', clock, ids)).toEqual({ title: 'Buy 100 AAPL submitted · LIVE', body: 'Order rejected - reason: account — is not permitted' });
    expect(notificationText(tagged, 'zh', clock, ids)).toEqual({ title: '买入 100 AAPL 已提交 · 实盘', body: '已连接账户 —' });
    // The notice's own account counts too (a sub-account of the login).
    const own = { title: { en: 'Fill · PAPER DU222', zh: '' }, body: { en: '', zh: '' } };
    expect(notificationText(own, 'en', clock, knownAccountIds({ connection: { accounts: [], account: undefined }, vault: { account: null } }, { account: 'DU222' })).title).toBe('Fill · PAPER');
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
