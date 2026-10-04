import { describe, expect, it } from 'vitest';
import { index, option, stock } from '@shared/contract';
import type { Bar, ContractRef, Timeframe } from '@shared/types';
import {
  aggregateBars,
  aggregateYears,
  barsToDays,
  dedupePeriods,
  durationSpanSec,
  historyAdjusted,
  historyKey,
  historySpec,
  historyTtlMs,
  lastSettledMs,
  mergeTail,
  normalizeBars,
  parseBarTime,
  planFetch,
  seriesKey,
  tailDuration,
  windowStartSec,
} from './historyParams';

const aapl = stock('AAPL');

describe('historySpec', () => {
  it('maps timeframes to bar size and duration', () => {
    const table: Array<[Timeframe, string, string]> = [
      ['1m', '1 min', '2 D'],
      ['5m', '5 mins', '10 D'],
      ['1h', '1 hour', '2 M'],
      ['1D', '1 day', '2 Y'],
      ['1W', '1 week', '10 Y'],
      ['1M', '1 month', '20 Y'],
      ['1Y', '1 month', '20 Y'],
    ];
    for (const [tf, barSize, duration] of table) {
      const s = historySpec({ contract: aapl, timeframe: tf });
      expect([s.barSize, s.duration, s.whatToShow, s.useRTH]).toEqual([barSize, duration, 'TRADES', 1]);
      expect(s.aggregateYears).toBe(tf === '1Y');
    }
  });

  it('builds daily and longer option bars from 8-hour bars (IB has no EOD bars for options)', () => {
    const call = option('AAPL', '20261120', 260, 'C');
    for (const [tf, aggregate] of [
      ['1D', undefined],
      ['1W', 'week'],
      ['1M', 'month'],
      ['1Y', 'year'],
    ] as const) {
      const s = historySpec({ contract: call, timeframe: tf });
      expect([s.barSize, s.duration, s.seriesBarSize, s.toDays, s.aggregate, s.intraday]).toEqual(['8 hours', '2 Y', '1 day', true, aggregate, false]);
      expect(seriesKey(s, 'OPT:AAPL:20261120:260:C')).toBe('OPT:AAPL:20261120:260:C|1 day|TRADES|1');
    }
    const fop = { ...call, secType: 'FOP' as const };
    expect(historySpec({ contract: fop, timeframe: '1D' }).barSize).toBe('8 hours');
    // Intraday option bars work as for stocks.
    expect([historySpec({ contract: call, timeframe: '5m' }).barSize, historySpec({ contract: call, timeframe: '5m' }).duration]).toEqual(['5 mins', '10 D']);
  });

  it('includes extended hours only for intraday bars', () => {
    expect(historySpec({ contract: aapl, timeframe: '5m', outsideRth: true }).useRTH).toBe(0);
    expect(historySpec({ contract: aapl, timeframe: '1D', outsideRth: true }).useRTH).toBe(1);
  });

  it('uses MIDPOINT for forex and daily bars for volatility series', () => {
    const eur: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };
    expect(historySpec({ contract: eur, timeframe: '1h' }).whatToShow).toBe('MIDPOINT');
    const iv = historySpec({ contract: index('SPX', 'CBOE'), timeframe: '1D', whatToShow: 'OPTION_IMPLIED_VOLATILITY' });
    expect([iv.barSize, iv.duration, iv.whatToShow]).toEqual(['1 day', '2 Y', 'OPTION_IMPLIED_VOLATILITY']);
    expect(historySpec({ contract: aapl, timeframe: '5m', whatToShow: 'HISTORICAL_VOLATILITY' }).barSize).toBe('1 day');
  });

  it('caches intraday bars briefly and longer bars for minutes', () => {
    expect(historyTtlMs('1m')).toBe(30_000);
    expect(historyTtlMs('1D')).toBe(300_000);
  });

  it('keeps stored bars for at least the fetch window, and not much longer', () => {
    const DAY = 86_400;
    const timeframes: Timeframe[] = ['1m', '5m', '1h', '1D', '1W', '1M', '1Y'];
    const iv = (tf: Timeframe) => historySpec({ contract: aapl, timeframe: tf, whatToShow: 'OPTION_IMPLIED_VOLATILITY' });
    for (const s of [...timeframes.map((tf) => historySpec({ contract: aapl, timeframe: tf, outsideRth: true })), iv('5m'), iv('1D')]) {
      expect(s.retentionSec).toBeGreaterThanOrEqual(durationSpanSec(s.duration));
    }
    const days = (tf: Timeframe) => historySpec({ contract: aapl, timeframe: tf }).retentionSec / DAY;
    // 2 trading days back from a Sunday after a holiday reach Wednesday.
    expect(days('1m')).toBeGreaterThanOrEqual(5);
    expect(days('1m')).toBeLessThan(8);
    expect(days('5m')).toBeGreaterThanOrEqual(17);
    // '2 M' reaches back up to 62 days; a flat 30-day intraday limit would cut it in half.
    expect(days('1h')).toBeGreaterThanOrEqual(65);
    expect(days('1D')).toBeGreaterThanOrEqual(2 * 366);
  });

  it('keys requests by what changes the result', () => {
    const a = historyKey({ contract: aapl, timeframe: '1D' }, 'STK:AAPL');
    expect(historyKey({ contract: aapl, timeframe: '1D', outsideRth: true }, 'STK:AAPL')).toBe(a);
    expect(historyKey({ contract: aapl, timeframe: '5m', outsideRth: true }, 'STK:AAPL')).not.toBe(historyKey({ contract: aapl, timeframe: '5m' }, 'STK:AAPL'));
  });
});

describe('durationSpanSec', () => {
  it('converts IB durations to calendar seconds, counting days as trading days', () => {
    const DAY = 86_400;
    expect(durationSpanSec('30 S')).toBe(30);
    expect(durationSpanSec('10 D')).toBe(14 * DAY);
    expect(durationSpanSec('1 W')).toBe(7 * DAY);
    expect(durationSpanSec('2 M')).toBe(62 * DAY);
    expect(durationSpanSec('20 Y')).toBe(20 * 366 * DAY);
  });

  it('rejects malformed durations', () => {
    expect(() => durationSpanSec('2M')).toThrow(/Invalid IB duration/);
    expect(() => durationSpanSec('2 H')).toThrow(/Invalid IB duration/);
  });
});

describe('parseBarTime', () => {
  it('reads epoch seconds for intraday bars', () => {
    expect(parseBarTime('1759411800')).toBe(1_759_411_800);
  });

  it('reads YYYYMMDD as that date at 00:00 UTC', () => {
    expect(parseBarTime('20261002')).toBe(Date.UTC(2026, 9, 2) / 1000);
  });

  it('tolerates date-time strings and rejects garbage', () => {
    expect(parseBarTime('20261002 09:30:00')).toBe(Date.UTC(2026, 9, 2, 9, 30) / 1000);
    expect(parseBarTime('finished')).toBeNaN();
  });
});

describe('bar post-processing', () => {
  const bar = (t: number, o: number, h: number, l: number, c: number, v = 1): Bar => ({ time: t, open: o, high: h, low: l, close: c, volume: v });

  it('sorts and de-duplicates', () => {
    expect(normalizeBars([bar(3, 1, 1, 1, 1), bar(1, 1, 1, 1, 1), bar(3, 2, 2, 2, 2)]).map((b) => [b.time, b.open])).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it('aggregates monthly bars into calendar years', () => {
    const m = (y: number, mo: number, o: number, h: number, l: number, c: number) => bar(Date.UTC(y, mo - 1, 1) / 1000, o, h, l, c, 10);
    const years = aggregateYears([m(2025, 11, 10, 12, 9, 11), m(2025, 12, 11, 15, 10, 14), m(2026, 1, 14, 14.5, 8, 9), m(2026, 2, 9, 20, 9, 19)]);
    expect(years).toEqual([
      bar(Date.UTC(2025, 0, 1) / 1000, 10, 15, 9, 14, 20),
      bar(Date.UTC(2026, 0, 1) / 1000, 14, 20, 8, 19, 20),
    ]);
  });
});

/** New York wall time (EDT in these dates) as unix ms. */
const ny = (date: string, hhmm = '14:00') => Date.parse(`${date}T${hhmm}:00-04:00`);
const d = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 1000;
const b = (time: number, close = 1, volume = 1): Bar => ({ time, open: close, high: close, low: close, close, volume });

describe('windows and tails', () => {
  it('starts a full window like IB counts it', () => {
    // Sunday: two trading days back are Thursday and Friday.
    expect(windowStartSec('2 D', ny('2026-10-04'))).toBe(ny('2026-10-01', '00:00') / 1000);
    expect(windowStartSec('10 D', ny('2026-10-02'))).toBe(ny('2026-09-21', '00:00') / 1000);
    expect(windowStartSec('2 Y', ny('2026-10-04'))).toBe(d('20241004'));
    expect(windowStartSec('2 M', ny('2026-10-04'))).toBe(d('20260804'));
    expect(windowStartSec('7200 S', 1_000_000_000)).toBe(1_000_000 - 7200);
  });

  it('asks for the shortest duration that reaches the second-newest bar', () => {
    const now = ny('2026-10-02', '14:00');
    // Small bars within a day: seconds (rounded up to minutes, one bar of slack).
    expect(tailDuration('1 min', now / 1000 - 7200, now)).toBe('7260 S');
    expect(tailDuration('5 mins', now / 1000 - 600, now)).toBe('900 S');
    // Larger spans and bars: trading days from the bar's New York date.
    expect(tailDuration('1 min', ny('2026-09-30', '15:58') / 1000, now)).toBe('3 D');
    expect(tailDuration('1 hour', ny('2026-10-02', '10:00') / 1000, now)).toBe('1 D');
    expect(tailDuration('1 day', d('20261001'), now)).toBe('2 D');
    expect(tailDuration('1 day', d('20261001'), ny('2026-10-05', '11:00'))).toBe('3 D');
    // Option daily series: stored daily stamps, fetched as 8-hour bars.
    expect(tailDuration('8 hours', d('20261001'), now, true)).toBe('2 D');
    expect(tailDuration('1 week', d('20260925'), ny('2026-10-04'))).toBe('3 W');
    expect(tailDuration('1 month', d('20260831'), ny('2026-10-04'))).toBe('3 M');
  });

  it('knows when US bars are settled', () => {
    expect(lastSettledMs(ny('2026-09-30', '14:00'), true)).toBeUndefined();
    expect(lastSettledMs(ny('2026-09-30', '16:20'), true)).toBeUndefined();
    expect(lastSettledMs(ny('2026-09-30', '17:00'), true)).toBe(ny('2026-09-30', '16:30'));
    expect(lastSettledMs(ny('2026-10-04', '12:00'), true)).toBe(ny('2026-10-02', '16:30'));
    expect(lastSettledMs(ny('2026-10-05', '08:00'), true)).toBe(ny('2026-10-02', '16:30'));
    // Extended hours run 04:00-20:00.
    expect(lastSettledMs(ny('2026-09-30', '19:00'), false)).toBeUndefined();
    expect(lastSettledMs(ny('2026-09-30', '21:00'), false)).toBe(ny('2026-09-30', '20:30'));
    expect(lastSettledMs(ny('2026-10-01', '03:00'), false)).toBe(ny('2026-09-30', '20:30'));
    expect(lastSettledMs(ny('2026-10-01', '05:00'), false)).toBeUndefined();
  });

  it('plans none, a tail or the full window', () => {
    const spec = historySpec({ contract: stock('AAPL'), timeframe: '1D' });
    const now = ny('2026-09-30', '14:00');
    const stored = [b(d('20240930')), b(d('20260929')), b(d('20260930'))];
    const base = { spec, contract: stock('AAPL'), stored, nowMs: now, ttlMs: 300_000 };
    expect(planFetch({ ...base, meta: undefined })).toEqual({ kind: 'full' });
    expect(planFetch({ ...base, stored: [], meta: { fetchedAt: 0 } })).toEqual({ kind: 'full' });
    expect(planFetch({ ...base, meta: { first: d('20240930'), fetchedAt: now - 1000 } })).toEqual({ kind: 'none' });
    expect(planFetch({ ...base, meta: { first: d('20240930'), fetchedAt: now - 1000 }, fresh: true })).toEqual({ kind: 'tail', duration: '2 D', from: d('20260929') });
    expect(planFetch({ ...base, meta: { first: d('20240930'), fetchedAt: now - 3_600_000 } })).toEqual({ kind: 'tail', duration: '2 D', from: d('20260929') });
    // Not covering the window (only recent bars stored): full.
    expect(planFetch({ ...base, stored: stored.slice(1), meta: { first: d('20240930'), fetchedAt: 0 } })).toEqual({ kind: 'full' });
    // A recent listing: IB's data starts after the window start, and the stored bars still do.
    expect(planFetch({ ...base, stored: stored.slice(1), meta: { first: d('20260929'), fetchedAt: 0 } }).kind).toBe('tail');
    // A tail longer than half the window: full.
    expect(planFetch({ ...base, stored: [b(d('20240930')), b(d('20250101')), b(d('20250102'))], meta: { first: d('20240930'), fetchedAt: 0 } })).toEqual({ kind: 'full' });
  });

  it('merges a tail and detects adjusted history', () => {
    const stored = [b(d('20260928'), 1), b(d('20260929'), 2), b(d('20260930'), 3)];
    expect(mergeTail(stored, [b(d('20260929'), 2), b(d('20260930'), 3.5), b(d('20261001'), 4)], '1 day').map((x) => x.close)).toEqual([1, 2, 3.5, 4]);
    expect(mergeTail(stored, [], '1 day')).toEqual(stored);
    // Weekly: the tail's first week replaces a stale stamp of the same week.
    const weekly = [b(d('20260918'), 1), b(d('20260924'), 2)];
    expect(mergeTail(weekly, [b(d('20260925'), 2.5), b(d('20261002'), 3)], '1 week').map((x) => x.time)).toEqual([d('20260918'), d('20260925'), d('20261002')]);
    expect(historyAdjusted(stored, [b(d('20260929'), 2.01)])).toBe(false);
    expect(historyAdjusted(stored, [b(d('20260929'), 1)])).toBe(true);
    expect(historyAdjusted(stored, [b(d('20261001'), 9)])).toBe(false);
  });
});

describe('periods', () => {
  it('merges intraday bars into New York days', () => {
    const t = (iso: string) => Date.parse(iso) / 1000;
    const bars = [
      { time: t('2026-10-01T13:30:00Z'), open: 5, high: 5.5, low: 4.9, close: 5.2, volume: 10 },
      { time: t('2026-10-01T16:00:00Z'), open: 5.2, high: 6, low: 5.1, close: 5.8, volume: 20 },
      // 21:00 New York is still October 1st there.
      { time: t('2026-10-02T01:00:00Z'), open: 5.8, high: 5.8, low: 5.7, close: 5.7, volume: 1 },
      { time: t('2026-10-02T13:30:00Z'), open: 5.7, high: 5.9, low: 5.0, close: 5.1, volume: 5 },
    ];
    expect(barsToDays(bars)).toEqual([
      { time: d('20261001'), open: 5, high: 6, low: 4.9, close: 5.7, volume: 31 },
      { time: d('20261002'), open: 5.7, high: 5.9, low: 5.0, close: 5.1, volume: 5 },
    ]);
  });

  it('aggregates days into Monday weeks and months stamped with their last bar', () => {
    const days = ['20260928', '20260929', '20261002', '20261005'].map((x, i) => b(d(x), i + 1, 10));
    expect(aggregateBars(days, 'week').map((x) => [x.time, x.open, x.close, x.volume])).toEqual([
      [d('20261002'), 1, 3, 30],
      [d('20261005'), 4, 4, 10],
    ]);
    expect(aggregateBars(days, 'month').map((x) => [x.time, x.open, x.close])).toEqual([
      [d('20260929'), 1, 2],
      [d('20261005'), 3, 4],
    ]);
    expect(aggregateBars(days, 'year').map((x) => x.time)).toEqual([d('20260101')]);
  });

  it('keeps the newest stamp of every period', () => {
    const monthly = [b(d('20260831'), 1), b(d('20260930'), 2), b(d('20261001'), 3), b(d('20261002'), 4)];
    expect(dedupePeriods(monthly, 'month').map((x) => x.close)).toEqual([1, 2, 4]);
    expect(dedupePeriods([b(d('20260928')), b(d('20261002')), b(d('20261005'))], 'week').map((x) => x.time)).toEqual([d('20261002'), d('20261005')]);
  });
});
