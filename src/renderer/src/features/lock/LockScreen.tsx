// The lock screen (design "lk.on"): covers the whole window above every dialog, popover and toast.
// Main decides whether Tape is locked and checks the PIN / biometrics; this only draws the state
// and plays the unlock animation (cells fill, then the screen fades and lifts).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import type { UnlockResult } from '@shared/types';
import { useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { FingerprintIcon, LogoMark } from '../../ui/icons';
import { clack } from './clack';
import { useLockMessages } from './messages';
import { lockDate, lockTime, pinLength, PIN_LENGTH, unlockTimeline, waitLeft, type UnlockVia } from './model';
import { PinCells } from './PinCells';
import { ResetDialog } from './ResetDialog';

type Phase = 'idle' | 'checking' | 'ok' | 'out';

const motionQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const subscribeMotion = (cb: () => void) => {
  motionQuery?.addEventListener('change', cb);
  return () => motionQuery?.removeEventListener('change', cb);
};

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => motionQuery?.matches ?? false);
}

/** Focuses the lock screen's PIN input (the key guard calls this for keys typed elsewhere). */
export function focusLockInput(): void {
  // Not while the Forgot-PIN dialog is open over it.
  if (document.querySelector('[data-lock-root] [data-reset-dialog]')) return;
  document.querySelector<HTMLInputElement>('[data-lock-root] [data-pin-input]:not(:disabled)')?.focus();
}

export function LockScreen() {
  const m = useLockMessages();
  const lang = useLang();
  const lock = useStore((s) => s.lock);
  const biometricsSeen = useStore((s) => s.biometricsSeen);
  const sound = useStore((s) => s.settings.lock.sound);
  const unlockWith = useStore((s) => s.settings.lock.unlockWith);
  const mac = useStore((s) => s.platform === 'darwin');
  const setUnlocking = useStore((s) => s.setUnlocking);
  const reduced = useReducedMotion();

  const [pin, setPin] = useState('');
  /** 'checking': a PIN is being checked; 'ok' / 'out': the unlock animation. */
  const [phase, setPhaseState] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  /**
   * A Touch ID / Windows Hello prompt is open. It does not block the PIN or Forgot PIN: the Windows
   * dialog may open behind Tape or take long, and a PIN unlock closes it.
   */
  const [bioPending, setBioPendingState] = useState(false);
  const bioPendingRef = useRef(false);
  const setBioPending = (on: boolean) => {
    bioPendingRef.current = on;
    setBioPendingState(on);
  };
  const [error, setError] = useState(false);
  /** Main cannot read lock.json: no PIN is accepted until it can (or Forgot PIN resets Tape). */
  const [unreadable, setUnreadable] = useState(false);
  /** Whitespace or a control character was typed and dropped. */
  const [charHint, setCharHint] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [bioNote, setBioNote] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // The clock and the wait countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  // Touch ID availability changes with the lid and keyboard: ask main again when the screen appears
  // (only when it is the unlock method: Windows Hello's check starts a helper process).
  useEffect(() => {
    if (unlockWith === 'biometric') window.tape.getLockState().catch(() => undefined);
  }, [unlockWith]);

  const wait = waitLeft(lock.retryAt, now);
  const throttled = wait != null;
  const busy = phase !== 'idle';

  // Back from a refused wait: take the focus again.
  useEffect(() => {
    if (!throttled && !resetOpen) input.current?.focus();
  }, [throttled, resetOpen]);

  const later = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));

  const succeed = useCallback(
    (via: UnlockVia, elapsed: number) => {
      const t = unlockTimeline(via, reduced);
      later(Math.max(0, t.sound - elapsed), () => {
        if (sound) clack();
        setPhase('ok');
      });
      later(Math.max(0, t.out - elapsed), () => setPhase('out'));
      later(Math.max(0, t.done - elapsed), () => setUnlocking(false));
    },
    [reduced, sound, setUnlocking],
  );

  const failPin = (res: Exclude<UnlockResult, { ok: true }>) => {
    // A biometric prompt still open keeps the screen up for its own unlock animation.
    setUnlocking(bioPendingRef.current);
    setPhase('idle');
    setPin('');
    setError(res.reason === 'wrongPin');
    setUnreadable(res.reason === 'pinUnreadable');
    requestAnimationFrame(() => input.current?.focus());
  };

  const onPin = (value: string, rejected: boolean) => {
    if (busy || throttled) return;
    setPin(value);
    setError(false);
    setCharHint(rejected);
    setBioNote(null);
    if (pinLength(value) < PIN_LENGTH) return;
    const started = performance.now();
    setPhase('checking');
    // Keeps this screen up when main reports "unlocked" before the animation has played.
    setUnlocking(true);
    window.tape.unlockWithPin(value).then(
      (res) => (res.ok ? succeed('pin', performance.now() - started) : failPin(res)),
      () => failPin({ ok: false, reason: 'noPin' }),
    );
  };

  const onBiometric = () => {
    if (busy || bioPending) return;
    setError(false);
    setBioNote(null);
    setBioPending(true);
    // Main may report "unlocked" before this call returns: keep the screen up for the animation.
    setUnlocking(true);
    const done = (res: UnlockResult) => {
      setBioPending(false);
      // The PIN was entered meanwhile: its check (or its animation) decides.
      if (phaseRef.current !== 'idle') return;
      if (res.ok) {
        setPhase('checking');
        setPin('••••••');
        succeed('biometric', 0);
        return;
      }
      setUnlocking(false);
      const kind = lock.biometrics.kind ?? 'touchId';
      if (res.reason === 'pinUnreadable') setUnreadable(true);
      else if (res.reason === 'biometric' && res.failure === 'unavailable') setBioNote(m.bioUnavailable(kind));
      else if (res.reason === 'biometric' && res.failure !== 'busy' && res.failure !== 'canceled') setBioNote(m.bioNotVerified(kind));
      requestAnimationFrame(() => input.current?.focus());
    };
    window.tape.unlockWithBiometrics().then(done, () => done({ ok: false, reason: 'biometric', failure: 'error' }));
  };

  // Clicking anywhere (but on a control) gives the PIN input its focus back.
  const refocus = (e: MouseEvent) => {
    if (resetOpen || (e.target as Element).closest('button, input, [role="button"]')) return;
    input.current?.focus();
  };

  const kind = lock.biometrics.kind;
  const showBio = unlockWith === 'biometric' && kind != null;
  // "Not available" only where it was available before (or after a try), never while still checking:
  // a Mac without Touch ID simply shows the PIN entry.
  const passiveNote = showBio && biometricsSeen && !lock.biometrics.available && lock.biometrics.reason !== 'checking' ? m.bioUnavailable(kind) : null;
  const note = showBio && !throttled ? (bioNote ?? passiveNote) : null;
  const success = phase === 'ok' || phase === 'out';
  const out = phase === 'out';
  const date = new Date(now);

  return (
    <div
      data-lock-root=""
      className="no-drag"
      onMouseUp={refocus}
      // Keys typed here never reach the app's shortcuts (window listeners) behind the lock.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && resetOpen) setResetOpen(false);
        // Typing while a button (Forgot PIN, Touch ID) has the focus goes to the PIN; Enter and
        // Space still press the button.
        if (
          !resetOpen &&
          e.target instanceof HTMLButtonElement &&
          [...e.key].length === 1 &&
          e.key !== ' ' &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        )
          input.current?.focus();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        opacity: out ? 0 : 1,
        transition: reduced ? undefined : 'opacity .42s cubic-bezier(.4,0,.2,1)',
      }}
    >
      {/* The window can be dragged by the top strip, as by the top bar (Windows: not under the caption buttons). */}
      <div className="drag" style={{ height: 56, flexShrink: 0, marginRight: mac ? 0 : 138 }} />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
          paddingBottom: 56,
          transform: out && !reduced ? 'translateY(-18px) scale(1.03)' : 'none',
          transition: reduced ? undefined : 'transform .5s cubic-bezier(.4,0,.2,1)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
          <LogoMark size={64} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ font: '600 64px/1 var(--num)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{lockTime(date)}</div>
            <div style={{ fontSize: 14, color: 'var(--mu)' }}>{lockDate(date, lang)}</div>
          </div>
        </div>
        <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ fontSize: 13, color: 'var(--mu)' }}>{m.enterPin}</div>
            <PinCells
              inputRef={input}
              value={pin}
              onChange={onPin}
              onCapsLock={setCapsLock}
              error={error}
              success={success}
              disabled={throttled && !busy}
              autoFocus
              label={m.enterPin}
              reducedMotion={reduced}
            />
          </div>
          {throttled && !busy ? (
            <div style={{ fontSize: 12, color: 'var(--r)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{m.throttled(wait)}</div>
          ) : unreadable && !busy ? (
            <div style={{ fontSize: 12, color: 'var(--r)', textAlign: 'center', lineHeight: 1.5 }}>{m.pinUnreadable}</div>
          ) : error ? (
            <div style={{ fontSize: 12, color: 'var(--r)', textAlign: 'center' }}>{m.incorrect}</div>
          ) : capsLock && !busy ? (
            <div style={{ fontSize: 12, color: 'var(--dm)', textAlign: 'center' }}>{m.capsLock}</div>
          ) : charHint ? (
            <div style={{ fontSize: 12, color: 'var(--dm)', textAlign: 'center' }}>{m.charHint}</div>
          ) : null}
          {showBio && lock.biometrics.available && (
            <button
              type="button"
              onClick={onBiometric}
              disabled={busy || bioPending}
              className="hover-tx hover-p2"
              style={{
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: busy || bioPending ? 'default' : 'pointer',
                fontSize: 13,
                color: 'var(--mu)',
                boxShadow: 'inset 0 0 0 1px var(--ln)',
              }}
            >
              <FingerprintIcon />
              {m.unlockWith(kind)}
            </button>
          )}
          {note && <div style={{ fontSize: 12, color: 'var(--dm)', textAlign: 'center', lineHeight: 1.5 }}>{note}</div>}
          <button
            type="button"
            onClick={() => !busy && setResetOpen(true)}
            className="hover-tx"
            style={{ alignSelf: 'center', padding: '6px 8px', border: 'none', background: 'transparent', fontSize: 12, color: 'var(--dm)', cursor: 'pointer' }}
          >
            {m.forgot}
          </button>
        </div>
      </div>
      <div style={{ height: 48, flexShrink: 0 }} />
      {resetOpen && <ResetDialog onClose={() => setResetOpen(false)} />}
    </div>
  );
}
