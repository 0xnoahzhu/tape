// In-memory Database: used in tests and as the fallback when SQLite cannot be opened.

import type { Bar, Execution, NavPoint } from '@shared/types';
import type { Database } from './types';

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

export function createMemoryDatabase(): Database {
  /** Ascending, unique times per series (kept sorted on write, so reads never sort). */
  const bars = new Map<string, Bar[]>();
  /** JSON text like the SQLite table: readers get their own copy of every value. */
  const kv = new Map<string, { json: string; updatedAt: number }>();
  const execs = new Map<string, Execution>();
  let nav: NavPoint[] = [];

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
        const row = kv.get(`${ns}\u0000${key}`);
        return row ? { value: JSON.parse(row.json) as T, updatedAt: row.updatedAt } : undefined;
      },
      async set(ns, key, value) {
        kv.set(`${ns}\u0000${key}`, { json: JSON.stringify(value ?? null), updatedAt: Date.now() });
      },
      async delete(ns, key) {
        kv.delete(`${ns}\u0000${key}`);
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
      async append(points) {
        nav = [...nav, ...points].sort((a, b) => a.t - b.t);
      },
      async all() {
        return nav.slice();
      },
      async replace(points) {
        nav = points.slice().sort((a, b) => a.t - b.t);
      },
    },
    async close() {},
  };
}
