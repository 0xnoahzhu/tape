import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentEdges, isTruncated, overflows, placeTip } from './tipGeometry';

describe('overflows', () => {
  it('tells cut text from text that fits, ignoring rounding below a layout unit', () => {
    expect(overflows(179.875, 80)).toBe(true);
    expect(overflows(80.25, 80)).toBe(true);
    expect(overflows(61.38, 80)).toBe(false);
    expect(overflows(80, 80)).toBe(false);
    expect(overflows(80.01, 80)).toBe(false);
  });
});

describe('isTruncated and contentEdges', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A box `width` wide at x = 40 (with `padding` on both sides) holding text `text` wide. */
  const box = (width: number, text: number, padding = 0) => {
    vi.stubGlobal('document', { createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => ({ width: text }) }) });
    vi.stubGlobal('getComputedStyle', () => ({ paddingLeft: `${padding}px`, paddingRight: `${padding}px`, borderLeftWidth: '0px', borderRightWidth: '' }));
    return { getBoundingClientRect: () => ({ left: 40, right: 40 + width, width }) } as unknown as HTMLElement;
  };

  it('compares the natural width of the text with the content box', () => {
    expect(isTruncated(box(80, 179.875))).toBe(true);
    expect(isTruncated(box(300, 61.38))).toBe(false);
    expect(isTruncated(box(100, 90, 8))).toBe(true);
    expect(isTruncated(box(100, 84, 8))).toBe(false);
  });

  it('gives the edges inside the padding and border', () => {
    expect(contentEdges(box(100, 0))).toEqual({ left: 40, right: 140 });
    expect(contentEdges(box(100, 0, 12))).toEqual({ left: 52, right: 128 });
  });
});

describe('placeTip', () => {
  const view = { width: 1440, height: 900 };
  const size = { width: 240, height: 26 };

  it('goes under the hovered area, starting where the text starts', () => {
    expect(placeTip({ left: 640.4, top: 100, bottom: 140 }, size, view)).toEqual({ left: 640, top: 144 });
  });

  it('goes over the hovered area near the bottom of the window', () => {
    expect(placeTip({ left: 640, top: 840, bottom: 880 }, size, view)).toEqual({ left: 640, top: 810 });
  });

  it('stays under when it fits neither way but there is more room under, moved up into the window', () => {
    expect(placeTip({ left: 640, top: 300, bottom: 340 }, { width: 240, height: 600 }, view)).toEqual({ left: 640, top: 292 });
  });

  it('stays inside the window horizontally', () => {
    expect(placeTip({ left: 1300, top: 100, bottom: 140 }, size, view)).toEqual({ left: 1192, top: 144 });
    expect(placeTip({ left: -20, top: 100, bottom: 140 }, size, view)).toEqual({ left: 8, top: 144 });
    expect(placeTip({ left: 100, top: 100, bottom: 140 }, { width: 2000, height: 26 }, view)).toEqual({ left: 8, top: 144 });
  });
});
