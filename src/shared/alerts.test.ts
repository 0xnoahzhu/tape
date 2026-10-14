import { describe, expect, it } from 'vitest';
import {
  alertLimitProblem,
  alertSessions,
  clipNote,
  dataAllows,
  MAX_ALERTS,
  needsLiveData,
  noteLength,
  priceLevel,
  ruleFitProblem,
  usesAlertSessions,
} from './alerts';
import { index, option, stock } from './contract';
import type { AlertRule, PriceAlert } from './types';

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a',
  contract: stock('AAPL'),
  rule: { type: 'priceAbove', value: 1 },
  frequency: 'once',
  createdAt: 0,
  active: true,
  ...over,
});
const rsi = (timeframe: '1D' | '1h'): AlertRule => ({ type: 'indicator', timeframe, on: 'close', signal: { ind: 'rsi', kind: 'level', period: 6, level: 80, cross: 'up' } });

describe('notes', () => {
  it('counts and clips in code points, trimmed', () => {
    expect(noteLength('止盈线😀')).toBe(4);
    expect(clipNote('  ' + 'a'.repeat(25) + '  ')).toBe('a'.repeat(20));
    expect(clipNote('   ')).toBeUndefined();
    expect(clipNote(5)).toBeUndefined();
  });
});

describe('sessions', () => {
  it('apply to US stocks, pre / regular / post unless chosen', () => {
    expect(usesAlertSessions(stock('AAPL'))).toBe(true);
    expect(usesAlertSessions(option('AAPL', '20261016', 230, 'C'))).toBe(false);
    expect(usesAlertSessions({ ...stock('700'), currency: 'HKD' })).toBe(false);
    expect(alertSessions({})).toEqual(['pre', 'regular', 'post']);
    expect(alertSessions({ sessions: ['overnight'] })).toEqual(['overnight']);
  });
});

describe('rules', () => {
  it('need live data except price and day-change rules', () => {
    expect(needsLiveData({ type: 'priceBelow', value: 1 })).toBe(false);
    expect(needsLiveData({ type: 'dayRise', pct: 1 })).toBe(false);
    expect(needsLiveData({ type: 'windowRise', minutes: 3, pct: 1 })).toBe(true);
    expect(needsLiveData({ type: 'askSizeAbove', shares: 1 })).toBe(true);
    expect(needsLiveData({ type: 'halt', dir: 'halted' })).toBe(true);
    expect(needsLiveData(rsi('1D'))).toBe(true);
  });

  it('draw a line for price, bid and ask levels only', () => {
    expect(priceLevel({ type: 'askBelow', value: 3 })).toEqual({ value: 3, side: 'below', quote: 'ask' });
    expect(priceLevel({ type: 'dayFall', pct: 3 })).toBeNull();
  });

  it('fit the instruments IB reports the data for', () => {
    const fx = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' } as const;
    expect(ruleFitProblem('volumeAbove', fx)).toBe('noVolume');
    expect(ruleFitProblem('turnoverAbove', option('AAPL', '20261016', 230, 'C'))).toBe('stocksOnly');
    expect(ruleFitProblem('bidSizeAbove', index('SPX', 'CBOE'))).toBe('noSizes');
    expect(ruleFitProblem('halt', fx)).toBe('noHalts');
    expect(ruleFitProblem('indicator', stock('AAPL'))).toBeNull();
  });
});

describe('dataAllows', () => {
  const price: AlertRule = { type: 'priceAbove', value: 1 };
  const window: AlertRule = { type: 'windowRise', minutes: 3, pct: 1 };

  it('evaluates live data, delayed data for price and day-change rules (marked), and never frozen data', () => {
    expect(dataAllows(price, 1)).toEqual({ evaluate: true, delayed: false });
    expect(dataAllows(price, 3)).toEqual({ evaluate: true, delayed: true });
    expect(dataAllows({ type: 'dayFall', pct: 2 }, 3)).toEqual({ evaluate: true, delayed: true });
    expect(dataAllows(window, 3)).toEqual({ evaluate: false, delayed: true });
    expect(dataAllows({ type: 'halt', dir: 'halted' }, 3).evaluate).toBe(false);
    expect(dataAllows(price, 2).evaluate).toBe(false);
    expect(dataAllows(price, 4).evaluate).toBe(false);
    expect(dataAllows(price, undefined).evaluate).toBe(false);
  });
});

describe('alertLimitProblem', () => {
  it('allows 10 alerts of a type per instrument, not counting the one being edited', () => {
    const ten = Array.from({ length: 10 }, (_, i) => alert({ id: `p${i}` }));
    expect(alertLimitProblem(ten, alert({ id: 'new' }))).toBe('perType');
    expect(alertLimitProblem(ten, alert({ id: 'p0', rule: { type: 'priceAbove', value: 2 } }))).toBeNull();
    expect(alertLimitProblem(ten, alert({ id: 'new', rule: { type: 'priceBelow', value: 2 } }))).toBeNull();
    expect(alertLimitProblem(ten, alert({ id: 'new', contract: stock('MSFT') }))).toBeNull();
  });

  it(`allows ${MAX_ALERTS} alerts in all`, () => {
    const all = Array.from({ length: MAX_ALERTS }, (_, i) => alert({ id: `a${i}`, contract: stock(`S${i}`) }));
    expect(alertLimitProblem(all, alert({ id: 'new', contract: stock('X') }))).toBe('total');
    expect(alertLimitProblem(all, alert({ id: 'a5', contract: stock('S5'), note: 'x' }))).toBeNull();
  });

  it('allows 20 bar series for active indicator alerts', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => alert({ id: `i${i}`, contract: stock(`S${i}`), rule: rsi('1D') }));
    expect(alertLimitProblem(twenty, alert({ id: 'new', contract: stock('X'), rule: rsi('1D') }))).toBe('series');
    expect(alertLimitProblem(twenty, alert({ id: 'new', contract: stock('S0'), rule: rsi('1h') }))).toBe('series');
    expect(alertLimitProblem(twenty, alert({ id: 'new', contract: stock('S0'), rule: rsi('1D') }))).toBeNull();
    expect(alertLimitProblem(twenty, alert({ id: 'new', contract: stock('X'), rule: rsi('1D'), active: false }))).toBeNull();
  });
});
