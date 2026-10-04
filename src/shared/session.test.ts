import { describe, expect, it } from 'vitest';
import { usEquitySession } from './session';

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
