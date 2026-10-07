import { describe, expect, it } from 'vitest';
import { DESK_TABS } from '../features/options/deskStore';
import { TRADE_VIEWS } from './tradeViews';

describe('trade page views', () => {
  it('has Chart and Options, with or without Level 2 (the book is in the ticket)', () => {
    expect(TRADE_VIEWS).toEqual(['chart', 'opt']);
  });

  it('the options desk has Chain and Volatility (its positions are in the activity panel)', () => {
    expect(DESK_TABS).toEqual(['chain', 'vol']);
  });
});
