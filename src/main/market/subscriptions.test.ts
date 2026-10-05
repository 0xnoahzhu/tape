import { describe, expect, it } from 'vitest';
import { index, option, stock } from '@shared/contract';
import { allocateLines, coversTicks, genericTicksFor, ownerPriority, OwnerPriority, SubscriptionBook } from './subscriptions';

describe('genericTicksFor', () => {
  it('uses the profile tick lists per instrument type', () => {
    expect(genericTicksFor(stock('AAPL'), ['basic'])).toBe('318');
    expect(genericTicksFor(stock('AAPL'), ['underlying'])).toBe('100,101,104,106,165,318,456');
    expect(genericTicksFor(option('AAPL', '20261016', 230, 'C'), ['option'])).toBe('100,101,106,221');
    expect(genericTicksFor(index('SPX', 'CBOE'), ['basic'])).toBe('');
    expect(genericTicksFor(index('SPX', 'CBOE'), ['underlying'])).toBe('100,101,104,106,165');
  });

  it('adds IB dividends (456) to stocks only', () => {
    expect(genericTicksFor(stock('AAPL'), ['dividends'])).toBe('318,456');
    expect(genericTicksFor(stock('AAPL'), ['underlying', 'dividends'])).toBe('100,101,104,106,165,318,456');
    expect(genericTicksFor(index('SPX', 'CBOE'), ['dividends'])).toBe('');
    expect(genericTicksFor(option('AAPL', '20261016', 230, 'C'), ['option', 'dividends'])).toBe('100,101,106,221');
  });

  it('unions the ticks of several profiles', () => {
    expect(genericTicksFor(stock('AAPL'), ['basic', 'underlying'])).toBe('100,101,104,106,165,318,456');
  });

  it('nests the stock profiles, so a line covers every narrower one', () => {
    const t = (p: 'basic' | 'dividends' | 'underlying') => genericTicksFor(stock('AAPL'), [p]);
    expect(coversTicks(t('underlying'), t('dividends'))).toBe(true);
    expect(coversTicks(t('dividends'), t('basic'))).toBe(true);
    expect(coversTicks(t('dividends'), t('underlying'))).toBe(false);
  });
});

describe('SubscriptionBook', () => {
  it('unions owners by contract key and merges profiles', () => {
    const b = new SubscriptionBook();
    b.set('watchlist', [
      { contract: stock('AAPL'), profile: 'basic' },
      { contract: stock('NVDA'), profile: 'basic' },
    ]);
    b.set('options', [{ contract: { ...stock('AAPL'), conId: 265598 }, profile: 'underlying' }]);
    const w = b.wanted();
    expect(w.map((x) => x.key)).toEqual(['STK:AAPL', 'STK:NVDA']);
    expect(w[0].profiles).toEqual(['basic', 'underlying']);
    expect(w[0].contract.conId).toBe(265598); // the resolved description wins
  });

  it('keeps first-come priority and drops contracts no owner wants', () => {
    const b = new SubscriptionBook();
    b.set('a', [{ contract: stock('AAPL'), profile: 'basic' }]);
    b.set('b', [{ contract: stock('TSLA'), profile: 'basic' }]);
    b.set('a', [
      { contract: stock('MSFT'), profile: 'basic' },
      { contract: stock('AAPL'), profile: 'basic' },
    ]);
    expect(b.wanted().map((x) => x.key)).toEqual(['STK:AAPL', 'STK:TSLA', 'STK:MSFT']);
    b.set('a', []);
    expect(b.wanted().map((x) => x.key)).toEqual(['STK:TSLA']);
    expect(b.has('STK:AAPL')).toBe(false);
    // Re-adding a dropped contract puts it at the back of the queue.
    b.set('a', [{ contract: stock('AAPL'), profile: 'basic' }]);
    expect(b.wanted().map((x) => x.key)).toEqual(['STK:TSLA', 'STK:AAPL']);
  });

  it('reports whether the wanted set changed', () => {
    const b = new SubscriptionBook();
    expect(b.set('a', [{ contract: stock('AAPL'), profile: 'basic' }])).toBe(true);
    expect(b.set('a', [{ contract: stock('AAPL'), profile: 'basic' }])).toBe(false);
    expect(b.set('b', [{ contract: stock('AAPL'), profile: 'basic' }])).toBe(false);
    expect(b.set('b', [{ contract: stock('AAPL'), profile: 'underlying' }])).toBe(true);
  });

  it('ignores malformed subscriptions', () => {
    const b = new SubscriptionBook();
    // @ts-expect-error deliberately malformed input from IPC
    b.set('a', [null, { contract: { symbol: '' }, profile: 'basic' }, { contract: stock('AAPL'), profile: 'basic' }]);
    expect(b.wanted().map((x) => x.key)).toEqual(['STK:AAPL']);
  });
});

describe('owner priority', () => {
  it('orders visible owners before background ones, then first come', () => {
    const b = new SubscriptionBook();
    b.set('portfolio', [{ contract: stock('AAPL'), profile: 'basic' }]);
    b.set('alerts', [{ contract: stock('TSLA'), profile: 'basic' }]);
    b.set('chart', [{ contract: stock('NVDA'), profile: 'basic' }]);
    b.set('options-alerts-und', [{ contract: stock('MSFT'), profile: 'basic' }]);
    expect(b.wanted().map((w) => [w.key, w.priority])).toEqual([
      ['STK:NVDA', OwnerPriority.Visible],
      ['STK:MSFT', OwnerPriority.Visible],
      ['STK:AAPL', OwnerPriority.Background],
      ['STK:TSLA', OwnerPriority.Background],
    ]);
    // A visible owner lifts a background contract; that counts as a change.
    expect(b.set('watchlist', [{ contract: stock('TSLA'), profile: 'basic' }])).toBe(true);
    expect(b.wanted().map((w) => w.key)).toEqual(['STK:TSLA', 'STK:NVDA', 'STK:MSFT', 'STK:AAPL']);
  });

  it('publishes only what renderer owners want, keeps owners of the same name apart and drops the renderer\'s at once', () => {
    const b = new SubscriptionBook();
    expect(b.set('alerts', [{ contract: stock('NVDA'), profile: 'basic' }])).toBe(true);
    expect(b.published('STK:NVDA')).toBe(false);
    expect(b.set('watchlist', [{ contract: stock('NVDA'), profile: 'basic' }], 'renderer')).toBe(true);
    expect(b.published('STK:NVDA')).toBe(true);
    // A renderer owner named like a main-process one does not replace it.
    b.set('alerts', [{ contract: stock('MSFT'), profile: 'basic' }], 'renderer');
    expect(b.wanted().map((w) => w.key)).toEqual(['STK:NVDA', 'STK:MSFT']);
    expect(b.clearRenderer()).toBe(true);
    expect(b.wanted().map((w) => w.key)).toEqual(['STK:NVDA']);
    expect(b.published('STK:NVDA')).toBe(false);
    expect(b.clearRenderer()).toBe(false);
  });

  it('classifies owners', () => {
    for (const o of ['chart', 'ticket', 'watchlist', 'search', 'options-chain', 'options-underlying', 'options-legs']) expect(ownerPriority(o)).toBe(OwnerPriority.Visible);
    for (const o of ['alerts', 'options-risk', 'options-term', 'portfolio', 'bell-risk-count', 'bell-alerts']) expect(ownerPriority(o)).toBe(OwnerPriority.Background);
  });
});

describe('coversTicks', () => {
  it('accepts a line whose generic ticks include the needed ones', () => {
    expect(coversTicks('100,101,104,106,165,318', '318')).toBe(true);
    expect(coversTicks('318', '100,101,104,106,165,318')).toBe(false);
    expect(coversTicks('', '')).toBe(true);
    expect(coversTicks('318', '')).toBe(true);
    expect(coversTicks('', '318')).toBe(false);
  });
});

describe('allocateLines', () => {
  it('caps the number of lines in priority order', () => {
    const b = new SubscriptionBook();
    b.set(
      'big',
      Array.from({ length: 100 }, (_, i) => ({ contract: stock(`S${i}`), profile: 'basic' as const })),
    );
    const { active, overflow } = allocateLines(b.wanted(), 95);
    expect(active).toHaveLength(95);
    expect(overflow.map((w) => w.key)).toEqual(['STK:S95', 'STK:S96', 'STK:S97', 'STK:S98', 'STK:S99']);
  });
});
