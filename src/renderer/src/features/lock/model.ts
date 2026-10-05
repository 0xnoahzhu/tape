// Pure logic of the lock screen and the PIN dialogs (unit tested).

import type { Clock } from '@shared/timeFormat';
import type { Lang } from '@shared/types';

// The PIN rule is shared with main (any six characters but whitespace and control characters).
export { PIN_LENGTH, pinInput, pinLength } from '@shared/lock';

export interface LockClock {
  /** Two digits in both formats: "08", "12", "23". */
  hours: string;
  minutes: string;
  /** "AM" / "PM" / "上午" / "下午", set smaller beside the digits; null in the 24-hour format. */
  period: string | null;
  /** The period goes before the hours (Chinese), else after the minutes. */
  periodFirst: boolean;
}

/**
 * The large clock "08:37", split at the colon so the screen can put the colon on the centre line
 * (hours right of it, minutes left of it). The hour always has two digits, also on the 12-hour clock.
 */
export function lockTime(d: Date, clock: Clock): LockClock {
  const p = clock.parts(d);
  const [hours = '', minutes = ''] = p.time.split(':');
  return { hours: hours.padStart(2, '0'), minutes, period: p.period, periodFirst: p.periodFirst };
}

const WEEKDAYS: Record<Lang, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  zh: ['日', '一', '二', '三', '四', '五', '六'],
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** en "Sun, Oct 4", zh "10 月 4 日 星期日". */
export function lockDate(d: Date, lang: Lang): string {
  return lang === 'zh'
    ? `${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${WEEKDAYS.zh[d.getDay()]}`
    : `${WEEKDAYS.en[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Remaining wait as "m:ss" (rounded up, so it never shows 0:00 while still waiting), or null when over. */
export function waitLeft(retryAt: number | null, now: number): string | null {
  if (retryAt == null || retryAt <= now) return null;
  const s = Math.ceil((retryAt - now) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Unlock animation (design: cells fill with a 45 ms stagger, then the screen fades and lifts)

export type UnlockVia = 'pin' | 'biometric';

/** Milliseconds after the unlock was confirmed: sound, fade-out start, overlay gone. */
export function unlockTimeline(via: UnlockVia, reducedMotion: boolean): { sound: number; out: number; done: number } {
  if (reducedMotion) return { sound: 0, out: 0, done: 150 };
  return via === 'pin' ? { sound: 120, out: 620, done: 1060 } : { sound: 0, out: 500, done: 940 };
}

export interface CellLook {
  bg: string;
  border: string;
  dot: string;
  scale: number;
  delay: string;
}

/** One of the six cells: filled dots, the next cell's accent ring, red rings on error, accent fill on success. */
export function cellLook(index: number, length: number, state: { error: boolean; success: boolean; disabled?: boolean }): CellLook {
  if (state.success) return { bg: 'var(--ac)', border: 'var(--ac)', dot: 'var(--acI)', scale: 0.6, delay: `${index * 45}ms` };
  return {
    bg: 'var(--p)',
    border: state.error ? 'var(--r)' : index === length && !state.disabled ? 'var(--ac)' : 'var(--ln)',
    dot: index < length ? 'var(--tx)' : 'transparent',
    scale: 1,
    delay: '0ms',
  };
}

// ---------------------------------------------------------------------------
// Set / change / remove PIN dialog

export type PinDialogMode = 'set' | 'change' | 'remove';
export type PinStep = 'current' | 'new' | 'confirm';

export interface PinFlow {
  mode: PinDialogMode;
  step: PinStep;
  /** The new PIN entered in the 'new' step, waiting for its confirmation. */
  first: string;
  /** Token from verifying the current PIN (or biometrics), for change and remove. */
  token: string | null;
  error: 'wrong' | 'mismatch' | null;
}

export function startPinFlow(mode: PinDialogMode): PinFlow {
  return { mode, step: mode === 'set' ? 'new' : 'current', first: '', token: null, error: null };
}

/** The current PIN (or biometrics) was verified: remove is ready, change asks for the new PIN. */
export function verified(flow: PinFlow, token: string): PinFlow {
  return { ...flow, token, step: flow.mode === 'remove' ? 'current' : 'new', error: null };
}

export function enteredNew(flow: PinFlow, pin: string): PinFlow {
  return { ...flow, step: 'confirm', first: pin, error: null };
}

/** The confirmation matches the new PIN: save it. Otherwise start the new PIN over. */
export function enteredConfirm(flow: PinFlow, pin: string): { flow: PinFlow; save: string | null } {
  if (pin === flow.first) return { flow, save: pin };
  return { flow: { ...flow, step: 'new', first: '', error: 'mismatch' }, save: null };
}
