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

/** "YYYYMMDD" `n` calendar days after another. */
function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) + n));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Whether the regular sessions of the current New York calendar week (Monday to Friday) are over: on
 * the weekend, and from the regular close (16:00, or the early close) of the week's last trading day,
 * which is Friday, or an earlier day when `liquidHours` lists every day after it as a holiday (Good
 * Friday). A weekly bar closes then (indicator alerts, shared/liveBars.ts → alertBarForming).
 */
export function usWeekClosed(now: Date, liquidHours?: string): boolean {
  const { weekday, minutes, ymd } = nyClock(now);
  if (weekday === 0 || weekday === 6) return true;
  for (let d = weekday + 1; d <= 5; d++) {
    if (!liquidHours || todaysEarlyClose(liquidHours, addDaysYmd(ymd, d - weekday)) !== 'closed') return false;
  }
  const early = liquidHours ? todaysEarlyClose(liquidHours, ymd) : undefined;
  return early === 'closed' || minutes >= (early ?? REGULAR_CLOSE);
}

/** IB's overnight session for US stocks: 20:00–03:50 New York, Sunday evening to Friday morning. */
const OVERNIGHT_OPEN = 20 * 60;
const OVERNIGHT_CLOSE = 3 * 60 + 50;

/**
 * Session of a US stock including IB's overnight session, which usEquitySession counts as closed:
 * 'overnight' from 20:00 Sunday to Thursday until 03:50 the next morning. Holidays only shape the
 * day sessions (through `liquidHours`); the overnight session is taken to run every weeknight.
 */
export function usStockSession(now: Date = new Date(), liquidHours?: string): MarketSession | 'overnight' {
  const session = usEquitySession(now, liquidHours);
  if (session !== 'closed') return session;
  const { weekday, minutes } = nyClock(now);
  if (minutes >= OVERNIGHT_OPEN && weekday >= 0 && weekday <= 4) return 'overnight';
  if (minutes < OVERNIGHT_CLOSE && weekday >= 1 && weekday <= 5) return 'overnight';
  return 'closed';
}

/**
 * The New York trading day (YYYYMMDD) an instant belongs to: the calendar day, except that from
 * 20:00 it is the next one, as IB starts the next day (its volume, the overnight session) then.
 * Alerts that notify once a day count by it, so the day does not end at the user's local midnight
 * (mid-session for a user in Asia) or at New York midnight inside the overnight session.
 */
export function tradingDay(ms: number): string {
  return nyClock(new Date(ms + 4 * 3_600_000)).ymd;
}
