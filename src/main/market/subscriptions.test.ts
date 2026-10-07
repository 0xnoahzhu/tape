import { describe, expect, it } from 'vitest';
import { index, option, stock } from '@shared/contract';
import { ADD_ON_PROFILES, ADD_ON_TICKS } from '@shared/quoteProfiles';
import type { ContractRef, QuoteProfile, SecType } from '@shared/types';
import {
  allocateLines,
  coversTicks,
  genericTicksFor,
  LEGAL_GENERIC_TICKS,
  lineServes,
  NEVER_REQUESTED,
  ownerPriority,
  OwnerPriority,
  SubscriptionBook,
  type TickLevel,
} from './subscriptions';

const future: ContractRef = { symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218' };
const forex: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };
const bond: ContractRef = { symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 1 };
const ALL_TYPES: SecType[] = ['STK', 'OPT', 'IND', 'FUT', 'FOP', 'CASH', 'BAG', 'CFD', 'BOND', 'WAR', 'CRYPTO'];
const BASE_PROFILES: QuoteProfile[] = ['basic', 'underlying', 'option', 'dividends'];

describe('the legal generic ticks', () => {
  // IB's 321 "Legal ones" list, the same for every type the probe asked about (paper account, server 193).
  const PROBED = [100, 101, 105, 106, 165, 221, 225, 232, 233, 236, 258, 292, 293, 294, 295, 318, 375, 411, 456, 460, 499, 577, 586, 587, 588, 595, 614, 619, 623, 787];

  it('equals the probe’s lists; warrants and combos get none', () => {
    for (const t of ['STK', 'OPT', 'IND', 'FUT', 'FOP', 'CASH', 'CRYPTO', 'CFD', 'BOND'] as const) expect([...LEGAL_GENERIC_TICKS[t]].sort((a, b) => a - b), t).toEqual(PROBED);
    expect(LEGAL_GENERIC_TICKS.WAR.size).toBe(0);
    expect(LEGAL_GENERIC_TICKS.BAG.size).toBe(0);
    // Illegal everywhere: historical volatility (104), 576, 578.
    for (const t of ALL_TYPES) for (const id of [104, 576, 578]) expect(LEGAL_GENERIC_TICKS[t].has(id)).toBe(false);
    expect([...NEVER_REQUESTED].sort((a, b) => a - b)).toEqual([232, 258, 292, 375, 586, 587, 619, 787]);
  });

  it('keeps every type × profile × level within the legal ids Tape asks for', () => {
    const profiles: QuoteProfile[] = [...BASE_PROFILES, ...ADD_ON_PROFILES];
    for (const secType of ALL_TYPES) {
      for (const p of profiles) {
        for (const level of ['full', 'core', 'none'] as TickLevel[]) {
          const ticks = genericTicksFor({ secType }, [p], level);
          for (const id of ticks ? ticks.split(',').map(Number) : []) {
            expect(LEGAL_GENERIC_TICKS[secType].has(id), `${secType} ${p} ${level} ${id}`).toBe(true);
            expect(NEVER_REQUESTED.has(id), `${secType} ${p} ${level} ${id}`).toBe(false);
          }
        }
      }
    }
    // Never 104, 258 or 787, whatever is asked for.
    const everything = genericTicksFor(stock('AAPL'), profiles);
    for (const id of ['104', '258', '787']) expect(everything.split(',')).not.toContain(id);
  });
});

describe('genericTicksFor', () => {
  it('uses the profile tick lists per instrument type', () => {
    expect(genericTicksFor(stock('AAPL'), ['basic'])).toBe('318');
    // 104 is not legal: real-time historical volatility (411) takes its place.
    expect(genericTicksFor(stock('AAPL'), ['underlying'])).toBe('100,101,106,165,318,411,456');
    expect(genericTicksFor(option('AAPL', '20261016', 230, 'C'), ['option'])).toBe('100,101,106,221');
    expect(genericTicksFor(index('SPX', 'CBOE'), ['basic'])).toBe('');
    expect(genericTicksFor(index('SPX', 'CBOE'), ['underlying'])).toBe('100,101,106,165,411');
  });

  it('adds IB dividends (456) to stocks only', () => {
    expect(genericTicksFor(stock('AAPL'), ['dividends'])).toBe('318,456');
    expect(genericTicksFor(stock('AAPL'), ['underlying', 'dividends'])).toBe('100,101,106,165,318,411,456');
    expect(genericTicksFor(index('SPX', 'CBOE'), ['dividends'])).toBe('');
    expect(genericTicksFor(option('AAPL', '20261016', 230, 'C'), ['option', 'dividends'])).toBe('100,101,106,221');
  });

  it('unions the ticks of several profiles', () => {
    expect(genericTicksFor(stock('AAPL'), ['basic', 'underlying'])).toBe('100,101,106,165,318,411,456');
  });

  it('adds an add-on profile’s ticks to the type’s basic ones, only where the probe saw data', () => {
    expect(genericTicksFor(stock('AAPL'), ['range'])).toBe('165,318');
    expect(genericTicksFor(stock('AAPL'), ['volatility'])).toBe('106,318,411');
    expect(genericTicksFor(stock('AAPL'), ['shortSale'])).toBe('236,318,499');
    expect(genericTicksFor(stock('SPY'), ['etfNav'])).toBe('318,577,614,623');
    expect(genericTicksFor(future, ['futuresOi'])).toBe('588');
    expect(genericTicksFor(future, ['optionFlow', 'activity'])).toBe('101,295');
    expect(genericTicksFor(forex, ['mark'])).toBe('221');
    expect(genericTicksFor(bond, ['bondFactor'])).toBe('460');
    // A profile with nothing for the type adds nothing; options carry the mark already.
    expect(genericTicksFor(forex, ['range'])).toBe('');
    expect(genericTicksFor(option('AAPL', '20261016', 230, 'C'), ['option', 'mark'])).toBe('100,101,106,221');
    // Each add-on list contains the basic one, so a line with add-ons covers the basic profile.
    for (const p of ADD_ON_PROFILES) for (const t of Object.keys(ADD_ON_TICKS[p]) as SecType[]) expect(coversTicks(genericTicksFor({ secType: t }, [p]), genericTicksFor({ secType: t }, ['basic']))).toBe(true);
  });

  it('leaves the add-ons out at the core level and every generic tick at none', () => {
    const profiles: QuoteProfile[] = ['dividends', 'range', 'shortSale'];
    expect(genericTicksFor(stock('AAPL'), profiles)).toBe('165,236,318,456,499');
    expect(genericTicksFor(stock('AAPL'), profiles, 'core')).toBe('318,456');
    expect(genericTicksFor(stock('AAPL'), ['underlying', 'vwap'], 'core')).toBe('100,101,106,165,318,411,456');
    expect(genericTicksFor(stock('AAPL'), profiles, 'none')).toBe('');
    expect(genericTicksFor(forex, ['mark'], 'core')).toBe('');
  });

  it('nests the stock profiles, so a line covers every narrower one', () => {
    const t = (p: 'basic' | 'dividends' | 'underlying') => genericTicksFor(stock('AAPL'), [p]);
    expect(coversTicks(t('underlying'), t('dividends'))).toBe(true);
    expect(coversTicks(t('dividends'), t('basic'))).toBe(true);
    expect(coversTicks(t('dividends'), t('underlying'))).toBe(false);
  });

  it('keeps a wider line for a narrower list, unless it carries RTVolume no one wants', () => {
    const t = (...p: QuoteProfile[]) => genericTicksFor(stock('AAPL'), p);
    expect(lineServes(t('basic', 'range'), t('basic'))).toBe(true);
    expect(lineServes(t('underlying'), t('dividends'))).toBe(true);
    expect(lineServes(t('basic'), t('basic', 'range'))).toBe(false);
    // 233 sends a message per trade: the line goes once VWAP is hidden.
    expect(lineServes(t('basic', 'vwap'), t('basic'))).toBe(false);
    expect(lineServes(t('basic', 'vwap', 'range'), t('basic', 'range'))).toBe(false);
    expect(lineServes(t('basic', 'vwap', 'range'), t('basic', 'vwap'))).toBe(true);
    expect(lineServes('', '')).toBe(true);
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

  it('gives an unknown profile the basic ticks', () => {
    const b = new SubscriptionBook();
    b.set('a', [{ contract: stock('AAPL'), profile: 'fundamentals' as QuoteProfile }], 'renderer');
    expect(b.wanted()[0].profiles).toEqual(['basic']);
  });

  it('adds the Positions table’s extra ticks without a new contract or a new priority', () => {
    const b = new SubscriptionBook();
    const held = [stock('AAPL'), { ...stock('SPY'), primaryExchange: 'ARCA' }, future];
    b.set('portfolio', held.map((contract) => ({ contract, profile: 'basic' as const })), 'renderer');
    b.set('chart', [{ contract: stock('NVDA'), profile: 'basic' }], 'renderer');
    const before = b.wanted().map((w) => [w.key, w.priority]);
    expect(
      b.set(
        'positions-table',
        [
          { contract: stock('AAPL'), profile: 'range' },
          { contract: stock('AAPL'), profile: 'shortSale' },
          { contract: future, profile: 'futuresOi' },
        ],
        'renderer',
      ),
    ).toBe(true);
    const after = b.wanted();
    expect(after.map((w) => [w.key, w.priority])).toEqual(before);
    expect(after.find((w) => w.key === 'STK:AAPL')!.profiles).toEqual(['basic', 'range', 'shortSale']);
    expect(allocateLines(after).active).toHaveLength(4);
    expect(ownerPriority('positions-table')).toBe(OwnerPriority.Background);
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
    expect(coversTicks('100,101,106,165,318,411', '318')).toBe(true);
    expect(coversTicks('318', '100,101,106,165,318,411')).toBe(false);
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
