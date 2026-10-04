// America/New_York calendar helpers for the simulator (pure, unit-tested).

export interface CalendarDay {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });

/** New York calendar day and minutes since midnight for a unix ms instant. */
export function nyDay(ms: number): CalendarDay & { minutes: number } {
  const p = Object.fromEntries(partsFormatter.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** UTC offset of New York in minutes at an instant (−240 in summer, −300 in winter). */
export function nyOffsetMinutes(ms: number): number {
  const name = offsetFormatter.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT-5';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -v : v;
}

/** Unix ms of a New York wall-clock time (minutes since midnight) on a calendar day. */
export function nyWallToEpochMs(day: CalendarDay, minutes: number): number {
  const naive = Date.UTC(day.y, day.m - 1, day.d) + minutes * 60_000;
  let t = naive - nyOffsetMinutes(naive) * 60_000;
  const off = nyOffsetMinutes(t);
  if (naive - off * 60_000 !== t) t = naive - off * 60_000;
  return t;
}

export function addDays(day: CalendarDay, n: number): CalendarDay {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: CalendarDay): number {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
}

export function isWeekday(day: CalendarDay): boolean {
  const w = weekday(day);
  return w !== 0 && w !== 6;
}

export function previousWeekday(day: CalendarDay): CalendarDay {
  let d = addDays(day, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

/** The calendar day at 00:00 UTC in unix seconds (the convention for daily bars). */
export function dayStamp(day: CalendarDay): number {
  return Date.UTC(day.y, day.m - 1, day.d) / 1000;
}

export function yyyymmdd(day: CalendarDay): string {
  return `${day.y}${String(day.m).padStart(2, '0')}${String(day.d).padStart(2, '0')}`;
}

export function parseYyyymmdd(s: string): CalendarDay {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(4, 6)), d: Number(s.slice(6, 8)) };
}

/** Third Friday of a month (standard monthly option expiration). */
export function thirdFriday(y: number, m: number): CalendarDay {
  const first: CalendarDay = { y, m, d: 1 };
  const offset = (5 - weekday(first) + 7) % 7;
  return { y, m, d: 1 + offset + 14 };
}

export const RTH_OPEN = 570; // 09:30
export const RTH_CLOSE = 960; // 16:00

/**
 * The most recent regular session that has started: today once it is past 09:30 on a weekday,
 * otherwise the previous weekday. `elapsed` is the number of session minutes so far (1–390).
 * Exchange holidays are not modelled.
 */
export function latestSession(ms: number): { day: CalendarDay; elapsed: number; live: boolean } {
  const now = nyDay(ms);
  const today: CalendarDay = { y: now.y, m: now.m, d: now.d };
  if (isWeekday(today) && now.minutes >= RTH_OPEN) {
    const elapsed = Math.min(RTH_CLOSE - RTH_OPEN, now.minutes - RTH_OPEN + 1);
    return { day: today, elapsed, live: now.minutes < RTH_CLOSE };
  }
  return { day: isWeekday(today) ? previousWeekday(today) : previousWeekday(addDays(today, 1)), elapsed: RTH_CLOSE - RTH_OPEN, live: false };
}
