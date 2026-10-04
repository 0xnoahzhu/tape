import { describe, expect, it } from 'vitest';
import type { Quote } from '@shared/types';
import { QuoteOwners, withoutQuotes } from './quoteSubscriptions';

describe('QuoteOwners', () => {
  it('reports keys an owner releases and whether any owner still wants them', () => {
    const owners = new QuoteOwners();
    expect(owners.set('chain', ['A', 'B'])).toEqual([]);
    expect(owners.set('legs', ['B'])).toEqual([]);
    expect(owners.set('chain', ['C'])).toEqual(['A', 'B']);
    expect(owners.wanted('A')).toBe(false);
    expect(owners.wanted('B')).toBe(true);
    expect(owners.set('legs', [])).toEqual(['B']);
    expect(owners.wanted('B')).toBe(false);
    expect(owners.set('chain', [])).toEqual(['C']);
  });
});

describe('withoutQuotes', () => {
  const q = (key: string): Quote => ({ key, updatedAt: 0 });

  it('removes the given keys', () => {
    expect(withoutQuotes({ A: q('A'), B: q('B') }, ['A', 'X'])).toEqual({ B: q('B') });
  });

  it('keeps the same object when nothing is removed', () => {
    const quotes = { A: q('A') };
    expect(withoutQuotes(quotes, ['X'])).toBe(quotes);
  });
});
