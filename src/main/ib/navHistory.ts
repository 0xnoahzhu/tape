// Net liquidation history for the equity curve: intraday samples for the last few days and
// one point per trading day (the last sample of the day, New York date) for everything older.
// Persisted in the database's NAV log (tape.db); nav.json is only read once, to import it.

import type { NavPoint } from '@shared/types';
import { nyClock } from '@shared/session';
import type { Database } from '../db/types';

export const NAV_SAMPLE_MS = 5 * 60_000;
export const INTRADAY_DAYS = 10;

/** New York date, YYYYMMDD (sorts like the dates). */
const nyDay = (t: number): string => nyClock(new Date(t)).ymd;

/** The New York date `days` calendar days before the one of `t` (calendar arithmetic, DST-proof). */
function nyDayBefore(t: number, days: number): string {
  const ymd = nyDay(t);
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) - days));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

const isValid = (p: NavPoint | undefined): p is NavPoint => !!p && Number.isFinite(p.t) && Number.isFinite(p.netLiq) && p.netLiq > 0;

/** Adds a sample (replacing one with the same timestamp) and compacts old days. */
export function addNavPoint(points: readonly NavPoint[], p: NavPoint, intradayDays = INTRADAY_DAYS): NavPoint[] {
  if (!isValid(p)) return points.slice();
  const list = points.filter((x) => x.t !== p.t);
  list.push({ t: p.t, netLiq: p.netLiq });
  list.sort((a, b) => a.t - b.t);
  return compactNav(list, Math.max(p.t, list[list.length - 1].t), intradayDays);
}

/**
 * Keeps every point of today and the `intradayDays` New York days before it; older days are
 * reduced to their last point. The window moves by whole days at New York midnight, so between
 * two midnights nothing is dropped (samples only append). `points` must be sorted by time.
 */
export function compactNav(points: readonly NavPoint[], now: number, intradayDays = INTRADAY_DAYS): NavPoint[] {
  const firstIntraday = nyDayBefore(now, intradayDays);
  const out: NavPoint[] = [];
  let i = 0;
  let day = points.length ? nyDay(points[0].t) : '';
  // Sorted, so the old days are a prefix: keep the last point of each.
  while (i < points.length && day < firstIntraday) {
    const nextDay = i + 1 < points.length ? nyDay(points[i + 1].t) : '';
    if (nextDay !== day) out.push(points[i]);
    day = nextDay;
    i++;
  }
  for (; i < points.length; i++) out.push(points[i]);
  return out;
}

/** The pre-database NAV history (nav.json in the JSON store). */
export interface LegacyNav {
  get(): NavPoint[];
  /** Empties the file once its points are safely in the database. */
  clear(): void;
}

export interface NavRecorder {
  /** Loads the history once (later calls share the result). */
  load(): Promise<NavPoint[]>;
  /**
   * Adds and persists a sample; resolves with the whole history to send to the renderer once
   * the write is done, i.e. after the database answered every read sent before it (a snapshot
   * read in flight never misses a point whose 'nav' event already went out).
   */
  add(p: NavPoint): Promise<NavPoint[]>;
}

/**
 * NAV history kept in memory and persisted in the database's NAV log. The first load imports
 * the legacy JSON history (retired once the database holds it) and compacts old days. Samples
 * are appended; when compaction drops points (the first sample after New York midnight, once a
 * day) the log is replaced, so the database always matches what the renderer shows.
 */
export function createNavRecorder(db: Pick<Database, 'nav' | 'kind'> | undefined, legacy: LegacyNav, now: () => number = Date.now): NavRecorder {
  let points: NavPoint[] = [];
  let loading: Promise<NavPoint[]> | null = null;

  async function importAndCompact(): Promise<NavPoint[]> {
    if (!db) return [];
    const old = legacy.get().filter(isValid);
    if (old.length) await db.nav.append(old);
    const all = await db.nav.all();
    if (old.length && db.kind === 'sqlite') {
      const stored = new Set(all.map((p) => p.t));
      if (old.every((p) => stored.has(Math.round(p.t)))) legacy.clear();
    }
    const compacted = compactNav(all, now());
    if (compacted.length < all.length) await db.nav.replace(compacted);
    return compacted;
  }

  function load(): Promise<NavPoint[]> {
    loading ??= importAndCompact().then(
      (list) => (points = list),
      (err) => {
        console.error('[account] NAV history could not be loaded:', err);
        return points;
      },
    );
    return loading;
  }

  return {
    load,
    async add(p) {
      await load();
      if (!isValid(p)) return points;
      const prev = points;
      const next = (points = addNavPoint(prev, p));
      // Writes never reject; awaiting them orders the caller's 'nav' event after earlier reads.
      if (next.length === prev.length + 1) await db?.nav.append([{ t: p.t, netLiq: p.netLiq }]);
      else await db?.nav.replace(next);
      return next;
    },
  };
}
