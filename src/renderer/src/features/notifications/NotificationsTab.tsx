// Bell panel › Notifications: filter chips and the list (newest first).

import { useEffect, useMemo, useState } from 'react';
import type { AppNotification } from '@shared/types';
import { useClock, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { knownName, openNotificationTarget } from '../orders/navigation';
import { useNotificationsMessages } from './messages';
import { filterNotifications, NOTIFICATION_FILTERS, notificationTarget, notificationText, relativeTime, stampText, type NotificationFilter } from './model';

// The panel unmounts when closed; keep the filter for the session like the design does.
let lastFilter: NotificationFilter = 'all';

/** Current time, refreshed every `ms` so relative times stay correct. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Marks the notification read, closes the panel and opens where it leads (model.ts →
 * notificationTarget), else selects its instrument, if any.
 */
function openNotification(n: AppNotification): void {
  if (!n.read) window.tape.markNotificationsRead([n.id]).catch(() => undefined);
  const s = useStore.getState();
  s.setBell(false);
  if (!n.contract) return;
  const target = notificationTarget(n, s.page);
  if (target) openNotificationTarget(n.contract, target);
  else s.selectSymbol(n.contract, knownName(n.contract));
}

export function NotificationsTab() {
  const m = useNotificationsMessages();
  const lang = useLang();
  const clock = useClock();
  const all = useStore((s) => s.notifications);
  const [filter, setFilter] = useState<NotificationFilter>(lastFilter);
  const items = useMemo(() => filterNotifications(all, filter), [all, filter]);
  const now = useNow(30_000);

  const pick = (f: NotificationFilter) => {
    lastFilter = f;
    setFilter(f);
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 4, padding: '10px 18px', flexShrink: 0 }}>
        {NOTIFICATION_FILTERS.map((f) => (
          <div
            key={f}
            onClick={() => pick(f)}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              cursor: 'pointer',
              boxShadow: `inset 0 0 0 1px ${filter === f ? 'var(--ac)' : 'var(--ln)'}`,
              color: filter === f ? 'var(--tx)' : 'var(--mu)',
            }}
          >
            {m.filters[f]}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {items.length === 0 && <div style={{ padding: '32px 18px', textAlign: 'center', fontSize: 13, color: 'var(--dm)' }}>{m.empty}</div>}
        {items.map((n) => {
          const text = notificationText(n, lang, clock);
          return (
          <div
            key={n.id}
            onClick={() => openNotification(n)}
            style={{
              display: 'flex',
              gap: 12,
              padding: '12px 18px',
              cursor: 'pointer',
              boxShadow: 'inset 0 1px 0 var(--ln2)',
              background: n.read ? 'transparent' : 'var(--sel)',
            }}
          >
            <div style={{ width: 7, height: 7, marginTop: 6, flexShrink: 0, background: n.read ? 'transparent' : 'var(--ac)' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <div style={{ fontSize: 13, fontWeight: n.read ? 400 : 600 }}>{text.title}</div>
                <div style={{ flex: 1 }} />
                <div title={stampText(n.t, clock)} style={{ font: '11px/1 var(--num)', color: 'var(--dm)', whiteSpace: 'nowrap' }}>
                  {relativeTime(n.t, now, m)}
                </div>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--mu)', overflowWrap: 'anywhere' }}>
                {text.body}
              </div>
              <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.kinds[n.kind] ?? n.kind}</div>
            </div>
          </div>
          );
        })}
      </div>
    </>
  );
}
