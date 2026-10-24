import { describe, expect, it } from 'vitest';
import { chartScale, fitLabels, niceTicks } from './svg';

describe('axis values', () => {
  it('takes round values within the range, at most as many as asked', () => {
    expect(niceTicks(17.4, 31.2, 5)).toEqual([20, 25, 30]);
    expect(niceTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(220, 245, 6)).toEqual([220, 225, 230, 235, 240, 245]);
    expect(niceTicks(5700, 5740, 4)).toEqual([5700, 5720, 5740]);
  });

  it('reads small steps without float noise', () => {
    expect(niceTicks(18.2, 19.1, 5)).toEqual([18.2, 18.4, 18.6, 18.8, 19]);
    expect(niceTicks(0.5, 0.9, 4)).toEqual([0.6, 0.8]);
    expect(niceTicks(-1, 1, 5)).toEqual([-1, -0.5, 0, 0.5, 1]);
  });

  it('gives nothing for an empty or broken range', () => {
    expect(niceTicks(5, 5)).toEqual([]);
    expect(niceTicks(NaN, 5)).toEqual([]);
    expect(niceTicks(1, 2, 0)).toEqual([]);
  });

  it('places the ticks of a padded scale inside it', () => {
    const s = chartScale([0, 1], [20, 30], 600, 200);
    const ticks = niceTicks(s.y0, s.y1, 4);
    expect(ticks.every((v) => s.Y(v) >= 0 && s.Y(v) <= 200)).toBe(true);
  });
});

describe('x labels', () => {
  it('keeps the labels that fit, the strong ones first', () => {
    const labels = [
      { at: 0, label: '200' },
      { at: 0.1, label: '210' },
      { at: 0.5, label: '250' },
      { at: 0.52, label: '251.37', strong: true },
      { at: 1, label: '300' },
    ];
    // 400 px: 210 is 40 px from 200 (needs 26), 250 is 8 px from the spot (needs 47).
    expect(fitLabels(labels, 400).map((l) => l.label)).toEqual(['200', '210', '251.37', '300']);
    expect(fitLabels(labels, 400).find((l) => l.label === '251.37')?.x).toBeCloseTo(208);
    // 100 px: 210 touches 200 now.
    expect(fitLabels(labels, 100).map((l) => l.label)).toEqual(['200', '251.37', '300']);
  });

  it('leaves out labels off the plot, and everything without a width', () => {
    expect(fitLabels([{ at: -0.1, label: 'a' }, { at: 1.2, label: 'b' }, { at: 0.5, label: 'c' }], 300).map((l) => l.label)).toEqual(['c']);
    expect(fitLabels([{ at: 0.5, label: 'c' }], 0)).toEqual([]);
  });
});
