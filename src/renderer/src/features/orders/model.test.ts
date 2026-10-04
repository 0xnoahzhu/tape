import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { Execution, WorkingOrder } from '@shared/types';
import { useOrdersMessages } from './messages';
import {
  canModifyInTicket,
  isChildRow,
  newestExecutions,
  orderPriceText,
  orderStatusText,
  orderTypeLabel,
  parseGoodAfter,
  priceOrUndefined,
  ticketPatchFor,
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
});

describe('orderStatusText', () => {
  const now = Date.UTC(2026, 9, 5, 12, 0);

  it('shows a pending price condition', () => {
    const o = order({ status: 'PreSubmitted', condition: { symbol: 'AAPL', operator: '>=', price: 235, outsideRth: false } });
    expect(orderStatusText(o, en, now)).toEqual({ text: 'Waiting · AAPL ≥ 235.00', tone: 'ac' });
    expect(orderStatusText(o, zh, now).text).toBe('等待触发 · AAPL ≥ 235.00');
  });

  it('falls back to the normal status once the condition released the order', () => {
    const o = order({ status: 'Submitted', tif: 'GTC', condition: { symbol: 'AAPL', operator: '<=', price: 220, outsideRth: false } });
    expect(orderStatusText(o, en, now)).toEqual({ text: 'Working · GTC', tone: 'mu' });
  });

  it('shows a pending good-after time until it passes', () => {
    const o = order({ status: 'PreSubmitted', goodAfterTime: '20261005 09:35:00 US/Eastern' });
    expect(orderStatusText(o, en, now)).toEqual({ text: 'After 09:35 ET · DAY', tone: 'ac' });
    expect(orderStatusText(o, zh, now).text).toBe('定时 09:35 ET · DAY');
    expect(orderStatusText(o, en, Date.UTC(2026, 9, 5, 14, 0)).text).toBe('Pre-submitted · DAY');
  });

  it('adds trailing, iceberg, hold and IB messages', () => {
    expect(orderStatusText(order({ orderType: 'TRAIL', trailingPercent: 3, tif: 'GTC' }), en, now).text).toBe('Working · GTC · 3%');
    expect(orderStatusText(order({ orderType: 'TRAIL', auxPrice: 1.5 }), en, now).text).toBe('Working · DAY · $1.50');
    expect(orderStatusText(order({ displaySize: 100 }), zh, now).text).toBe('已提交 · DAY · 冰山 100');
    expect(orderStatusText(order({ whyHeld: 'locate' }), en, now).text).toBe('Working · DAY · Held: locate');
    expect(orderStatusText(order({ message: 'Order will not be placed until 09:30' }), en, now).text).toBe(
      'Working · DAY · Order will not be placed until 09:30',
    );
  });

  it('describes transitional states', () => {
    expect(orderStatusText(order({ status: 'PendingCancel' }), en, now).text).toBe('Cancelling');
    expect(orderStatusText(order({ status: 'PendingSubmit' }), en, now).text).toBe('Submitting · DAY');
  });
});

describe('ticketPatchFor', () => {
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
    expect(ticketPatchFor(o)).toMatchObject({
      side: 'SELL',
      orderType: 'STP LMT',
      qty: 50,
      stopPrice: 245,
      limitPrice: 244.5,
      tif: 'GTC',
      outsideRth: true,
      condition: true,
      condOp: '<=',
      condPx: '220',
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

  it('maps trailing orders to the ticket trail fields', () => {
    expect(ticketPatchFor(order({ orderType: 'TRAIL', limitPrice: undefined, trailingPercent: 2.5 }))).toMatchObject({ trailMode: 'pct', trailAmt: '2.5', limitPrice: null });
    expect(ticketPatchFor(order({ orderType: 'TRAIL', limitPrice: undefined, auxPrice: 1.25 }))).toMatchObject({ trailMode: 'amt', trailAmt: '1.25' });
  });

  it('only offers Modify for stock orders of ticket types', () => {
    expect(canModifyInTicket(order())).toBe(true);
    expect(canModifyInTicket(order({ contract: option('AAPL', '20261016', 230, 'C') }))).toBe(false);
    expect(canModifyInTicket(order({ orderType: 'MOC' }))).toBe(false);
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
