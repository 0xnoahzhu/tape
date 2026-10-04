// Settings › Notifications: which kinds are pushed to the OS, sound, do-not-disturb, test.

import { NOTIFICATION_KINDS } from '@shared/defaults';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import { useSettingsMessages } from './messages';
import { LabelBlock, SectionHeader, SettingToggle, saveSettings } from './parts';

export function NotificationsSection() {
  const m = useSettingsMessages();
  const n = useStore((s) => s.settings.notifications);
  const showToast = useStore((s) => s.showToast);

  const test = () => window.tape.testNotification().catch((err: unknown) => showToast(errorText(err), 'error'));

  return (
    <>
      <SectionHeader title={m.nav.notif} desc={m.notifDesc} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {NOTIFICATION_KINDS.map((kind) => (
          <div
            key={kind}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) 34px',
              gap: 12,
              height: 56,
              alignItems: 'center',
              boxShadow: 'inset 0 -1px 0 var(--ln2)',
            }}
          >
            <LabelBlock label={m.rules[kind].l} desc={m.rules[kind].d} />
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Toggle on={n.system[kind]} onClick={() => saveSettings({ notifications: { system: { [kind]: !n.system[kind] } } })} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <SettingToggle height={56} label={m.sound} desc={m.soundD} on={n.sound} onToggle={() => saveSettings({ notifications: { sound: !n.sound } })} />
        <SettingToggle height={56} label={m.dnd} desc={m.dndD} on={n.dnd} onToggle={() => saveSettings({ notifications: { dnd: !n.dnd } })} />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div
          onClick={() => void test()}
          className="hover-p2"
          style={{
            height: 36,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            fontSize: 13,
            cursor: 'pointer',
            boxShadow: 'inset 0 0 0 1px var(--ln)',
            color: 'var(--tx)',
          }}
        >
          {m.test}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.testD}</div>
      </div>
    </>
  );
}
