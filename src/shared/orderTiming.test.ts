import { describe, expect, it } from 'vitest';
import { option, stock } from './contract';
import {
  ibEasternTime,
  isTimingProblem,
  nyDaysUntil,
  overnightEligible,
  parseIbDateTime,
  sessionOf,
  sessionOutsideRth,
  timingProblem,
  tifChangeAllowed,
  timingProblems,
  timingText,
  unavailableReason,
  zonedParts,
  zonedToUtc,
  type TimingInput,
} from './orderTiming';

const AAPL = stock('AAPL');
const OPT = option('AAPL', '20261016', 230, 'C');
const base: TimingInput = { contract: AAPL, orderType: 'LMT', tif: 'DAY', session: 'regular' };
const NOW = Date.UTC(2026, 9, 5, 14); // Monday 10:00 New York

describe('sessions', () => {
  it('derives the session of data without one from outsideRth', () => {
    expect(sessionOf({ outsideRth: true })).toBe('extended');
    expect(sessionOf({ outsideRth: false })).toBe('regular');
    expect(sessionOf({ session: 'overnightDay', outsideRth: false })).toBe('overnightDay');
  });

  it('sets outsideRth for the sessions with pre-market and after-hours', () => {
    expect(['regular', 'extended', 'overnight', 'overnightDay'].map((s) => sessionOutsideRth(s as never))).toEqual([false, true, false, true]);
  });

  it('offers the overnight sessions for US stocks and ETFs only', () => {
    expect(overnightEligible(AAPL)).toBe(true);
    expect(overnightEligible(stock('SPY'))).toBe(true);
    expect(overnightEligible(OPT)).toBe(false);
    expect(overnightEligible({ secType: 'FUT', currency: 'USD' })).toBe(false);
    expect(overnightEligible({ secType: 'STK', currency: 'EUR' })).toBe(false);
  });
});

describe('timingProblems', () => {
  const problems = (x: Partial<TimingInput>) => timingProblems({ ...base, ...x }, NOW);

  it('accepts what IB took on the paper account', () => {
    for (const tif of ['DAY', 'GTC', 'IOC', 'OPG'] as const) expect(problems({ tif })).toEqual([]);
    expect(problems({ tif: 'GTD', goodTill: NOW + 60_000 })).toEqual([]);
    expect(problems({ tif: 'FOK', contract: OPT })).toEqual([]);
    expect(problems({ tif: 'OPG', orderType: 'MKT' })).toEqual([]);
    expect(problems({ session: 'extended', tif: 'GTC' })).toEqual([]);
    expect(problems({ session: 'overnight' })).toEqual([]);
    expect(problems({ session: 'overnightDay' })).toEqual([]);
  });

  it('refuses what IB rejected or ignores', () => {
    expect(problems({ tif: 'FOK' })).toEqual(['fokInstrument']);
    expect(problems({ tif: 'OPG', contract: OPT })).toEqual(['opgInstrument']);
    expect(problems({ tif: 'OPG', orderType: 'STP' })).toEqual(['opgType']);
    expect(problems({ tif: 'IOC', session: 'extended' })).toEqual(['regularHoursTif']);
    expect(problems({ tif: 'GTD' })).toEqual(['gtdTime']);
    expect(problems({ tif: 'GTD', goodTill: NOW })).toEqual(['gtdTime']);
    expect(problems({ session: 'overnightDay', tif: 'GTC' })).toEqual(['overnightTif']);
    expect(problems({ session: 'overnightDay', orderType: 'STP' })).toEqual(['overnightType']);
    expect(problems({ session: 'overnight', bracket: true })).toEqual(['overnightBracket']);
    // IB answered 201 "… not supported for this combination of exchange and security type".
    expect(problems({ session: 'overnightDay', iceberg: true })).toEqual(['overnightIceberg']);
    expect(problems({ session: 'overnightDay', condition: true })).toEqual(['overnightCondition']);
    expect(problems({ session: 'overnight', goodAfter: true })).toEqual(['overnightGoodAfter']);
    expect(problems({ session: 'extended', iceberg: true, condition: true, goodAfter: true })).toEqual([]);
    // Bracket children take the parent's TIF; IB rejects a stop with IOC or FOK.
    expect(problems({ tif: 'IOC', bracket: true })).toEqual(['bracketTif']);
    expect(problems({ tif: 'OPG', bracket: true })).toEqual(['bracketTif']);
    expect(problems({ tif: 'FOK', contract: OPT, bracket: true })).toEqual(['bracketTif']);
    expect(problems({ tif: 'GTC', bracket: true })).toEqual([]);
    expect(problems({ tif: 'GTD', goodTill: NOW + 60_000, bracket: true })).toEqual([]);
    expect(problems({ session: 'overnight', contract: OPT, orderType: 'MKT', tif: 'FOK' })).toEqual(['overnightInstrument', 'overnightType', 'overnightTif']);
    expect(timingProblem({ ...base, session: 'overnight', orderType: 'MKT' }, NOW)).toBe('overnightType');
  });

  it('names a problem as such', () => {
    expect(isTimingProblem('gtdTime')).toBe(true);
    expect(isTimingProblem('limit')).toBe(false);
    expect(isTimingProblem('toString')).toBe(false);
  });
});

describe('unavailableReason', () => {
  it('blames only the choices a problem depends on', () => {
    // A market order in the overnight session: DAY is still fine, GTC conflicts with the session.
    const x: TimingInput = { ...base, session: 'overnight', orderType: 'MKT' };
    expect(unavailableReason(x, 'tif', 'DAY')).toBeNull();
    expect(unavailableReason(x, 'tif', 'GTC')).toBe('overnightTif');
    expect(unavailableReason(x, 'orderType', 'LMT')).toBeNull();
    expect(unavailableReason(x, 'orderType', 'STP')).toBe('overnightType');
    expect(unavailableReason(x, 'session', 'regular')).toBeNull();
  });

  it('disables the sessions and TIFs that conflict with the order', () => {
    expect(unavailableReason({ ...base, orderType: 'MKT' }, 'session', 'overnightDay')).toBe('overnightType');
    expect(unavailableReason({ ...base, tif: 'GTC' }, 'session', 'overnight')).toBe('overnightTif');
    expect(unavailableReason({ ...base, contract: OPT }, 'session', 'overnight')).toBe('overnightInstrument');
    expect(unavailableReason({ ...base, tif: 'OPG' }, 'session', 'extended')).toBe('regularHoursTif');
    expect(unavailableReason(base, 'tif', 'FOK')).toBe('fokInstrument');
    expect(unavailableReason({ ...base, session: 'extended' }, 'tif', 'IOC')).toBe('regularHoursTif');
    expect(unavailableReason({ ...base, orderType: 'TRAIL' }, 'tif', 'OPG')).toBe('opgType');
    expect(unavailableReason({ ...base, tif: 'OPG' }, 'orderType', 'STP LMT')).toBe('opgType');
    expect(unavailableReason({ ...base, session: 'overnightDay' }, 'bracket', true)).toBe('overnightBracket');
    expect(unavailableReason({ ...base, tif: 'IOC' }, 'bracket', true)).toBe('bracketTif');
    expect(unavailableReason({ ...base, bracket: true }, 'tif', 'OPG')).toBe('bracketTif');
    expect(unavailableReason({ ...base, bracket: true }, 'tif', 'GTC')).toBeNull();
    expect(unavailableReason({ ...base, session: 'overnightDay' }, 'iceberg', true)).toBe('overnightIceberg');
    expect(unavailableReason({ ...base, session: 'overnight' }, 'condition', true)).toBe('overnightCondition');
    expect(unavailableReason({ ...base, session: 'overnightDay' }, 'goodAfter', true)).toBe('overnightGoodAfter');
    expect(unavailableReason({ ...base, session: 'overnightDay' }, 'iceberg', false)).toBeNull();
    expect(unavailableReason({ ...base, iceberg: true }, 'session', 'overnightDay')).toBe('overnightIceberg');
    expect(unavailableReason({ ...base, iceberg: true }, 'session', 'extended')).toBeNull();
    // An expiry still to be entered does not disable GTD.
    expect(unavailableReason(base, 'tif', 'GTD')).toBeNull();
  });
});

describe('tifChangeAllowed', () => {
  it('lets a working order change only what IB accepted', () => {
    expect(tifChangeAllowed('DAY', 'GTC')).toBe(true);
    expect(tifChangeAllowed('GTC', 'DAY')).toBe(true);
    expect(tifChangeAllowed('DAY', 'IOC')).toBe(true);
    expect(tifChangeAllowed('GTC', 'IOC')).toBe(true);
    expect(tifChangeAllowed('GTD', 'GTD')).toBe(true);
    // IB: 462 "Order modify failed. Cannot change to the new Time in Force".
    expect(tifChangeAllowed('DAY', 'GTD')).toBe(false);
    expect(tifChangeAllowed('GTD', 'DAY')).toBe(false);
    expect(tifChangeAllowed('GTC', 'GTD')).toBe(false);
    expect(tifChangeAllowed('DAY', 'OPG')).toBe(false);
    expect(tifChangeAllowed('OPG', 'DAY')).toBe(false);
    expect(tifChangeAllowed('DAY', 'FOK')).toBe(false);
  });
});

describe('time zones', () => {
  it('converts New York wall time across daylight saving changes', () => {
    expect(zonedToUtc('20261009', '16:00', 'America/New_York')).toBe(Date.UTC(2026, 9, 9, 20));
    expect(zonedToUtc('20261204', '16:00', 'America/New_York')).toBe(Date.UTC(2026, 11, 4, 21));
    // 2026-11-01 01:30 happens twice; 2026-03-08 02:30 does not exist.
    expect(zonedParts(zonedToUtc('20261101', '01:30', 'America/New_York'), 'America/New_York')).toMatchObject({ ymd: '20261101', hhmm: '01:30' });
    expect(zonedToUtc('20261009', '16:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 9, 14));
    expect(zonedParts(Date.UTC(2026, 9, 6, 2), 'America/New_York')).toEqual({ ymd: '20261005', hhmm: '22:00', weekday: 1 });
  });

  it('counts days to a date on New York’s calendar, whatever the viewer’s time zone', () => {
    // Thursday 2026-10-08 13:00 ET (Friday 01:00 in Shanghai): a Friday expiry is 1 day away.
    expect(nyDaysUntil('20261009', new Date(Date.UTC(2026, 9, 8, 17)))).toBe(1);
    // Friday 00:30 ET: the day itself.
    expect(nyDaysUntil('20261009', new Date(Date.UTC(2026, 9, 9, 4, 30)))).toBe(0);
    expect(nyDaysUntil('20261008', new Date(Date.UTC(2026, 9, 9, 4, 30)))).toBe(-1);
    // Across the end of daylight saving time (2026-11-01) and a year end.
    expect(nyDaysUntil('20261106', new Date(Date.UTC(2026, 9, 30, 15)))).toBe(7);
    expect(nyDaysUntil('20270115', new Date(Date.UTC(2026, 11, 31, 15)))).toBe(15);
  });

  it('reads IB date-times', () => {
    expect(ibEasternTime('20261009', '16:00')).toBe('20261009 16:00:00 US/Eastern');
    expect(parseIbDateTime('20261009 16:00:00 US/Eastern')).toBe(Date.UTC(2026, 9, 9, 20));
    expect(parseIbDateTime('20261009 16:00:00 America/New_York')).toBe(Date.UTC(2026, 9, 9, 20));
    expect(parseIbDateTime('20261009 16:00:00')).toBe(Date.UTC(2026, 9, 9, 20));
    expect(parseIbDateTime('20261009-20:00:00')).toBe(Date.UTC(2026, 9, 9, 20));
    expect(parseIbDateTime('20261009 22:00:00 Europe/Berlin')).toBe(Date.UTC(2026, 9, 9, 20));
    expect(parseIbDateTime('20261009 16:00:00 Mars/Olympus')).toBeUndefined();
    expect(parseIbDateTime('soon')).toBeUndefined();
    expect(parseIbDateTime(undefined)).toBeUndefined();
  });
});

describe('timingText', () => {
  const sessions = { regular: 'Regular hours', extended: 'Extended hours', overnight: 'Overnight', overnightDay: 'Overnight + Day' };

  it('adds the session and the GTD expiry to the TIF', () => {
    expect(timingText({ tif: 'DAY', outsideRth: false }, sessions)).toBe('DAY');
    expect(timingText({ tif: 'GTC', outsideRth: true }, sessions)).toBe('GTC · Extended hours');
    expect(timingText({ tif: 'DAY', session: 'overnightDay', outsideRth: true }, sessions)).toBe('DAY · Overnight + Day');
    expect(timingText({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' }, sessions)).toBe('GTD 10/09 16:00 ET');
    expect(timingText({ tif: 'GTD', goodTillDate: '20261009-20:00:00', session: 'extended' }, sessions)).toBe('GTD 10/09 16:00 ET · Extended hours');
    expect(timingText({ tif: 'GTD', goodTillDate: 'whenever' }, sessions)).toBe('GTD whenever');
    expect(timingText({ tif: '' }, sessions)).toBe('DAY');
  });
});
