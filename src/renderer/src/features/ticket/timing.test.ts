import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import type { WorkingOrder } from '@shared/types';
import { initialTicket, normalizeTicketPatch, withModifiedTiming, type StoreState, type TicketState } from '../../state/store';
import { easternToUtc, fromLocalInput, goodTillTime, nextSessionClose, ticketTiming, toLocalInput } from './timing';

const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...initialTicket(defaultSettings()), ...patch });
// 2026-10-05 is a Monday.
const ny = (d: number, h: number, mi = 0) => Date.UTC(2026, 9, d, h + 4, mi);

describe('nextSessionClose', () => {
  it('is today at 16:00 ET before the close, else the next weekday', () => {
    expect(nextSessionClose(ny(5, 9))).toEqual({ ymd: '20261005', hhmm: '16:00' });
    expect(nextSessionClose(ny(5, 15, 59))).toEqual({ ymd: '20261005', hhmm: '16:00' });
    expect(nextSessionClose(ny(5, 16))).toEqual({ ymd: '20261006', hhmm: '16:00' });
    expect(nextSessionClose(ny(9, 18))).toEqual({ ymd: '20261012', hhmm: '16:00' });
    expect(nextSessionClose(ny(10, 9))).toEqual({ ymd: '20261012', hhmm: '16:00' });
  });

  it('follows IB’s liquid hours in the exchange’s time zone', () => {
    const xetra = { liquidHours: '20261005:0900-20261005:1730;20261006:0900-20261006:1730', timeZoneId: 'MET' };
    // 17:30 in Frankfurt is 11:30 in New York.
    expect(nextSessionClose(ny(5, 9), xetra)).toEqual({ ymd: '20261005', hhmm: '11:30' });
    expect(nextSessionClose(ny(5, 12), xetra)).toEqual({ ymd: '20261006', hhmm: '11:30' });
    // Older servers leave the date off the end time.
    expect(nextSessionClose(ny(5, 9), { liquidHours: '20261005:0930-1300;20261006:CLOSED;20261007:0930-1600', timeZoneId: 'US/Eastern' })).toEqual({
      ymd: '20261005',
      hhmm: '13:00',
    });
  });

  it('closes a day with a lunch break at its last session', () => {
    // As IB sent them for 700 on SEHK and 7203 on TSEJ.
    const sehk = { liquidHours: '20261004:CLOSED;20261005:0930-20261005:1200;20261005:1300-20261005:1610;20261006:0930-20261006:1200;20261006:1300-20261006:1610', timeZoneId: 'Hongkong' };
    const tsej = { liquidHours: '20261004:CLOSED;20261005:0900-20261005:1130;20261005:1230-20261005:1530;20261006:0900-20261006:1130;20261006:1230-20261006:1530', timeZoneId: 'Japan' };
    const hkt = (d: number, h: number, mi = 0) => Date.UTC(2026, 9, d, h - 8, mi);
    // 16:10 in Hong Kong is 04:10 in New York; 15:30 in Tokyo is 02:30.
    expect(nextSessionClose(hkt(5, 10), sehk)).toEqual({ ymd: '20261005', hhmm: '04:10' });
    expect(nextSessionClose(hkt(5, 12, 30), sehk)).toEqual({ ymd: '20261005', hhmm: '04:10' });
    expect(nextSessionClose(hkt(5, 16, 30), sehk)).toEqual({ ymd: '20261006', hhmm: '04:10' });
    expect(nextSessionClose(hkt(5, 8, 30), tsej)).toEqual({ ymd: '20261005', hhmm: '02:30' });
    expect(nextSessionClose(hkt(5, 11, 45), tsej)).toEqual({ ymd: '20261005', hhmm: '02:30' });
  });

  it('falls back to weekdays without usable hours', () => {
    expect(nextSessionClose(ny(5, 9), { liquidHours: '20261005:0930-20261005:1600', timeZoneId: 'Mars/Olympus' })).toEqual({ ymd: '20261005', hhmm: '16:00' });
    expect(nextSessionClose(ny(5, 17), { liquidHours: '20261005:0930-20261005:1600', timeZoneId: 'US/Eastern' })).toEqual({ ymd: '20261006', hhmm: '16:00' });
  });
});

describe('GTD input values', () => {
  it('converts between datetime-local values and New York wall times', () => {
    expect(toLocalInput({ ymd: '20261009', hhmm: '16:00' })).toBe('2026-10-09T16:00');
    expect(fromLocalInput('2026-10-09T16:00')).toEqual({ ymd: '20261009', hhmm: '16:00' });
    expect(fromLocalInput('2026-10-09T16:00:30')).toEqual({ ymd: '20261009', hhmm: '16:00' });
    expect(fromLocalInput('2026-02-30T16:00')).toBeNull();
    expect(fromLocalInput('')).toBeNull();
    expect(easternToUtc({ ymd: '20261009', hhmm: '16:00' })).toBe(Date.UTC(2026, 9, 9, 20));
  });

  it('uses the typed expiry, or the default until one is typed', () => {
    expect(goodTillTime(null, ny(5, 10))).toEqual({ ymd: '20261005', hhmm: '16:00' });
    expect(goodTillTime('2026-10-09T12:00', ny(5, 10))).toEqual({ ymd: '20261009', hhmm: '12:00' });
    expect(goodTillTime('', ny(5, 10))).toBeNull();
  });
});

describe('ticketTiming', () => {
  it('describes the ticket for the shared rules', () => {
    const t = ticket({ tif: 'GTD', orderType: 'MKT', bracket: true });
    expect(ticketTiming(t, stock('AAPL'), 'overnightDay', { ymd: '20261009', hhmm: '16:00' })).toEqual({
      contract: stock('AAPL'),
      orderType: 'MKT',
      tif: 'GTD',
      session: 'overnightDay',
      bracket: true,
      iceberg: false,
      condition: false,
      goodAfter: false,
      goodTill: Date.UTC(2026, 9, 9, 20),
    });
    expect(ticketTiming({ ...t, modifyingOrderId: 3 }, option('AAPL', '20261016', 230, 'C'), 'regular', null)).toMatchObject({ bracket: false, goodTill: undefined });
    expect(ticketTiming(ticket({ iceberg: true, condition: true, goodAfter: true }), stock('AAPL'), 'overnight', null)).toMatchObject({ iceberg: true, condition: true, goodAfter: true });
  });
});

describe('ticket session state', () => {
  it('starts in the session of Settings › Trade', () => {
    expect(ticket()).toMatchObject({ session: 'regular', outsideRth: false, goodTill: null });
    const s = defaultSettings();
    expect(initialTicket({ ...s, trading: { ...s.trading, outsideRthDefault: true } })).toMatchObject({ session: 'extended', outsideRth: true });
  });

  it('keeps outsideRth in step with the session, also for callers that only set outsideRth', () => {
    expect(normalizeTicketPatch({ session: 'overnightDay' })).toEqual({ session: 'overnightDay', outsideRth: true });
    expect(normalizeTicketPatch({ session: 'overnight', outsideRth: true })).toEqual({ session: 'overnight', outsideRth: false });
    expect(normalizeTicketPatch({ outsideRth: true, tif: 'GTC' })).toEqual({ outsideRth: true, session: 'extended', tif: 'GTC' });
    expect(normalizeTicketPatch({ outsideRth: false })).toEqual({ outsideRth: false, session: 'regular' });
    expect(normalizeTicketPatch({ qty: 5 })).toEqual({ qty: 5 });
  });
});

describe('withModifiedTiming', () => {
  const gtd: WorkingOrder = {
    orderId: 33,
    clientId: 7,
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 1,
    limitPrice: 1,
    tif: 'GTD',
    goodTillDate: '20261005 16:00:00 US/Eastern',
    outsideRth: false,
    status: 'PreSubmitted',
    filled: 0,
    remaining: 1,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const state = { orders: [gtd, { ...gtd, orderId: 34, tif: 'DAY', goodTillDate: undefined, session: 'overnightDay', outsideRth: true }], connection: { clientId: 7 } } as Pick<
    StoreState,
    'orders' | 'connection'
  >;

  it('starts a modify from the order’s TIF, GTD expiry and session, whatever the caller filled in', () => {
    // As the chart's activity panel loads a GTD order: DAY, outside RTH from IB's flag.
    expect(withModifiedTiming({ modifyingOrderId: 33, tif: 'DAY', limitPrice: 1.03 }, state)).toEqual({
      modifyingOrderId: 33,
      limitPrice: 1.03,
      tif: 'GTD',
      goodTill: '2026-10-05T16:00',
      session: 'regular',
    });
    expect(normalizeTicketPatch(withModifiedTiming({ modifyingOrderId: 34, outsideRth: true }, state))).toMatchObject({ tif: 'DAY', session: 'overnightDay', outsideRth: true });
  });

  it('leaves other patches alone', () => {
    expect(withModifiedTiming({ tif: 'GTC' }, state)).toEqual({ tif: 'GTC' });
    expect(withModifiedTiming({ modifyingOrderId: null }, state)).toEqual({ modifyingOrderId: null });
    // Another client's order with that id is not the one being modified.
    expect(withModifiedTiming({ modifyingOrderId: 33, tif: 'DAY' }, { ...state, connection: { clientId: 8 } } as typeof state)).toEqual({ modifyingOrderId: 33, tif: 'DAY' });
  });
});
