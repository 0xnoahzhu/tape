import { describe, expect, it } from 'vitest';
import { addRange, clipRanges, MAX_RANGES, normalizeRanges, parseCoverage, rangeBefore, subtractRange, type Range } from './coverage';

describe('coverage ranges', () => {
  it('normalizes: sorted, merged when overlapping or touching, invalid ranges dropped', () => {
    expect(
      normalizeRanges([
        [50, 60],
        [10, 20],
        [20, 30],
        [15, 18],
        [40, 45],
        [44, 50],
        [7, 7],
        [9, 3],
        [NaN, 4],
      ]),
    ).toEqual([
      [10, 30],
      [40, 60],
    ]);
  });

  it('adds a range, filling the gap between two', () => {
    const r: Range[] = [
      [0, 10],
      [20, 30],
    ];
    expect(addRange(r, [10, 20])).toEqual([[0, 30]]);
    expect(addRange(r, [12, 15])).toEqual([
      [0, 10],
      [12, 15],
      [20, 30],
    ]);
    expect(addRange(r, [5, 5])).toEqual(r);
    // The input is not modified.
    expect(r).toEqual([
      [0, 10],
      [20, 30],
    ]);
  });

  it('keeps the newest ranges when there are too many', () => {
    let r: Range[] = [];
    for (let i = 0; i < MAX_RANGES + 5; i++) r = addRange(r, [i * 10, i * 10 + 5]);
    expect(r).toHaveLength(MAX_RANGES);
    expect(r[r.length - 1]).toEqual([(MAX_RANGES + 4) * 10, (MAX_RANGES + 4) * 10 + 5]);
    expect(r[0]).toEqual([50, 55]);
  });

  it('subtracts and clips', () => {
    const r: Range[] = [
      [0, 10],
      [20, 30],
    ];
    expect(subtractRange(r, [5, 25])).toEqual([
      [0, 5],
      [25, 30],
    ]);
    expect(subtractRange(r, [2, 4])).toEqual([
      [0, 2],
      [4, 10],
      [20, 30],
    ]);
    expect(subtractRange(r, [-5, 100])).toEqual([]);
    expect(subtractRange(r, [7, 7])).toEqual(r);
    expect(clipRanges(r, 5)).toEqual([
      [5, 10],
      [20, 30],
    ]);
    expect(clipRanges(r, 5, 22)).toEqual([
      [5, 10],
      [20, 22],
    ]);
    expect(clipRanges(r, 30)).toEqual([]);
  });

  it('finds the range that holds the time just before t', () => {
    const r: Range[] = [
      [0, 10],
      [20, 30],
    ];
    expect(rangeBefore(r, 10)).toEqual([0, 10]);
    expect(rangeBefore(r, 5)).toEqual([0, 10]);
    expect(rangeBefore(r, 0)).toBeUndefined();
    expect(rangeBefore(r, 15)).toBeUndefined();
    expect(rangeBefore(r, 21)).toEqual([20, 30]);
    expect(rangeBefore(r, 31)).toBeUndefined();
  });

  it('parses persisted documents defensively', () => {
    expect(parseCoverage({ ranges: [[20, 30], [0, 10], 'x', [5, 1]], fetchedAt: 7, first: 3 })).toEqual({
      ranges: [
        [0, 10],
        [20, 30],
      ],
      fetchedAt: 7,
      first: 3,
    });
    expect(parseCoverage(null)).toEqual({ ranges: [] });
    expect(parseCoverage({ ranges: 'nope', fetchedAt: 'x' })).toEqual({ ranges: [] });
  });
});
