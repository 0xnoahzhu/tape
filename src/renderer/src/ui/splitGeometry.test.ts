import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampSplit, loadFlag, loadSplit, saveFlag, saveSplit } from './splitGeometry';

const limits = { min: 76, minAbove: 200 };

describe('clampSplit', () => {
  it('keeps the lower pane between its minimum and the room the upper pane needs', () => {
    expect(clampSplit(150, 700, limits)).toBe(150);
    expect(clampSplit(40, 700, limits)).toBe(76);
    expect(clampSplit(650, 700, limits)).toBe(500);
    expect(clampSplit(123.6, 700, limits)).toBe(124);
  });

  it('lets the upper pane give way when the container is too small for both', () => {
    expect(clampSplit(150, 240, limits)).toBe(76);
    expect(clampSplit(NaN, 700, limits)).toBe(76);
  });
});

describe('persistence', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  afterEach(() => store.clear());

  it('stores the height and the collapsed flag, falling back on bad values', () => {
    expect(loadSplit('h', 150)).toBe(150);
    saveSplit('h', 212.4);
    expect(loadSplit('h', 150)).toBe(212);
    store.set('h', 'abc');
    expect(loadSplit('h', 150)).toBe(150);
    expect(loadFlag('c')).toBe(false);
    saveFlag('c', true);
    expect(loadFlag('c')).toBe(true);
  });

  it('works without storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadSplit('h', 150)).toBe(150);
    expect(() => saveSplit('h', 200)).not.toThrow();
    expect(loadFlag('c')).toBe(false);
  });
});
