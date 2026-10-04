import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { alertSummary, conditionFor, distancePct, isAlreadyMet, newAlert, parseAlertPrice, presetPrice } from './model';

describe('price alert helpers', () => {
  it('parses trigger prices', () => {
    expect(parseAlertPrice('235')).toBe(235);
    expect(parseAlertPrice('1,234.5')).toBe(1234.5);
    expect(parseAlertPrice('')).toBeNull();
    expect(parseAlertPrice('abc')).toBeNull();
    expect(parseAlertPrice('0')).toBeNull();
    expect(parseAlertPrice('-3')).toBeNull();
  });

  it('computes the distance from last and whether the alert is already met', () => {
    expect(distancePct(235, 227.48)).toBeCloseTo(3.3058, 3);
    expect(isAlreadyMet('above', 235, 227.48)).toBe(false);
    expect(isAlreadyMet('above', 220, 227.48)).toBe(true);
    expect(isAlreadyMet('below', 230, 227.48)).toBe(true);
    expect(isAlreadyMet('below', 220, 227.48)).toBe(false);
  });

  it('builds preset prices and conditions', () => {
    expect(presetPrice(227.48, 2)).toBe('232.03');
    expect(presetPrice(227.48, -5)).toBe('216.11');
    expect(presetPrice(0.5, 2)).toBe('0.5100');
    expect(conditionFor(5)).toBe('above');
    expect(conditionFor(-2)).toBe('below');
  });

  it('summarizes alerts for toasts', () => {
    expect(alertSummary(stock('AAPL'), 'above', 235)).toBe('AAPL ≥ 235.00');
    expect(alertSummary(option('AAPL', '20261016', 230, 'C'), 'below', 3.2)).toBe('AAPL 10/16 230 Call ≤ 3.20');
  });

  it('creates active alerts', () => {
    expect(newAlert(stock('AAPL'), 'above', 235, true, 'id1', 42)).toEqual({
      id: 'id1',
      contract: stock('AAPL'),
      condition: 'above',
      price: 235,
      repeat: true,
      createdAt: 42,
      active: true,
    });
  });
});
