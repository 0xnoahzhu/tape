import { describe, expect, it } from 'vitest';
import { nyDayStart, tradingDay, usEquitySession, usStockSession, usWeekClosed } from './session';

// November 2026 is EST (UTC−5).
const et = (day: number, hhmm: string) => new Date(`2026-11-${day}T${hhmm}:00-05:00`);

describe('usEquitySession', () => {
  it('follows the standard schedule without trading hours', () => {
    expect(usEquitySession(et(24, '03:59'))).toBe('closed');
    expect(usEquitySession(et(24, '04:00'))).toBe('pre');
    expect(usEquitySession(et(24, '09:30'))).toBe('regular');
    expect(usEquitySession(et(24, '15:59'))).toBe('regular');
    expect(usEquitySession(et(24, '16:00'))).toBe('post');
    expect(usEquitySession(et(24, '20:00'))).toBe('closed');
    expect(usEquitySession(et(28, '12:00'))).toBe('closed'); // Saturday
  });

  it('is closed on a holiday', () => {
    expect(usEquitySession(et(26, '12:00'), '20261126:CLOSED;20261127:0930-20261127:1300')).toBe('closed');
  });

  it('ends the regular session early on a half day', () => {
    const hours = '20261126:CLOSED;20261127:0930-20261127:1300;20261130:0930-20261130:1600';
    expect(usEquitySession(et(27, '12:59'), hours)).toBe('regular');
    expect(usEquitySession(et(27, '13:00'), hours)).toBe('post');
    expect(usEquitySession(et(27, '14:00'), hours)).toBe('post');
    expect(usEquitySession(et(27, '17:00'), hours)).toBe('closed');
    expect(usEquitySession(et(30, '15:00'), hours)).toBe('regular');
    expect(usEquitySession(et(30, '19:00'), hours)).toBe('post');
  });

  it('accepts the older format without a date on the end time', () => {
    expect(usEquitySession(et(27, '14:00'), '20261127:0930-1300;20261130:0930-1600')).toBe('post');
  });
});

describe('nyDayStart', () => {
  it('is New York midnight of the current New York day', () => {
    const midnight = et(24, '00:00').getTime();
    expect(nyDayStart(et(24, '09:41').getTime() + 7_123)).toBe(midnight);
    expect(nyDayStart(et(24, '23:59').getTime())).toBe(midnight);
    expect(nyDayStart(midnight)).toBe(midnight);
    // 11 PM in New York is already the next day in UTC+8.
    expect(nyDayStart(new Date('2026-11-25T12:30:00+08:00').getTime())).toBe(midnight);
  });
});

describe('usStockSession', () => {
  it("adds IB's overnight session from Sunday 20:00 to Friday 03:50", () => {
    expect(usStockSession(et(24, '10:00'))).toBe('regular');
    expect(usStockSession(et(24, '19:59'))).toBe('post');
    expect(usStockSession(et(24, '20:00'))).toBe('overnight'); // Tuesday evening
    expect(usStockSession(et(25, '03:49'))).toBe('overnight');
    expect(usStockSession(et(25, '03:50'))).toBe('closed');
    expect(usStockSession(et(27, '20:30'))).toBe('closed'); // Friday evening
    expect(usStockSession(et(28, '02:00'))).toBe('closed'); // Saturday
    expect(usStockSession(et(29, '20:00'))).toBe('overnight'); // Sunday evening
    expect(usStockSession(et(30, '01:00'))).toBe('overnight'); // Monday morning
  });

  it('keeps holidays and half days from the liquid hours', () => {
    expect(usStockSession(et(26, '12:00'), '20261126:CLOSED;20261127:0930-20261127:1300')).toBe('closed');
    expect(usStockSession(et(27, '17:30'), '20261126:CLOSED;20261127:0930-20261127:1300')).toBe('closed');
  });
});

describe('usWeekClosed', () => {
  it("ends the week at Friday's regular close", () => {
    expect(usWeekClosed(et(24, '16:01'))).toBe(false); // Tuesday after the close
    expect(usWeekClosed(et(25, '08:00'))).toBe(false); // Wednesday pre-market
    expect(usWeekClosed(et(27, '15:59'))).toBe(false);
    expect(usWeekClosed(et(27, '16:00'))).toBe(true);
    expect(usWeekClosed(et(28, '12:00'))).toBe(true); // Saturday
    expect(usWeekClosed(et(30, '08:00'))).toBe(false); // Monday pre-market: a new week
  });

  it('ends it at an early close, or on the day before a Friday holiday', () => {
    const halfDay = '20261126:CLOSED;20261127:0930-20261127:1300';
    expect(usWeekClosed(et(25, '16:30'), halfDay)).toBe(false); // Thursday's holiday is not the end
    expect(usWeekClosed(et(27, '12:59'), halfDay)).toBe(false);
    expect(usWeekClosed(et(27, '13:00'), halfDay)).toBe(true);
    const fridayOff = '20261126:0930-20261126:1600;20261127:CLOSED';
    expect(usWeekClosed(et(26, '15:59'), fridayOff)).toBe(false);
    expect(usWeekClosed(et(26, '16:00'), fridayOff)).toBe(true);
    expect(usWeekClosed(et(27, '10:00'), fridayOff)).toBe(true);
  });
});

describe('tradingDay', () => {
  it('is the New York day, the next one from 20:00', () => {
    expect(tradingDay(et(24, '04:00').getTime())).toBe('20261124');
    expect(tradingDay(et(24, '19:59').getTime())).toBe('20261124');
    expect(tradingDay(et(24, '20:00').getTime())).toBe('20261125');
    expect(tradingDay(et(25, '00:30').getTime())).toBe('20261125');
  });

  it('does not change at midnight in China, which is noon in New York', () => {
    // 2026-10-14 is EDT (UTC−4): 00:00 in Shanghai on the 15th is 12:00 in New York on the 14th.
    expect(tradingDay(new Date('2026-10-14T23:30:00+08:00').getTime())).toBe('20261014');
    expect(tradingDay(new Date('2026-10-15T00:30:00+08:00').getTime())).toBe('20261014');
    expect(tradingDay(new Date('2026-10-15T09:30:00-04:00').getTime())).toBe('20261015');
  });
});
