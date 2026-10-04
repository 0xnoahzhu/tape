import { describe, expect, it } from 'vitest';
import { TIMEFRAMES } from '@shared/timeframes';
import { DEFAULT_MAS } from './chartMath';
import { parseChartPrefs, toggledMas } from './chartPrefs';
import { DEFAULT_FAVORITES } from './timeframePicker';

const defaults = { range: null, favorites: DEFAULT_FAVORITES };

describe('parseChartPrefs', () => {
  it('defaults to 1D, MA20 / MA50 / MA200 and volume, no range, the former toolbar as favorites', () => {
    expect(parseChartPrefs(null)).toEqual({ timeframe: '1D', mas: [20, 50, 200], showVol: true, ...defaults });
    expect(parseChartPrefs('nonsense')).toEqual({ timeframe: '1D', mas: DEFAULT_MAS, showVol: true, ...defaults });
    expect(parseChartPrefs({})).toEqual({ timeframe: '1D', mas: DEFAULT_MAS, showVol: true, ...defaults });
    expect(DEFAULT_FAVORITES).toEqual({ timeframes: ['1m', '5m', '1h', '1D', '1W', '1M', '1Y'], ranges: [] });
  });

  it('migrates the single MA20 flag: on becomes the default set, off shows none', () => {
    expect(parseChartPrefs({ timeframe: '1h', showMa: true, showVol: false })).toEqual({ timeframe: '1h', mas: [20, 50, 200], showVol: false, ...defaults });
    expect(parseChartPrefs({ timeframe: '5m', showMa: false, showVol: true })).toEqual({ timeframe: '5m', mas: [], showVol: true, ...defaults });
  });

  it('keeps every interval saved before the picker (1m 5m 1h 1D 1W 1M 1Y) and reads the new ones', () => {
    for (const tf of ['1m', '5m', '1h', '1D', '1W', '1M', '1Y']) {
      expect(parseChartPrefs({ timeframe: tf, mas: [20], showVol: true })).toEqual({ timeframe: tf, mas: [20], showVol: true, ...defaults });
    }
    for (const tf of TIMEFRAMES) expect(parseChartPrefs({ timeframe: tf }).timeframe).toBe(tf);
  });

  it('reads favorites and the range, in picker order, dropping unknown entries', () => {
    const p = parseChartPrefs({ timeframe: '1h', range: '3M', favorites: { timeframes: ['1Y', '45s', '1s', '7m'], ranges: ['MAX', '1M', 'YTD', 'all'] } });
    expect(p.range).toBe('3M');
    expect(p.favorites).toEqual({ timeframes: ['1s', '45s', '1Y'], ranges: ['1M', 'YTD', 'MAX'] });
    // An empty toolbar is the user's choice; a malformed one falls back.
    expect(parseChartPrefs({ favorites: { timeframes: [], ranges: [] } }).favorites).toEqual({ timeframes: [], ranges: [] });
    expect(parseChartPrefs({ favorites: { timeframes: '1m' } }).favorites).toEqual(DEFAULT_FAVORITES);
    expect(parseChartPrefs({ range: '2W' }).range).toBeNull();
  });

  it('reads the stored moving averages in period order, dropping unknown ones', () => {
    expect(parseChartPrefs({ timeframe: '1W', mas: [200, 5, 7, '20', 10], showVol: true }).mas).toEqual([5, 10, 200]);
    expect(parseChartPrefs({ mas: [] }).mas).toEqual([]);
    // The new list wins over a leftover flag.
    expect(parseChartPrefs({ mas: [50], showMa: false }).mas).toEqual([50]);
  });

  it('falls back on invalid values', () => {
    expect(parseChartPrefs({ timeframe: '2D', mas: 'all', showVol: 'yes' })).toEqual({ timeframe: '1D', mas: DEFAULT_MAS, showVol: true, ...defaults });
  });
});

describe('toggledMas', () => {
  it('switches one average on or off and keeps period order', () => {
    expect(toggledMas([20, 50, 200], 5)).toEqual([5, 20, 50, 200]);
    expect(toggledMas([20, 50, 200], 50)).toEqual([20, 200]);
    expect(toggledMas([], 200)).toEqual([200]);
    expect(toggledMas([10], 10)).toEqual([]);
  });
});
