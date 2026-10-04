// Bell panel (design "nt"): risk / price alerts and the notification list.
// Rendered at the window root; a transparent overlay closes it on any outside click.

import { useEffect } from 'react';
import { errorText } from '../../state/orderActions';
import { useStore, type BellTab } from '../../state/store';
import { TabItems } from '../../ui/primitives';
import { AlertsTab } from './AlertsTab';
import { useNotificationsMessages } from './messages';
import { unreadCount } from './model';
import { NotificationsTab } from './NotificationsTab';

export function NotificationsPanel() {
  const open = useStore((s) => s.bellOpen);
  return open ? <Panel /> : null;
}

function markAllRead(): void {
  window.tape.markNotificationsRead('all').catch((err: unknown) => useStore.getState().showToast(errorText(err), 'error'));
}

function Panel() {
  const m = useNotificationsMessages();
  const tab = useStore((s) => s.bellTab);
  const setBell = useStore((s) => s.setBell);
  const openSettings = useStore((s) => s.openSettings);
  const unread = useStore((s) => unreadCount(s.notifications));

  // Escape closes the panel unless a dialog above it (confirm, order review, alert form) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useStore.getState();
      if (s.confirm || s.pendingOrder || s.alertForm) return;
      s.setBell(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div className="no-drag" onClick={() => setBell(false)} style={{ position: 'absolute', inset: 0, zIndex: 15 }} />
      <div
        style={{
          position: 'absolute',
          top: 60,
          right: 14,
          zIndex: 16,
          width: 392,
          maxHeight: 560,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--p)',
          boxShadow: '0 0 0 1px var(--ln),0 16px 48px rgba(0,0,0,.22)',
          animation: 'tape-fade-in .12s ease-out',
        }}
      >
        <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px', boxShadow: 'inset 0 -1px 0 var(--ln2)', flexShrink: 0 }}>
          <div style={{ fontWeight: 600 }}>{m.title}</div>
          <div style={{ flex: 1 }} />
          <div onClick={markAllRead} style={{ fontSize: 12, color: 'var(--ac)', cursor: 'pointer' }}>
            {m.markAll}
          </div>
          <div onClick={() => openSettings('notif')} className="hover-tx" style={{ fontSize: 12, color: 'var(--dm)', cursor: 'pointer' }}>
            {m.settings}
          </div>
        </div>
        <div style={{ height: 44, display: 'flex', alignItems: 'stretch', gap: 22, padding: '0 18px', boxShadow: 'inset 0 -1px 0 var(--ln2)', flexShrink: 0 }}>
          <TabItems<BellTab>
            tabs={[
              { key: 'alerts', label: m.tabAlerts },
              { key: 'notifs', label: m.tabNotifs, count: unread ? String(unread) : '' },
            ]}
            value={tab}
            onChange={(k) => setBell(true, k)}
            itemStyle={{ fontSize: 13 }}
          />
        </div>
        {tab === 'alerts' ? <AlertsTab /> : <NotificationsTab />}
      </div>
    </>
  );
}
