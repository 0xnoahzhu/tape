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
