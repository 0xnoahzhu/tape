import { describe, expect, it } from 'vitest';
import { index, stock } from '@shared/contract';
import type { ChainExpiry } from './chain';
import { addLeg, buildStrategy, hasStockLeg, legContract, STRATEGIES, type Leg } from './strategies';

const strikes = [90, 95, 100, 105, 110, 115, 120];
const exp = (expiry: string): ChainExpiry => ({ expiry, tradingClass: 'AAPL', multiplier: 100, exchange: 'SMART', strikes });
const chain = [exp('20261009'), exp('20261016'), exp('20261023')];

describe('buildStrategy', () => {
  it('has every template from the design', () => {
    expect(STRATEGIES.map((s) => s.key)).toEqual(['single', 'vertical', 'covered', 'collar', 'straddle', 'strangle', 'calendar', 'diagonal', 'fly', 'condor', 'ironfly', 'icondor', 'custom']);
  });

  it('builds a vertical two strikes apart', () => {
    const legs = buildStrategy('vertical', chain, 0, 104);
    expect(legs.map((l) => [l.side, l.right, l.strike, l.expiry])).toEqual([
      ['BUY', 'C', 105, '20261009'],
      ['SELL', 'C', 115, '20261009'],
    ]);
  });

  it('builds a butterfly with a 2× body', () => {
    const legs = buildStrategy('fly', chain, 1, 100);
    expect(legs.map((l) => [l.side, l.strike, l.qty])).toEqual([
      ['BUY', 90, 1],
      ['SELL', 100, 2],
      ['BUY', 110, 1],
    ]);
  });

  it('clamps strikes to the list', () => {
    const legs = buildStrategy('icondor', chain, 0, 90);
    expect(legs.map((l) => l.strike)).toEqual([90, 90, 100, 110]);
  });

  it('uses the next expiry for calendar back months, and the previous pair on the last expiry', () => {
    expect(buildStrategy('calendar', chain, 0, 100).map((l) => l.expiry)).toEqual(['20261009', '20261016']);
    expect(buildStrategy('calendar', chain, 2, 100).map((l) => l.expiry)).toEqual(['20261016', '20261023']);
  });

  it('keeps single-expiry templates on the last expiry', () => {
    expect(buildStrategy('vertical', chain, 2, 100).map((l) => l.expiry)).toEqual(['20261023', '20261023']);
    expect(buildStrategy('calendar', [exp('20261009')], 0, 100).map((l) => l.expiry)).toEqual(['20261009', '20261009']);
  });

  it('adds stock legs for covered and collar', () => {
    const legs = buildStrategy('collar', chain, 0, 100);
    expect(legs[0]).toMatchObject({ side: 'BUY', right: 'S', strike: 0, qty: 1 });
    expect(hasStockLeg('collar')).toBe(true);
    expect(hasStockLeg('straddle')).toBe(false);
    expect(buildStrategy('custom', chain, 0, 100)).toEqual([]);
  });
});

describe('legs', () => {
  it('merges identical legs', () => {
    const l: Omit<Leg, 'id'> = { side: 'BUY', right: 'C', strike: 100, expiry: '20261016', qty: 1, multiplier: 100, tradingClass: 'AAPL' };
    let legs = addLeg([], l, 1);
    legs = addLeg(legs, l, 2);
    expect(legs).toHaveLength(1);
    expect(legs[0].qty).toBe(2);
    legs = addLeg(legs, { ...l, side: 'SELL' }, 3);
    expect(legs).toHaveLength(2);
  });

  it('maps legs to contracts', () => {
    const leg: Leg = { id: 1, side: 'BUY', right: 'P', strike: 5000, expiry: '20261016', qty: 1, multiplier: 100, tradingClass: 'SPXW' };
    expect(legContract(leg, index('SPX', 'CBOE'))).toMatchObject({ symbol: 'SPX', secType: 'OPT', strike: 5000, right: 'P', tradingClass: 'SPXW', exchange: 'SMART' });
    expect(legContract({ ...leg, right: 'S' }, stock('AAPL'))).toEqual(stock('AAPL'));
  });
});
