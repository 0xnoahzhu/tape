import { describe, expect, it } from 'vitest';
import { addDays, latestSession, nyDay, nyOffsetMinutes, nyWallToEpochMs, previousWeekday, thirdFriday, weekday, yyyymmdd } from './nyTime';

describe('New York time', () => {
  it('knows daylight saving time', () => {
    expect(nyOffsetMinutes(Date.UTC(2026, 6, 1, 12))).toBe(-240);
    expect(nyOffsetMinutes(Date.UTC(2026, 0, 15, 12))).toBe(-300);
  });

  it('converts wall-clock times to instants in summer and winter', () => {
    expect(nyWallToEpochMs({ y: 2026, m: 10, d: 2 }, 570)).toBe(Date.UTC(2026, 9, 2, 13, 30));
    expect(nyWallToEpochMs({ y: 2026, m: 12, d: 18 }, 960)).toBe(Date.UTC(2026, 11, 18, 21, 0));
    const d = nyDay(Date.UTC(2026, 9, 2, 13, 30));
    expect(d).toEqual({ y: 2026, m: 10, d: 2, minutes: 570 });
  });

  it('walks the calendar', () => {
    expect(addDays({ y: 2026, m: 12, d: 31 }, 1)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(weekday({ y: 2026, m: 10, d: 4 })).toBe(0);
    expect(previousWeekday({ y: 2026, m: 10, d: 5 })).toEqual({ y: 2026, m: 10, d: 2 });
    expect(yyyymmdd(thirdFriday(2026, 10))).toBe('20261016');
    expect(yyyymmdd(thirdFriday(2027, 1))).toBe('20270115');
  });
});

describe('latestSession', () => {
  it('is the previous Friday on a weekend', () => {
    const s = latestSession(Date.UTC(2026, 9, 4, 15)); // Sunday
    expect(s).toEqual({ day: { y: 2026, m: 10, d: 2 }, elapsed: 390, live: false });
  });

  it('is the previous weekday before the open', () => {
    expect(latestSession(Date.UTC(2026, 9, 6, 12)).day).toEqual({ y: 2026, m: 10, d: 5 }); // Tue 08:00 ET
  });

  it('is today once the market opened', () => {
    const s = latestSession(Date.UTC(2026, 9, 6, 14, 0)); // Tue 10:00 ET
    expect(s).toEqual({ day: { y: 2026, m: 10, d: 6 }, elapsed: 31, live: true });
    expect(latestSession(Date.UTC(2026, 9, 6, 21, 0)).live).toBe(false); // 17:00 ET
  });
});
