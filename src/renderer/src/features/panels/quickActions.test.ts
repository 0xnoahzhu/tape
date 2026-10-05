import { describe, expect, it } from 'vitest';
import { closingSide, positionQty, priceTarget, QTY_CHIPS, qtyChipText, quotePrice, stepPrice } from './quickActions';

describe('quantity chips', () => {
  it('are 100, 500 and 1K', () => {
    expect(QTY_CHIPS.map(qtyChipText)).toEqual(['100', '500', '1K']);
    expect(qtyChipText(2500)).toBe('2500');
  });

  it('fill the position size (long or short), and none without a position', () => {
    expect(positionQty(200)).toBe(200);
    expect(positionQty(-300)).toBe(300);
    expect(positionQty(0)).toBeNull();
    expect(positionQty(undefined)).toBeNull();
    expect(positionQty(Number.NaN)).toBeNull();
    expect(closingSide(200)).toBe('SELL');
    expect(closingSide(-300)).toBe('BUY');
  });
});

describe('prices from the quote', () => {
  const q = { bid: 227.53, ask: 227.58 };

  it('takes the bid or the ask on the tick', () => {
    expect(quotePrice('bid', q, 0.01, 'BUY')).toBe(227.53);
    expect(quotePrice('ask', q, 0.01, 'SELL')).toBe(227.58);
    expect(quotePrice('bid', { bid: 4.123 }, 0.05, 'BUY')).toBe(4.1);
  });

  it('rounds the mid to the tick on the passive side', () => {
    // Mid 227.555: a buy bids 227.55, a sell offers 227.56.
    expect(quotePrice('mid', q, 0.01, 'BUY')).toBe(227.55);
    expect(quotePrice('mid', q, 0.01, 'SELL')).toBe(227.56);
    // A mid on the tick stays (no float drift: 0.1 + 0.2).
    expect(quotePrice('mid', { bid: 0.1, ask: 0.3 }, 0.01, 'BUY')).toBe(0.2);
    expect(quotePrice('mid', { bid: 0.1, ask: 0.3 }, 0.01, 'SELL')).toBe(0.2);
    // Futures ticks.
    expect(quotePrice('mid', { bid: 5000.25, ask: 5000.75 }, 0.25, 'BUY')).toBe(5000.5);
    expect(quotePrice('mid', { bid: 5000.25, ask: 5000.5 }, 0.25, 'BUY')).toBe(5000.25);
    expect(quotePrice('mid', { bid: 5000.25, ask: 5000.5 }, 0.25, 'SELL')).toBe(5000.5);
  });

  it('gives nothing without the sides it needs', () => {
    expect(quotePrice('bid', { ask: 1 }, 0.01, 'BUY')).toBeNull();
    expect(quotePrice('mid', { bid: 1 }, 0.01, 'BUY')).toBeNull();
    expect(quotePrice('ask', { ask: 0 }, 0.01, 'BUY')).toBeNull();
  });
});

describe('stepPrice', () => {
  it('moves one tick and stays on the tick grid', () => {
    expect(stepPrice(227.55, 1, 0.01)).toBe(227.56);
    expect(stepPrice(227.55, -1, 0.01)).toBe(227.54);
    expect(stepPrice(0.3, -1, 0.1)).toBe(0.2);
    expect(stepPrice(5000.25, 1, 0.25)).toBe(5000.5);
  });

  it('never goes below one tick, and needs a price', () => {
    expect(stepPrice(0.01, -1, 0.01)).toBe(0.01);
    expect(stepPrice(undefined, 1, 0.01)).toBeNull();
  });
});

describe('where a price from the quote goes', () => {
  it('a limit order: the limit, from the boxes and the chips', () => {
    expect(priceTarget('LMT', 'limitPrice', false, 'quote')).toBe('limitPrice');
    expect(priceTarget('LMT', 'limitPrice', false, 'chip')).toBe('limitPrice');
  });

  it('a stop limit / LIT: the boxes fill the limit, the chips under the trigger the trigger', () => {
    expect(priceTarget('STP LMT', 'stopPrice', false, 'quote')).toBe('limitPrice');
    expect(priceTarget('STP LMT', 'stopPrice', false, 'chip')).toBe('stopPrice');
    expect(priceTarget('LIT', 'stopPrice', false, 'quote')).toBe('limitPrice');
    expect(priceTarget('LIT', 'stopPrice', false, 'chip')).toBe('stopPrice');
    expect(priceTarget('STP', 'stopPrice', false, 'quote')).toBe('stopPrice');
  });

  it('a market order becomes a limit order, except while modifying; offsets take no price', () => {
    expect(priceTarget('MKT', null, false, 'chip')).toBe('toLimit');
    expect(priceTarget('MTL', null, false, 'quote')).toBe('toLimit');
    expect(priceTarget('MKT', null, true, 'quote')).toBeNull();
    expect(priceTarget('MOC', null, false, 'quote')).toBeNull();
    expect(priceTarget('REL', 'offset', false, 'chip')).toBeNull();
  });
});
