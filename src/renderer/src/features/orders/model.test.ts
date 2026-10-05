import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { CLOCK_24H, createClock } from '@shared/timeFormat';
import { defaultSettings } from '@shared/defaults';
import type { Execution, WorkingOrder } from '@shared/types';
import { initialTicket } from '../../state/store';
import { buildOrderRequest } from '../ticket/buildOrder';
import { useOrdersMessages } from './messages';
import {
  canModifyInTicket,
  goodTillInput,
  isChildRow,
  newestExecutions,
  orderPriceText,
  orderStatusText,
  orderTypeLabel,
  parseGoodAfter,
  priceOrUndefined,
  ticketPatchFromOrder,
  timeCell,
  tradeAmount,
  workingOrders,
} from './model';

const en = useOrdersMessages.for('en');
const zh = useOrdersMessages.for('zh');

function order(p: Partial<WorkingOrder> = {}): WorkingOrder {
  return {
    orderId: 4008,
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
    createdAt: 1_000,
    updatedAt: 1_000,
    ...p,
  };
}

describe('workingOrders', () => {
  it('keeps active orders only, newest first, children after their parent', () => {
    const rows = workingOrders([
      order({ orderId: 1, createdAt: 10 }),
      order({ orderId: 2, createdAt: 30, status: 'Filled' }),
      order({ orderId: 3, createdAt: 20 }),
      order({ orderId: 5, createdAt: 21, parentId: 3 }),
      order({ orderId: 4, createdAt: 21, parentId: 3 }),
      order({ orderId: 6, createdAt: 40, status: 'Cancelled' }),
      order({ orderId: 7, createdAt: 5, parentId: 99 }),
    ]);
    expect(rows.map((o) => o.orderId)).toEqual([3, 4, 5, 1, 7]);
    expect(isChildRow(rows[1], rows)).toBe(true);
    expect(isChildRow(rows[4], rows)).toBe(false);
  });

  it('does not attach children across client ids', () => {
    const rows = workingOrders([order({ orderId: 3, clientId: 7, createdAt: 20 }), order({ orderId: 4, clientId: 0, parentId: 3, createdAt: 30 })]);
    expect(rows.map((o) => o.orderId)).toEqual([4, 3]);
  });
});

describe('orderPriceText', () => {
  it('shows limit, stop, stop-limit and trailing prices', () => {
    expect(orderPriceText(order())).toBe('226.50');
    expect(orderPriceText(order({ orderType: 'MKT', limitPrice: 0 }))).toBe('—');
    expect(orderPriceText(order({ orderType: 'STP', limitPrice: undefined, auxPrice: 245 }))).toBe('245.00');
    expect(orderPriceText(order({ orderType: 'STP LMT', limitPrice: 244.5, auxPrice: 245 }))).toBe('245.00 / 244.50');
    expect(orderPriceText(order({ orderType: 'TRAIL', limitPrice: undefined, trailStopPrice: 240.1 }))).toBe('240.10');
    expect(orderPriceText(order({ orderType: 'TRAIL', limitPrice: undefined }))).toBe('—');
  });

  it('treats IB unset doubles as missing', () => {
    expect(priceOrUndefined(Number.MAX_VALUE)).toBeUndefined();
    expect(orderPriceText(order({ limitPrice: Number.MAX_VALUE, auxPrice: Number.MAX_VALUE }))).toBe('—');
  });
});

describe('orderTypeLabel', () => {
  it('localizes known types and passes others through', () => {
    expect(orderTypeLabel('STP LMT', en)).toBe('Stop limit');
    expect(orderTypeLabel('TRAIL', zh)).toBe('跟踪止损');
    expect(orderTypeLabel('MOC', en)).toBe('MOC');
  });
});

describe('parseGoodAfter', () => {
  it('reads a bare ET time', () => {
    expect(parseGoodAfter('9:35')).toEqual({ label: '09:35 ET', etTime: '09:35' });
  });

  it('reads a dated US/Eastern time and computes the instant', () => {
    const g = parseGoodAfter('20261005 09:35:00 US/Eastern')!;
    expect(g.label).toBe('09:35 ET');
    expect(g.etTime).toBe('09:35');
    expect(g.at).toBe(Date.UTC(2026, 9, 5, 13, 35)); // EDT = UTC−4
  });

  it('converts the UTC dash format to ET', () => {
    const g = parseGoodAfter('20261205-14:35:00')!;
    expect(g.label).toBe('09:35 ET'); // EST = UTC−5
    expect(g.at).toBe(Date.UTC(2026, 11, 5, 14, 35));
  });

  it('keeps other zones and unknown formats readable', () => {
    expect(parseGoodAfter('20261005 21:35:00 Asia/Shanghai')!.label).toBe('21:35 Asia/Shanghai');
    expect(parseGoodAfter('20261005 21:35:00 Asia/Shanghai')!.etTime).toBe('09:35');
    expect(parseGoodAfter('20261005 09:35:00')).toEqual({ label: '09:35' });
    expect(parseGoodAfter('tomorrow')).toEqual({ label: 'tomorrow' });
    expect(parseGoodAfter('  ')).toBeNull();
  });

  it('writes the label in the clock format, keeping the 24-hour ET time for the ticket', () => {
    const h12en = createClock('12h', 'en');
    const h12zh = createClock('12h', 'zh');
    expect(parseGoodAfter('9:35', h12en)).toEqual({ label: '9:35 AM ET', etTime: '09:35' });
    expect(parseGoodAfter('20261005 13:05:00 US/Eastern', h12zh)!.label).toBe('下午 1:05 ET');
    expect(parseGoodAfter('20261205-14:35:00', h12en)!.label).toBe('9:35 AM ET');
    expect(parseGoodAfter('20261005 21:35:00 Asia/Shanghai', h12en)!.label).toBe('9:35 PM Asia/Shanghai');
    expect(parseGoodAfter('20261005 00:15:00', h12en)!.label).toBe('12:15 AM');
  });
});

describe('timeCell', () => {
  const t = new Date(2026, 9, 5, 14, 35, 7).getTime();
  it('shows the local time with seconds in the clock format', () => {
    expect(timeCell(t, createClock('12h', 'en'))).toBe('2:35:07 PM');
    expect(timeCell(t, createClock('12h', 'zh'))).toBe('下午 2:35:07');
    expect(timeCell(t, createClock('24h', 'zh'))).toBe('14:35:07');
  });
});

describe('orderStatusText', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0);

  it('shows a pending price condition', () => {
    const o = order({ status: 'PreSubmitted', condition: { symbol: 'AAPL', operator: '>=', price: 235, outsideRth: false } });
    expect(orderStatusText(o, en, CLOCK_24H, now)).toEqual({ text: 'Waiting · AAPL ≥ 235.00', tone: 'ac' });
    expect(orderStatusText(o, zh, CLOCK_24H, now).text).toBe('等待触发 · AAPL ≥ 235.00');
  });

  it('falls back to the normal status once the condition released the order', () => {
    const o = order({ status: 'Submitted', tif: 'GTC', condition: { symbol: 'AAPL', operator: '<=', price: 220, outsideRth: false } });
    expect(orderStatusText(o, en, CLOCK_24H, now)).toEqual({ text: 'Submitted · GTC', tone: 'mu' });
  });

  it('shows a pending good-after time until it passes', () => {
    const o = order({ status: 'PreSubmitted', goodAfterTime: '20261005 09:35:00 US/Eastern' });
    expect(orderStatusText(o, en, CLOCK_24H, now)).toEqual({ text: 'After 09:35 ET · DAY', tone: 'ac' });
    expect(orderStatusText(o, zh, CLOCK_24H, now).text).toBe('定时 09:35 ET · DAY');
    expect(orderStatusText(o, en, CLOCK_24H, Date.UTC(2026, 9, 5, 14, 0)).text).toBe('Pre-submitted · DAY');
  });

  it('adds trailing, iceberg, hold and IB messages', () => {
    expect(orderStatusText(order({ orderType: 'TRAIL', trailingPercent: 3, tif: 'GTC' }), en, CLOCK_24H, now).text).toBe('Submitted · GTC · 3%');
    expect(orderStatusText(order({ orderType: 'TRAIL', auxPrice: 1.5 }), en, CLOCK_24H, now).text).toBe('Submitted · DAY · $1.50');
    expect(orderStatusText(order({ displaySize: 100 }), zh, CLOCK_24H, now).text).toBe('已提交 · DAY · 冰山 100');
    expect(orderStatusText(order({ whyHeld: 'locate' }), en, CLOCK_24H, now).text).toBe('Submitted · DAY · Held: locate');
    expect(orderStatusText(order({ message: 'Order will not be placed until 09:30' }), en, CLOCK_24H, now).text).toBe(
      'Submitted · DAY · Order will not be placed until 09:30',
    );
  });

  it('describes transitional states', () => {
    expect(orderStatusText(order({ status: 'PendingCancel' }), en, CLOCK_24H, now).text).toBe('Cancelling');
    expect(orderStatusText(order({ status: 'PendingSubmit' }), en, CLOCK_24H, now).text).toBe('Submitting · DAY');
  });

  it('adds the GTD expiry and a session other than regular hours to the TIF', () => {
    expect(orderStatusText(order({ session: 'overnightDay', outsideRth: true }), en, CLOCK_24H, now).text).toBe('Submitted · DAY · Overnight + Day');
    expect(orderStatusText(order({ session: 'overnightDay', outsideRth: true }), zh, CLOCK_24H, now).text).toBe('已提交 · DAY · 夜盘 + 日盘');
    expect(orderStatusText(order({ status: 'PreSubmitted', session: 'overnight' }), zh, CLOCK_24H, now).text).toBe('预提交 · DAY · 夜盘');
    expect(orderStatusText(order({ tif: 'GTC', session: 'extended', outsideRth: true }), en, CLOCK_24H, now).text).toBe('Submitted · GTC · Extended hours');
    expect(orderStatusText(order({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' }), en, CLOCK_24H, now).text).toBe('Submitted · GTD 10/09 16:00 ET');
    // Orders recorded before sessions existed: outsideRth decides.
    expect(orderStatusText(order({ tif: 'GTC', outsideRth: true }), zh, CLOCK_24H, now).text).toBe('已提交 · GTC · 盘前盘后');
  });

  it('writes good-after and GTD times in the clock format', () => {
    const gat = order({ status: 'PreSubmitted', goodAfterTime: '20261005 09:35:00 US/Eastern' });
    const gtd = order({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' });
    expect(orderStatusText(gat, en, createClock('12h', 'en'), now).text).toBe('After 9:35 AM ET · DAY');
    expect(orderStatusText(gat, zh, createClock('12h', 'zh'), now).text).toBe('定时 上午 9:35 ET · DAY');
    expect(orderStatusText(gtd, en, createClock('12h', 'en'), now).text).toBe('Submitted · GTD 10/09 4:00 PM ET');
    expect(orderStatusText(gtd, zh, createClock('12h', 'zh'), now).text).toBe('已提交 · GTD 10/09 下午 4:00 ET');
    expect(orderStatusText(gtd, zh, createClock('24h', 'zh'), now).text).toBe('已提交 · GTD 10/09 16:00 ET');
  });
});

describe('ticketPatchFromOrder', () => {
  it('reproduces a stop-limit order with its advanced options', () => {
    const o = order({
      orderId: 4012,
      action: 'SELL',
      orderType: 'STP LMT',
      totalQuantity: 50,
      auxPrice: 245,
      limitPrice: 244.5,
      tif: 'GTC',
      outsideRth: true,
      displaySize: 10,
      goodAfterTime: '20261005 09:35:00 US/Eastern',
      condition: { symbol: 'AAPL', operator: '<=', price: 220, outsideRth: true },
    });
    expect(ticketPatchFromOrder(o)).toMatchObject({
      side: 'SELL',
      orderType: 'STP LMT',
      qty: 50,
      stopPrice: 245,
      limitPrice: 244.5,
      tif: 'GTC',
      goodTill: null,
      session: 'extended',
      condition: true,
      conds: [expect.objectContaining({ kind: 'price', op: '<=', value: '220', contract: stock('AAPL') })],
      condRth: true,
      iceberg: true,
      iceQty: '10',
      goodAfter: true,
      goodAfterTime: '09:35',
      advancedOpen: true,
      bracket: false,
      modifyingOrderId: 4012,
    });
  });

  it('keeps the TIF, the GTD expiry and the session', () => {
    expect(ticketPatchFromOrder(order({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' }))).toMatchObject({ tif: 'GTD', goodTill: '2026-10-09T16:00', session: 'regular', advancedOpen: false });
    expect(ticketPatchFromOrder(order({ tif: 'GTD', goodTillDate: '20261009-20:00:00' })).goodTill).toBe('2026-10-09T16:00');
    expect(ticketPatchFromOrder(order({ session: 'overnightDay', outsideRth: true }))).toMatchObject({ tif: 'DAY', session: 'overnightDay', advancedOpen: true });
    expect(ticketPatchFromOrder(order({ session: 'overnight' }))).toMatchObject({ tif: 'DAY', session: 'overnight', advancedOpen: true });
    expect(ticketPatchFromOrder(order({ tif: 'FOK' })).tif).toBe('FOK');
    expect(ticketPatchFromOrder(order({ tif: 'GTT' })).tif).toBe('DAY');
    expect(goodTillInput('whenever')).toBeNull();
  });

  it('maps trailing orders to the ticket trail fields', () => {
    expect(ticketPatchFromOrder(order({ orderType: 'TRAIL', limitPrice: undefined, trailingPercent: 2.5 }))).toMatchObject({ trailMode: 'pct', trailAmt: '2.5', limitPrice: null });
    expect(ticketPatchFromOrder(order({ orderType: 'TRAIL', limitPrice: undefined, auxPrice: 1.25 }))).toMatchObject({ trailMode: 'amt', trailAmt: '1.25' });
  });

  it('offers Modify for the ticket order types on single instruments', () => {
    expect(canModifyInTicket(order())).toBe(true);
    expect(canModifyInTicket(order({ contract: option('AAPL', '20261016', 230, 'C') }))).toBe(true);
    expect(canModifyInTicket(order({ orderType: 'MOC' }))).toBe(true);
    expect(canModifyInTicket(order({ orderType: 'VWAP' }))).toBe(false);
    expect(canModifyInTicket(order({ contract: { symbol: 'AAPL', secType: 'BAG', exchange: 'SMART', currency: 'USD' } }))).toBe(false);
  });
});

describe('executions', () => {
  const fill = (p: Partial<Execution>): Execution => ({
    execId: 'e1',
    orderId: 4008,
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    side: 'BUY',
    shares: 100,
    price: 226.95,
    time: 1,
    ...p,
  });

  it('computes the amount with the contract multiplier', () => {
    expect(tradeAmount(fill({}))).toBeCloseTo(22_695);
    expect(tradeAmount(fill({ contract: option('AAPL', '20261016', 230, 'C'), shares: 10, price: 3.1 }))).toBeCloseTo(3_100);
  });

  it('sorts newest first', () => {
    const list = newestExecutions([fill({ execId: 'a', time: 1 }), fill({ execId: 'b', time: 3 }), fill({ execId: 'c', time: 2 })]);
    expect(list.map((e) => e.execId)).toEqual(['b', 'c', 'a']);
  });
});

describe('modify keeps every attribute', () => {
  // IB replaces the whole order on a modify: whatever the ticket does not load is switched off.
  const base = { ...initialTicket(defaultSettings()) };
  const mkt = { bid: 227.48, ask: 227.49, last: 227.5, refLast: 227.5, minTick: 0.01, multiplier: 1 };
  const resend = (o: WorkingOrder) => {
    const r = buildOrderRequest({ contract: o.contract, ticket: { ...base, ...ticketPatchFromOrder(o) }, market: mkt, now: Date.UTC(2026, 9, 5, 14), timeFormat: '24h' });
    if (!r.ok) throw new Error(r.error);
    return r.request;
  };

  it('sends a limit order back with its fill attributes, algo, conditions, OCA group, route and note', () => {
    const spy = { ...stock('SPY'), conId: 756733 };
    const o = order({
      algo: { strategy: 'Adaptive', params: { adaptivePriority: 'Patient' } },
      conditions: {
        items: [
          { kind: 'price', contract: spy, operator: '<=', price: 600, triggerMethod: 2, join: 'or' },
          { kind: 'time', time: '20261009 10:30:00 US/Eastern', join: 'and' },
          { kind: 'margin', operator: '<=', percent: 25 },
        ],
        cancel: true,
        outsideRth: true,
      },
      oca: { group: 'exits', type: 2 },
      orderRef: 'core',
      displaySize: undefined,
    });
    const req = resend(o);
    expect(req).toMatchObject({ orderType: 'LMT', limitPrice: 226.5, oca: { group: 'exits', type: 2 }, orderRef: 'core' });
    expect(req.algo).toEqual(o.algo);
    expect(req.conditions).toEqual(o.conditions);
    expect(req).toMatchObject({ allOrNone: false, hidden: false, sweepToFill: false, minQty: 0, discretionaryAmt: 0 });
    // IB algo orders take no hidden or discretionary attributes; a plain limit order keeps them.
    expect(resend(order({ hidden: true, discretionaryAmt: 0.05, displaySize: undefined }))).toMatchObject({ hidden: true, discretionaryAmt: 0.05 });
  });

  it('sends the other order types back with their prices', () => {
    expect(resend(order({ orderType: 'MIT', limitPrice: 0, auxPrice: 225, triggerMethod: 8 }))).toMatchObject({ orderType: 'MIT', stopPrice: 225, triggerMethod: 8 });
    expect(resend(order({ orderType: 'TRAIL LIMIT', action: 'SELL', limitPrice: 221.3, auxPrice: 2, trailStopPrice: 220.5, limitOffset: 0.4 }))).toMatchObject({
      orderType: 'TRAIL LIMIT',
      trailingAmount: 2,
      trailStopPrice: 220.5,
      limitOffset: 0.4,
    });
    expect(resend(order({ orderType: 'REL', limitPrice: 0, auxPrice: 0, percentOffset: 0.5 }))).toMatchObject({ orderType: 'REL', percentOffset: 0.5 });
    expect(resend(order({ orderType: 'REL', limitPrice: 228, auxPrice: 0.02 }))).toMatchObject({ offset: 0.02, limitPrice: 228 });
    expect(resend(order({ orderType: 'MIDPRICE', limitPrice: 0 }))).not.toHaveProperty('limitPrice');
    expect(resend(order({ orderType: 'MOC', limitPrice: 0 }))).toMatchObject({ orderType: 'MOC' });
  });

  it('sends a stop with its adjustable stop, and an option with its minimum quantity', () => {
    const adj = { trigger: 240, type: 'TRAIL' as const, trailAmount: 1, trailUnit: 'percent' as const };
    expect(resend(order({ orderType: 'STP', action: 'SELL', limitPrice: 0, auxPrice: 230, adjustStop: adj })).adjustStop).toEqual(adj);
    const opt = option('AAPL', '20261016', 230, 'C');
    expect(resend(order({ contract: opt, key: 'opt', totalQuantity: 5, limitPrice: 4.25, minQty: 2 }))).toMatchObject({ minQty: 2, quantity: 5 });
  });

  it('opens the Advanced sections the order uses', () => {
    expect(ticketPatchFromOrder(order({ allOrNone: true, oca: { group: 'g', type: 1 } }))).toMatchObject({ advancedOpen: true, advSections: ['fill', 'routing'] });
    expect(ticketPatchFromOrder(order())).toMatchObject({ advancedOpen: false, advSections: [] });
  });
});

describe('new order types and attributes in the lists', () => {
  it('writes the price column of every type', () => {
    expect(orderPriceText(order({ orderType: 'MIT', limitPrice: 0, auxPrice: 225 }))).toBe('225.00');
    expect(orderPriceText(order({ orderType: 'LIT', limitPrice: 225.5, auxPrice: 225 }))).toBe('225.00 / 225.50');
    expect(orderPriceText(order({ orderType: 'MOC', limitPrice: 0 }))).toBe('—');
    expect(orderPriceText(order({ orderType: 'MIDPRICE', limitPrice: 0 }))).toBe('—');
    expect(orderPriceText(order({ orderType: 'MIDPRICE', limitPrice: 228 }))).toBe('≤ 228.00');
    // A sell's limit is a floor.
    expect(orderPriceText(order({ orderType: 'MIDPRICE', action: 'SELL', limitPrice: 228 }))).toBe('≥ 228.00');
    // Relative, snap and pegged orders show their offset (and limit).
    expect(orderPriceText(order({ orderType: 'REL', limitPrice: 230, auxPrice: 0.02 }))).toBe('±0.02 · ≤ 230.00');
    expect(orderPriceText(order({ orderType: 'REL', limitPrice: 0, percentOffset: 0.5 }))).toBe('±0.5%');
    expect(orderPriceText(order({ orderType: 'PEG MID', action: 'SELL', limitPrice: 231, auxPrice: 0.01 }))).toBe('±0.01 · ≥ 231.00');
    expect(orderPriceText(order({ orderType: 'SNAP MID', limitPrice: 0, auxPrice: 0.01 }))).toBe('±0.01');
    expect(orderPriceText(order({ orderType: 'SNAP MKT', limitPrice: 0 }))).toBe('±0.00');
    expect(orderPriceText(order({ orderType: 'TRAIL LIT', limitPrice: 0, trailStopPrice: 220.5 }))).toBe('220.50');
    expect(orderTypeLabel('MIT', en)).toBe('MIT');
    expect(en.typeNames.MIT).toBe('Market if touched');
    expect(orderTypeLabel('MIDPRICE', zh)).toBe('中间价');
  });

  it('adds the attributes to the status and waits on any condition', () => {
    const now = Date.UTC(2026, 9, 5, 14);
    const flags = order({ allOrNone: true, algo: { strategy: 'Vwap', params: {} }, triggerMethod: 8, oca: { group: 'g1', type: 1 }, route: 'NASDAQ', orderRef: 'core' });
    expect(orderStatusText(flags, en, CLOCK_24H, now).text).toBe('Submitted · DAY · AON · Trigger: Midpoint · VWAP · OCA g1 · → NASDAQ · “core”');
    expect(orderStatusText(flags, zh, CLOCK_24H, now).text).toBe('已提交 · DAY · AON · 触发：中间价 · VWAP · OCA g1 · → NASDAQ · “core”');
    const waiting = order({
      status: 'PreSubmitted',
      conditions: { items: [{ kind: 'time', time: '20261009 10:30:00 US/Eastern', join: 'and' }, { kind: 'margin', operator: '<=', percent: 25 }], outsideRth: false },
    });
    expect(orderStatusText(waiting, en, CLOCK_24H, now)).toEqual({ text: 'Waiting · after 10/09 10:30 ET +1', tone: 'ac' });
    // An order a condition cancels works meanwhile.
    const cancel = order({ conditions: { items: [{ kind: 'price', contract: stock('AAPL'), operator: '>=', price: 240 }], cancel: true, outsideRth: false } });
    expect(orderStatusText(cancel, en, CLOCK_24H, now).text).toBe('Submitted · DAY · Cancel if AAPL ≥ 240.00');
  });
});
