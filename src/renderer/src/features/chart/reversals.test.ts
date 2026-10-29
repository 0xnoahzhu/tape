import { describe, expect, it } from 'vitest';
import { findReversal, MIN_REVERSAL_BARS } from './reversals';
import { pathBars } from './__fixtures__/pathBars';

const shape = (r: ReturnType<typeof findReversal>) => r.points.map((p) => `${p.label}@${Math.round(p.price)}`).join(' ');

describe('findReversal', () => {
  it('finds a head and shoulders top, its neckline and the breakdown with its target', () => {
    // Up to the left shoulder (120), neckline 110, head 130, neckline 110, right shoulder 121, then through the neckline.
    const bars = pathBars([100, 120, 110, 130, 110, 121, 104], 6);
    // Selected with the move into it and out of it (the right shoulder is a turn only once the price falls from it).
    const r = findReversal(bars, 0, 36);
    expect(r.kind).toBe('headShouldersTop');
    expect(shape(r)).toBe('LS@120 N@110 H@130 N@110 RS@121');
    expect(r.neckline!.slope).toBeCloseTo(0, 5);
    expect(r.height!).toBeCloseTo(20.2, 1);
    // After the right shoulder (bar 30) the close goes under 110 at bar 34; the target is a height below the neckline.
    expect(r.breakout!.index).toBe(34);
    expect(r.breakout!.target).toBeCloseTo(110 - 0.1 - 20.2, 1);
  });

  it('finds a head and shoulders bottom', () => {
    const r = findReversal(pathBars([130, 110, 120, 100, 120, 109, 126], 6), 0, 36);
    expect(r.kind).toBe('headShouldersBottom');
    expect(shape(r)).toBe('LS@110 N@120 H@100 N@120 RS@109');
    expect(r.breakout?.index).toBeGreaterThan(30);
    // Cut off at the right shoulder, it is not one yet.
    expect(findReversal(pathBars([130, 110, 120, 100, 120, 109, 126], 6), 0, 30).kind).not.toBe('headShouldersBottom');
  });

  it('finds double tops and bottoms', () => {
    const top = findReversal(pathBars([100, 120, 108, 119.5, 100], 6), 0, 24);
    expect(top.kind).toBe('doubleTop');
    expect(shape(top)).toBe('T1@120 N@108 T2@120');
    expect(findReversal(pathBars([120, 100, 112, 100.5, 120], 6), 0, 24).kind).toBe('doubleBottom');
  });

  it('is not a head and shoulders with lopsided shoulders or a head no higher than them', () => {
    // Right shoulder barely above the neckline.
    expect(findReversal(pathBars([100, 120, 110, 130, 110, 112, 104], 6), 0, 36).kind).not.toBe('headShouldersTop');
    // A "head" level with the shoulders: a triple top, not a head and shoulders.
    expect(findReversal(pathBars([100, 120, 110, 120.5, 110, 120, 104], 6), 0, 36).kind).not.toBe('headShouldersTop');
  });

  it('finds nothing in a straight run, and needs enough bars', () => {
    expect(findReversal(pathBars([100, 130], 30), 0, 30)).toMatchObject({ kind: null, why: 'none' });
    expect(findReversal(pathBars([100, 120, 108, 119.5, 100], 6), 0, MIN_REVERSAL_BARS - 2)).toMatchObject({ kind: null, why: 'short' });
  });
});
