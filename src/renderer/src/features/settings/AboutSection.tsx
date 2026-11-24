// Settings › About: Tape's version and its own updates (main/updater.ts): Automatic updates (download
// a new version by itself; it always checks), what the last check found, Check Now, Download (a new
// version found with automatic updates off) and Restart to Update once one has downloaded.

import type { UpdateState } from '@shared/types';
import { useClock } from '../../i18n';
import { useStore } from '../../state/store';
import { Button } from '../../ui/primitives';
import { checkForUpdates, confirmInstallUpdate, downloadUpdate, releaseUrl } from '../update/actions';
import { useUpdateMessages } from '../update/messages';
import { useSettingsMessages } from './messages';
import { LabelBlock, saveSettings, SectionHeader, SettingToggle, SubHeader } from './parts';

const rowStyle = { minHeight: 60, padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)' } as const;

export function AboutSection() {
  const sm = useSettingsMessages();
  const m = useUpdateMessages();
  const clock = useClock();
  const version = useStore((s) => s.appVersion);
  const update = useStore((s) => s.update);
  const auto = useStore((s) => s.settings.updates.auto);

  const statusText = (u: UpdateState): string => {
    const when = (t: number | null) => (t == null ? m.notChecked : m.checkedAt(clock.time(t, { date: 'md' })));
    switch (u.status) {
      case 'off':
        return m.off;
      case 'idle':
        return u.checkedAt == null ? m.notChecked : `${m.upToDate} ${when(u.checkedAt)}`;
      case 'checking':
        return m.checking;
      case 'available':
        return m.available(u.version);
      case 'downloading':
        return m.downloading(u.version, u.percent);
      case 'ready':
        return m.ready(u.version);
      case 'error':
        return `${m.failed(u.message)} ${when(u.checkedAt)}`;
    }
  };

  const openNotes = (v: string) => void window.tape.openExternal(releaseUrl(v)).catch(() => undefined);

  return (
    <>
      <SectionHeader title={sm.nav.about} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={rowStyle}>
          <LabelBlock label={m.version} />
          <div className="selectable" style={{ font: '500 14px/1 var(--num)' }}>
            {version}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 20 }}>
        <SubHeader title={m.updates} desc={update.status === 'off' ? undefined : m.updatesDesc} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: -14 }}>
        {update.status !== 'off' && <SettingToggle label={m.auto} desc={m.autoDesc} on={auto} onToggle={() => saveSettings({ updates: { auto: !auto } })} height={60} />}
        <div data-setting="update-status" style={rowStyle}>
          <div
            role="status"
            className="selectable"
            style={{ fontSize: 13, color: update.status === 'error' ? 'var(--r)' : 'var(--mu)', lineHeight: 1.6, textWrap: 'pretty', minWidth: 0 }}
          >
            {statusText(update)}
          </div>
          {update.status === 'ready' ? (
            <Button height={36} onClick={confirmInstallUpdate} style={{ flexShrink: 0 }}>
              {m.restart}
            </Button>
          ) : update.status === 'available' ? (
            <Button height={36} onClick={downloadUpdate} style={{ flexShrink: 0 }}>
              {m.download}
            </Button>
          ) : update.status !== 'off' ? (
            <Button kind="secondary" height={36} disabled={update.status === 'checking' || update.status === 'downloading'} onClick={checkForUpdates} style={{ flexShrink: 0 }}>
              {m.checkNow}
            </Button>
          ) : null}
        </div>
        {(update.status === 'ready' || update.status === 'available') && (
          <a
            href={releaseUrl(update.version)}
            onClick={(e) => {
              e.preventDefault();
              openNotes(update.version);
            }}
            style={{ paddingTop: 12, fontSize: 13, color: 'var(--ac)', textDecoration: 'none', alignSelf: 'flex-start', cursor: 'pointer' }}
          >
            {m.releaseNotes}
          </a>
        )}
      </div>
    </>
  );
}
