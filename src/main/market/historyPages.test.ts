import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { Bar, ContractRef, HistoryRequest } from '@shared/types';
import { historySpec } from './historyParams';
import {
  alignUp,
  barsPerUnit,
  claimStart,
  durationUnits,
  headStamp,
  ibEndDateTime,
  intradayCoverageStart,
  newestBarsStale,
  nextPeriodStart,
  pageBound,
  pageDuration,
  pageEnd,
  periodStart,
  presentedPeriod,
  weekdaysBackStart,
  yearsBackStart,
} from './historyPages';

/** New York wall time as unix seconds (EDT, UTC−4, unless the date says otherwise). */
const ny = (date: string, hhmm = '00:00', offset = '-04:00') => Date.parse(`${date}T${hhmm}:00${offset}`) / 1000;
const d = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 1000;
const b = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const spec = (req: Partial<HistoryRequest> & Pick<HistoryRequest, 'timeframe'>) => historySpec({ contract: stock('AAPL'), ...req });
const aapl = stock('AAPL');
const call = option('AAPL', '20261120', 260, 'C');
const eur: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };

describe('periods', () => {
  it('finds period starts and aligns up', () => {
    expect(periodStart(d('20240105'), 'week')).toBe(d('20240101'));
    expect(periodStart(d('20240107'), 'week')).toBe(d('20240101'));
    expect(periodStart(d('20230131'), 'month')).toBe(d('20230101'));
    expect(periodStart(d('20230615'), 'year')).toBe(d('20230101'));
    expect(nextPeriodStart(d('20240105'), 'week')).toBe(d('20240108'));
    expect(nextPeriodStart(d('20231231'), 'month')).toBe(d('20240101'));
    expect(alignUp(d('20240101'), 'week')).toBe(d('20240101'));
    expect(alignUp(d('20240102'), 'week')).toBe(d('20240108'));
    expect(alignUp(1234, 'intraday')).toBe(1234);
  });

  it('ends a page where the period of the oldest bar begins', () => {
    // Daily and intraday: strictly older than the bar itself.
    expect(pageBound(d('20241003'), spec({ timeframe: '1D' }))).toBe(d('20241003'));
    expect(pageBound(1790323200, spec({ timeframe: '5m' }))).toBe(1790323200);
    // IB stamps weekly / monthly bars with the last trading day of the period.
    expect(pageBound(d('20240105'), spec({ timeframe: '1W' }))).toBe(d('20240101'));
    expect(pageBound(d('20230131'), spec({ timeframe: '1M' }))).toBe(d('20230101'));
    expect(pageBound(d('20230101'), spec({ timeframe: '1Y' }))).toBe(d('20230101'));
    // Option weeks are built from days and stamped with their last day.
    const optWeek = historySpec({ contract: call, timeframe: '1W' });
    expect(presentedPeriod(optWeek)).toBe('week');
    expect(pageBound(d('20261002'), optWeek)).toBe(d('20260928'));
  });

  it('ends intraday page requests on the bar grid', () => {
    const m5 = spec({ timeframe: '5m', outsideRth: true });
    // Live: "5 mins" ending 17:03:27 UTC returned the 17:00 bar cut there; ending 17:05:00 returned it whole.
    expect(ibEndDateTime(pageEnd(Date.parse('2026-09-30T17:03:27Z') / 1000, m5))).toBe('20260930-17:05:00');
    expect(pageEnd(ny('2026-09-30', '13:00'), m5)).toBe(ny('2026-09-30', '13:00'));
    expect(pageEnd(ny('2026-09-30', '13:00') + 1, spec({ timeframe: '1m' }))).toBe(ny('2026-09-30', '13:01'));
    // The regular-hours 09:30 bar of "1 hour" ends at 10:00, on the hour.
    expect(pageEnd(ny('2026-09-30', '09:45'), spec({ timeframe: '1h' }))).toBe(ny('2026-09-30', '10:00'));
    // Daily and longer series are date stamps; their pages end where the coverage starts.
    expect(pageEnd(d('20240105'), spec({ timeframe: '1D' }))).toBe(d('20240105'));
  });

  it('starts the served intraday coverage at midnight New York', () => {
    // Friday 17:03:27: 29 days back is Thursday 09-03 17:03:27, so the coverage starts on 09-04.
    expect(intradayCoverageStart(Date.parse('2026-10-02T17:03:27-04:00'), 29)).toBe(ny('2026-09-04'));
    expect(intradayCoverageStart(Date.parse('2026-10-02T00:00:00-04:00'), 29)).toBe(ny('2026-09-04'));
    // Across the change to standard time.
    expect(intradayCoverageStart(Date.parse('2026-11-20T12:00:00-05:00'), 29)).toBe(ny('2026-10-23'));
  });

  it('formats endDateTime in UTC and dates head timestamps', () => {
    expect(ibEndDateTime(d('20250101'))).toBe('20250101-00:00:00');
    expect(ibEndDateTime(ny('2026-09-25', '13:00'))).toBe('20260925-17:00:00');
    // AAPL's head timestamp (formatDate 2) as answered live.
    expect(headStamp(345479400, spec({ timeframe: '1D' }))).toBe(d('19801212'));
    expect(headStamp(345479400, spec({ timeframe: '5m' }))).toBe(345479400);
  });
});

describe('page durations', () => {
  it('asks for about the missing bars, within what IB allows', () => {
    const ext = (tf: '1m' | '5m' | '1h') => spec({ timeframe: tf, outsideRth: true });
    expect(pageDuration(ext('1m'), 300)).toBe('1 D');
    expect(pageDuration(ext('1m'), 2000)).toBe('3 D');
    expect(pageDuration(spec({ timeframe: '1m' }), 5000)).toBe('5 D');
    expect(pageDuration(ext('5m'), 300)).toBe('2 D');
    expect(pageDuration(ext('1h'), 300)).toBe('19 D');
    expect(pageDuration(ext('1h'), 1000)).toBe('20 D');
    expect(pageDuration(spec({ timeframe: '1D' }), 100)).toBe('1 Y');
    expect(pageDuration(spec({ timeframe: '1D' }), 300)).toBe('2 Y');
    expect(pageDuration(spec({ timeframe: '1W' }), 300)).toBe('6 Y');
    expect(pageDuration(spec({ timeframe: '1M' }), 12)).toBe('2 Y');
    expect(pageDuration(spec({ timeframe: '1M' }), 300)).toBe('20 Y');
    // 1Y pages in years (of monthly bars).
    expect(pageDuration(spec({ timeframe: '1Y' }), 5)).toBe('5 Y');
    expect(pageDuration(spec({ timeframe: '1Y' }), 30)).toBe('20 Y');
    // Options: days from 8-hour bars; a week of days per presented week.
    expect(pageDuration(historySpec({ contract: call, timeframe: '1D' }), 300)).toBe('2 Y');
    expect(pageDuration(historySpec({ contract: call, timeframe: '1W' }), 40)).toBe('1 Y');
  });

  it('asks for longer spans of sparse series', () => {
    const optM5 = historySpec({ contract: call, timeframe: '5m', outsideRth: true });
    expect(barsPerUnit(optM5)).toBe(192);
    expect(pageDuration(optM5, 300)).toBe('2 D');
    // The option traded in a sixth of the 5-minute bars: about six times the sessions, within the cap.
    expect(pageDuration(optM5, 300, 1 / 6)).toBe('10 D');
    expect(pageDuration(optM5, 100, 1 / 6)).toBe('4 D');
    expect(pageDuration(spec({ timeframe: '1D' }), 100, 0.25)).toBe('2 Y');
    expect(durationUnits('10 D')).toBe(10);
    expect(durationUnits('nonsense')).toBe(1);
  });
});

describe('claims', () => {
  const m1 = spec({ timeframe: '1m', outsideRth: true });

  it('counts N D as weekdays back to 00:00 New York, the day of the end included once past midnight', () => {
    expect(weekdaysBackStart(ny('2026-09-25', '13:00'), 1)).toBe(ny('2026-09-25'));
    expect(weekdaysBackStart(ny('2026-09-25', '13:00'), 2)).toBe(ny('2026-09-24'));
    // Monday 00:00: Monday has not begun, the window ends with Friday.
    expect(weekdaysBackStart(ny('2026-09-28'), 1)).toBe(ny('2026-09-25'));
    expect(weekdaysBackStart(ny('2026-09-27', '12:00'), 1)).toBe(ny('2026-09-25'));
    expect(weekdaysBackStart(ny('2026-09-25', '13:00'), 5)).toBe(ny('2026-09-21'));
  });

  it('takes a calendar year back in New York wall time', () => {
    expect(yearsBackStart(d('20250101'), 1)).toBe(ny('2023-12-31', '19:00', '-05:00'));
    expect(yearsBackStart(ny('2026-08-01', '20:00'), 2)).toBe(ny('2024-08-01', '20:00'));
  });

  it('claims what IB returned for N D windows, not the calendar marker (checked live)', () => {
    // "1 D" ending Friday 13:00 returned Friday from 04:00; the marker said Thursday 13:00.
    const fri = [b(ny('2026-09-25', '04:00')), b(ny('2026-09-25', '12:59'))];
    expect(claimStart({ spec: m1, contract: aapl, end: ny('2026-09-25', '13:00'), duration: '1 D', bars: fri })).toBe(ny('2026-09-25'));
    // Ending Monday 00:00 it returned Friday: Friday on is complete (the weekend had nothing).
    expect(claimStart({ spec: m1, contract: aapl, end: ny('2026-09-28'), duration: '1 D', bars: fri })).toBe(ny('2026-09-25'));
    // "2 D" returned Thursday from 04:00.
    const thu = [b(ny('2026-09-24', '04:00')), ...fri];
    expect(claimStart({ spec: m1, contract: aapl, end: ny('2026-09-25', '13:00'), duration: '2 D', bars: thu })).toBe(ny('2026-09-24'));
    // A holiday in the window: IB went further back than the weekday count; the bars say so.
    const before = [b(ny('2026-09-04', '04:00'))];
    expect(claimStart({ spec: m1, contract: aapl, end: ny('2026-09-08', '13:00'), duration: '2 D', bars: before })).toBe(ny('2026-09-04', '04:00'));
  });

  it('claims an option window without trades (162 no data) by the weekday count', () => {
    const optMin = historySpec({ contract: call, timeframe: '1m', outsideRth: true });
    expect(claimStart({ spec: optMin, contract: call, end: ny('2026-09-25', '13:00'), duration: '1 D', bars: [] })).toBe(ny('2026-09-25'));
  });

  it('claims only from the bars for instruments without New York sessions, and W / M intraday windows', () => {
    const fx = historySpec({ contract: eur, timeframe: '1h' });
    expect(claimStart({ spec: fx, contract: eur, end: ny('2026-09-28'), duration: '1 D', bars: [] })).toBeUndefined();
    expect(claimStart({ spec: fx, contract: eur, end: ny('2026-09-28'), duration: '1 D', bars: [b(ny('2026-09-27', '17:15'))] })).toBe(ny('2026-09-27', '17:15'));
    // "1 M" of 1-hour bars ending 09-25 13:00 started on 08-27 (marker: 08-25).
    const h1 = spec({ timeframe: '1h', outsideRth: true });
    expect(claimStart({ spec: h1, contract: aapl, end: ny('2026-09-25', '13:00'), duration: '1 M', bars: [b(ny('2026-08-27', '04:00'))] })).toBe(ny('2026-08-27', '04:00'));
  });

  it('claims daily Y windows from the first bar or the calendar start plus slack', () => {
    const day = spec({ timeframe: '1D' });
    const end = d('20250101');
    expect(claimStart({ spec: day, contract: aapl, end, duration: '1 Y', bars: [b(d('20240102')), b(d('20241231'))] })).toBe(d('20240102'));
    // Nothing returned (before the listing): the calendar start plus three days, then the next date.
    expect(claimStart({ spec: day, contract: aapl, end, duration: '1 Y', bars: [] })).toBe(d('20240104'));
  });

  it('never claims a weekly or monthly bar that may be partial', () => {
    const week = spec({ timeframe: '1W' });
    // A window ending Monday 2025-01-06 (UTC): the first bar 2024-01-05 may cover part of its week.
    expect(claimStart({ spec: week, contract: aapl, end: d('20250106'), duration: '1 Y', bars: [b(d('20240105')), b(d('20250103'))] })).toBe(d('20240108'));
    expect(claimStart({ spec: week, contract: eur, end: d('20250106'), duration: '1 Y', bars: [b(d('20240105'))] })).toBe(d('20240108'));
    // Monthly bars for a 1Y chart: the window started 2022-12-31 19:00, so January 2023 is whole.
    const month = spec({ timeframe: '1Y' });
    expect(claimStart({ spec: month, contract: aapl, end: d('20250101'), duration: '2 Y', bars: [b(d('20230131'))] })).toBe(d('20230101'));
    expect(claimStart({ spec: month, contract: eur, end: d('20250101'), duration: '2 Y', bars: [b(d('20230131'))] })).toBe(d('20230201'));
  });

  it('skips the first day built from 8-hour option bars', () => {
    const optDay = historySpec({ contract: call, timeframe: '1D' });
    const bars = [b(d('20260608')), b(d('20260609'))];
    // The calendar start of a 2 Y window is far older (before the listing), so it wins.
    expect(claimStart({ spec: optDay, contract: call, end: d('20261003'), duration: '2 Y', bars })).toBe(d('20241006'));
    expect(claimStart({ spec: optDay, contract: { ...call, currency: 'EUR' }, end: d('20261003'), duration: '2 Y', bars })).toBe(d('20260609'));
  });

  it('claims the first weekly or monthly period whole where the series begins in it', () => {
    const week = historySpec({ contract: eur, timeframe: '1W' });
    // EUR.USD's head timestamp (live): 2005-03-09 00:00 New York; IB's first weekly bar is 2005-03-11.
    const head = headStamp(1110344400, week);
    expect(head).toBe(d('20050309'));
    const lone = [b(d('20050311'))];
    expect(claimStart({ spec: week, contract: eur, end: d('20050314'), duration: '6 Y', bars: lone, head })).toBe(d('20050307'));
    expect(claimStart({ spec: week, contract: eur, end: d('20070226'), duration: '6 Y', bars: [...lone, b(d('20050318'))], head })).toBe(d('20050307'));
    // Without the head timestamp, or with one before the first bar's period, the first week may be partial.
    expect(claimStart({ spec: week, contract: eur, end: d('20050314'), duration: '6 Y', bars: lone })).toBeUndefined();
    expect(claimStart({ spec: week, contract: eur, end: d('20070226'), duration: '2 Y', bars: [b(d('20050318'))], head })).toBe(d('20050321'));
    // A window that starts inside the head's week (2011-03-09 minus 6 years) may have cut it.
    expect(claimStart({ spec: week, contract: eur, end: d('20110309'), duration: '6 Y', bars: [...lone, b(d('20050318'))], head })).toBe(d('20050314'));
    const month = historySpec({ contract: eur, timeframe: '1M' });
    expect(claimStart({ spec: month, contract: eur, end: d('20050401'), duration: '2 Y', bars: [b(d('20050331'))], head })).toBe(d('20050301'));
    // Days built from 8-hour option bars: the listing day is whole.
    const optDay = historySpec({ contract: { ...call, currency: 'EUR' }, timeframe: '1D' });
    expect(claimStart({ spec: optDay, contract: { ...call, currency: 'EUR' }, end: d('20261003'), duration: '2 Y', bars: [b(d('20260608')), b(d('20260609'))], head: d('20260608') })).toBe(d('20260608'));
  });

  it('claims nothing at or after the end', () => {
    expect(claimStart({ spec: m1, contract: eur, end: 100, duration: '1 D', bars: [b(100)] })).toBeUndefined();
  });
});

describe('staleness of the newest bars', () => {
  const ms = (s: number) => s * 1000;

  it('intraday: a new bar has started since the last load', () => {
    expect(newestBarsStale('1m', ms(ny('2026-09-30', '10:00') + 30), ms(ny('2026-09-30', '10:00') + 50))).toBe(false);
    expect(newestBarsStale('1m', ms(ny('2026-09-30', '10:00') + 30), ms(ny('2026-09-30', '10:01') + 5))).toBe(true);
    expect(newestBarsStale('5m', ms(ny('2026-09-30', '10:01')), ms(ny('2026-09-30', '10:04')))).toBe(false);
    expect(newestBarsStale('5m', ms(ny('2026-09-30', '10:01')), ms(ny('2026-09-30', '10:05')))).toBe(true);
  });

  it('daily: a new session has opened; weekly / monthly: in a new period', () => {
    const at = (date: string, hhmm: string) => ms(ny(date, hhmm));
    expect(newestBarsStale('1D', at('2026-09-28', '14:00'), at('2026-09-28', '15:00'))).toBe(false);
    expect(newestBarsStale('1D', at('2026-09-28', '17:00'), at('2026-09-29', '09:00'))).toBe(false);
    expect(newestBarsStale('1D', at('2026-09-28', '17:00'), at('2026-09-29', '10:00'))).toBe(true);
    expect(newestBarsStale('1D', at('2026-09-25', '17:00'), at('2026-09-26', '12:00'))).toBe(false);
    expect(newestBarsStale('1W', at('2026-09-28', '14:00'), at('2026-09-30', '10:00'))).toBe(false);
    expect(newestBarsStale('1W', at('2026-09-28', '14:00'), at('2026-10-05', '10:00'))).toBe(true);
    expect(newestBarsStale('1M', at('2026-09-30', '14:00'), at('2026-10-01', '10:00'))).toBe(true);
    expect(newestBarsStale('1Y', at('2026-09-30', '14:00'), at('2026-10-01', '10:00'))).toBe(false);
  });

  it('daily and longer: the session has closed or settled since the load', () => {
    const at = (date: string, hhmm: string) => ms(ny(date, hhmm));
    // Loaded during the session: after the close the newest bar is final, and differs.
    expect(newestBarsStale('1D', at('2026-09-28', '10:00'), at('2026-09-28', '15:59'))).toBe(false);
    expect(newestBarsStale('1D', at('2026-09-28', '10:00'), at('2026-09-28', '16:05'))).toBe(true);
    expect(newestBarsStale('1D', at('2026-09-28', '14:00'), at('2026-09-29', '09:00'))).toBe(true);
    expect(newestBarsStale('1D', at('2026-09-25', '15:00'), at('2026-09-26', '12:00'))).toBe(true);
    // Loaded after the close: late prints until it has settled.
    expect(newestBarsStale('1D', at('2026-09-28', '16:05'), at('2026-09-28', '16:20'))).toBe(false);
    expect(newestBarsStale('1D', at('2026-09-28', '16:05'), at('2026-09-28', '20:30'))).toBe(true);
    expect(newestBarsStale('1D', at('2026-09-28', '16:35'), at('2026-09-28', '20:30'))).toBe(false);
    expect(newestBarsStale('1W', at('2026-09-28', '14:00'), at('2026-09-28', '16:05'))).toBe(true);
    expect(newestBarsStale('1M', at('2026-09-28', '14:00'), at('2026-09-28', '20:00'))).toBe(true);
  });
});
