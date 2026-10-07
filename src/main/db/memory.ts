// In-memory Database: used in tests and as the fallback when SQLite cannot be opened.
// Nothing is evicted on its own; tests evict series with evictSeries, as maintenance would.

import type { Bar, Execution, NavPoint } from '@shared/types';
import type { Database, EvictedSeries } from './types';

export interface MemoryDatabase extends Database {
  /** Drops series with their coverage documents and reports them, like SQLite maintenance. */
  evictSeries(series: readonly string[]): void;
}

/** Index of the first bar with time >= t in an ascending series (bars.length when none). */
function lowerBound(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Bars sorted by time, unique, later entries winning (like INSERT OR REPLACE in order). Times
 * are truncated to whole seconds and bars without a finite time are skipped, as SQLite does.
 */
function sortedUnique(list: readonly Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const b of list) {
    if (!b || !Number.isFinite(b.time)) continue;
    const time = Math.trunc(b.time);
    byTime.set(time, { ...b, time });
  }
  const out = [...byTime.values()];
  let sorted = true;
  for (let i = 1; i < out.length && sorted; i++) sorted = out[i - 1].time < out[i].time;
  if (!sorted) out.sort((a, b) => a.time - b.time);
  return out;
}

/** Merges two ascending series; on equal times the bar from `next` wins. */
function mergeSorted(cur: readonly Bar[], next: readonly Bar[]): Bar[] {
  const out: Bar[] = new Array(cur.length + next.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < cur.length && j < next.length) {
    const a = cur[i];
    const b = next[j];
    if (a.time < b.time) {
      out[k++] = a;
      i++;
    } else {
      if (a.time === b.time) i++;
      out[k++] = b;
      j++;
    }
  }
  while (i < cur.length) out[k++] = cur[i++];
  while (j < next.length) out[k++] = next[j++];
  out.length = k;
  return out;
}

const kvKey = (ns: string, key: string) => `${ns}\u0000${key}`;
/** Coverage documents of bar series, as in sqlite.ts (the bundles share no runtime code). */
const COVERAGE_KV_NS = 'coverage';
/** kv namespaces of cached market data, as sqlite.ts → MARKET_DATA_NS. */
export const MEMORY_MARKET_DATA_NS: readonly string[] = [COVERAGE_KV_NS, 'contract', 'secdef'];
/** An account's first NAV sample claims the unattributed rows within this factor of it, as sqlite.ts → NAV_CLAIM_FACTOR. */
const NAV_CLAIM_FACTOR = 2;

/** A NAV row as the SQLite table holds it (account null: unattributed). */
interface NavRow {
  t: number;
  netLiq: number;
  account: string | null;
}

const navPoint = (r: NavRow): NavPoint => ({ t: r.t, netLiq: r.netLiq });
const validNav = (p: NavPoint | undefined): p is NavPoint => !!p && Number.isFinite(p.t) && Number.isFinite(p.netLiq);

/**
 * Upserts `account`'s points into rows sorted and unique by time, as sqlite.ts → navInsert: a row of
 * another owner (an account, or none) at the same time is left alone.
 */
function navUpsert(rows: readonly NavRow[], account: string | null, points: readonly NavPoint[]): NavRow[] {
  const byTime = new Map(rows.map((r) => [r.t, r]));
  for (const p of points) {
    if (!validNav(p)) continue;
    const t = Math.round(p.t);
    const cur = byTime.get(t);
    if (!cur || cur.account === account) byTime.set(t, { t, netLiq: p.netLiq, account });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export function createMemoryDatabase(): MemoryDatabase {
  /** Ascending, unique times per series (kept sorted on write, so reads never sort). */
  const bars = new Map<string, Bar[]>();
  /** JSON text like the SQLite table: readers get their own copy of every value. */
  const kv = new Map<string, { json: string; updatedAt: number }>();
  const execs = new Map<string, Execution>();
  /** Ascending, unique times (as the SQLite table, whose primary key is the time). */
  let nav: NavRow[] = [];
  const listeners = new Set<(evicted: EvictedSeries) => void>();
  const notify = (evicted: EvictedSeries) => {
    for (const l of [...listeners]) l(evicted);
  };

  return {
    kind: 'memory',
    bars: {
      async get(series, fromTime, toTime) {
        const list = bars.get(series);
        if (!list) return [];
        const from = fromTime == null ? 0 : lowerBound(list, fromTime);
        const to = toTime == null ? list.length : Math.max(from, lowerBound(list, toTime));
        const out = new Array<Bar>(to - from);
        for (let i = from; i < to; i++) out[i - from] = { ...list[i] };
        return out;
      },
      async put(series, list) {
        const incoming = sortedUnique(list);
        if (!incoming.length) return;
        const cur = bars.get(series);
        if (!cur || !cur.length) bars.set(series, incoming);
        // The common case, new bars after the stored ones, appends in place.
        else if (incoming[0].time > cur[cur.length - 1].time) for (const b of incoming) cur.push(b);
        else bars.set(series, mergeSorted(cur, incoming));
      },
      async last(series) {
        const list = bars.get(series);
        return list && list.length ? list[list.length - 1].time : undefined;
      },
    },
    kv: {
      async get<T>(ns: string, key: string) {
        const row = kv.get(kvKey(ns, key));
        return row ? { value: JSON.parse(row.json) as T, updatedAt: row.updatedAt } : undefined;
      },
      async set(ns, key, value) {
        kv.set(kvKey(ns, key), { json: JSON.stringify(value ?? null), updatedAt: Date.now() });
      },
      async delete(ns, key) {
        kv.delete(kvKey(ns, key));
      },
    },
    executions: {
      async put(list) {
        for (const e of list) execs.set(e.execId, e);
      },
      async since(t) {
        return [...execs.values()].filter((e) => e.time >= t).sort((a, b) => b.time - a.time);
      },
    },
    nav: {
      async append(account, points) {
        // As sqlite.ts → navAppend: an account without rows claims the unattributed ones first.
        const first = account ? points.find((p) => validNav(p) && p.netLiq > 0) : undefined;
        if (first && !nav.some((r) => r.account === account)) {
          const low = first.netLiq / NAV_CLAIM_FACTOR;
          const high = first.netLiq * NAV_CLAIM_FACTOR;
          nav = nav.map((r) => (r.account === null && r.netLiq >= low && r.netLiq <= high ? { ...r, account } : r));
        }
        nav = navUpsert(nav, account, points);
      },
      async get(account) {
        return nav.filter((r) => r.account === account).map(navPoint);
      },
      async all() {
        return nav.map(navPoint);
      },
      async lastAccount() {
        for (let i = nav.length - 1; i >= 0; i--) {
          const account = nav[i].account;
          if (account !== null) return account;
        }
        return undefined;
      },
      async replace(account, points) {
        nav = navUpsert(nav.filter((r) => r.account !== account), account, points);
      },
    },
    async stats() {
      let count = 0;
      for (const list of bars.values()) count += list.length;
      return { bytes: 0, series: bars.size, bars: count, executions: execs.size };
    },
    async clearMarketData() {
      notify('all');
      bars.clear();
      for (const k of [...kv.keys()]) if (MEMORY_MARKET_DATA_NS.includes(k.slice(0, k.indexOf('\u0000')))) kv.delete(k);
    },
    onEvicted(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    evictSeries(series) {
      for (const s of series) {
        bars.delete(s);
        kv.delete(kvKey(COVERAGE_KV_NS, s));
      }
      if (series.length) notify(series);
    },
    async close() {},
  };
}
