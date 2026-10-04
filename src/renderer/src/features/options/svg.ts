// Scaling helpers for the desk's small SVG charts (design `chart()`).

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
