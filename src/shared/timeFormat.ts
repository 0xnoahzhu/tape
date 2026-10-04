// Clock times as the user chose to read them (Settings › General › Time format), shared by the
// renderer and the main process. Pure: no DOM, no Electron.
//
//   12-hour: en "9:41 AM", "9:41:07 PM"; zh "上午 9:41", "下午 2:35" (the period comes first, as
//            Chinese writes it). Midnight is "12:00 AM" / "上午 12:00", noon "12:00 PM" / "下午 12:00":
//            上午 / 下午 are CLDR's am / pm markers for Chinese (what Intl's zh-CN hour12 output and
//            the Windows / macOS 12-hour clocks use); the finer day periods (凌晨, 中午, 晚上 …) would
//            give one clock reading several names and make the period's width jump.
//   24-hour: "09:41", "14:35:07" in both languages.
//
// Only what a person reads goes through here. The API log (milliseconds), CSV exports and
// everything sent to IB keep their fixed 24-hour forms (format.ts hms / hmsMs, orderTiming.ts).

import type { Lang } from './types';

export type TimeFormat = '12h' | '24h';
export const TIME_FORMATS: readonly TimeFormat[] = ['12h', '24h'];
export const DEFAULT_TIME_FORMAT: TimeFormat = '12h';

export const isTimeFormat = (v: unknown): v is TimeFormat => v === '12h' || v === '24h';

/** New York, the zone of US exchange times shown with " ET". */
export const NEW_YORK_ZONE = 'America/New_York';

/** A wall clock reading: hours 0–23. */
export interface WallClock {
  h: number;
  m: number;
  s?: number;
}

export interface ClockParts {
  /** "9:41", "9:41:07", "09:41". */
  time: string;
  /** "AM" / "PM" / "上午" / "下午"; null in the 24-hour format. */
  period: string | null;
  /** The period is written before the time (Chinese). */
  periodFirst: boolean;
}

const PERIODS: Record<Lang, [string, string]> = { en: ['AM', 'PM'], zh: ['上午', '下午'] };
const two = (n: number) => String(n).padStart(2, '0');

/** The pieces of a wall clock reading in a format and language (the lock screen styles them apart). */
export function clockParts(w: WallClock, format: TimeFormat, lang: Lang, seconds = false): ClockParts {
  const h = ((w.h % 24) + 24) % 24;
  const rest = `${two(w.m)}${seconds ? `:${two(w.s ?? 0)}` : ''}`;
  if (format === '24h') return { time: `${two(h)}:${rest}`, period: null, periodFirst: false };
  return { time: `${h % 12 || 12}:${rest}`, period: PERIODS[lang][h < 12 ? 0 : 1], periodFirst: lang === 'zh' };
}

/** "9:41 AM", "上午 9:41", "09:41". */
export function joinClockParts(p: ClockParts): string {
  if (!p.period) return p.time;
  return p.periodFirst ? `${p.period} ${p.time}` : `${p.time} ${p.period}`;
}

/** A wall clock reading as text: "9:41 AM", "上午 9:41", "09:41". */
export function clockText(w: WallClock, format: TimeFormat, lang: Lang, seconds = false): string {
  return joinClockParts(clockParts(w, format, lang, seconds));
}

// ---------------------------------------------------------------------------
// Instants

export interface ClockOptions {
  /** Show seconds. */
  seconds?: boolean;
  /** IANA time zone of the wall clock; the local zone when omitted. */
  timeZone?: string;
  /** Written after the time, e.g. 'ET' -> "9:35 AM ET". */
  zone?: string;
  /** Date before the time: 'md' -> "10/09 4:00 PM", 'ymd' -> "2026-10-09 4:00 PM". */
  date?: 'md' | 'ymd';
}

interface ZonedReading extends Required<WallClock> {
  y: number;
  mo: number;
  d: number;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, f);
  }
  return f;
}

/** Wall clock and date of an instant, in a time zone or the local one. Throws for unknown zones. */
export function wallClockAt(t: number | Date, timeZone?: string): ZonedReading {
  const d = t instanceof Date ? t : new Date(t);
  if (!timeZone) return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  const p = Object.fromEntries(zoneFormatter(timeZone).formatToParts(d).map((x) => [x.type, x.value]));
  const n = (k: string) => Number(p[k]);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour') % 24, m: n('minute'), s: n('second') };
}

function dateText(r: ZonedReading, style: 'md' | 'ymd'): string {
  return style === 'md' ? `${two(r.mo)}/${two(r.d)}` : `${r.y}-${two(r.mo)}-${two(r.d)}`;
}

/** Reads a 24-hour wall time ("16:00", "9:35", "16:00:05"); null when it is not one. */
export function readWallTime(s: string): WallClock | null {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(s);
  if (!m) return null;
  const w = { h: Number(m[1]), m: Number(m[2]), s: m[3] != null ? Number(m[3]) : undefined };
  return w.h > 23 || w.m > 59 || (w.s ?? 0) > 59 ? null : w;
}

/** Formats clock times in one format and language. Get one with createClock (or useClock in the renderer). */
export interface Clock {
  readonly format: TimeFormat;
  readonly lang: Lang;
  /** An instant: "9:41 AM", "上午 9:41:07", "10/09 4:00 PM ET", "09:41". */
  time(t: number | Date, o?: ClockOptions): string;
  /** The pieces of an instant's clock reading (no date or zone). */
  parts(t: number | Date, o?: Pick<ClockOptions, 'seconds' | 'timeZone'>): ClockParts;
  /**
   * A 24-hour wall time ("16:00", "09:35:00", as IB and the order ticket keep them) in this
   * format: "4:00 PM"; with `zone` "4:00 PM ET". Text that is not such a time comes back unchanged.
   */
  wall(hhmm: string, o?: Pick<ClockOptions, 'seconds' | 'zone'>): string;
  /**
   * A range of two 24-hour wall times: "9:30 AM–4:00 PM", "09:30–16:00"; a period both ends share
   * is written once ("4:00–9:30 AM", "上午 4:00–9:30").
   */
  range(from: string, to: string): string;
}

function makeClock(format: TimeFormat, lang: Lang): Clock {
  const withZone = (text: string, zone: string | undefined) => (zone ? `${text} ${zone}` : text);
  const clock: Clock = {
    format,
    lang,
    time(t, o = {}) {
      const r = wallClockAt(t, o.timeZone);
      const text = clockText(r, format, lang, o.seconds);
      return withZone(o.date ? `${dateText(r, o.date)} ${text}` : text, o.zone);
    },
    parts(t, o = {}) {
      return clockParts(wallClockAt(t, o.timeZone), format, lang, o.seconds);
    },
    wall(hhmm, o = {}) {
      const w = readWallTime(hhmm);
      if (!w) return hhmm;
      return withZone(clockText(w, format, lang, o.seconds ?? w.s != null), o.zone);
    },
    range(from, to) {
      const a = readWallTime(from);
      const b = readWallTime(to);
      if (!a || !b) return `${clock.wall(from)}–${clock.wall(to)}`;
      const pa = clockParts(a, format, lang);
      const pb = clockParts(b, format, lang);
      if (!pa.period || pa.period !== pb.period) return `${joinClockParts(pa)}–${joinClockParts(pb)}`;
      return joinClockParts({ ...pa, time: `${pa.time}–${pb.time}` });
    },
  };
  return clock;
}

const clocks = new Map<string, Clock>();

/** The (cached) clock of a format and language. */
export function createClock(format: TimeFormat, lang: Lang): Clock {
  const key = `${format}:${lang}`;
  let c = clocks.get(key);
  if (!c) {
    c = makeClock(format, lang);
    clocks.set(key, c);
  }
  return c;
}

/** Fixed 24-hour clock: the default of shared helpers whose callers have no setting at hand. */
export const CLOCK_24H: Clock = createClock('24h', 'en');

/**
 * Width of a table column of clock times with seconds at the tables' 12.5–13px var(--num): the
 * widest 12-hour readings ("下午 12:00:30", "12:05:00 PM") take about 96px, "14:35:07" about 62px.
 * The cells also need white-space: nowrap, or the zh period wraps onto its own line.
 */
export function timeColumn(clock: Pick<Clock, 'format'>): string {
  return clock.format === '12h' ? '112px' : '90px';
}

// ---------------------------------------------------------------------------
// Typed times

/**
 * A time the user typed -> "HH:MM" (24-hour), or null. Takes both formats in either language:
 * "09:35", "9:35", "21:35", "9:35 AM", "9:35pm", "9:35 p.m.", "上午 9:35", "下午9:35", "9:35 下午",
 * and a bare hour with a period ("9 AM", "下午 3"). Without a period the time is read as 24-hour,
 * except that someone on the 12-hour clock who types "3:55" (an hour of 1–11 without a leading
 * zero) may well mean the afternoon: in `format` '12h' that is ambiguous and null, while "03:55",
 * "00:15", "12:30" and "13:00"–"23:59" can only be 24-hour times and are read as such.
 */
export function parseTypedTime(s: string, format: TimeFormat): string | null {
  let text = s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  let period: 'am' | 'pm' | null = null;
  const marker = /(a\.?\s?m\.?|p\.?\s?m\.?|上午|下午)/.exec(text);
  if (marker) {
    const w = marker[1].replace(/[.\s]/g, '');
    period = w === 'am' || w === '上午' ? 'am' : 'pm';
    text = (text.slice(0, marker.index) + ' ' + text.slice(marker.index + marker[1].length)).trim();
  }
  const m = /^(\d{1,2})(?:[:：](\d{2}))?$/.exec(text);
  if (!m || (m[2] == null && !period)) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  if (period) {
    if (h < 1 || h > 12) return null;
    // 12 AM is midnight, 12 PM noon.
    h = (h % 12) + (period === 'pm' ? 12 : 0);
  } else if (h > 23 || (format === '12h' && /^(?:[1-9]|1[01])$/.test(m[1]))) return null;
  return `${two(h)}:${two(min)}`;
}

// ---------------------------------------------------------------------------
// Times inside stored texts
//
// Notification texts are built once (in main or the renderer) and kept in notifications.json,
// but must read in the format chosen now. Their clock times are stored as tokens
// "⟦t:<unix ms>:<flags>⟧" and resolved whenever the text is shown (the in-app list, the OS
// notification). Flags: s = seconds, d = month/day before the time, e = New York time + " ET".

const TOKEN = /⟦t:(\d{1,15}):([sde]*)⟧/g;

/** A clock that writes tokens instead of text, for stored texts (see resolveTimeTokens). */
export const TOKEN_CLOCK: Clock = {
  format: '24h',
  lang: 'en',
  time(t, o = {}) {
    const ms = t instanceof Date ? t.getTime() : t;
    const eastern = o.timeZone === NEW_YORK_ZONE && o.zone === 'ET';
    // Options a token cannot carry are written out now, in 24-hour time.
    if ((o.timeZone && !eastern) || (o.zone && !eastern) || o.date === 'ymd' || !Number.isFinite(ms) || ms < 0) return CLOCK_24H.time(t, o);
    return `⟦t:${Math.round(ms)}:${o.seconds ? 's' : ''}${o.date ? 'd' : ''}${eastern ? 'e' : ''}⟧`;
  },
  parts: (t, o) => CLOCK_24H.parts(t, o),
  wall: (hhmm, o) => CLOCK_24H.wall(hhmm, o),
  range: (from, to) => CLOCK_24H.range(from, to),
};

/** Replaces the time tokens of a stored text with times in `clock`'s format. */
export function resolveTimeTokens(text: string, clock: Clock): string {
  if (!text.includes('⟦t:')) return text;
  return text.replace(TOKEN, (_, ms: string, flags: string) =>
    clock.time(Number(ms), {
      seconds: flags.includes('s'),
      date: flags.includes('d') ? 'md' : undefined,
      ...(flags.includes('e') ? { timeZone: NEW_YORK_ZONE, zone: 'ET' } : {}),
    }),
  );
}
