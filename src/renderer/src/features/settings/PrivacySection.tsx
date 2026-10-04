// Settings › Privacy & Security: account id visibility and the lock screen (auto-lock, unlock
// method, sound, PIN). The preferences are settings; the PIN lives in main only and is set through
// the PIN dialog. Until a PIN exists the lock rows are visible but dimmed.

import { useEffect, useState } from 'react';
import type { AutoLock } from '@shared/types';
import { useStore } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import { customMinutesInput } from './logic';
import { useSettingsMessages } from './messages';
import { disabledRow, LabelBlock, OptionRow, SectionHeader, saveSettings } from './parts';

export function PrivacySection() {
  const m = useSettingsMessages();
  const showAccountId = useStore((s) => s.settings.appearance.showAccountId);
  const lock = useStore((s) => s.settings.lock);
  const state = useStore((s) => s.lock);
  const setPinDialog = useStore((s) => s.setPinDialog);
  const noPin = !state.hasPin;
  const bio = state.biometrics;

  // Availability changes with the lid, the keyboard and enrolment: ask main when the section opens.
  useEffect(() => {
    window.tape.getLockState().catch(() => undefined);
  }, []);

  return (
    <>
      <SectionHeader title={m.privacy} />
      <OptionRow<'show' | 'hide'>
        label={m.accountId}
        options={[
          { key: 'show', label: m.show },
          { key: 'hide', label: m.hide },
        ]}
        value={showAccountId ? 'show' : 'hide'}
        onChange={(k) => saveSettings({ appearance: { showAccountId: k === 'show' } })}
      />

      <div style={{ marginTop: 20 }}>
        <SectionHeader title={m.lockScreen} desc={noPin ? m.lockNoPin : undefined} />
      </div>
      <OptionRow<AutoLock>
        label={m.autoLock}
        options={[
          { key: '15', label: m.minutes(15) },
          { key: '30', label: m.minutes(30) },
          { key: '60', label: m.minutes(60) },
          { key: 'custom', label: m.custom },
          { key: 'never', label: m.never },
        ]}
        value={lock.autoLock}
        onChange={(autoLock) => saveSettings({ lock: { autoLock } })}
        disabled={noPin}
      />
      {lock.autoLock === 'custom' && <CustomDuration minutes={lock.customMinutes} disabled={noPin} />}
      {/* Linux has no biometric provider: the row is hidden. */}
      {bio.kind != null && (
        <OptionRow<'biometric' | 'pin'>
          label={m.unlockWith}
          options={[
            { key: 'biometric', label: m.bio(bio.kind), disabled: !bio.available, title: bio.available ? undefined : m.bioOff({ ...bio, kind: bio.kind }) },
            { key: 'pin', label: m.pinOnly },
          ]}
          // The method in effect: PIN only while biometrics cannot be used (the preference is kept).
          value={!bio.available && bio.reason !== 'checking' ? 'pin' : lock.unlockWith}
          onChange={(unlockWith) => saveSettings({ lock: { unlockWith } })}
          disabled={noPin}
        />
      )}
      <div
        role="switch"
        aria-checked={lock.sound}
        onClick={() => saveSettings({ lock: { sound: !lock.sound } })}
        style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: 'pointer', boxShadow: 'inset 0 -1px 0 var(--ln2)', ...disabledRow(noPin) }}
      >
        <LabelBlock label={m.unlockSound} desc={m.unlockSoundD} />
        <Toggle on={lock.sound} />
      </div>
      <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
        <LabelBlock label={m.pinL} desc={m.pinD} />
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {state.hasPin && <RowButton onClick={() => setPinDialog({ mode: 'remove' })}>{m.pinRemove}</RowButton>}
          <RowButton onClick={() => setPinDialog({ mode: state.hasPin ? 'change' : 'set' })}>{state.hasPin ? m.pinChange : m.pinSet}</RowButton>
        </div>
      </div>
    </>
  );
}

function CustomDuration({ minutes, disabled }: { minutes: number; disabled: boolean }) {
  const m = useSettingsMessages();
  const [text, setText] = useState(String(minutes));
  // Follow changes saved elsewhere (or the clamp main applied).
  useEffect(() => setText(String(minutes)), [minutes]);

  const onChange = (raw: string) => {
    const { text, minutes: n } = customMinutesInput(raw);
    setText(text);
    if (n != null && n !== minutes) void saveSettings({ lock: { customMinutes: n } });
  };

  return (
    <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)', ...disabledRow(disabled) }}>
      <LabelBlock label={m.customL} desc={m.customD} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setText(String(minutes))}
          inputMode="numeric"
          aria-label={m.customL}
          disabled={disabled}
          style={{
            width: 72,
            height: 34,
            padding: '0 10px',
            border: 'none',
            outline: 'none',
            boxShadow: 'inset 0 0 0 1px var(--ln)',
            background: 'var(--p)',
            color: 'var(--tx)',
            font: '500 14px/1 var(--num)',
            textAlign: 'right',
          }}
        />
        <div style={{ fontSize: 13, color: 'var(--mu)' }}>{m.minU}</div>
      </div>
    </div>
  );
}

/** The design's outlined row button (Change). */
function RowButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover-p2"
      style={{ padding: '7px 14px', border: 'none', background: 'transparent', fontSize: 13, lineHeight: 'normal', cursor: 'pointer', boxShadow: 'inset 0 0 0 1px var(--ln)', whiteSpace: 'nowrap' }}
    >
      {children}
    </button>
  );
}
