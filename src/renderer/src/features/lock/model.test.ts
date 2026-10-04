import { describe, expect, it } from 'vitest';
import { createClock } from '@shared/timeFormat';
import { cellLook, enteredConfirm, enteredNew, lockDate, lockTime, pinInput, pinLength, startPinFlow, unlockTimeline, verified, waitLeft } from './model';

describe('PIN entry', () => {
  it('keeps any characters, at most six code points', () => {
    expect(pinInput('12a3')).toEqual({ value: '12a3', rejected: false });
    expect(pinInput('Ab#$%^&*')).toEqual({ value: 'Ab#$%^', rejected: false });
    expect(pinInput('１２３')).toEqual({ value: '１２３', rejected: false });
    // An emoji is one character (two UTF-16 units); a paste is cut to six.
    expect(pinInput('🔑🔑🔑🔑🔑🔑🔑').value).toBe('🔑🔑🔑🔑🔑🔑');
    expect(pinLength(pinInput('a🔑b').value)).toBe(3);
    // NFC: e + combining acute is one character.
    expect(pinInput('e\u0301').value).toBe('\u00e9');
  });

  it('drops whitespace and control characters and says so', () => {
    expect(pinInput(' 9 8 ')).toEqual({ value: '98', rejected: true });
    expect(pinInput('ab\tc\u200bd\u0000')).toEqual({ value: 'abcd', rejected: true });
    expect(pinInput('abc\u3000')).toEqual({ value: 'abc', rejected: true });
  });

  it('draws the cells: dots, the next cell, errors and the success fill', () => {
    expect(cellLook(0, 2, { error: false, success: false })).toMatchObject({ dot: 'var(--tx)', border: 'var(--ln)', bg: 'var(--p)' });
    expect(cellLook(2, 2, { error: false, success: false })).toMatchObject({ dot: 'transparent', border: 'var(--ac)' });
    expect(cellLook(2, 2, { error: false, success: false, disabled: true }).border).toBe('var(--ln)');
    // Errors use the app's danger color, never the up/down colors.
    expect(cellLook(4, 0, { error: true, success: false }).border).toBe('var(--r)');
    expect(cellLook(3, 6, { error: false, success: true })).toEqual({ bg: 'var(--ac)', border: 'var(--ac)', dot: 'var(--acI)', scale: 0.6, delay: '135ms' });
  });

  it('follows the design’s unlock timings', () => {
    expect(unlockTimeline('pin', false)).toEqual({ sound: 120, out: 620, done: 1060 });
    expect(unlockTimeline('biometric', false)).toEqual({ sound: 0, out: 500, done: 940 });
    expect(unlockTimeline('pin', true).done).toBeLessThan(200);
  });
});

describe('clock and countdown', () => {
  const d = new Date(2026, 9, 4, 9, 5);
  it('formats the time and date like the design', () => {
    expect(lockTime(d, createClock('24h', 'en'))).toEqual({ time: '09:05', period: null, periodFirst: false });
    expect(lockDate(d, 'en')).toBe('Sun, Oct 4');
    expect(lockDate(d, 'zh')).toBe('10 月 4 日 星期日');
  });

  it('splits the 12-hour clock into digits and a period (after them in English, before in Chinese)', () => {
    expect(lockTime(d, createClock('12h', 'en'))).toEqual({ time: '9:05', period: 'AM', periodFirst: false });
    expect(lockTime(d, createClock('12h', 'zh'))).toEqual({ time: '9:05', period: '上午', periodFirst: true });
    expect(lockTime(new Date(2026, 9, 4, 0, 0), createClock('12h', 'en'))).toEqual({ time: '12:00', period: 'AM', periodFirst: false });
    expect(lockTime(new Date(2026, 9, 4, 12, 0), createClock('12h', 'zh'))).toEqual({ time: '12:00', period: '下午', periodFirst: true });
    expect(lockTime(new Date(2026, 9, 4, 23, 59), createClock('24h', 'zh')).time).toBe('23:59');
  });

  it('shows the remaining wait, rounded up', () => {
    expect(waitLeft(null, 0)).toBeNull();
    expect(waitLeft(1000, 1000)).toBeNull();
    expect(waitLeft(30_000, 0)).toBe('0:30');
    expect(waitLeft(30_000, 29_100)).toBe('0:01');
    expect(waitLeft(15 * 60_000, 0)).toBe('15:00');
  });
});

describe('PIN dialog flow', () => {
  it('sets a PIN: new, then confirm', () => {
    let f = startPinFlow('set');
    expect(f.step).toBe('new');
    f = enteredNew(f, '123456');
    expect(f.step).toBe('confirm');
    expect(enteredConfirm(f, '123456')).toEqual({ flow: f, save: '123456' });
  });

  it('starts over when the confirmation does not match', () => {
    const f = enteredNew(startPinFlow('set'), '123456');
    const res = enteredConfirm(f, '123457');
    expect(res.save).toBeNull();
    expect(res.flow).toMatchObject({ step: 'new', first: '', error: 'mismatch' });
  });

  it('changes a PIN after verifying the current one', () => {
    let f = startPinFlow('change');
    expect(f.step).toBe('current');
    f = verified(f, 'tok');
    expect(f).toMatchObject({ step: 'new', token: 'tok' });
    f = enteredNew(f, '654321');
    expect(enteredConfirm(f, '654321')).toMatchObject({ save: '654321', flow: { token: 'tok' } });
  });

  it('removes with the current PIN only', () => {
    expect(startPinFlow('remove').step).toBe('current');
    expect(verified(startPinFlow('remove'), 't').step).toBe('current');
  });
});
