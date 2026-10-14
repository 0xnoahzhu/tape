import { describe, expect, it } from 'vitest';
import { readIndicator, signalOperands, type IndicatorRule } from './indicatorSignal';
import type { Bar } from './types';

describe('readIndicator', () => {
  // Closes 10, 10, 10, 9, 9, 12 on 5-minute bars: MA3 = 10, 10, 9.67, 9.33, 10 → the close crosses above at the last bar.
  const closes = [10, 10, 10, 9, 9, 12];
  const bars: Bar[] = closes.map((c, i) => ({ time: i * 300, open: c, high: c, low: c, close: c, volume: 1 }));
  const rule = (on: 'close' | 'live'): IndicatorRule => ({ type: 'indicator', timeframe: '5m', on, signal: { ind: 'ma', kind: 'price', period: 3, cross: 'up' } });

  it('compares the forming bar with the last closed one in live mode', () => {
    const r = readIndicator(rule('live'), bars, true)!;
    expect(r.prev).toBeCloseTo(9 - 28 / 3);
    expect(r.cur).toBeCloseTo(12 - 10);
    expect(r).toMatchObject({ bar: 1500, closedBar: 1200, value: 10 });
    expect(r.detail).toEqual({ close: 12, MA3: 10 });
  });

  it('compares the two newest closed bars in close mode', () => {
    expect(readIndicator(rule('close'), bars, true)).toMatchObject({ bar: 1200, closedBar: 1200 });
    // No bar forming (after the close): the two newest bars.
    expect(readIndicator(rule('close'), bars, false)).toMatchObject({ bar: 1500, closedBar: 1500 });
  });

  it('needs the warm-up bars', () => {
    expect(readIndicator(rule('live'), bars.slice(0, 3), true)).toBeNull();
    expect(readIndicator({ ...rule('close'), signal: { ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' } }, bars, false)).toBeNull();
  });

  it('measures a level cross of a line with its re-arm band', () => {
    const rising = [10, 9, 8, 9, 10, 11, 12, 13, 14, 15].map((c, i) => ({ time: i * 60, open: c, high: c, low: c, close: c, volume: 1 }));
    const r = readIndicator({ type: 'indicator', timeframe: '1m', on: 'close', signal: { ind: 'rsi', kind: 'level', period: 3, level: 70, cross: 'up' } }, rising, false)!;
    expect(r.band).toBe(2);
    expect(Object.keys(r.detail)).toEqual(['RSI3']);
    expect(r.cur).toBeCloseTo(r.value - 70);
  });
});

describe('signalOperands', () => {
  it('names the two operands of every signal as the detail lines do', () => {
    expect(signalOperands({ ind: 'ma', kind: 'price', period: 20, cross: 'up' })).toEqual({ a: 'close', b: 'MA20' });
    expect(signalOperands({ ind: 'ema', kind: 'lines', fast: 12, slow: 26, cross: 'down' })).toEqual({ a: 'EMA12', b: 'EMA26' });
    expect(signalOperands({ ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' })).toEqual({ a: 'DIF', b: 'DEA' });
    expect(signalOperands({ ind: 'macd', kind: 'zero', fast: 12, slow: 26, signal: 9, cross: 'up' })).toEqual({ a: 'DIF', b: 0 });
    expect(signalOperands({ ind: 'kdj', kind: 'cross', n: 9, m1: 3, m2: 3, cross: 'up' })).toEqual({ a: 'K', b: 'D' });
    expect(signalOperands({ ind: 'kdj', kind: 'level', n: 9, m1: 3, m2: 3, line: 'j', level: 100, cross: 'up' })).toEqual({ a: 'J', b: 100 });
    expect(signalOperands({ ind: 'rsi', kind: 'level', period: 6, level: 70, cross: 'up' })).toEqual({ a: 'RSI6', b: 70 });
    expect(signalOperands({ ind: 'rsi', kind: 'lines', fast: 6, slow: 12, cross: 'up' })).toEqual({ a: 'RSI6', b: 'RSI12' });
    expect(signalOperands({ ind: 'boll', kind: 'band', period: 20, k: 2, band: 'lower', cross: 'down' })).toEqual({ a: 'close', b: 'LOWER' });
  });

  it('matches the names readIndicator reports', () => {
    const bars: Bar[] = Array.from({ length: 60 }, (_, i) => {
      const c = 100 + Math.sin(i / 4) * 5;
      return { time: i * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 1 };
    });
    const signals: IndicatorRule['signal'][] = [
      { ind: 'ma', kind: 'price', period: 5, cross: 'up' },
      { ind: 'macd', kind: 'signal', fast: 12, slow: 26, signal: 9, cross: 'up' },
      { ind: 'kdj', kind: 'level', n: 9, m1: 3, m2: 3, line: 'k', level: 80, cross: 'up' },
      { ind: 'rsi', kind: 'lines', fast: 6, slow: 12, cross: 'up' },
      { ind: 'boll', kind: 'band', period: 20, k: 2, band: 'upper', cross: 'up' },
    ];
    for (const signal of signals) {
      const r = readIndicator({ type: 'indicator', timeframe: '1m', on: 'live', signal }, bars, false)!;
      const { a, b } = signalOperands(signal);
      expect(r.detail[a]).toBeDefined();
      if (typeof b === 'string') expect(r.cur).toBeCloseTo(r.detail[a] - r.detail[b]);
      else expect(r.cur).toBeCloseTo(r.detail[a] - b);
    }
  });
});
