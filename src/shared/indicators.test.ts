import { describe, expect, it } from 'vitest';
import { sma } from './indicators';

describe('sma', () => {
  it('averages the last n values once n are there', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
    expect(sma([1, 2], 1)).toEqual([1, 2]);
  });

  it('is undefined everywhere for an invalid period', () => {
    expect(sma([1, 2, 3], 0)).toEqual([undefined, undefined, undefined]);
    expect(sma([1, 2, 3], 1.5)).toEqual([undefined, undefined, undefined]);
  });
});
