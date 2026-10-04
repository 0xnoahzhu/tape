import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { NavPoint, Position, Quote } from '@shared/types';
import {
  CASH_KEY,
  CHART_H,
  CHART_W,
  ETF_SECTOR,
  MAX_BASE_GAP,
  MIN_CURVE_SPAN,
  OTHER_SECTOR,
  accountTotals,
  allocation,
  axisLabels,
  downsample,
  equityChart,
  grossValue,
  leverage,
  leverageLabel,
  livePrice,
  marginUsage,
  maxDrawdown,
  modeValues,
  moneyShort,
  navSeries,
  positionRow,
  positionTarget,
  qtyLabel,
  quoteContract,
  rangeReturn,
  rangeStart,
  sectorOf,
  shortHistory,
  sliceRange,
  sortRows,
  sumRows,
  tickLabels,
  underlyingOf,
  weightLabel,
} from './calc';

const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h = 16) => new Date(y, m - 1, d, h).getTime();
const pt = (t: number, netLiq: number): NavPoint => ({ t, netLiq });
const quote = (over: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...over });

/** One sample per day (16:00) from `from` for `days` days, value from fn(i). */
function daily(from: number, days: number, fn: (i: number) => number): NavPoint[] {
  return Array.from({ length: days }, (_, i) => pt(from + i * DAY, fn(i)));
}

function position(over: Partial<Position> = {}): Position {
  return {
    account: 'DU1',
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    quantity: 100,
    avgPrice: 200,
    multiplier: 1,
    updatedAt: 0,
    ...over,
  };
}

describe('navSeries', () => {
  it('sorts, drops invalid samples and de-duplicates timestamps', () => {
    const s = navSeries([pt(3, 30), pt(1, 10), pt(2, NaN), pt(2, 0), pt(3, 31), pt(4, 40)]);
    expect(s).toEqual([pt(1, 10), pt(3, 31), pt(4, 40)]);
  });

  it('appends the live net liquidation as the newest point', () => {
    expect(navSeries([pt(1, 10)], { netLiq: 12, t: 5 })).toEqual([pt(1, 10), pt(5, 12)]);
    expect(navSeries([pt(5, 10)], { netLiq: 12, t: 5 })).toEqual([pt(5, 12)]);
    // A persisted sample newer than the account update wins.
    expect(navSeries([pt(9, 10)], { netLiq: 12, t: 5 })).toEqual([pt(9, 10)]);
    expect(navSeries([], { netLiq: undefined, t: 5 })).toEqual([]);
    expect(navSeries([], { netLiq: 7, t: 5 })).toEqual([pt(5, 7)]);
  });
});

describe('rangeStart', () => {
  const now = at(2026, 10, 4, 11);
  it('uses calendar boundaries for MTD and YTD', () => {
    expect(rangeStart('MTD', now)).toBe(new Date(2026, 9, 1).getTime());
    expect(rangeStart('YTD', now)).toBe(new Date(2026, 0, 1).getTime());
    expect(rangeStart('1Y', now)).toBe(at(2025, 10, 4, 11));
    expect(rangeStart('7D', now)).toBe(now - 7 * DAY);
    expect(rangeStart('ALL', now)).toBe(-Infinity);
  });
});

describe('sliceRange', () => {
  const now = at(2026, 10, 4, 11);
  const series = daily(at(2024, 10, 1), 733, (i) => 1_000_000 + i * 100); // through 2026-10-03

  it('starts with the last sample before the range start', () => {
    const ytd = sliceRange(series, 'YTD', now);
    expect(ytd.covered).toBe(true);
    expect(new Date(ytd.points[0].t).getFullYear()).toBe(2025);
    expect(new Date(ytd.points[1].t).getFullYear()).toBe(2026);
    const mtd = sliceRange(series, 'MTD', now);
    expect(new Date(mtd.points[0].t).getMonth()).toBe(8); // Sep 30
    expect(mtd.points.length).toBe(4);
  });

  it('is not covered when history starts inside the range', () => {
    const short = daily(at(2026, 9, 20), 14, () => 1e6);
    const ytd = sliceRange(short, 'YTD', now);
    expect(ytd.covered).toBe(false);
    expect(ytd.points.length).toBe(14);
    expect(sliceRange(short, '7D', now).covered).toBe(true);
  });

  it('ignores a base sample that is too old', () => {
    const start = rangeStart('7D', now);
    const gappy = [pt(start - MAX_BASE_GAP - 1, 1e6), pt(now - DAY, 1.1e6), pt(now, 1.2e6)];
    const r = sliceRange(gappy, '7D', now);
    expect(r.covered).toBe(false);
    expect(r.points).toEqual(gappy.slice(1));
  });

  it('ALL is covered with two or more samples', () => {
    expect(sliceRange([pt(1, 1)], 'ALL', now).covered).toBe(false);
    expect(sliceRange([pt(1, 1), pt(2, 2)], 'ALL', now).covered).toBe(true);
  });
});

describe('returns and drawdown', () => {
  it('computes change, percent and max drawdown', () => {
    const r = rangeReturn([pt(1, 100), pt(2, 120), pt(3, 90), pt(4, 110)])!;
    expect(r.change).toBe(10);
    expect(r.pct).toBeCloseTo(10);
    expect(r.maxDrawdown).toBeCloseTo(-25);
  });

  it('needs two samples', () => {
    expect(rangeReturn([pt(1, 100)])).toBeNull();
  });

  it('is zero for a rising series', () => {
    expect(maxDrawdown([1, 2, 3])).toBe(0);
  });
});

describe('downsample', () => {
  it('keeps short series untouched', () => {
    const s = daily(0, 10, (i) => i);
    expect(downsample(s, 10)).toEqual(s);
  });

  it('keeps first, last and extremes', () => {
    const s = daily(0, 10_000, (i) => (i === 5_000 ? 9e9 : i === 7_000 ? 1 : 1e6 + (i % 7)));
    const d = downsample(s, 50);
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d[0]).toBe(s[0]);
    expect(d[d.length - 1]).toBe(s[s.length - 1]);
    expect(d.some((p) => p.netLiq === 9e9)).toBe(true);
    expect(d.some((p) => p.netLiq === 1)).toBe(true);
    for (let i = 1; i < d.length; i++) expect(d[i].t).toBeGreaterThan(d[i - 1].t);
  });
});

describe('equityChart', () => {
  it('maps time to x and value to y with 8% headroom', () => {
    const c = equityChart([pt(0, 100), pt(50, 150), pt(100, 200)], 'value')!;
    const pts = c.line.split(' ').map((s) => s.split(',').map(Number));
    expect(pts[0][0]).toBe(0);
    expect(pts[2][0]).toBe(CHART_W);
    expect(pts[1][0]).toBe(CHART_W / 2);
    // lo = 92, hi = 208
    expect(c.baseY).toBeCloseTo(((208 - 100) / 116) * CHART_H);
    expect(c.endY).toBeCloseTo(((208 - 200) / 116) * CHART_H);
    expect(c.area.startsWith(`0,${CHART_H} `)).toBe(true);
    expect(c.area.endsWith(` ${CHART_W},${CHART_H}`)).toBe(true);
    expect(c.axis.map((a) => a.frac)).toEqual([0.2, 0.5, 0.8]);
    expect(c.axis[1].value).toBeCloseTo(150);
    expect(c.ticks).toEqual([0, 33, 66, 100]);
  });

  it('plots percent change in performance mode', () => {
    expect(modeValues([pt(0, 100), pt(1, 110)], 'perf')).toEqual([0, 10.000000000000009]);
    const c = equityChart([pt(0, 100), pt(1, 110)], 'perf')!;
    expect(c.axis[1].value).toBeCloseTo(5);
  });

  it('draws only the end marker for a single sample', () => {
    const c = equityChart([pt(0, 1_020_000)], 'value')!;
    expect(c.line).toBe('');
    expect(c.area).toBe('');
    expect(c.endY).toBeCloseTo(CHART_H / 2);
    expect(c.ticks).toEqual([]);
    expect(equityChart([], 'value')).toBeNull();
  });

  it('draws a flat series as a line without an area', () => {
    for (const mode of ['value', 'perf'] as const) {
      const c = equityChart(daily(at(2026, 9, 1), 30, () => 1_020_171.48), mode)!;
      expect(c.line).not.toBe('');
      expect(c.area).toBe('');
      expect(c.endY).toBeCloseTo(CHART_H / 2);
    }
    expect(equityChart([pt(0, 100), pt(DAY, 100.01)], 'value')!.area).not.toBe('');
  });

  it('flags history too short for a curve', () => {
    const t = at(2026, 10, 4, 20);
    expect(shortHistory([])).toBe(true);
    expect(shortHistory([pt(t, 1)])).toBe(true);
    // Just connected: the first stored sample and the live value seconds later.
    expect(shortHistory([pt(t, 1_020_171), pt(t + 6_000, 1_020_171)])).toBe(true);
    expect(shortHistory([pt(t, 1), pt(t + MIN_CURVE_SPAN - 1, 2)])).toBe(true);
    expect(shortHistory([pt(t, 1), pt(t + MIN_CURVE_SPAN, 2)])).toBe(false);
    expect(shortHistory(daily(t, 3, (i) => i + 1))).toBe(false);
  });
});

describe('labels', () => {
  it('formats the right axis like the design', () => {
    const c = equityChart([pt(0, 1_100_000), pt(1, 1_300_000)], 'value')!;
    expect(axisLabels(c.axis.map((a) => a.value), 'value')).toEqual(['$1.270M', '$1.200M', '$1.130M']);
    expect(axisLabels([60_000, 52_400, 44_800], 'value')).toEqual(['$60.0K', '$52.4K', '$44.8K']);
    expect(axisLabels([6_000, 5_400, 4_800], 'value')).toEqual(['$6,000', '$5,400', '$4,800']);
    expect(axisLabels([1.5, 0, -1.5], 'perf')).toEqual(['+1.50%', '+0.00%', '−1.50%']);
  });

  it('keeps close axis labels apart', () => {
    // A flat account: the band is 0.2% of the value.
    const flat = equityChart([pt(0, 1_020_500), pt(1, 1_020_500)], 'value')!;
    expect(axisLabels(flat.axis.map((a) => a.value), 'value')).toEqual(['$1,021.1K', '$1,020.5K', '$1,019.9K']);
    // A quiet range: a few hundred dollars on a million.
    expect(axisLabels([1_020_900, 1_020_800, 1_020_700], 'value')).toEqual(['$1,020.9K', '$1,020.8K', '$1,020.7K']);
    expect(axisLabels([1_020_830, 1_020_800, 1_020_770], 'value')).toEqual(['$1,020,830', '$1,020,800', '$1,020,770']);
    expect(axisLabels([1_020_800.3, 1_020_800, 1_020_799.7], 'value')).toEqual(['$1,020,800.3', '$1,020,800.0', '$1,020,799.7']);
    expect(axisLabels([54_000, 52_400, 50_800], 'value')).toEqual(['$54.0K', '$52.4K', '$50.8K']);
    expect(axisLabels([52_430, 52_400, 52_370], 'value')).toEqual(['$52,430', '$52,400', '$52,370']);
    expect(axisLabels([0.012, 0.009, 0.006], 'perf')).toEqual(['+0.012%', '+0.009%', '+0.006%']);
  });

  it('formats short money', () => {
    expect(moneyShort(1_284_530.42)).toBe('$1.28M');
    expect(moneyShort(52_400)).toBe('$52.4K');
    expect(moneyShort(undefined)).toBe('—');
  });

  it('formats x ticks by span', () => {
    const t = at(2026, 6, 7, 9);
    const spread = (span: number) => [0, 0.33, 0.66, 1].map((f) => t + span * f);
    expect(tickLabels(spread(DAY), 'MTD')).toEqual(['09:00', '16:55', '00:50', '09:00']);
    expect(tickLabels(spread(30 * DAY), 'YTD')).toEqual(['6/7', '6/17', '6/27', '7/7']);
    expect(tickLabels(spread(700 * DAY), 'ALL')).toEqual(['2026/6', '2027/1', '2027/9', '2028/5']);
    expect(tickLabels(spread(30 * DAY), 'ALL')[0]).toBe('6/7');
    expect(tickLabels([], '7D')).toEqual([]);
  });

  it('never repeats an x label', () => {
    const t = at(2026, 10, 4, 12) + 16 * 60_000;
    // Samples a few seconds apart (first launch) get seconds.
    expect(tickLabels([t, t + 10_000, t + 20_000, t + 30_000], '7D')).toEqual(['12:16:00', '12:16:10', '12:16:20', '12:16:30']);
    // Repeats left blank: a span below the label resolution, and day labels less than a day apart.
    expect(tickLabels([t, t + 500, t + 1_000, t + 1_500], '7D')).toEqual(['12:16:00', '', '12:16:01', '']);
    const d = at(2026, 10, 1, 1);
    expect(tickLabels([d, d + 0.8 * DAY, d + 1.6 * DAY, d + 2.4 * DAY], 'MTD')).toEqual(['10/1', '', '10/2', '10/3']);
  });

  it('formats weights with a true minus', () => {
    expect(weightLabel(12.94)).toBe('12.9%');
    expect(weightLabel(-1.04)).toBe('−1.0%');
    expect(weightLabel(undefined)).toBe('—');
  });
});

describe('sectors', () => {
  it('classifies by IB industry, funds and indices', () => {
    expect(sectorOf('STK', { industry: 'Technology', category: 'Computers' })).toBe('Technology');
    expect(sectorOf('STK', { industry: 'Funds', category: 'Equity Fund' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { industry: '', category: '', longName: 'SPDR S&P 500 ETF TRUST' })).toBe(ETF_SECTOR);
    expect(sectorOf('IND', undefined)).toBe(ETF_SECTOR);
    expect(sectorOf('STK', undefined)).toBe(OTHER_SECTOR);
    expect(sectorOf('FUT', { longName: 'E-mini S&P 500' })).toBe(OTHER_SECTOR);
  });

  it('uses the stock type when IB reports it', () => {
    // IB reports SPY as stock type ETF (checked live); the stock type wins over the heuristic.
    expect(sectorOf('STK', { stockType: 'ETF' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { stockType: 'ETN', industry: 'Financial' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { stockType: 'COMMON', industry: 'Technology', category: 'Computers' })).toBe('Technology');
    // A company without industry is not taken for a fund once its stock type says otherwise.
    expect(sectorOf('STK', { stockType: 'COMMON' })).toBe(OTHER_SECTOR);
    expect(sectorOf('STK', { stockType: 'common', longName: 'SOME ETF ADVISORS INC' })).toBe(OTHER_SECTOR);
  });

  it('treats unclassified stocks as funds', () => {
    // IB sends QQQ, GLD and TLT without industry and category.
    expect(sectorOf('STK', { longName: 'INVESCO QQQ TRUST SERIES 1' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { industry: ' ', category: '', longName: 'SPDR GOLD SHARES' })).toBe(ETF_SECTOR);
    expect(sectorOf('STK', { category: 'Computers' })).toBe(OTHER_SECTOR);
  });

  it('requests quotes SMART-routed', () => {
    expect(quoteContract({ ...stock('AAPL'), exchange: 'NASDAQ', conId: 265598 })).toEqual({ ...stock('AAPL', 'NASDAQ'), conId: 265598 });
    expect(quoteContract({ ...option('AAPL', '20261016', 230, 'C'), exchange: '' }).exchange).toBe('SMART');
    const fut = { symbol: 'ES', secType: 'FUT' as const, exchange: 'CME', currency: 'USD', lastTradeDate: '20261218' };
    expect(quoteContract(fut)).toBe(fut);
  });

  it('resolves underlyings and click targets', () => {
    const call = option('AAPL', '20261016', 230, 'C');
    expect(underlyingOf(call)).toEqual(stock('AAPL'));
    expect(underlyingOf(option('SPX', '20261016', 5700, 'P'))).toMatchObject({ symbol: 'SPX', secType: 'IND', exchange: 'CBOE' });
    expect(positionTarget(call)).toEqual({ contract: stock('AAPL'), view: 'opt' });
    expect(positionTarget({ ...stock('NVDA'), conId: 4815747, exchange: 'NASDAQ' })).toEqual({ contract: stock('NVDA'), view: 'chart' });
  });
});

describe('allocation', () => {
  it('reproduces the design: sectors by size, then cash', () => {
    const s = allocation(
      [
        { sector: 'Technology', value: 160_000 },
        { sector: 'Consumer, Cyclical', value: -12_551 },
        { sector: ETF_SECTOR, value: -2_550 },
        { sector: 'Technology', value: 4_250 },
      ],
      1_134_456,
      1_284_530,
    );
    expect(s.map((x) => x.key)).toEqual(['Technology', 'Consumer, Cyclical', ETF_SECTOR, CASH_KEY]);
    expect(s.map((x) => x.opacity)).toEqual([1, 0.75, 0.5, 0.55]);
    expect(s.reduce((a, x) => a + x.len, 0)).toBeCloseTo(100);
    expect(s[0].offset).toBe(0);
    expect(s[1].offset).toBeCloseTo(-s[0].len);
    expect(s[1].pctOfNetLiq).toBeCloseTo((-12_551 / 1_284_530) * 100);
  });

  it('merges small sectors into Other and keeps opacities visible', () => {
    const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((sector, i) => ({ sector, value: 1000 - i * 100 }));
    const s = allocation([...items, { sector: OTHER_SECTOR, value: 5 }], undefined, undefined, 6);
    expect(s.map((x) => x.key)).toEqual(['A', 'B', 'C', 'D', 'E', OTHER_SECTOR]);
    expect(s[5].value).toBe(500 + 400 + 300 + 5);
    expect(Math.min(...s.map((x) => x.opacity))).toBeCloseTo(0.3);
    expect(s[0].pctOfNetLiq).toBeUndefined();
  });

  it('shows only cash for an account without positions', () => {
    const s = allocation([], 1_020_000, 1_020_000);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ key: CASH_KEY, len: 100, pctOfNetLiq: 100 });
    expect(allocation([], undefined, undefined)).toEqual([]);
  });
});

describe('positionRow', () => {
  it('values a stock at the live price', () => {
    const r = positionRow(position({ marketPrice: 220, marketValue: 22_000, unrealizedPnL: 2_000, dailyPnL: 150 }), 227.48, 1_284_530, 'Technology');
    expect(r.last).toBe(227.48);
    expect(r.value).toBeCloseTo(22_748);
    expect(r.unrealized).toBeCloseTo(2_748);
    expect(r.unrealizedPct).toBeCloseTo(13.74);
    expect(r.dayPnl).toBe(150);
    expect(r.weight).toBeCloseTo((22_748 / 1_284_530) * 100);
  });

  it('falls back to IB portfolio values without a quote', () => {
    const r = positionRow(position({ marketPrice: 220, marketValue: 22_000, unrealizedPnL: 2_000 }), undefined, undefined, 'Technology');
    expect(r.last).toBe(220);
    expect(r.value).toBe(22_000);
    expect(r.unrealized).toBe(2_000);
    expect(r.unrealizedPct).toBeCloseTo(10);
    expect(r.weight).toBeUndefined();
    expect(r.dayPnl).toBeUndefined();
  });

  it('applies the option multiplier and short sign', () => {
    const put = position({ key: 'OPT:SPY', contract: option('SPY', '20261120', 560, 'P'), quantity: -5, avgPrice: 6.8, multiplier: 100 });
    const r = positionRow(put, 5.1, 1_284_530, ETF_SECTOR);
    expect(r.value).toBeCloseTo(-2_550);
    expect(r.unrealized).toBeCloseTo(850);
    expect(r.unrealizedPct).toBeCloseTo(25);
  });

  it('values options at the mark, not a stale last trade', () => {
    const call = option('AAPL', '20261016', 230, 'C');
    const q = quote({ last: 1, bid: 3.1, ask: 3.3 });
    expect(livePrice('OPT', q, 1)).toBeCloseTo(3.2);
    expect(livePrice('FOP', { ...q, mark: 3.25 }, 1)).toBe(3.25);
    expect(livePrice('OPT', quote({ last: 1, bid: 0, ask: 0.1 }), 1)).toBeCloseTo(0.05);
    // No two-sided market (closed, delayed-frozen): keep IB's portfolio values.
    expect(livePrice('OPT', quote({ last: 1, bid: -1, ask: -1 }), 1)).toBeUndefined();
    expect(livePrice('OPT', undefined, undefined)).toBeUndefined();
    expect(livePrice('STK', q, 1)).toBe(1);

    const p = position({ key: 'OPT:AAPL', contract: call, quantity: 10, avgPrice: 3.1, multiplier: 100, marketPrice: 4.25, unrealizedPnL: 1_150 });
    const live = positionRow(p, livePrice('OPT', q, 1), 1e6, 'Technology');
    expect(live.last).toBeCloseTo(3.2);
    expect(live.value).toBeCloseTo(3_200);
    expect(live.unrealized).toBeCloseTo(100);
    const ib = positionRow(p, livePrice('OPT', quote({ last: 1 }), 1), 1e6, 'Technology');
    expect(ib.last).toBe(4.25);
    expect(ib.value).toBeCloseTo(4_250);
    expect(ib.unrealized).toBe(1_150);
  });

  it('formats fractional quantities', () => {
    expect(qtyLabel(1_200)).toBe('1,200');
    expect(qtyLabel(-5)).toBe('−5');
    expect(qtyLabel(0.0153)).toBe('0.0153');
    expect(qtyLabel(10.5)).toBe('10.5');
    expect(qtyLabel(-1_234.25)).toBe('−1,234.25');
    expect(qtyLabel(2.00001)).toBe('2');
    expect(qtyLabel(undefined)).toBe('—');
  });

  it('leaves unknown prices unknown', () => {
    const r = positionRow(position(), undefined, 1e6, OTHER_SECTOR);
    expect(r.last).toBeUndefined();
    expect(r.value).toBeUndefined();
    expect(r.unrealized).toBeUndefined();
  });

  it('sorts by size and sums fields', () => {
    const a = positionRow(position({ key: 'a', marketValue: -5_000, unrealizedPnL: 1 }), undefined, 1e6, 'x');
    const b = positionRow(position({ key: 'b', marketValue: 3_000, unrealizedPnL: 2 }), undefined, 1e6, 'x');
    const c = positionRow(position({ key: 'c' }), undefined, 1e6, 'x');
    expect(sortRows([c, b, a]).map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(sumRows([a, b], 'value')).toBe(-2_000);
    expect(sumRows([a, b, c], 'value')).toBeUndefined();
    expect(sumRows([a, b, c], 'unrealized', (r) => r.key !== 'c')).toBe(3);
    expect(sumRows([], 'dayPnl')).toBe(0);
    expect(grossValue([a, b])).toBe(8_000);
    expect(grossValue([a, c])).toBeUndefined();
  });

  it('falls back to position sums for missing account figures', () => {
    const stk = positionRow(position({ key: 'a', marketValue: 22_000, unrealizedPnL: 2_000, dailyPnL: 100 }), undefined, 1e6, 'x');
    const opt = positionRow(
      position({ key: 'b', contract: option('AAPL', '20261016', 230, 'C'), multiplier: 100, quantity: -2, avgPrice: 3, marketValue: -500, unrealizedPnL: 100 }),
      undefined,
      1e6,
      'x',
    );
    const account = { account: 'DU1', currency: 'USD', netLiquidation: 1e6, updatedAt: 0 };
    expect(accountTotals(null, [stk])).toEqual({});
    expect(accountTotals(account, [stk, opt])).toEqual({ dayPnl: undefined, unrealized: 2_100, stockValue: 22_000, optionValue: -500, gross: 22_500 });
    expect(accountTotals({ ...account, dailyPnL: -5, unrealizedPnL: 7, stockMarketValue: 1, optionMarketValue: 2, grossPositionValue: 3 }, [stk])).toEqual({
      dayPnl: -5,
      unrealized: 7,
      stockValue: 1,
      optionValue: 2,
      gross: 3,
    });
    expect(accountTotals(account, [])).toEqual({ dayPnl: undefined, unrealized: 0, stockValue: 0, optionValue: 0, gross: 0 });
  });

  it('computes leverage', () => {
    expect(leverage(1_772_651, 1_284_530)).toBeCloseTo(1.38, 2);
    expect(leverage(1, 0)).toBeUndefined();
    expect(leverage(undefined, 1)).toBeUndefined();
  });

  it('labels leverage', () => {
    expect(leverageLabel(leverage(1_772_651, 1_284_530))).toBe('1.38×');
    expect(leverageLabel(0)).toBe('0.00×');
    expect(leverageLabel(12.346)).toBe('12.35×');
    expect(leverageLabel(undefined)).toBe('—');
    expect(leverageLabel(NaN)).toBe('—');
  });

  it('computes margin usage', () => {
    expect(marginUsage(159_000, 1_284_530)).toEqual({ pct: expect.closeTo(12.378, 3), fill: expect.closeTo(12.378, 3), warn: false });
    expect(marginUsage(0, 50_000)).toEqual({ pct: 0, fill: 0, warn: false });
    // At the threshold it is not a warning yet; above it is.
    expect(marginUsage(80, 100)?.warn).toBe(false);
    expect(marginUsage(80.5, 100)?.warn).toBe(true);
    // The bar never overflows its track or goes negative.
    expect(marginUsage(150, 100)).toEqual({ pct: 150, fill: 100, warn: true });
    expect(marginUsage(-5, 100)).toEqual({ pct: -5, fill: 0, warn: false });
    expect(marginUsage(undefined, 100)).toBeNull();
    expect(marginUsage(10, undefined)).toBeNull();
    expect(marginUsage(10, 0)).toBeNull();
    expect(marginUsage(10, -100)).toBeNull();
  });
});
