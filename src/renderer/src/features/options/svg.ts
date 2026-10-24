// Scaling helpers for the desk's small SVG charts (design `chart()`), and their axes: round values
// for gridlines and labels, and x labels kept apart.

export interface ChartScale {
  X(x: number): number;
  Y(y: number): number;
  x0: number;
  x1: number;
  /** Padded y range. */
  y0: number;
  y1: number;
}

/** Linear scale of `xs` onto [0, w] and `ys` (padded by `pad` of the range) onto [h, 0]. */
export function chartScale(xs: number[], ys: number[], w: number, h: number, pad = 0.1): ChartScale {
  const fx = xs.filter(Number.isFinite);
  const fy = ys.filter(Number.isFinite);
  const x0 = Math.min(...fx);
  const x1 = Math.max(...fx);
  let y0 = Math.min(...fy);
  let y1 = Math.max(...fy);
  const p = (y1 - y0) * pad || 0.01;
  y0 -= p;
  y1 += p;
  return {
    X: (x) => (x1 === x0 ? w / 2 : ((x - x0) / (x1 - x0)) * w),
    Y: (y) => h - ((y - y0) / (y1 - y0)) * h,
    x0,
    x1,
    y0,
    y1,
  };
}

/** "x,y x,y …" for a polyline, skipping points with a missing value. */
export function polyPoints(pts: Array<{ x: number; y: number | undefined }>, s: Pick<ChartScale, 'X' | 'Y'>): string {
  return pts
    .filter((p): p is { x: number; y: number } => p.y != null && Number.isFinite(p.y))
    .map((p) => `${s.X(p.x).toFixed(1)},${s.Y(p.y).toFixed(1)}`)
    .join(' ');
}

/**
 * Round values within [lo, hi] for an axis, at most `max` of them: steps of 1, 2, 2.5 or 5 times a
 * power of ten (17.4–31.2 % with 5 gives 20, 25, 30).
 */
export function niceTicks(lo: number, hi: number, max = 5): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi) || max < 1) return [];
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / max));
  for (const k of [1, 2, 2.5, 5, 10, 20]) {
    const step = k * mag;
    const first = Math.ceil(lo / step - 1e-9);
    const last = Math.floor(hi / step + 1e-9);
    if (last - first + 1 > max) continue;
    // Decimals of the step (2.5 has one more than its power of ten), so 0.1 steps read 18.4, not 18.400000000000002.
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (k === 2.5 ? 1 : 0));
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => Number(((first + i) * step).toFixed(decimals)) + 0);
  }
  return [];
}

/** An x axis label: its position as a share of the plot's width, and whether it wins over the others (the spot price). */
export interface XLabel {
  at: number;
  label: string;
  strong?: boolean;
}

/** Approximate width (px) of a 10px monospace label: 0.6em a character. */
const labelPx = (text: string) => text.length * 6;
/** Space (px) kept between two x labels. */
const LABEL_GAP = 8;

/**
 * The labels that fit a plot `width` px wide, at their x (px): strong ones first, then in order,
 * each dropped when it would touch one already kept.
 */
export function fitLabels(labels: readonly XLabel[], width: number): Array<XLabel & { x: number }> {
  if (!(width > 0)) return [];
  const kept: Array<XLabel & { x: number }> = [];
  const fits = (x: number, w: number) => kept.every((k) => Math.abs(k.x - x) >= (w + labelPx(k.label)) / 2 + LABEL_GAP);
  for (const l of [...labels.filter((l) => l.strong), ...labels.filter((l) => !l.strong)]) {
    const x = l.at * width;
    if (l.at < -1e-9 || l.at > 1 + 1e-9 || !fits(x, labelPx(l.label))) continue;
    kept.push({ ...l, x });
  }
  return kept.sort((a, b) => a.x - b.x);
}
