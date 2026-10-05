import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { CLOCK_24H, createClock } from '@shared/timeFormat';
import type { WorkingOrder } from '@shared/types';
import { canModifyInTicket, orderPriceText, orderStatusText, ticketPatchFromOrder, type StatusLabels } from './orderModel';

const L: StatusLabels = {
  waiting: 'Waiting',
  after: (t) => `After ${t}`,
  pending: 'Pending',
  cancelling: 'Cancelling…',
  working: 'Working',
  iceberg: 'ice',
  filled: (n) => `${n} filled`,
  sessions: { regular: 'Regular hours', extended: 'Extended hours', overnight: 'Overnight', overnightDay: 'Overnight + Day' },
};

const C24 = CLOCK_24H;

function order(over: Partial<WorkingOrder> = {}): WorkingOrder {
  return {
    orderId: 4009,
    clientId: 7,
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 100,
    limitPrice: 226.5,
    tif: 'DAY',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 100,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('orderStatusText', () => {
  it('shows working orders with their TIF', () => {
    expect(orderStatusText(order({ tif: 'GTC' }), L, C24)).toEqual({ text: 'Working · GTC', accent: false });
    expect(orderStatusText(order({ tif: 'GTC', outsideRth: true }), L, C24).text).toBe('Working · GTC · Extended hours');
    expect(orderStatusText(order({ session: 'overnightDay', outsideRth: true }), L, C24).text).toBe('Working · DAY · Overnight + Day');
    expect(orderStatusText(order({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' }), L, C24).text).toBe('Working · GTD 10/09 16:00 ET');
  });

  it('shows pending states', () => {
    expect(orderStatusText(order({ status: 'PreSubmitted' }), L, C24).text).toBe('Pending · DAY');
    expect(orderStatusText(order({ status: 'PendingSubmit' }), L, C24).text).toBe('Pending · DAY');
    expect(orderStatusText(order({ status: 'PendingCancel' }), L, C24).text).toBe('Cancelling…');
  });

  it('highlights untriggered conditions and good-after times', () => {
    const cond = order({ status: 'PreSubmitted', condition: { symbol: 'AAPL', operator: '>=', price: 235, outsideRth: false } });
    expect(orderStatusText(cond, L, C24)).toEqual({ text: 'Waiting · AAPL ≥ 235.00', accent: true });
    const gat = order({ status: 'PreSubmitted', goodAfterTime: '20261005 09:35:00 US/Eastern' });
    expect(orderStatusText(gat, L, C24)).toEqual({ text: 'After 09:35 ET · DAY', accent: true });
    // Once IB submits the order it is simply working.
    expect(orderStatusText({ ...cond, status: 'Submitted' }, L, C24).text).toBe('Working · DAY');
  });

  it('writes good-after and GTD times in the clock format', () => {
    const gat = order({ status: 'PreSubmitted', goodAfterTime: '20261005 09:35:00 US/Eastern' });
    expect(orderStatusText(gat, L, createClock('12h', 'en')).text).toBe('After 9:35 AM ET · DAY');
    const zh: StatusLabels = { ...L, after: (t) => `定时 ${t}` };
    expect(orderStatusText(gat, zh, createClock('12h', 'zh')).text).toBe('定时 上午 9:35 ET · DAY');
    const noon = order({ status: 'PreSubmitted', goodAfterTime: '20261005 12:00:00 US/Eastern' });
    expect(orderStatusText(noon, L, createClock('12h', 'en')).text).toBe('After 12:00 PM ET · DAY');
    const gtd = order({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' });
    expect(orderStatusText(gtd, L, createClock('12h', 'en')).text).toBe('Working · GTD 10/09 4:00 PM ET');
    expect(orderStatusText(gtd, L, createClock('12h', 'zh')).text).toBe('Working · GTD 10/09 下午 4:00 ET');
    expect(orderStatusText(gtd, L, createClock('24h', 'zh')).text).toBe('Working · GTD 10/09 16:00 ET');
    // The ticket keeps the 24-hour wall time IB uses, whatever the display format.
    expect(ticketPatchFromOrder(gat).goodAfterTime).toBe('09:35');
  });

  it('reads good-after times in UTC and other zones as the Orders page does', () => {
    const en12 = createClock('12h', 'en');
    const zh12 = createClock('12h', 'zh');
    const zh: StatusLabels = { ...L, after: (t) => `定时 ${t}` };
    // IB's UTC form: 14:35 UTC on 12/05 (EST) and 13:35 UTC on 10/05 (EDT) are both 9:35 ET.
    const utc = order({ status: 'PreSubmitted', goodAfterTime: '20261205-14:35:00' });
    expect(orderStatusText(utc, L, en12).text).toBe('After 9:35 AM ET · DAY');
    expect(orderStatusText(utc, L, C24).text).toBe('After 09:35 ET · DAY');
    expect(orderStatusText(utc, zh, zh12).text).toBe('定时 上午 9:35 ET · DAY');
    const utcDst = order({ status: 'PreSubmitted', goodAfterTime: '20261005-13:35:00' });
    expect(orderStatusText(utcDst, L, en12).text).toBe('After 9:35 AM ET · DAY');
    // A TWS order placed with a Shanghai clock keeps its zone.
    const sh = order({ status: 'PreSubmitted', goodAfterTime: '20261005 21:35:00 Asia/Shanghai' });
    expect(orderStatusText(sh, L, en12).text).toBe('After 9:35 PM Asia/Shanghai · DAY');
    expect(orderStatusText(sh, L, C24).text).toBe('After 21:35 Asia/Shanghai · DAY');
    expect(orderStatusText(sh, zh, zh12).text).toBe('定时 下午 9:35 Asia/Shanghai · DAY');
    // "Modify" loads the ET wall time into the ticket.
    for (const o of [utc, utcDst, sh]) expect(ticketPatchFromOrder(o)).toMatchObject({ goodAfter: true, goodAfterTime: '09:35', advancedOpen: true });
    expect(ticketPatchFromOrder(order({ goodAfterTime: '9:05' }))).toMatchObject({ goodAfter: true, goodAfterTime: '09:05' });
    expect(ticketPatchFromOrder(order())).toMatchObject({ goodAfter: false, goodAfterTime: '09:35' });
  });

  it('adds trailing percent, iceberg size and partial fills', () => {
    expect(orderStatusText(order({ orderType: 'TRAIL', trailingPercent: 3 }), L, C24).text).toBe('Working · DAY · 3%');
    expect(orderStatusText(order({ displaySize: 100 }), L, C24).text).toBe('Working · DAY · ice 100');
    expect(orderStatusText(order({ filled: 30 }), L, C24).text).toBe('Working · DAY · 30/100 filled');
  });
});

describe('orderPriceText', () => {
  it('formats each order type', () => {
    expect(orderPriceText(order())).toBe('226.50');
    expect(orderPriceText(order({ orderType: 'MKT', limitPrice: undefined }))).toBe('MKT');
    expect(orderPriceText(order({ orderType: 'STP', limitPrice: undefined, auxPrice: 245 }))).toBe('245.00');
    expect(orderPriceText(order({ orderType: 'STP LMT', limitPrice: 244.5, auxPrice: 245 }))).toBe('244.50');
    expect(orderPriceText(order({ orderType: 'TRAIL', limitPrice: undefined, trailStopPrice: 219.8 }))).toBe('219.80');
    expect(orderPriceText(order({ orderType: 'MOC', limitPrice: undefined }))).toBe('MOC');
  });
});

describe('ticketPatchFromOrder', () => {
  it('loads a limit order for modification', () => {
    expect(ticketPatchFromOrder(order({ action: 'SELL', tif: 'GTC', outsideRth: true }))).toMatchObject({
      side: 'SELL',
      qty: 100,
      orderType: 'LMT',
      limitPrice: 226.5,
      stopPrice: null,
      tif: 'GTC',
      session: 'extended',
      condition: false,
      iceberg: false,
      goodAfter: false,
      bracket: false,
      advancedOpen: true,
      modifyingOrderId: 4009,
    });
  });

  it('carries stop prices, conditions, iceberg and good-after time', () => {
    const p = ticketPatchFromOrder(
      order({
        contract: option('AAPL', '20261016', 230, 'C'),
        orderType: 'STP LMT',
        limitPrice: 4.5,
        auxPrice: 4.6,
        condition: { symbol: 'AAPL', operator: '<=', price: 220, outsideRth: true },
        displaySize: 2,
        goodAfterTime: '09:45',
      }),
    );
    expect(p).toMatchObject({
      orderType: 'STP LMT',
      limitPrice: 4.5,
      stopPrice: 4.6,
      condition: true,
      condOp: '<=',
      condPx: '220',
      condRth: true,
      iceberg: true,
      iceQty: '2',
      goodAfter: true,
      goodAfterTime: '09:45',
      advancedOpen: true,
    });
  });

  it('maps trailing orders and unknown types / TIFs', () => {
    expect(ticketPatchFromOrder(order({ orderType: 'TRAIL', trailingPercent: 2.5 }))).toMatchObject({ orderType: 'TRAIL', trailMode: 'pct', trailAmt: '2.5', limitPrice: null });
    expect(ticketPatchFromOrder(order({ orderType: 'TRAIL', auxPrice: 1.5 }))).toMatchObject({ trailMode: 'amt', trailAmt: '1.5' });
    expect(ticketPatchFromOrder(order({ orderType: 'REL', tif: 'XYZ' }))).toMatchObject({ orderType: 'LMT', tif: 'DAY' });
  });

  it('keeps the TIF, GTD expiry and session of the working order', () => {
    expect(ticketPatchFromOrder(order({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' }))).toMatchObject({ tif: 'GTD', goodTill: '2026-10-09T16:00', session: 'regular' });
    expect(ticketPatchFromOrder(order({ tif: 'FOK' }))).toMatchObject({ tif: 'FOK' });
    expect(ticketPatchFromOrder(order({ session: 'overnightDay', outsideRth: true }))).toMatchObject({ tif: 'DAY', session: 'overnightDay', advancedOpen: true });
  });
});

describe('canModifyInTicket', () => {
  it('allows the ticket order types on stocks and options', () => {
    expect(canModifyInTicket(order())).toBe(true);
    expect(canModifyInTicket(order({ orderType: 'TRAIL' }))).toBe(true);
    expect(canModifyInTicket(order({ contract: option('AAPL', '20261016', 250, 'C') }))).toBe(true);
  });

  it('refuses order types and combos the ticket would silently change', () => {
    expect(canModifyInTicket(order({ orderType: 'REL' }))).toBe(false);
    expect(canModifyInTicket(order({ orderType: 'MOC' }))).toBe(false);
    expect(canModifyInTicket(order({ contract: { symbol: 'AAPL', secType: 'BAG', exchange: 'SMART', currency: 'USD' } }))).toBe(false);
  });
});
