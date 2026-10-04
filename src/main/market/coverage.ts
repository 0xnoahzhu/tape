// Coverage of stored bar series (pure, unit-tested): the time ranges of a series whose bars are
// known to be complete in the bar cache because they were requested from IB and answered.
//
// Ranges are half-open [start, end) in series time: unix seconds for intraday bars, the date
// stamp (00:00 UTC) for daily and longer bars. Weekends, holidays and closed sessions inside a
// requested range are covered (IB had nothing there); a stretch that was never requested is not,
// even when the bars on both sides of it are stored, so coverage is never inferred from bars.

export type Range = [start: number, end: number];

/** Per-series bookkeeping, persisted in the kv cache (namespace 'coverage', keyed by series). */
export interface SeriesCoverage {
  /** Complete ranges: ascending, disjoint, not touching. */
  ranges: Range[];
  /** Unix ms of the last load of the newest bars (the window or its tail). */
  fetchedAt?: number;
  /**
   * First bar of the last full-window load: IB had nothing older within the window (a recent
   * listing, an option), so a series starting there still counts as covering the window.
   */
  first?: number;
}

/** Ranges kept per series; older ones are dropped beyond this (losing coverage only costs a refetch). */
export const MAX_RANGES = 64;

const isRange = (r: unknown): r is readonly [number, number] =>
  Array.isArray(r) && r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && (r[0] as number) < (r[1] as number);

/** Sorted, disjoint ranges; overlapping and touching ranges are merged, invalid ones dropped. */
export function normalizeRanges(ranges: ReadonlyArray<readonly [number, number]>): Range[] {
  const list = ranges.filter(isRange).map(([a, b]): Range => [a, b]);
  list.sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** `ranges` plus [start, end), normalized; at most MAX_RANGES (the newest are kept). */
export function addRange(ranges: readonly Range[], range: readonly [number, number]): Range[] {
  const out = normalizeRanges([...ranges, range]);
  return out.length > MAX_RANGES ? out.slice(out.length - MAX_RANGES) : out;
}

/** `ranges` minus [start, end). */
export function subtractRange(ranges: readonly Range[], [start, end]: readonly [number, number]): Range[] {
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    if (!(start < end) || b <= start || a >= end) {
      out.push([a, b]);
      continue;
    }
    if (a < start) out.push([a, start]);
    if (b > end) out.push([end, b]);
  }
  return out;
}

/** The parts of `ranges` within [from, to). */
export function clipRanges(ranges: readonly Range[], from: number, to = Infinity): Range[] {
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (s < e) out.push([s, e]);
  }
  return out;
}

/** The range that holds the time just before `t` (so [range start, t) is complete), if any. */
export function rangeBefore(ranges: readonly Range[], t: number): Range | undefined {
  for (const r of ranges) if (r[0] < t && t <= r[1]) return r;
  return undefined;
}

/** A persisted document read back from the kv cache; anything malformed is dropped. */
export function parseCoverage(value: unknown): SeriesCoverage {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<SeriesCoverage>;
  const out: SeriesCoverage = { ranges: Array.isArray(v.ranges) ? normalizeRanges(v.ranges) : [] };
  if (Number.isFinite(v.fetchedAt)) out.fetchedAt = v.fetchedAt;
  if (Number.isFinite(v.first)) out.first = v.first;
  return out;
}
