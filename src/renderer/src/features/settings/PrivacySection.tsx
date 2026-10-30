// Settings › Privacy & Security: account id visibility, the data folder (main/vault.ts: where the
// watchlists, alerts and notifications of each account are kept) and the lock screen (auto-lock, unlock
// method, sound, PIN). The preferences are settings; the PIN lives in main only and is set through
// the PIN dialog. Until a PIN exists the lock rows are visible but dimmed.
//
// With a PIN, a change that weakens the lock (a longer auto-lock, Never, Touch ID / Windows Hello
// where the PIN alone unlocked) asks for the current PIN first and goes to main with its token
// (updateLockSettings); main refuses it on the plain settings path (lock/settingsGuard.ts).

import { useEffect, useState } from 'react';
import { loosensLock } from '@shared/lock';
import type { AutoLock, Settings } from '@shared/types';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import { customMinutesInput } from './logic';
import { useSettingsMessages, type SettingsMessages } from './messages';
import { disabledRow, LabelBlock, OptionRow, SectionHeader, saveSettings, SubHeader } from './parts';

type LockPatch = Partial<Settings['lock']>;

/** "60 min", "90 min" (custom), "Never". */
function autoLockLabel(l: Pick<Settings['lock'], 'autoLock' | 'customMinutes'>, m: SettingsMessages): string {
  if (l.autoLock === 'never') return m.never;
  return m.minutes(l.autoLock === 'custom' ? l.customMinutes : Number(l.autoLock));
}

/**
 * Saves lock preferences. With a PIN, a change that weakens the lock first asks for the current
 * PIN (the PIN dialog's verify mode) and is sent with its token; anything else saves at once.
 */
function changeLock(patch: LockPatch, m: SettingsMessages): void {
  const s = useStore.getState();
  const cur = s.settings.lock;
  const next = { ...cur, ...patch };
  if (!s.lock.hasPin || !loosensLock(cur, next)) return void saveSettings({ lock: patch });
  const kind = s.lock.biometrics.kind;
  const detail =
    next.unlockWith !== cur.unlockWith && kind
      ? m.loosenUnlock(m.bio(kind))
      : m.loosenAutoLock(autoLockLabel(cur, m), autoLockLabel(next, m));
  s.setPinDialog({
    mode: 'verify',
    detail,
    onVerified: (token) =>
      window.tape.updateLockSettings(patch, token).then(
        () => undefined,
        (err: unknown) => useStore.getState().showToast(errorText(err), 'error'),
      ),
  });
}

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
      <DataFolder />

      <div style={{ marginTop: 20 }}>
        {/* What the lock does not do (README › Lock screen): IB Gateway stays logged in. */}
        <SectionHeader title={m.lockScreen} desc={noPin ? m.lockNoPin : m.lockScope} />
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
        onChange={(autoLock) => changeLock({ autoLock }, m)}
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
          onChange={(unlockWith) => changeLock({ unlockWith }, m)}
          disabled={noPin}
        />
      )}
      <div
        role="switch"
        aria-checked={lock.sound}
        onClick={() => saveSettings({ lock: { sound: !lock.sound } })}
        style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: 'pointer', boxShadow: 'inset 0 -1px 0 var(--ln2)', ...disabledRow(noPin) }}
      >
        <LabelBlock label={m.lockSound} desc={m.lockSoundD} />
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

/**
 * Where the data folder is, the account it serves (its id hidden like everywhere else) and why it
 * cannot be used; buttons to open it, move the data elsewhere or switch to another folder.
 */
function DataFolder() {
  const m = useSettingsMessages();
  const vault = useStore((s) => s.vault);
  const showAccountId = useStore((s) => s.settings.appearance.showAccountId);
  const showToast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  const change = (how: 'open' | 'move') => {
    if (busy) return;
    setBusy(true);
    window.tape
      .setVaultFolder(how)
      .then(
        (next) => next && showToast(m.vaultChanged),
        (err: unknown) => showToast(errorText(err), 'error'),
      )
      .finally(() => setBusy(false));
  };
  const reveal = () => window.tape.revealVaultFolder().catch((err: unknown) => showToast(errorText(err), 'error'));

  const problem = vault.status === 'unavailable' ? m.vaultUnavailable : vault.status === 'newer' ? m.vaultNewer : null;
  const account = vault.account ? m.vaultAccount(showAccountId ? vault.account : '—') : m.vaultNoAccount;

  return (
    <div style={{ marginTop: 20 }}>
      <SubHeader title={m.vaultTitle} desc={m.vaultDesc} />
      <div style={{ padding: '4px 0 14px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div className="ellipsis" title={vault.path ?? undefined} style={{ font: '13px/1.3 var(--num)' }}>
            {vault.path}
          </div>
          <div style={{ fontSize: 12, color: problem ? 'var(--r)' : 'var(--dm)' }}>{problem ?? account}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', opacity: busy ? 0.5 : 1 }}>
          {vault.status === 'ok' && <RowButton onClick={reveal}>{m.vaultReveal}</RowButton>}
          {vault.status === 'ok' && (
            <RowButton onClick={() => change('move')} title={m.vaultMoveTip}>
              {m.vaultMove}
            </RowButton>
          )}
          <RowButton onClick={() => change('open')} title={m.vaultSwitchTip}>
            {m.vaultSwitch}
          </RowButton>
        </div>
      </div>
    </div>
  );
}

/**
 * The custom auto-lock minutes. Saved on Enter or when the field is left, not per keystroke: typed
 * on the way to "120", "1" and "12" would each be saved, and a longer time asks for the PIN.
 */
function CustomDuration({ minutes, disabled }: { minutes: number; disabled: boolean }) {
  const m = useSettingsMessages();
  const [text, setText] = useState(String(minutes));
  // Follow changes saved elsewhere (or the clamp main applied).
  useEffect(() => setText(String(minutes)), [minutes]);

  const commit = () => {
    const n = customMinutesInput(text).minutes;
    // Shows the saved value until a change is saved (or the PIN dialog is dismissed).
    setText(String(minutes));
    if (n != null && n !== minutes) changeLock({ customMinutes: n }, m);
  };

  return (
    <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)', ...disabledRow(disabled) }}>
      <LabelBlock label={m.customL} desc={m.customD} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(customMinutesInput(e.target.value).text)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') setText(String(minutes));
          }}
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
function RowButton({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="hover-p2"
      style={{ padding: '7px 14px', border: 'none', background: 'transparent', fontSize: 13, lineHeight: 'normal', cursor: 'pointer', boxShadow: 'inset 0 0 0 1px var(--ln)', whiteSpace: 'nowrap' }}
    >
      {children}
    </button>
  );
}
