// Geometry and persistence of a horizontal splitter that sizes the pane below it (pure, unit tested).

export interface SplitLimits {
  /** Smallest height of the pane below the splitter. */
  min: number;
  /** Smallest height left for the pane above it. */
  minAbove: number;
}

/**
 * Height of the lower pane, kept within its own minimum and the room the upper pane needs. When
 * the container is too small for both minimums, the upper pane gives way first.
 */
export function clampSplit(height: number, container: number, { min, minAbove }: SplitLimits): number {
  const max = Math.max(min, container - minAbove);
  if (!Number.isFinite(height)) return min;
  return Math.round(Math.min(max, Math.max(min, height)));
}

/** A side pane's width limits. */
export interface PaneLimits {
  min: number;
  max: number;
}

/**
 * A side pane's width within its own limits and `room`, the most the page leaves it (its width less
 * the other panes and the middle's minimum); short of room the pane keeps its minimum.
 */
export function clampPane(width: number, { min, max }: PaneLimits, room: number = Infinity): number {
  const hi = Math.max(min, Math.min(max, room));
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(hi, Math.max(min, width)));
}

/** A stored height, or `fallback` when storage is unavailable or holds something else. */
export function loadSplit(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function saveSplit(key: string, height: number): void {
  try {
    localStorage.setItem(key, String(Math.round(height)));
  } catch {
    // Storage blocked: the height lasts for this session only.
  }
}

/** A stored on/off preference (false when storage is unavailable). */
export function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts for this session only.
  }
}
