import { describe, expect, it } from 'vitest';
import { MIN_SPAN } from './chartMath';
import { isChartRange, MIN_PX_PER_BAR, missingBars, RANGES, rangeLoaded, rangeStartSec, rangeTimeframe, weekdaysThisYear } from './ranges';

/** New York wall time as unix ms (EDT unless the offset says otherwise). */
const ny = (date: string, hhmm = '14:00', offset = '-04:00') => Date.parse(`${date}T${hhmm}:00${offset}`);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;

describe('ranges', () => {
  it('lists the ranges in picker order', () => {
    expect(RANGES).toEqual(['1M', '3M', 'YTD', '1Y', '5Y', 'MAX']);
    expect(isChartRange('YTD')).toBe(true);
    expect(isChartRange('1D')).toBe(false);
  });

  it('picks an interval per range: 30m, 1h, D, D, W, M', () => {
    const now = ny('2026-10-05');
    expect(RANGES.map((r) => rangeTimeframe(r, now))).toEqual(['30m', '1h', '1D', '1D', '1W', '1M']);
  });

  it('takes a coarser interval for 1M and 3M when the plot is too narrow for the finest', () => {
    const now = ny('2026-10-05');
    // The finest without a width, and in a wide plot.
    expect([rangeTimeframe('1M', now), rangeTimeframe('3M', now)]).toEqual(['30m', '1h']);
    expect([rangeTimeframe('1M', now, 1400), rangeTimeframe('3M', now, 3000)]).toEqual(['30m', '1h']);
    // The minimum window (a plot about 460 px wide): about 350 hourly bars for 1M, 260 4-hour bars for 3M.
    expect([rangeTimeframe('1M', now, 460), rangeTimeframe('3M', now, 460)]).toEqual(['1h', '4h']);
    expect([rangeTimeframe('1M', now, 800), rangeTimeframe('3M', now, 800)]).toEqual(['1h', '2h']);
    // Never coarser than the last choice; other ranges do not depend on the width.
    expect([rangeTimeframe('1M', now, 50), rangeTimeframe('3M', now, 50)]).toEqual(['2h', '4h']);
    expect(['YTD', '1Y', '5Y', 'MAX'].map((r) => rangeTimeframe(r as 'YTD', now, 50))).toEqual(['1D', '1D', '1W', '1M']);
    expect(MIN_PX_PER_BAR).toBeGreaterThanOrEqual(1);
  });

  it('YTD shows days once the year has MIN_SPAN sessions, a finer interval in early January', () => {
    expect(MIN_SPAN).toBe(20);
    // 2027: Friday 01-01 counts as a weekday (holidays are not modelled).
    expect(weekdaysThisYear(ny('2027-01-01', '12:00', '-05:00'))).toBe(1);
    expect(weekdaysThisYear(ny('2027-01-28', '12:00', '-05:00'))).toBe(20);
    expect(rangeTimeframe('YTD', ny('2027-01-28', '12:00', '-05:00'))).toBe('1D');
    expect(rangeTimeframe('YTD', ny('2027-01-27', '12:00', '-05:00'))).toBe('1h');
    expect(rangeTimeframe('YTD', ny('2027-01-01', '12:00', '-05:00'))).toBe('30m');
    // New Year's Eve still belongs to the old year, in New York time (05:00 UTC on January 1st).
    expect(rangeTimeframe('YTD', Date.parse('2027-01-01T04:30:00Z'))).toBe('1D');
  });

  it('starts at the New York calendar date the span reaches back to', () => {
    const now = ny('2026-10-05');
    // Daily and longer bars are stamped 00:00 UTC on their date.
    expect(rangeStartSec('1Y', now, '1D')).toBe(day(2025, 10, 5));
    expect(rangeStartSec('5Y', now, '1W')).toBe(day(2021, 10, 5));
    expect(rangeStartSec('YTD', now, '1D')).toBe(day(2026, 1, 1));
    // Intraday bars are instants: 00:00 New York of the start date (EST in winter).
    expect(rangeStartSec('1M', now, '30m')).toBe(ny('2026-09-05', '00:00') / 1000);
    expect(rangeStartSec('3M', now, '1h')).toBe(ny('2026-07-05', '00:00') / 1000);
    expect(rangeStartSec('3M', ny('2027-02-10', '12:00', '-05:00'), '1h')).toBe(ny('2026-11-10', '00:00', '-05:00') / 1000);
    // A month back from March 31st is the last day of February.
    expect(rangeStartSec('1M', ny('2027-03-31', '12:00'), '30m')).toBe(ny('2027-02-28', '00:00', '-05:00') / 1000);
    // YTD across New Year: on January 2nd it starts on January 1st of the new year.
    expect(rangeStartSec('YTD', ny('2027-01-02', '12:00', '-05:00'), '30m')).toBe(ny('2027-01-01', '00:00', '-05:00') / 1000);
    expect(rangeStartSec('YTD', Date.parse('2027-01-01T04:30:00Z'), '1D')).toBe(day(2026, 1, 1));
    // MAX: everything there is.
    expect(rangeStartSec('MAX', now, '1M')).toBeNull();
  });

  it('sizes the page that loads the rest of a range, and knows when it is loaded', () => {
    const start = ny('2026-07-05', '00:00') / 1000;
    const oldest = ny('2026-09-08', '04:00') / 1000;
    // About two months of 1-hour bars of extended hours: 46 sessions x 16.
    const n = missingBars('1h', start, oldest);
    expect(n).toBeGreaterThan(46 * 16);
    expect(n).toBeLessThan(46 * 16 * 1.4);
    expect(missingBars('1D', day(2025, 10, 5), day(2025, 10, 5))).toBe(0);
    expect(missingBars('1M', day(1980, 1, 1), day(2006, 10, 1))).toBeGreaterThan(26 * 12);
    expect(rangeLoaded(start, [{ time: start - 1 }], false)).toBe(true);
    expect(rangeLoaded(start, [{ time: start + 3600 }], false)).toBe(false);
    // A listing younger than the range, or MAX with the head reached.
    expect(rangeLoaded(start, [{ time: start + 3600 }], true)).toBe(true);
    expect(rangeLoaded(null, [{ time: 1 }], false)).toBe(false);
    expect(rangeLoaded(null, [{ time: 1 }], true)).toBe(true);
    expect(rangeLoaded(null, [], true)).toBe(false);
  });
});
