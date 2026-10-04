import { describe, expect, it } from 'vitest';
import { DEFAULT_MAS } from './chartMath';
import { parseChartPrefs, toggledMas } from './chartPrefs';

describe('parseChartPrefs', () => {
  it('defaults to 1D, MA20 / MA50 / MA200 and volume', () => {
    expect(parseChartPrefs(null)).toEqual({ timeframe: '1D', mas: [20, 50, 200], showVol: true });
    expect(parseChartPrefs('nonsense')).toEqual({ timeframe: '1D', mas: DEFAULT_MAS, showVol: true });
    expect(parseChartPrefs({})).toEqual({ timeframe: '1D', mas: DEFAULT_MAS, showVol: true });
  });

  it('migrates the single MA20 flag: on becomes the default set, off shows none', () => {
    expect(parseChartPrefs({ timeframe: '1h', showMa: true, showVol: false })).toEqual({ timeframe: '1h', mas: [20, 50, 200], showVol: false });
    expect(parseChartPrefs({ timeframe: '5m', showMa: false, showVol: true })).toEqual({ timeframe: '5m', mas: [], showVol: true });
  });

  it('reads the stored moving averages in period order, dropping unknown ones', () => {
    expect(parseChartPrefs({ timeframe: '1W', mas: [200, 5, 7, '20', 10], showVol: true }).mas).toEqual([5, 10, 200]);
    expect(parseChartPrefs({ mas: [] }).mas).toEqual([]);
    // The new list wins over a leftover flag.
    expect(parseChartPrefs({ mas: [50], showMa: false }).mas).toEqual([50]);
  });

  it('falls back on invalid values', () => {
    expect(parseChartPrefs({ timeframe: '2D', mas: 'all', showVol: 'yes' })).toEqual({ timeframe: '1D', mas: DEFAULT_MAS, showVol: true });
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
