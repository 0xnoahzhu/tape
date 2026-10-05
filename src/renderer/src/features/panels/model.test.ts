import { describe, expect, it } from 'vitest';
import { BAR_SIZE, barRect, clampRect, DEFAULT_SIZE, DEFAULT_TOP, defaultRect, MARGIN, MIN_SIZE, moveRect, panelRect, resizeRect } from './model';

// The content area of a 1440×900 window (under the 56px top bar) and of the smallest one (1180×720).
const LARGE = { width: 1440, height: 844 };
const SMALL = { width: 1180, height: 664 };
const min = MIN_SIZE.ticket;

describe('where a floating panel opens', () => {
  it('opens at the approved 16:10 size over the right part, under the view tabs', () => {
    expect(defaultRect(LARGE, min)).toEqual({ x: LARGE.width - MARGIN - 1000, y: DEFAULT_TOP, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height });
  });

  it('is smaller in a small window, inside the margins', () => {
    const r = defaultRect(SMALL, min);
    expect(r.width).toBe(1000);
    expect(r.y).toBe(DEFAULT_TOP);
    expect(r.y + r.height).toBe(SMALL.height - MARGIN);
    expect(r.x + r.width).toBe(SMALL.width - MARGIN);
    const tiny = defaultRect({ width: 800, height: 500 }, min);
    expect(tiny).toEqual({ x: MARGIN, y: DEFAULT_TOP, width: 800 - 2 * MARGIN, height: 500 - DEFAULT_TOP - MARGIN });
  });

  it('never goes below the minimum, unless the area itself is smaller', () => {
    expect(defaultRect({ width: 1440, height: 400 }, min).height).toBe(400 - 2 * MARGIN);
    expect(defaultRect({ width: 1440, height: 480 }, min)).toMatchObject({ height: 420, y: 480 - MARGIN - 420 });
  });

  it('uses the remembered rectangle, fitted into the area', () => {
    expect(panelRect({ x: 40, y: 60, width: 800, height: 500 }, LARGE, min)).toEqual({ x: 40, y: 60, width: 800, height: 500 });
    expect(panelRect(null, LARGE, min)).toEqual(defaultRect(LARGE, min));
  });
});

describe('clamping to the content area', () => {
  it('moves a panel back inside after the window shrank', () => {
    expect(clampRect({ x: 1200, y: 600, width: 600, height: 450 }, min, SMALL)).toEqual({ x: SMALL.width - MARGIN - 600, y: SMALL.height - MARGIN - 450, width: 600, height: 450 });
    expect(clampRect({ x: -50, y: -20, width: 600, height: 450 }, min, SMALL)).toMatchObject({ x: MARGIN, y: MARGIN });
  });

  it('shrinks a panel larger than the area, and grows one below the minimum', () => {
    expect(clampRect({ x: 0, y: 0, width: 3000, height: 2000 }, min, SMALL)).toEqual({ x: MARGIN, y: MARGIN, width: SMALL.width - 2 * MARGIN, height: SMALL.height - 2 * MARGIN });
    expect(clampRect({ x: 100, y: 100, width: 100, height: 100 }, min, LARGE)).toMatchObject({ width: min.width, height: min.height });
    expect(clampRect({ x: 100, y: 100, width: 100, height: 100 }, MIN_SIZE.strategy, LARGE)).toMatchObject({ width: 384 });
  });
});

describe('dragging', () => {
  const start = { x: 400, y: 100, width: 600, height: 400 };

  it('follows the pointer', () => {
    expect(moveRect(start, -150, 60, LARGE)).toEqual({ x: 250, y: 160, width: 600, height: 400 });
  });

  it('stops at the margins of the content area, keeping the size', () => {
    expect(moveRect(start, -1000, -1000, LARGE)).toEqual({ x: MARGIN, y: MARGIN, width: 600, height: 400 });
    expect(moveRect(start, 5000, 5000, LARGE)).toEqual({ x: LARGE.width - MARGIN - 600, y: LARGE.height - MARGIN - 400, width: 600, height: 400 });
  });
});

describe('resizing from the edges and corners', () => {
  const start = { x: 400, y: 100, width: 600, height: 500 };

  it('moves only the dragged edges', () => {
    expect(resizeRect(start, 'e', 50, 999, min, LARGE)).toEqual({ ...start, width: 650 });
    expect(resizeRect(start, 's', 999, 40, min, LARGE)).toEqual({ ...start, height: 540 });
    expect(resizeRect(start, 'w', -100, 0, min, LARGE)).toEqual({ ...start, x: 300, width: 700 });
    expect(resizeRect(start, 'n', 0, 30, min, LARGE)).toEqual({ ...start, y: 130, height: 470 });
    expect(resizeRect(start, 'se', 20, 30, min, LARGE)).toEqual({ ...start, width: 620, height: 530 });
    expect(resizeRect(start, 'nw', -20, -30, min, LARGE)).toEqual({ x: 380, y: 70, width: 620, height: 530 });
    expect(resizeRect(start, 'ne', 20, -30, min, LARGE)).toEqual({ x: 400, y: 70, width: 620, height: 530 });
    expect(resizeRect(start, 'sw', -20, 30, min, LARGE)).toEqual({ x: 380, y: 100, width: 620, height: 530 });
  });

  it('stops at the minimum size, the opposite edge staying put', () => {
    expect(resizeRect(start, 'e', -1000, 0, min, LARGE)).toEqual({ ...start, width: min.width });
    expect(resizeRect(start, 'w', 1000, 0, min, LARGE)).toEqual({ ...start, x: 400 + 600 - min.width, width: min.width });
    expect(resizeRect(start, 'n', 0, 1000, min, LARGE)).toEqual({ ...start, y: 100 + 500 - min.height, height: min.height });
  });

  it('stops at the content area', () => {
    expect(resizeRect(start, 'e', 5000, 0, min, LARGE)).toEqual({ ...start, width: LARGE.width - MARGIN - 400 });
    expect(resizeRect(start, 'w', -5000, 0, min, LARGE)).toEqual({ ...start, x: MARGIN, width: 1000 - MARGIN });
    expect(resizeRect(start, 's', 0, 5000, min, LARGE)).toEqual({ ...start, height: LARGE.height - MARGIN - 100 });
    expect(resizeRect(start, 'n', 0, -5000, min, LARGE)).toEqual({ ...start, y: MARGIN, height: 600 - MARGIN });
  });
});

describe('the collapsed bar', () => {
  it('sits in the bottom-right corner until it is moved', () => {
    expect(barRect(null, LARGE)).toEqual({ x: LARGE.width - MARGIN - BAR_SIZE.width, y: LARGE.height - MARGIN - BAR_SIZE.height, ...BAR_SIZE });
  });

  it('keeps its own place, fitted into the area', () => {
    expect(barRect({ x: 100, y: 200 }, LARGE)).toEqual({ x: 100, y: 200, ...BAR_SIZE });
    expect(barRect({ x: 1400, y: 800 }, SMALL)).toEqual({ x: SMALL.width - MARGIN - BAR_SIZE.width, y: SMALL.height - MARGIN - BAR_SIZE.height, ...BAR_SIZE });
  });

  it('is narrower in a narrow area', () => {
    expect(barRect(null, { width: 300, height: 400 }).width).toBe(300 - 2 * MARGIN);
  });
});
