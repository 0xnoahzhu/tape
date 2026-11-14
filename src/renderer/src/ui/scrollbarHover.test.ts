import { describe, expect, it } from 'vitest';
import { scrollbarAt } from './scrollbarHover';

describe('scrollbarAt', () => {
  // A 200×100 scroller at (10, 20) with both 10px scrollbars.
  const box = { left: 10, top: 20, right: 210, bottom: 120, v: 10, h: 10 };

  it('finds the vertical bar on the right edge and the horizontal one on the bottom edge', () => {
    expect(scrollbarAt(box, 205, 50)).toBe('y');
    expect(scrollbarAt(box, 200, 20)).toBe('y');
    expect(scrollbarAt(box, 100, 115)).toBe('x');
    expect(scrollbarAt(box, 10, 110)).toBe('x');
  });

  it('is neither over the content, the corner or outside', () => {
    expect(scrollbarAt(box, 199, 50)).toBeNull();
    expect(scrollbarAt(box, 100, 109)).toBeNull();
    expect(scrollbarAt(box, 205, 115)).toBeNull();
    expect(scrollbarAt(box, 210, 50)).toBeNull();
    expect(scrollbarAt(box, 100, 120)).toBeNull();
  });

  it('only counts the scrollbars there are', () => {
    expect(scrollbarAt({ ...box, h: 0 }, 205, 115)).toBe('y');
    expect(scrollbarAt({ ...box, v: 0 }, 205, 115)).toBe('x');
    expect(scrollbarAt({ ...box, v: 0, h: 0 }, 205, 115)).toBeNull();
  });
});
