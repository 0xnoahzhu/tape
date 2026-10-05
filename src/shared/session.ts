// US equity market sessions, computed in America/New_York.

export type MarketSession = 'pre' | 'regular' | 'post' | 'closed';

interface NyClock {
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since midnight
  ymd: string; // YYYYMMDD
}

const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hour12: false,
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function nyClock(now: Date = new Date()): NyClock {
  const parts = Object.fromEntries(nyFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    weekday: WEEKDAYS.indexOf(parts.weekday),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    ymd: `${parts.year}${parts.month}${parts.day}`,
  };
}

/**
 * Start of the current New York calendar day (unix ms), the "today" of the executions list.
 * On daylight saving changes it is off by an hour, which only widens the window.
 */
export function nyDayStart(now: number): number {
  return now - nyClock(new Date(now)).minutes * 60_000 - (now % 60_000);
}

const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;
const PRE_OPEN = 4 * 60;
const POST_CLOSE = 20 * 60;
/** Extended hours end at 17:00 on early-close days. */
const EARLY_POST_CLOSE = 17 * 60;

/**
 * Today's regular session from IB `liquidHours` ("20261127:0930-20261127:1300;20261128:CLOSED",
 * exchange time): 'closed' on a holiday, the closing minute when it is earlier than 16:00
 * (half day), otherwise undefined.
 */
function todaysEarlyClose(liquidHours: string, ymd: string): 'closed' | number | undefined {
  const today = liquidHours.split(';').filter((s) => s.startsWith(ymd + ':'));
  if (today.some((s) => s.endsWith('CLOSED'))) return 'closed';
  let close: number | undefined;
  // Older servers send "20261127:0930-1300", without the date on the end time.
  for (const range of today.flatMap((s) => s.split(','))) {
    const m = /-(?:(\d{8}):)?(\d{2})(\d{2})$/.exec(range);
    if (!m || (m[1] && m[1] !== ymd)) continue;
    close = Math.max(close ?? 0, Number(m[2]) * 60 + Number(m[3]));
  }
  return close != null && close > REGULAR_OPEN && close < REGULAR_CLOSE ? close : undefined;
}

/**
 * Session for a US-listed stock. When `liquidHours` from contract details is given, today's
 * entry decides whether the market is closed for a holiday or closes early; otherwise only
 * weekends are treated as closed.
 */
export function usEquitySession(now: Date = new Date(), liquidHours?: string): MarketSession {
  const { weekday, minutes, ymd } = nyClock(now);
  if (weekday === 0 || weekday === 6) return 'closed';
  const early = liquidHours ? todaysEarlyClose(liquidHours, ymd) : undefined;
  if (early === 'closed') return 'closed';
  const close = early ?? REGULAR_CLOSE;
  const postClose = early != null ? EARLY_POST_CLOSE : POST_CLOSE;
  if (minutes >= PRE_OPEN && minutes < REGULAR_OPEN) return 'pre';
  if (minutes >= REGULAR_OPEN && minutes < close) return 'regular';
  if (minutes >= close && minutes < postClose) return 'post';
  return 'closed';
}
