// Set / change / remove the lock PIN. Set: new PIN, then confirm. Change: current PIN (or Touch ID /
// Windows Hello), new PIN, confirm. Remove: current PIN. Main checks the current PIN and hands out
// a single-use token for the change; the PIN never stays in the renderer after the dialog closes.

import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../state/orderActions';
import { useStore, type PinDialogRequest } from '../../state/store';
import { Button, Modal } from '../../ui/primitives';
import { FingerprintIcon } from '../../ui/icons';
import { useLockMessages } from './messages';
import { enteredConfirm, enteredNew, pinLength, PIN_LENGTH, startPinFlow, verified, waitLeft, type PinFlow } from './model';
import { PinCells } from './PinCells';

export function PinDialogHost() {
  const req = useStore((s) => s.pinDialog);
  // A new request starts a new flow.
  return req ? <PinDialog key={`${req.mode}-${String(req.lockAfter)}`} req={req} /> : null;
}

function PinDialog({ req }: { req: PinDialogRequest }) {
  const m = useLockMessages();
  const close = () => useStore.getState().setPinDialog(null);
  const showToast = useStore((s) => s.showToast);
  const lock = useStore((s) => s.lock);
  const unlockWith = useStore((s) => s.settings.lock.unlockWith);
  const [flow, setFlow] = useState<PinFlow>(() => startPinFlow(req.mode));
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [charHint, setCharHint] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);

  const wait = flow.step === 'current' ? waitLeft(lock.retryAt, now) : null;
  useEffect(() => {
    if (!lock.retryAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lock.retryAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refocus = () => requestAnimationFrame(() => input.current?.focus());
  useEffect(() => {
    if (!busy && !wait) refocus();
  }, [busy, wait, flow.step]);

  const failed = (err: unknown) => {
    setBusy(false);
    setPin('');
    showToast(m.failed(errorText(err)), 'error');
  };

  const save = async (next: string, token: string | null) => {
    const state = await window.tape.setLockPin(next, token);
    close();
    showToast(req.mode === 'set' ? m.pinSet : m.pinChanged);
    if (req.lockAfter && state.hasPin) await window.tape.lock();
  };

  const submit = async (value: string) => {
    setBusy(true);
    setNote(null);
    try {
      if (flow.step === 'current') {
        const res = await window.tape.verifyLockPin(value);
        if (!res.ok) {
          setFlow({ ...flow, error: res.reason === 'wrongPin' ? 'wrong' : null });
          if (res.reason === 'pinUnreadable') setNote(m.pinUnreadable);
        } else if (req.mode === 'remove') {
          await window.tape.removeLockPin(res.token);
          close();
          showToast(m.pinRemoved);
          return;
        } else {
          setFlow(verified(flow, res.token));
        }
      } else if (flow.step === 'new') {
        setFlow(enteredNew(flow, value));
      } else {
        const res = enteredConfirm(flow, value);
        if (res.save == null) setFlow(res.flow);
        else return void (await save(res.save, flow.token));
      }
      setBusy(false);
      setPin('');
    } catch (err) {
      failed(err);
    }
  };

  const onPin = (value: string, rejected: boolean) => {
    if (busy) return;
    setPin(value);
    setCharHint(rejected);
    if (flow.error) setFlow({ ...flow, error: null });
    if (pinLength(value) === PIN_LENGTH) void submit(value);
  };

  const verifyWithBiometrics = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await window.tape.verifyLockBiometrics();
      if (res.ok) setFlow(verified(flow, res.token));
      else if (res.reason === 'pinUnreadable') setNote(m.pinUnreadable);
      else if (res.reason === 'biometric' && res.failure === 'unavailable' && lock.biometrics.kind) setNote(m.bioUnavailable(lock.biometrics.kind));
      setBusy(false);
      setPin('');
    } catch (err) {
      failed(err);
    }
  };

  const title = req.mode === 'set' ? m.setTitle : req.mode === 'change' ? m.changeTitle : m.removeTitle;
  const step = flow.step === 'current' ? m.stepCurrent : flow.step === 'new' ? m.stepNew : m.stepConfirm;
  const kind = lock.biometrics.kind;
  const bio = req.mode === 'change' && flow.step === 'current' && unlockWith === 'biometric' && kind != null && lock.biometrics.available;
  const errorLine = wait ? m.throttled(wait) : flow.error === 'wrong' ? m.incorrect : flow.error === 'mismatch' ? m.mismatch : null;

  return (
    <Modal onClose={busy ? undefined : close} zIndex={22}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ font: '600 18px/1.2 var(--sans)' }}>{title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--mu)', textWrap: 'pretty' }}>{req.mode === 'remove' ? m.removeDesc : m.pinDesc}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '6px 0' }}>
        <div style={{ fontSize: 13, color: 'var(--mu)' }}>{step}</div>
        <PinCells inputRef={input} value={pin} onChange={onPin} onCapsLock={setCapsLock} error={flow.error === 'wrong'} disabled={!!wait} autoFocus label={step} />
        {errorLine && (
          <div style={{ fontSize: 12, color: 'var(--r)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{errorLine}</div>
        )}
        {!errorLine && (capsLock || charHint) && (
          <div style={{ fontSize: 12, color: 'var(--dm)', textAlign: 'center' }}>{capsLock ? m.capsLock : m.charHint}</div>
        )}
        {note && <div style={{ fontSize: 12, color: 'var(--dm)', textAlign: 'center' }}>{note}</div>}
      </div>
      {bio && (
        <button
          type="button"
          onClick={() => void verifyWithBiometrics()}
          disabled={busy}
          className="hover-tx hover-p2"
          style={{
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: busy ? 'default' : 'pointer',
            fontSize: 13,
            color: 'var(--mu)',
            boxShadow: 'inset 0 0 0 1px var(--ln)',
          }}
        >
          <FingerprintIcon />
          {m.useBio(kind)}
        </button>
      )}
      <Button kind="secondary" onClick={close} disabled={busy}>
        {m.cancel}
      </Button>
    </Modal>
  );
}
