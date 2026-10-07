// Net liquidation history for the equity curve, one per account: intraday samples for the last
// few days and one point per trading day (the last sample of the day, New York date) for
// everything older. IB keeps no NAV history for the socket API, so Tape records the active
// account's NetLiquidation itself while connected (account.ts). Persisted in the database's NAV
// log (tape.db); nav.json is only read once, to import it.
//
// Rows written before the history was kept per account (schema v4) and the nav.json import have
// no account: an account's first sample claims those within a factor of 2 of its value
// (db/sqlite.ts → navAppend); the others are kept and never shown, and never compacted.

import type { NavHistory, NavPoint } from '@shared/types';
import { nyClock } from '@shared/session';
import type { Database, NavLog } from '../db/types';

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

/**
 * The account whose history is shown: `account` (the connection's), else, before the first
 * connect, the one that recorded the newest sample ('' when none has).
 */
async function shownAccount(nav: Pick<NavLog, 'lastAccount'>, account: string | undefined): Promise<string> {
  return account || (await nav.lastAccount()) || '';
}

/** `account`'s history, else (before the first connect) that of the account that recorded the newest sample. */
export async function readNavHistory(db: Pick<Database, 'nav'>, account?: string): Promise<NavHistory> {
  const shown = await shownAccount(db.nav, account);
  return { account: shown, points: shown ? await db.nav.get(shown) : [] };
}

export interface NavRecorder {
  /**
   * The history to show (as readNavHistory): `account`'s, else that of the account of the newest
   * sample. Each account's history is loaded and compacted once, after the nav.json import.
   */
  history(account?: string): Promise<NavHistory>;
  /**
   * Adds and persists a sample of `account` (samples are added one at a time); resolves with the
   * account's whole history to send to the renderer once the write is done, i.e. after the
   * database answered every read sent before it (a snapshot read in flight never misses a point
   * whose 'nav' event already went out).
   */
  add(account: string, p: NavPoint): Promise<NavPoint[]>;
}

/**
 * NAV histories kept in memory per account and persisted in the database's NAV log. The legacy
 * JSON history is imported first (retired once the database holds it); each account's history is
 * compacted when it is loaded. Samples are appended; when compaction drops points (the first
 * sample after New York midnight, once a day) the account's rows are replaced, so the database
 * always matches what the renderer shows. An account's first sample reads its rows back: the
 * database added the unattributed rows it claimed. Only a list read from the database is kept, so
 * a replace never drops rows that were not read.
 */
export function createNavRecorder(db: Pick<Database, 'nav' | 'kind'> | undefined, legacy: LegacyNav, now: () => number = Date.now): NavRecorder {
  /** Each loaded account's history as stored. */
  const lists = new Map<string, NavPoint[]>();
  const loads = new Map<string, Promise<void>>();
  let imported: Promise<void> | null = null;
  /** The last sample's work (samples are added one at a time). */
  let adding: Promise<unknown> = Promise.resolve();
  /** The account of the newest sample recorded in this run (what history() falls back to without a database). */
  let lastAccount = '';

  /**
   * Imports nav.json once. No account is known yet: its points land unattributed, for the first
   * account whose first sample is within a factor of 2 of them. The file is retired once every
   * point is in the database, claimed or not.
   */
  function importLegacy(): Promise<void> {
    imported ??= (async () => {
      if (!db) return;
      const old = legacy.get().filter(isValid);
      if (!old.length) return;
      await db.nav.append(null, old);
      if (db.kind !== 'sqlite') return;
      const stored = new Set((await db.nav.all()).map((p) => p.t));
      if (old.every((p) => stored.has(Math.round(p.t)))) legacy.clear();
    })().catch((err) => console.error('[account] NAV history could not be imported:', err));
    return imported;
  }

  /** `account`'s rows, compacted (the rows are replaced when that dropped any). */
  async function readCompacted(account: string): Promise<NavPoint[]> {
    if (!db) return [];
    const stored = await db.nav.get(account);
    const compacted = compactNav(stored, now());
    if (compacted.length < stored.length) await db.nav.replace(account, compacted);
    return compacted;
  }

  /** Loads `account`'s history once (later calls share it). */
  function load(account: string): Promise<void> {
    let loading = loads.get(account);
    if (!loading) {
      loading = importLegacy()
        .then(() => readCompacted(account))
        .then(
          (list) => void lists.set(account, list),
          (err) => {
            console.error('[account] NAV history could not be loaded:', err);
            lists.set(account, []);
          },
        );
      loads.set(account, loading);
    }
    return loading;
  }

  async function addNow(account: string, p: NavPoint): Promise<NavPoint[]> {
    await load(account);
    const prev = lists.get(account) ?? [];
    if (!isValid(p)) return prev;
    const point = { t: p.t, netLiq: p.netLiq };
    let next = addNavPoint(prev, point);
    // Writes never reject; awaiting them orders the caller's 'nav' event after earlier reads.
    if (db && !prev.length) {
      // The account's first sample: the rows it claimed come with it.
      await db.nav.append(account, [point]);
      try {
        next = await readCompacted(account);
      } catch (err) {
        // Not cached: a list missing the account's rows must never replace them (nav.replace).
        // The next sample (or history()) loads the account again.
        console.error('[account] NAV history could not be read:', err);
        loads.delete(account);
        lists.delete(account);
        lastAccount = account;
        return next;
      }
    } else if (next.length === prev.length + 1) await db?.nav.append(account, [point]);
    else await db?.nav.replace(account, next);
    lists.set(account, next);
    lastAccount = account;
    return next;
  }

  return {
    async history(account) {
      await importLegacy();
      let shown = account || lastAccount;
      if (db) {
        try {
          shown = await shownAccount(db.nav, account);
        } catch (err) {
          console.error('[account] NAV history could not be read:', err);
        }
      }
      if (!shown) return { account: '', points: [] };
      await load(shown);
      return { account: shown, points: lists.get(shown) ?? [] };
    },
    add(account, p) {
      const done = adding.then(() => addNow(account, p));
      adding = done.catch(() => undefined);
      return done;
    },
  };
}
