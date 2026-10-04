import { describe, expect, it } from 'vitest';
import {
  CLOCK_24H,
  clockParts,
  clockText,
  createClock,
  DEFAULT_TIME_FORMAT,
  isTimeFormat,
  NEW_YORK_ZONE,
  parseTypedTime,
  readWallTime,
  resolveTimeTokens,
  timeColumn,
  TOKEN_CLOCK,
} from './timeFormat';

const h12en = createClock('12h', 'en');
const h12zh = createClock('12h', 'zh');
const h24en = createClock('24h', 'en');
const h24zh = createClock('24h', 'zh');
const ET = { timeZone: NEW_YORK_ZONE, zone: 'ET' };

describe('clockText', () => {
  it('writes 12-hour English without a leading zero on the hour', () => {
    expect(clockText({ h: 9, m: 41 }, '12h', 'en')).toBe('9:41 AM');
    expect(clockText({ h: 9, m: 41, s: 7 }, '12h', 'en', true)).toBe('9:41:07 AM');
    expect(clockText({ h: 14, m: 35 }, '12h', 'en')).toBe('2:35 PM');
    expect(clockText({ h: 23, m: 59, s: 59 }, '12h', 'en', true)).toBe('11:59:59 PM');
  });

  it('writes 12-hour Chinese with the period first', () => {
    expect(clockText({ h: 9, m: 41 }, '12h', 'zh')).toBe('上午 9:41');
    expect(clockText({ h: 14, m: 35 }, '12h', 'zh')).toBe('下午 2:35');
    expect(clockText({ h: 14, m: 35, s: 7 }, '12h', 'zh', true)).toBe('下午 2:35:07');
  });

  it('reads midnight as 12 AM / 上午 12 and noon as 12 PM / 下午 12', () => {
    expect(clockText({ h: 0, m: 0 }, '12h', 'en')).toBe('12:00 AM');
    expect(clockText({ h: 0, m: 5 }, '12h', 'zh')).toBe('上午 12:05');
    expect(clockText({ h: 12, m: 0 }, '12h', 'en')).toBe('12:00 PM');
    expect(clockText({ h: 12, m: 30 }, '12h', 'zh')).toBe('下午 12:30');
    expect(clockText({ h: 11, m: 59 }, '12h', 'zh')).toBe('上午 11:59');
  });

  it('writes 24-hour time with two-digit hours in both languages', () => {
    expect(clockText({ h: 9, m: 41 }, '24h', 'en')).toBe('09:41');
    expect(clockText({ h: 9, m: 41 }, '24h', 'zh')).toBe('09:41');
    expect(clockText({ h: 14, m: 35, s: 7 }, '24h', 'zh', true)).toBe('14:35:07');
    expect(clockText({ h: 0, m: 0 }, '24h', 'en')).toBe('00:00');
  });

  it('splits the period for the lock screen', () => {
    expect(clockParts({ h: 21, m: 5 }, '12h', 'en')).toEqual({ time: '9:05', period: 'PM', periodFirst: false });
    expect(clockParts({ h: 9, m: 5 }, '12h', 'zh')).toEqual({ time: '9:05', period: '上午', periodFirst: true });
    expect(clockParts({ h: 9, m: 5 }, '24h', 'zh')).toEqual({ time: '09:05', period: null, periodFirst: false });
  });
});

describe('createClock', () => {
  it('formats instants in the local zone by default', () => {
    const t = new Date(2026, 9, 5, 14, 35, 7);
    expect(h12en.time(t)).toBe('2:35 PM');
    expect(h12en.time(t.getTime(), { seconds: true })).toBe('2:35:07 PM');
    expect(h12zh.time(t)).toBe('下午 2:35');
    expect(h24zh.time(t, { seconds: true })).toBe('14:35:07');
    expect(h12en.time(t, { date: 'ymd', seconds: true })).toBe('2026-10-05 2:35:07 PM');
    expect(h12en.parts(t)).toEqual({ time: '2:35', period: 'PM', periodFirst: false });
  });

  it('formats instants in a time zone with a zone suffix and a date', () => {
    // 2026-10-09 20:00 UTC = 16:00 EDT.
    const close = Date.UTC(2026, 9, 9, 20);
    expect(h12en.time(close, ET)).toBe('4:00 PM ET');
    expect(h12en.time(close, { ...ET, date: 'md' })).toBe('10/09 4:00 PM ET');
    expect(h12zh.time(close, { ...ET, date: 'md' })).toBe('10/09 下午 4:00 ET');
    expect(h24en.time(close, { ...ET, date: 'md' })).toBe('10/09 16:00 ET');
    expect(h12en.time(close, { timeZone: 'Asia/Shanghai' })).toBe('4:00 AM');
    expect(h12en.time(close, { timeZone: 'UTC', zone: 'UTC' })).toBe('8:00 PM UTC');
  });

  it('follows daylight saving time', () => {
    // 2026-03-08: New York springs forward from 02:00 EST to 03:00 EDT.
    expect(h12en.time(Date.UTC(2026, 2, 8, 6, 59), ET)).toBe('1:59 AM ET');
    expect(h12en.time(Date.UTC(2026, 2, 8, 7, 0), ET)).toBe('3:00 AM ET');
    // 2026-11-01: 01:30 happens twice (EDT, then EST).
    expect(h12en.time(Date.UTC(2026, 10, 1, 5, 30), ET)).toBe('1:30 AM ET');
    expect(h12en.time(Date.UTC(2026, 10, 1, 6, 30), ET)).toBe('1:30 AM ET');
    // The same UTC time reads an hour apart in summer and winter.
    expect(h24en.time(Date.UTC(2026, 6, 1, 13, 30), ET)).toBe('09:30 ET');
    expect(h24en.time(Date.UTC(2026, 11, 1, 13, 30), ET)).toBe('08:30 ET');
    // Midnight in New York, the date moves with the zone.
    expect(h12zh.time(Date.UTC(2026, 9, 6, 4), { ...ET, date: 'md' })).toBe('10/06 上午 12:00 ET');
  });

  it('rewrites 24-hour wall times and ranges', () => {
    expect(h12en.wall('16:00')).toBe('4:00 PM');
    expect(h12en.wall('09:35', { zone: 'ET' })).toBe('9:35 AM ET');
    expect(h12zh.wall('9:35', { zone: 'ET' })).toBe('上午 9:35 ET');
    expect(h12en.wall('16:00:05')).toBe('4:00:05 PM');
    expect(h24en.wall('9:35')).toBe('09:35');
    expect(h12en.wall('soon')).toBe('soon');
    expect(h12en.wall('24:00')).toBe('24:00');
    expect(h12en.range('09:30', '16:00')).toBe('9:30 AM–4:00 PM');
    expect(h12en.range('04:00', '09:30')).toBe('4:00–9:30 AM');
    expect(h12zh.range('16:00', '20:00')).toBe('下午 4:00–8:00');
    expect(h12zh.range('20:00', '03:50')).toBe('下午 8:00–上午 3:50');
    expect(h24zh.range('09:30', '16:00')).toBe('09:30–16:00');
  });

  it('caches one clock per format and language', () => {
    expect(createClock('12h', 'en')).toBe(h12en);
    expect(CLOCK_24H.format).toBe('24h');
    expect(DEFAULT_TIME_FORMAT).toBe('12h');
    expect(isTimeFormat('24h')).toBe(true);
    expect(isTimeFormat('12')).toBe(false);
  });
});

describe('readWallTime', () => {
  it('reads 24-hour wall times only', () => {
    expect(readWallTime('9:35')).toEqual({ h: 9, m: 35, s: undefined });
    expect(readWallTime('23:59:59')).toEqual({ h: 23, m: 59, s: 59 });
    expect(readWallTime('24:00')).toBeNull();
    expect(readWallTime('9:60')).toBeNull();
    expect(readWallTime('9:35 PM')).toBeNull();
  });
});

describe('parseTypedTime', () => {
  it('reads 24-hour times', () => {
    expect(parseTypedTime('09:35', '24h')).toBe('09:35');
    expect(parseTypedTime('9:35', '24h')).toBe('09:35');
    expect(parseTypedTime(' 21:35 ', '24h')).toBe('21:35');
    expect(parseTypedTime('0:00', '24h')).toBe('00:00');
    expect(parseTypedTime('9：35', '24h')).toBe('09:35');
  });

  it('reads 12-hour times in English and Chinese', () => {
    expect(parseTypedTime('9:35 AM', '24h')).toBe('09:35');
    expect(parseTypedTime('9:35pm', '24h')).toBe('21:35');
    expect(parseTypedTime('9:35 p.m.', '24h')).toBe('21:35');
    expect(parseTypedTime('9:35 P.M', '24h')).toBe('21:35');
    expect(parseTypedTime('9 AM', '24h')).toBe('09:00');
    expect(parseTypedTime('上午 9:35', '24h')).toBe('09:35');
    expect(parseTypedTime('下午2:35', '24h')).toBe('14:35');
    expect(parseTypedTime('2:35 下午', '24h')).toBe('14:35');
    expect(parseTypedTime('下午 3', '24h')).toBe('15:00');
  });

  it('reads midnight and noon', () => {
    expect(parseTypedTime('12:00 AM', '24h')).toBe('00:00');
    expect(parseTypedTime('12:30 am', '24h')).toBe('00:30');
    expect(parseTypedTime('12:00 PM', '24h')).toBe('12:00');
    expect(parseTypedTime('上午 12:00', '24h')).toBe('00:00');
    expect(parseTypedTime('下午 12:15', '24h')).toBe('12:15');
  });

  it('in the 12-hour format, does not guess the period of an hour typed without a leading zero', () => {
    expect(parseTypedTime('3:55', '12h')).toBeNull();
    expect(parseTypedTime('1:30', '12h')).toBeNull();
    expect(parseTypedTime('10:15', '12h')).toBeNull();
    expect(parseTypedTime('11:59', '12h')).toBeNull();
    expect(parseTypedTime('3：55', '12h')).toBeNull();
    // Unambiguous: a leading zero, midnight hour 0, noon hour 12, afternoon hours, or a period.
    expect(parseTypedTime('03:55', '12h')).toBe('03:55');
    expect(parseTypedTime('00:15', '12h')).toBe('00:15');
    expect(parseTypedTime('0:15', '12h')).toBe('00:15');
    expect(parseTypedTime('12:30', '12h')).toBe('12:30');
    expect(parseTypedTime('15:55', '12h')).toBe('15:55');
    expect(parseTypedTime('23:59', '12h')).toBe('23:59');
    expect(parseTypedTime('3:55 PM', '12h')).toBe('15:55');
    expect(parseTypedTime('下午 3:55', '12h')).toBe('15:55');
    expect(parseTypedTime('3 pm', '12h')).toBe('15:00');
    // The 24-hour format reads it as typed.
    expect(parseTypedTime('3:55', '24h')).toBe('03:55');
  });

  it('rejects what is not a time', () => {
    for (const s of ['', '9', '935', '9.30', '25:00', '9:60', '13:00 PM', '0:30 AM', '9:35 XM', 'AM', '9:35 AM PM', '1:2']) for (const f of ['12h', '24h'] as const) expect(parseTypedTime(s, f), s).toBeNull();
  });
});

describe('timeColumn', () => {
  it('leaves room for the widest 12-hour reading', () => {
    expect(timeColumn(h12zh)).toBe('112px');
    expect(timeColumn(h12en)).toBe('112px');
    expect(timeColumn(h24en)).toBe('90px');
  });
});

describe('time tokens', () => {
  const close = Date.UTC(2026, 9, 9, 20);

  it('stores New York times with a date as tokens and resolves them in any format', () => {
    const text = `GTD ${TOKEN_CLOCK.time(close, { ...ET, date: 'md' })} ET-free`;
    expect(text).toBe(`GTD ⟦t:${close}:de⟧ ET-free`);
    expect(resolveTimeTokens(text, h12en)).toBe('GTD 10/09 4:00 PM ET ET-free');
    expect(resolveTimeTokens(text, h12zh)).toBe('GTD 10/09 下午 4:00 ET ET-free');
    expect(resolveTimeTokens(text, h24zh)).toBe('GTD 10/09 16:00 ET ET-free');
  });

  it('keeps seconds and the local zone', () => {
    const t = new Date(2026, 9, 5, 14, 35, 7).getTime();
    const token = TOKEN_CLOCK.time(t, { seconds: true });
    expect(resolveTimeTokens(`at ${token}`, h12en)).toBe('at 2:35:07 PM');
    expect(resolveTimeTokens(`${token} / ${token}`, h24en)).toBe('14:35:07 / 14:35:07');
  });

  it('writes out what a token cannot carry, and leaves other text alone', () => {
    expect(TOKEN_CLOCK.time(close, { timeZone: 'Asia/Shanghai' })).toBe('04:00');
    expect(TOKEN_CLOCK.time(close, { ...ET, date: 'ymd' })).toBe('2026-10-09 16:00 ET');
    expect(TOKEN_CLOCK.wall('16:00')).toBe('16:00');
    expect(resolveTimeTokens('Limit 226.95 · DAY', h12en)).toBe('Limit 226.95 · DAY');
    expect(resolveTimeTokens('⟦t:abc:e⟧', h12en)).toBe('⟦t:abc:e⟧');
  });
});
