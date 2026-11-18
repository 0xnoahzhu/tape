import { describe, expect, it } from 'vitest';
import { clampPoint, DEFAULT_PLACE, parsePlace, placePoint, pointPlace } from './model';

const size = { width: 140, height: 50 };
const area = { width: 1200, height: 800 };

describe('clock widget place', () => {
  it('reads a stored place, else the default', () => {
    expect(parsePlace({ corner: 'sw', dx: 20.4, dy: 30 })).toEqual({ corner: 'sw', dx: 20, dy: 30 });
    for (const bad of [null, 'x', {}, { corner: 'up', dx: 1, dy: 1 }, { corner: 'ne', dx: '1', dy: 1 }, { corner: 'ne', dx: NaN, dy: 1 }]) expect(parsePlace(bad)).toEqual(DEFAULT_PLACE);
    expect(parsePlace({ corner: 'ne', dx: -5, dy: 1e9 })).toEqual({ corner: 'ne', dx: 0, dy: 100_000 });
  });

  it('places by its corner, so a resized window keeps it there', () => {
    expect(placePoint({ corner: 'ne', dx: 16, dy: 56 }, size, area)).toEqual({ x: 1044, y: 56 });
    expect(placePoint({ corner: 'ne', dx: 16, dy: 56 }, size, { width: 900, height: 800 })).toEqual({ x: 744, y: 56 });
    expect(placePoint({ corner: 'se', dx: 20, dy: 30 }, size, area)).toEqual({ x: 1040, y: 720 });
    expect(placePoint({ corner: 'nw', dx: 100, dy: 200 }, size, area)).toEqual({ x: 100, y: 200 });
  });

  it('stays inside the area, by the margin', () => {
    expect(placePoint({ corner: 'nw', dx: 2000, dy: 0 }, size, area)).toEqual({ x: 1052, y: 8 });
    expect(clampPoint({ x: -50, y: 900 }, size, area)).toEqual({ x: 8, y: 742 });
    // An area smaller than the widget: at the top-left margin.
    expect(clampPoint({ x: 50, y: 50 }, size, { width: 100, height: 40 })).toEqual({ x: 8, y: 8 });
  });

  it('keeps where it was left by the nearest corner', () => {
    expect(pointPlace({ x: 1000, y: 60 }, size, area)).toEqual({ corner: 'ne', dx: 60, dy: 60 });
    expect(pointPlace({ x: 40, y: 700 }, size, area)).toEqual({ corner: 'sw', dx: 40, dy: 50 });
    expect(pointPlace({ x: 30, y: 20 }, size, area)).toEqual({ corner: 'nw', dx: 30, dy: 20 });
    // Back where it was left.
    for (const p of [{ x: 1000, y: 60 }, { x: 40, y: 700 }, { x: 700, y: 500 }]) expect(placePoint(pointPlace(p, size, area), size, area)).toEqual(p);
  });
});
