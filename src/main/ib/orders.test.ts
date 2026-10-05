import {
  ConjunctionConnection,
  Encoder,
  ExecutionCondition,
  MarginCondition,
  OrderConditionType,
  PercentChangeCondition,
  PriceCondition,
  TimeCondition,
  TriggerMethod,
  VolumeCondition,
  type Contract,
  type Order,
  type OrderState,
} from './tws';
import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { createClock, resolveTimeTokens } from '@shared/timeFormat';
import { withOrderAttributes } from '@shared/orderRules';
import type { ContractRef, OrderRequest } from '@shared/types';
import { algoParams, buildOrders, buildPreviewOrder, goodAfterTime, validateOrderRequest } from './orderBuilder';
import {
  applyOrderStatus,
  execBaseId,
  fillNotice,
  ibOrderSession,
  mapCompletedOrder,
  mapExecution,
  mapOpenOrder,
  mapPreview,
  orderAlgo,
  orderKey,
  orderNotice,
} from './orderMapping';

const aapl = { ...stock('AAPL'), conId: 265598 };
const base: OrderRequest = { contract: aapl, action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 226.5, tif: 'DAY', outsideRth: false };
const ids = (start: number) => {
  let n = start;
  return () => n++;
};

/** The tokens of the placeOrder frame the TWS encoder writes (server version 193). */
function frame(contract: Contract, order: Order): string[] {
  let tokens: string[] = [];
  const encoder = new Encoder({
    serverVersion: 193,
    sendMsg: (...t: unknown[]) => {
      tokens = (t.flat(Infinity) as unknown[]).map((v) => (v == null ? '' : String(v)));
    },
    emitError: (msg: string) => {
      throw new Error(msg);
    },
  });
  encoder.placeOrder(1, contract, order);
  return tokens;
}

/** Sends the order through the TWS encoder to make sure it can be serialized. */
function encodes(contract: Contract, order: Order): boolean {
  let sent = false;
  const encoder = new Encoder({
    serverVersion: 193,
    sendMsg: () => {
      sent = true;
    },
    emitError: (msg: string) => {
      throw new Error(msg);
    },
  });
  encoder.placeOrder(1, contract, order);
  return sent;
}

describe('goodAfterTime', () => {
  // 2026-10-05 is a Monday; 13:00 UTC = 09:00 New York (EDT).
  it('uses today when the time is still ahead in New York', () => {
    expect(goodAfterTime('09:35', new Date(Date.UTC(2026, 9, 5, 13, 0)))).toBe('20261005 09:35:00 US/Eastern');
  });
  it('uses the next weekday once the time has passed', () => {
    expect(goodAfterTime('09:35', new Date(Date.UTC(2026, 9, 5, 15, 0)))).toBe('20261006 09:35:00 US/Eastern');
    // Friday afternoon -> Monday
    expect(goodAfterTime('9:30', new Date(Date.UTC(2026, 9, 9, 20, 0)))).toBe('20261012 09:30:00 US/Eastern');
    // Saturday morning -> Monday
    expect(goodAfterTime('10:00', new Date(Date.UTC(2026, 9, 10, 12, 0)))).toBe('20261012 10:00:00 US/Eastern');
  });
  it('uses the New York date, not the local one', () => {
    // 02:00 UTC Tuesday is still Monday 22:00 in New York.
    expect(goodAfterTime('23:00', new Date(Date.UTC(2026, 9, 6, 2, 0)))).toBe('20261005 23:00:00 US/Eastern');
  });
  it('rejects malformed times', () => {
    expect(() => goodAfterTime('9.30')).toThrow();
    expect(() => goodAfterTime('25:00')).toThrow();
  });
});

describe('buildOrders', () => {
  it('builds a limit order', () => {
    const [o] = buildOrders(base, { orderId: 10, nextOrderId: ids(11), account: 'DU1' });
    expect(o.orderId).toBe(10);
    expect(o.contract).toMatchObject({ conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' });
    expect(o.order).toEqual({ action: 'BUY', orderType: 'LMT', totalQuantity: 100, lmtPrice: 226.5, tif: 'DAY', outsideRth: false, account: 'DU1', transmit: true });
    expect(encodes(o.contract, o.order)).toBe(true);
  });

  it('sets prices per order type', () => {
    const b = (r: Partial<OrderRequest>) => buildOrders({ ...base, limitPrice: undefined, ...r }, { orderId: 1, nextOrderId: ids(2) })[0].order;
    expect(b({ orderType: 'MKT' })).not.toHaveProperty('lmtPrice');
    expect(b({ orderType: 'STP', stopPrice: 220 })).toMatchObject({ orderType: 'STP', auxPrice: 220 });
    expect(b({ orderType: 'STP LMT', stopPrice: 220, limitPrice: 219.5 })).toMatchObject({ orderType: 'STP LMT', auxPrice: 220, lmtPrice: 219.5 });
    const pct = b({ orderType: 'TRAIL', action: 'SELL', trailingPercent: 3, trailStopPrice: 219 });
    expect(pct).toMatchObject({ orderType: 'TRAIL', trailingPercent: 3, trailStopPrice: 219 });
    expect(pct).not.toHaveProperty('auxPrice');
    expect(b({ orderType: 'TRAIL', action: 'SELL', trailingAmount: 2.5 })).toMatchObject({ auxPrice: 2.5 });
  });

  it('adds iceberg, good-after time and outside RTH', () => {
    const [o] = buildOrders({ ...base, displaySize: 10, goodAfterTime: '09:35', outsideRth: true, tif: 'GTC' }, { orderId: 1, nextOrderId: ids(2), now: new Date(Date.UTC(2026, 9, 5, 13)) });
    expect(o.order).toMatchObject({ displaySize: 10, goodAfterTime: '20261005 09:35:00 US/Eastern', outsideRth: true, tif: 'GTC' });
  });

  it('builds a price condition on SMART', () => {
    const req: OrderRequest = { ...base, contract: { ...option('AAPL', '20261016', 230, 'C'), conId: 777 }, condition: { contract: aapl, operator: '>=', price: 235, outsideRth: true } };
    const [o] = buildOrders(req, { orderId: 1, nextOrderId: ids(2), conditionConId: 265598 });
    const cond = o.order.conditions?.[0] as PriceCondition;
    expect(cond).toBeInstanceOf(PriceCondition);
    expect(cond).toMatchObject({ price: 235, conId: 265598, exchange: 'SMART', isMore: true, triggerMethod: TriggerMethod.Default, conjunctionConnection: ConjunctionConnection.AND });
    expect(o.order.conditionsIgnoreRth).toBe(true);
    expect(o.order.conditionsCancelOrder).toBe(false);
    expect(encodes(o.contract, o.order)).toBe(true);
    const le = buildOrders({ ...req, condition: { ...req.condition!, operator: '<=', outsideRth: false } }, { orderId: 1, nextOrderId: ids(2), conditionConId: 1 })[0];
    expect((le.order.conditions?.[0] as PriceCondition).isMore).toBe(false);
    expect(le.order.conditionsIgnoreRth).toBe(false);
    // The watched instrument needs a conId: from the options, or the condition's own contract.
    expect(() => buildOrders({ ...req, condition: { ...req.condition!, contract: stock('AAPL') } }, { orderId: 1, nextOrderId: ids(2) })).toThrow(/price condition/);
    expect((buildOrders(req, { orderId: 1, nextOrderId: ids(2) })[0].order.conditions?.[0] as PriceCondition).conId).toBe(265598);
  });

  it('builds a bracket: parent held, children on the opposite side, last child transmits', () => {
    const out = buildOrders({ ...base, bracket: { takeProfit: 233, stopLoss: 222 } }, { orderId: 20, nextOrderId: ids(21), account: 'DU1' });
    expect(out.map((o) => [o.orderId, o.role, o.order.action, o.order.orderType, o.order.transmit, o.order.parentId])).toEqual([
      [20, 'main', 'BUY', 'LMT', false, undefined],
      [21, 'takeProfit', 'SELL', 'LMT', false, 20],
      [22, 'stopLoss', 'SELL', 'STP', true, 20],
    ]);
    expect(out[1].order.lmtPrice).toBe(233);
    expect(out[2].order.auxPrice).toBe(222);
    expect(out[2].order.totalQuantity).toBe(100);
    for (const o of out) expect(encodes(o.contract, o.order)).toBe(true);

    const tpOnly = buildOrders({ ...base, action: 'SELL', bracket: { takeProfit: 220 } }, { orderId: 30, nextOrderId: ids(31) });
    expect(tpOnly.map((o) => [o.order.action, o.order.transmit])).toEqual([
      ['SELL', false],
      ['BUY', true],
    ]);
    expect(buildOrders({ ...base, bracket: {} }, { orderId: 1, nextOrderId: ids(2) })).toHaveLength(1);
  });

  it('builds combo orders', () => {
    const req: OrderRequest = {
      ...base,
      contract: {
        symbol: 'AAPL',
        secType: 'BAG',
        exchange: 'SMART',
        currency: 'USD',
        comboLegs: [
          { conId: 11, ratio: 1, action: 'BUY', exchange: 'SMART' },
          { conId: 12, ratio: 1, action: 'SELL', exchange: 'SMART' },
        ],
      },
      quantity: 2,
      limitPrice: -0.35,
    };
    const [o] = buildOrders(req, { orderId: 1, nextOrderId: ids(2) });
    expect(o.contract).toMatchObject({ secType: 'BAG', exchange: 'SMART', comboLegs: [{ conId: 11 }, { conId: 12 }] });
    expect(o.order.lmtPrice).toBe(-0.35);
    expect(encodes(o.contract, o.order)).toBe(true);
  });

  it('validates requests', () => {
    expect(validateOrderRequest(base)).toBeNull();
    expect(validateOrderRequest({ ...base, quantity: 0 })).toMatch(/Quantity/);
    expect(validateOrderRequest({ ...base, limitPrice: undefined })).toMatch(/Limit price/);
    expect(validateOrderRequest({ ...base, orderType: 'STP' })).toMatch(/Stop price/);
    expect(validateOrderRequest({ ...base, orderType: 'TRAIL' })).toMatch(/Trailing/);
    expect(validateOrderRequest({ ...base, contract: { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' } })).toMatch(/index/);
    expect(validateOrderRequest({ ...base, displaySize: 500 })).toMatch(/Display size/);
    expect(validateOrderRequest({ ...base, goodAfterTime: 'soon' })).toMatch(/HH:MM/);
  });
});

describe('buildOrders: time in force and trading session', () => {
  // Monday 2026-10-05 10:00 New York.
  const now = new Date(Date.UTC(2026, 9, 5, 14));
  const build = (r: Partial<OrderRequest>) => buildOrders({ ...base, limitPrice: 1, quantity: 1, ...r }, { orderId: 1, nextOrderId: ids(2), account: 'DU1', now });
  /** includeOvernight is the field before the manual order indicator at server version 193. */
  const includeOvernight = (o: { contract: Contract; order: Order }) => frame(o.contract, o.order).at(-2);

  it('sends DAY, GTC, IOC and OPG on SMART during regular hours', () => {
    for (const tif of ['DAY', 'GTC', 'IOC', 'OPG'] as const) {
      const [o] = build({ tif });
      expect(o.contract.exchange).toBe('SMART');
      expect(o.order).toMatchObject({ tif, outsideRth: false });
      expect(o.order).not.toHaveProperty('includeOvernight');
      expect(o.order).not.toHaveProperty('goodTillDate');
      expect(includeOvernight(o)).toBe('');
    }
    expect(build({ tif: 'OPG', orderType: 'MKT', limitPrice: undefined })[0].order).toMatchObject({ tif: 'OPG', orderType: 'MKT' });
  });

  it('sends FOK for options', () => {
    const [o] = build({ tif: 'FOK', contract: { ...option('AAPL', '20261016', 230, 'C'), conId: 777 } });
    expect(o.order.tif).toBe('FOK');
    expect(encodes(o.contract, o.order)).toBe(true);
  });

  it('sends GTD with its expiry, also on bracket children', () => {
    const out = build({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern', bracket: { takeProfit: 2, stopLoss: 0.5 } });
    for (const o of out) expect(o.order).toMatchObject({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' });
    expect(frame(out[0].contract, out[0].order)).toContain('20261009 16:00:00 US/Eastern');
  });

  it('sends extended hours as outsideRth', () => {
    const [o] = build({ session: 'extended', tif: 'GTC' });
    expect(o.order).toMatchObject({ tif: 'GTC', outsideRth: true });
    // Requests without a session (other callers) still use outsideRth.
    expect(build({ outsideRth: true })[0].order.outsideRth).toBe(true);
    expect(build({ outsideRth: true, session: 'regular' })[0].order.outsideRth).toBe(false);
  });

  it('routes the overnight-only session to OVERNIGHT with the primary exchange', () => {
    const [o] = build({ session: 'overnight', contract: { ...aapl, primaryExchange: 'NASDAQ' } });
    expect(o.contract).toMatchObject({ exchange: 'OVERNIGHT', primaryExch: 'NASDAQ', conId: 265598 });
    expect(o.order).toMatchObject({ tif: 'DAY', outsideRth: false });
    expect(o.order).not.toHaveProperty('includeOvernight');
    const tokens = frame(o.contract, o.order);
    expect(tokens.slice(2, 12)).toEqual(['265598', 'AAPL', 'STK', '', '', '', '', 'OVERNIGHT', 'NASDAQ', 'USD']);
    expect(includeOvernight(o)).toBe('');
  });

  it('sends overnight + day as SMART with includeOvernight', () => {
    const [o] = build({ session: 'overnightDay' });
    expect(o.contract.exchange).toBe('SMART');
    expect(o.order).toMatchObject({ tif: 'DAY', outsideRth: true, includeOvernight: true });
    expect(includeOvernight(o)).toBe('1');
  });

  it('refuses what the order ticket refuses', () => {
    const v = (r: Partial<OrderRequest>) => validateOrderRequest({ ...base, ...r }, now.getTime());
    expect(v({ tif: 'FOK' })).toBe('IBKR accepts FOK only for options');
    expect(v({ tif: 'OPG', orderType: 'STP', stopPrice: 230 })).toMatch(/market or limit/);
    expect(v({ tif: 'IOC', session: 'extended' })).toMatch(/regular trading hours/);
    expect(v({ tif: 'GTD' })).toMatch(/expiry/);
    expect(v({ tif: 'GTD', goodTillDate: '20261001 16:00:00 US/Eastern' })).toMatch(/expiry/);
    expect(v({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' })).toBeNull();
    expect(v({ session: 'overnight', orderType: 'MKT', limitPrice: undefined })).toBe('The overnight sessions take limit orders only');
    expect(v({ session: 'overnightDay', tif: 'GTC' })).toBe('The overnight sessions take DAY orders only');
    expect(v({ session: 'overnightDay', bracket: { takeProfit: 230 } })).toMatch(/bracket/);
    expect(v({ session: 'overnightDay', contract: { ...option('AAPL', '20261016', 230, 'C'), conId: 777 } })).toMatch(/US stocks and ETFs/);
    // IB accepts these and then rejects them (201), leaving an Inactive order.
    expect(v({ session: 'overnightDay', quantity: 10, displaySize: 5 })).toBe('The overnight sessions do not take iceberg orders (display size)');
    expect(v({ session: 'overnight', condition: { contract: aapl, operator: '>=', price: 500, outsideRth: false } })).toBe('The overnight sessions do not take conditional orders');
    expect(v({ session: 'overnightDay', goodAfterTime: '09:35' })).toBe('The overnight sessions do not take good-after-time orders');
    expect(v({ session: 'extended', quantity: 10, displaySize: 5, goodAfterTime: '09:35' })).toBeNull();
    // Bracket children take the parent's TIF; IB rejects their stop with IOC (201).
    expect(v({ tif: 'IOC', bracket: { takeProfit: 233, stopLoss: 222 } })).toMatch(/bracket cannot use IOC, FOK or OPG/);
    expect(v({ tif: 'OPG', bracket: { takeProfit: 233 } })).toMatch(/bracket cannot use IOC, FOK or OPG/);
    expect(v({ tif: 'GTC', bracket: { takeProfit: 233, stopLoss: 222 } })).toBeNull();
    expect(() => build({ session: 'overnight', tif: 'GTC' })).toThrow(/DAY orders only/);
  });
});

describe('buildOrders: order types and attributes', () => {
  // Monday 2026-10-05 10:00 New York (EDT, UTC-4).
  const now = new Date(Date.UTC(2026, 9, 5, 14));
  const one = (r: Partial<OrderRequest>, opts: Partial<Parameters<typeof buildOrders>[1]> = {}) => {
    const [o] = buildOrders({ ...base, quantity: 1, ...r }, { orderId: 1, nextOrderId: ids(2), now, ...opts });
    expect(encodes(o.contract, o.order)).toBe(true);
    return o;
  };
  const fut: ContractRef = { symbol: 'MES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', conId: 815824257 };
  const eur: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD', conId: 12087792 };
  const bag: ContractRef = {
    symbol: 'AAPL',
    secType: 'BAG',
    exchange: 'SMART',
    currency: 'USD',
    comboLegs: [
      { conId: 11, ratio: 1, action: 'BUY', exchange: 'SMART' },
      { conId: 12, ratio: 1, action: 'SELL', exchange: 'SMART' },
    ],
  };

  it('sends the prices of each order type in the IB fields', () => {
    const at = (r: Partial<OrderRequest>) => one({ limitPrice: undefined, ...r }).order;
    expect(at({ orderType: 'MIT', stopPrice: 400 })).toMatchObject({ orderType: 'MIT', auxPrice: 400 });
    expect(at({ orderType: 'MIT', stopPrice: 400 })).not.toHaveProperty('lmtPrice');
    expect(at({ orderType: 'LIT', stopPrice: 400, limitPrice: 401 })).toMatchObject({ orderType: 'LIT', auxPrice: 400, lmtPrice: 401 });
    expect(at({ orderType: 'MOC' })).toEqual(expect.objectContaining({ orderType: 'MOC', tif: 'DAY', outsideRth: false }));
    expect(at({ orderType: 'MOC' })).not.toHaveProperty('auxPrice');
    expect(at({ orderType: 'LOC', limitPrice: 1 })).toMatchObject({ orderType: 'LOC', lmtPrice: 1 });
    expect(at({ orderType: 'MTL' })).not.toHaveProperty('lmtPrice');
    // TRAIL LIMIT: never lmtPrice (IB wants exactly one of price and offset), always the offset.
    const tl = at({ orderType: 'TRAIL LIMIT', action: 'SELL', trailingAmount: 5, trailStopPrice: 300, limitOffset: 0.1 });
    expect(tl).toMatchObject({ orderType: 'TRAIL LIMIT', auxPrice: 5, trailStopPrice: 300, lmtPriceOffset: 0.1 });
    expect(tl).not.toHaveProperty('lmtPrice');
    const tlp = at({ orderType: 'TRAIL LIMIT', action: 'SELL', trailingPercent: 2, trailStopPrice: 300, limitOffset: 0 });
    expect(tlp).toMatchObject({ trailingPercent: 2, lmtPriceOffset: 0 });
    expect(tlp).not.toHaveProperty('auxPrice');
    expect(at({ orderType: 'TRAIL MIT', trailingAmount: 300, trailStopPrice: 1 })).toMatchObject({ orderType: 'TRAIL MIT', auxPrice: 300, trailStopPrice: 1 });
    expect(at({ orderType: 'TRAIL LIT', trailingAmount: 300, trailStopPrice: 1, limitOffset: 0 })).toMatchObject({ orderType: 'TRAIL LIT', lmtPriceOffset: 0 });
    expect(at({ orderType: 'MIDPRICE' })).not.toHaveProperty('lmtPrice');
    expect(at({ orderType: 'MIDPRICE', limitPrice: 1 })).toMatchObject({ orderType: 'MIDPRICE', lmtPrice: 1 });
    expect(at({ orderType: 'REL', offset: 0.01, limitPrice: 1 })).toMatchObject({ orderType: 'REL', auxPrice: 0.01, lmtPrice: 1 });
    const pct = at({ orderType: 'REL', percentOffset: 0.01 });
    expect(pct).toMatchObject({ percentOffset: 0.01 });
    expect(pct).not.toHaveProperty('auxPrice');
    expect(at({ orderType: 'SNAP MID' })).toMatchObject({ orderType: 'SNAP MID', auxPrice: 0 });
    expect(at({ orderType: 'SNAP MKT', offset: 0.01 })).toMatchObject({ orderType: 'SNAP MKT', auxPrice: 0.01 });
    expect(at({ orderType: 'PEG MID', offset: 0, limitPrice: 1 })).toMatchObject({ orderType: 'PEG MID', auxPrice: 0, lmtPrice: 1 });
    // The lmtPriceOffset field reaches the frame (it is the third of the adjusted-order fields).
    expect(frame(one({ orderType: 'TRAIL LIMIT', limitPrice: undefined, trailingAmount: 5, trailStopPrice: 300, limitOffset: 0.1 }).contract, tl)).toContain('0.1');
  });

  it('sends fill attributes, trigger method and note', () => {
    expect(one({ allOrNone: true, hidden: true, sweepToFill: true, discretionaryAmt: 0.05, orderRef: ' note ' }).order).toMatchObject({
      allOrNone: true,
      hidden: true,
      sweepToFill: true,
      discretionaryAmt: 0.05,
      orderRef: 'note',
    });
    const opt = one({ contract: { ...option('AAPL', '20261120', 400, 'C'), conId: 845042719 }, quantity: 10, minQty: 5, limitPrice: 0.05 });
    expect(opt.order.minQty).toBe(5);
    expect(one({ orderType: 'STP', limitPrice: undefined, stopPrice: 10000, triggerMethod: 8 }).order.triggerMethod).toBe(8);
    // Nothing is sent for attributes that are off.
    const plain = one({ allOrNone: false, minQty: 0, discretionaryAmt: 0, triggerMethod: 0, orderRef: '' }).order;
    for (const k of ['allOrNone', 'minQty', 'discretionaryAmt', 'triggerMethod', 'orderRef', 'hidden', 'sweepToFill']) expect(plain).not.toHaveProperty(k);
  });

  it('sends IB algos with their parameters as tag / value strings', () => {
    const o = one({ algo: { strategy: 'Vwap', params: { maxPctVol: 0.1, startTime: '09:30', endTime: '16:00', allowPastEndTime: true, noTakeLiq: false } } }).order;
    expect(o.algoStrategy).toBe('Vwap');
    expect(o.algoParams).toEqual([
      { tag: 'maxPctVol', value: '0.1' },
      { tag: 'startTime', value: '09:30:00 US/Eastern' },
      { tag: 'endTime', value: '16:00:00 US/Eastern' },
      { tag: 'allowPastEndTime', value: '1' },
      { tag: 'noTakeLiq', value: '0' },
    ]);
    expect(one({ orderType: 'MKT', limitPrice: undefined, algo: { strategy: 'Adaptive', params: { adaptivePriority: 'Patient' } } }).order).toMatchObject({
      algoStrategy: 'Adaptive',
      algoParams: [{ tag: 'adaptivePriority', value: 'Patient' }],
    });
    // Accumulate / distribute takes its active times as UTC without a date (10315 otherwise).
    expect(algoParams({ strategy: 'AD', params: { componentSize: 1, timeBetweenOrders: 60, activeTimeStart: '09:30', activeTimeEnd: '16:00' } }, now)).toEqual([
      { tag: 'componentSize', value: '1' },
      { tag: 'timeBetweenOrders', value: '60' },
      { tag: 'activeTimeStart', value: '13:30:00' },
      { tag: 'activeTimeEnd', value: '20:00:00' },
    ]);
    // Parameters the algo does not have are not sent.
    expect(algoParams({ strategy: 'Twap', params: { strategyType: 'Marketable', startTime: '9:30' } }, now)).toEqual([{ tag: 'startTime', value: '09:30:00 US/Eastern' }]);
    expect(() => one({ algo: { strategy: 'Adaptive', params: {} } })).toThrow(/adaptivePriority/);
    expect(() => one({ session: 'extended', algo: { strategy: 'Adaptive', params: { adaptivePriority: 'Normal' } } })).toThrow(/regular trading hours/);
  });

  it('sends every kind of condition with its conjunction, and conditional cancel', () => {
    const spx: ContractRef = { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' };
    const o = one(
      {
        conditions: {
          items: [
            { kind: 'price', contract: stock('AAPL'), operator: '>=', price: 400, triggerMethod: 2, join: 'or' },
            { kind: 'price', contract: spx, operator: '<=', price: 5000 },
            { kind: 'time', time: '20261006 10:00:00 US/Eastern' },
            { kind: 'percentChange', contract: stock('MSFT'), operator: '<=', percent: -5 },
            { kind: 'volume', contract: stock('MSFT'), operator: '>=', volume: 100_000_000, join: 'or' },
          ],
          outsideRth: true,
          cancel: true,
        },
      },
      { conditionConIds: [265598, 416904, undefined, 272093, 272093] },
    ).order;
    const c = o.conditions!;
    expect(c[0]).toBeInstanceOf(PriceCondition);
    expect(c[0]).toMatchObject({ price: 400, triggerMethod: 2, conId: 265598, exchange: 'SMART', isMore: true, conjunctionConnection: 'o' });
    expect(c[1]).toMatchObject({ price: 5000, conId: 416904, exchange: 'CBOE', isMore: false, conjunctionConnection: 'a' });
    expect(c[2]).toBeInstanceOf(TimeCondition);
    expect(c[2]).toMatchObject({ time: '20261006 10:00:00 US/Eastern', isMore: true });
    expect(c[3]).toBeInstanceOf(PercentChangeCondition);
    expect(c[3]).toMatchObject({ percent: -5, conId: 272093, exchange: 'SMART', isMore: false });
    // The last condition joins nothing: always AND.
    expect(c[4]).toBeInstanceOf(VolumeCondition);
    expect(c[4]).toMatchObject({ volume: 100_000_000, exchange: 'SMART', isMore: true, conjunctionConnection: 'a' });
    expect(o).toMatchObject({ conditionsIgnoreRth: true, conditionsCancelOrder: true });
    const margin = one({ conditions: { items: [{ kind: 'margin', operator: '<=', percent: 30 }], outsideRth: false } }).order;
    expect(margin.conditions![0]).toBeInstanceOf(MarginCondition);
    expect(margin.conditions![0]).toMatchObject({ percent: 30, isMore: false });
    expect(margin.conditionsCancelOrder).toBe(false);
    const exec = one({ conditions: { items: [{ kind: 'execution', symbol: 'msft', secType: 'STK' }], outsideRth: false } }).order.conditions![0];
    expect(exec).toBeInstanceOf(ExecutionCondition);
    expect(exec).toMatchObject({ symbol: 'MSFT', secType: 'STK', exchange: 'SMART' });
    expect(() => one({ conditions: { items: [{ kind: 'volume', contract: stock('MSFT'), operator: '>=', volume: 1 }], outsideRth: false } })).toThrow(/Could not resolve MSFT/);
    // IB refuses conditional stops (148); Tape no longer sends them.
    expect(() => one({ orderType: 'STP', limitPrice: undefined, stopPrice: 400, condition: { contract: aapl, operator: '>=', price: 1, outsideRth: false } })).toThrow(/Conditional orders/);
  });

  it('builds stop-loss types and adjustable stops', () => {
    const sl = (bracket: OrderRequest['bracket'], r: Partial<OrderRequest> = {}) => {
      const out = buildOrders({ ...base, quantity: 1, bracket, ...r }, { orderId: 10, nextOrderId: ids(11), now });
      for (const o of out) expect(encodes(o.contract, o.order)).toBe(true);
      return out.at(-1)!.order;
    };
    expect(sl({ stopLoss: 0.5, stopType: 'STP LMT', stopLimit: 0.45 })).toMatchObject({ orderType: 'STP LMT', auxPrice: 0.5, lmtPrice: 0.45, parentId: 10, action: 'SELL' });
    expect(sl({ stopLoss: 0.5, stopType: 'TRAIL', stopTrailAmount: 0.2 })).toMatchObject({ orderType: 'TRAIL', auxPrice: 0.2, trailStopPrice: 0.5 });
    expect(sl({ stopLoss: 0.5, stopType: 'TRAIL', stopTrailPercent: 1 })).toMatchObject({ orderType: 'TRAIL', trailingPercent: 1, trailStopPrice: 0.5 });
    expect(sl({ stopLoss: 0.5, stopType: 'TRAIL LIMIT', stopTrailAmount: 0.2, stopLimitOffset: 0.05 })).toMatchObject({ orderType: 'TRAIL LIMIT', auxPrice: 0.2, trailStopPrice: 0.5, lmtPriceOffset: 0.05 });
    expect(sl({ stopLoss: 0.5, adjust: { trigger: 2, type: 'TRAIL', trailAmount: 0.5 } })).toMatchObject({
      orderType: 'STP',
      triggerPrice: 2,
      adjustedOrderType: 'TRAIL',
      adjustedTrailingAmount: 0.5,
      adjustableTrailingUnit: 0,
    });
    expect(sl({ stopLoss: 0.5, adjust: { trigger: 2, type: 'STP LMT', stopPrice: 1, limitPrice: 0.9 } })).toMatchObject({ adjustedStopPrice: 1, adjustedStopLimitPrice: 0.9 });
    // Bracket children never take the parent's all or none (10257).
    const aon = buildOrders({ ...base, allOrNone: true, bracket: { takeProfit: 300, stopLoss: 100 } }, { orderId: 10, nextOrderId: ids(11), now });
    expect(aon.map((o) => !!o.order.allOrNone)).toEqual([true, false, false]);
    const stp = one({ orderType: 'STP', limitPrice: undefined, stopPrice: 10000, adjustStop: { trigger: 5000, type: 'STP', stopPrice: 9000 } }).order;
    expect(stp).toMatchObject({ triggerPrice: 5000, adjustedOrderType: 'STP', adjustedStopPrice: 9000 });
  });

  it('sends OCA groups, directed routes, non-guaranteed combos and forex cash quantities', () => {
    expect(one({ oca: { group: ' exits ', type: 3 } }).order).toMatchObject({ ocaGroup: 'exits', ocaType: 3 });
    const directed = one({ route: 'NASDAQ', contract: { ...aapl, primaryExchange: 'NASDAQ' } });
    expect(directed.contract).toMatchObject({ exchange: 'NASDAQ', primaryExch: 'NASDAQ', conId: 265598 });
    expect(one({ route: 'SMART' }).contract.exchange).toBe('SMART');
    const combo = one({ contract: bag, nonGuaranteed: true, limitPrice: 0.05 });
    expect(combo.order.smartComboRoutingParams).toEqual([{ tag: 'NonGuaranteed', value: '1' }]);
    expect(frame(combo.contract, combo.order).join('|')).toContain('NonGuaranteed|1');
    const fx = one({ contract: eur, quantity: 0, cashQty: 10000, limitPrice: 0.5 });
    expect(fx.order).toMatchObject({ totalQuantity: 0, cashQty: 10000 });
    expect(validateOrderRequest({ ...base, quantity: 0.5 })).toMatch(/whole number/);
  });

  it("refuses what IB's list for the contract does not have", () => {
    expect(() => one({ contract: fut, orderType: 'MOC', limitPrice: undefined })).toThrow(/not available/);
    expect(() => one({ allOrNone: true }, { rules: { orderTypes: ['LMT'] } })).toThrow(/attribute/);
    expect(one({ allOrNone: true }, { rules: { orderTypes: ['LMT', 'AON'] } }).order.allOrNone).toBe(true);
  });

  it('builds the what-if order of a request: the main order alone, transmitted', () => {
    const p = buildPreviewOrder({ ...base, bracket: { takeProfit: 300, stopLoss: 100 } }, { orderId: 99, account: 'DU1', now });
    expect(p.orderId).toBe(99);
    expect(p.order).toMatchObject({ whatIf: true, transmit: true, orderType: 'LMT', account: 'DU1' });
    expect(p.order).not.toHaveProperty('parentId');
    expect(encodes(p.contract, p.order)).toBe(true);
  });

  it('maps every attribute back, so a modify can send the order again unchanged', () => {
    const req: OrderRequest = {
      ...base,
      quantity: 10,
      allOrNone: true,
      hidden: true,
      sweepToFill: true,
      discretionaryAmt: 0.05,
      orderRef: 'n1',
      oca: { group: 'g', type: 2 },
      conditions: {
        items: [
          { kind: 'price', contract: aapl, operator: '>=', price: 400, triggerMethod: 8, join: 'or' },
          { kind: 'margin', operator: '<=', percent: 30 },
        ],
        outsideRth: true,
      },
    };
    const [built] = buildOrders(req, { orderId: 5, nextOrderId: ids(6), now });
    const wo = mapOpenOrder(5, built.contract, { ...built.order, orderId: 5 }, { status: 'PreSubmitted' } as OrderState, undefined, 0, () => 'AAPL');
    expect(wo).toMatchObject({
      allOrNone: true,
      hidden: true,
      sweepToFill: true,
      discretionaryAmt: 0.05,
      orderRef: 'n1',
      oca: { group: 'g', type: 2 },
      conditions: {
        items: [
          { kind: 'price', operator: '>=', price: 400, triggerMethod: 8, join: 'or', contract: { conId: 265598, secType: 'STK' } },
          { kind: 'margin', operator: '<=', percent: 30 },
        ],
        outsideRth: true,
      },
    });
    // A modify request with only the new price keeps every attribute.
    const again = buildOrders(withOrderAttributes({ ...base, quantity: 10, limitPrice: 1.01 }, wo), { orderId: 5, nextOrderId: ids(6), now })[0].order;
    const pick = (o: Order) => ({ ...o, lmtPrice: undefined, conditions: o.conditions?.map((c) => ({ ...c })) });
    expect(pick(again)).toEqual(pick(built.order));
    expect(again.lmtPrice).toBe(1.01);

    // An algo: IB echoes Vwap with its own extra parameters and a dated start time.
    const vwap: OrderRequest = { ...base, algo: { strategy: 'Vwap', params: { maxPctVol: 0.1, startTime: '09:30', allowPastEndTime: true } } };
    const [v] = buildOrders(vwap, { orderId: 6, nextOrderId: ids(7), now });
    const echo: Order = {
      ...v.order,
      algoParams: [...v.order.algoParams!.map((p) => (p.tag === 'startTime' ? { ...p, value: '20261005 09:30:00 US/Eastern' } : p)), { tag: 'optoutClosingAuction', value: '' }],
    };
    const vo = mapOpenOrder(6, v.contract, echo, undefined, undefined, 0, () => 'AAPL');
    expect(vo.algo).toEqual(vwap.algo);
    expect(buildOrders(withOrderAttributes({ ...base, limitPrice: 1.02 }, vo), { orderId: 6, nextOrderId: ids(7), now })[0].order.algoParams).toEqual(v.order.algoParams);
  });

  it('maps the remaining fields back: offsets, trigger method, adjusted stop, route, combos, cash quantity', () => {
    const map = (c: Contract, o: Partial<Order>) => mapOpenOrder(1, c, { action: 'BUY' as never, totalQuantity: 1, tif: 'DAY' as never, orderType: 'LMT' as never, ...o }, undefined, undefined, 0, () => undefined);
    const ib: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK' as never, exchange: 'SMART', currency: 'USD' };
    expect(map(ib, { orderType: 'TRAIL LIMIT' as never, auxPrice: 5, trailStopPrice: 300, lmtPrice: 300.1, lmtPriceOffset: 0.1 })).toMatchObject({ limitOffset: 0.1, trailStopPrice: 300 });
    expect(map(ib, { orderType: 'REL' as never, percentOffset: 0.01 })).toMatchObject({ percentOffset: 0.01 });
    expect(map(ib, { percentOffset: 0.01, minQty: undefined })).not.toHaveProperty('percentOffset');
    expect(map(ib, { orderType: 'STP' as never, auxPrice: 1, triggerMethod: 8 })).toMatchObject({ triggerMethod: 8 });
    expect(map(ib, { orderType: 'STP' as never, auxPrice: 1, triggerMethod: 0 })).not.toHaveProperty('triggerMethod');
    expect(map(ib, { orderType: 'STP' as never, auxPrice: 0.5, triggerPrice: 2, adjustedOrderType: 'TRAIL', adjustedTrailingAmount: 0.5, adjustableTrailingUnit: 1 }).adjustStop).toEqual({
      trigger: 2,
      type: 'TRAIL',
      trailAmount: 0.5,
      trailUnit: 'percent',
    });
    expect(map(ib, { adjustedOrderType: 'None' })).not.toHaveProperty('adjustStop');
    const directed = map({ ...ib, exchange: 'NASDAQ' }, {});
    expect(directed).toMatchObject({ route: 'NASDAQ', contract: { exchange: 'SMART' }, key: 'STK:AAPL' });
    // A stock IB does not reach through SMART (SEHK) is traded on its own exchange: no route.
    const sehk: Contract = { conId: 152791428, symbol: '700', secType: 'STK' as never, exchange: 'SEHK', currency: 'HKD' };
    const hk = map(sehk, { action: 'SELL' as never, orderType: 'TRAIL' as never, trailingPercent: 2, trailStopPrice: 400 });
    expect(hk).not.toHaveProperty('route');
    expect(hk.contract.exchange).toBe('SEHK');
    // Known routing wins over the currency guess both ways.
    const known = (smart: boolean) => mapOpenOrder(1, sehk, { action: 'BUY' as never, totalQuantity: 1, tif: 'DAY' as never, orderType: 'LMT' as never }, undefined, undefined, 0, () => undefined, () => smart);
    expect(known(false)).not.toHaveProperty('route');
    expect(known(true)).toMatchObject({ route: 'SEHK', contract: { exchange: 'SMART' } });
    const usOwn = mapOpenOrder(1, { ...ib, exchange: 'NASDAQ' }, { action: 'BUY' as never, totalQuantity: 1, tif: 'DAY' as never, orderType: 'LMT' as never }, undefined, undefined, 0, () => undefined, () => false);
    expect(usOwn).not.toHaveProperty('route');
    // IB reports ocaType 3 for orders without a group, and its own group for bracket children.
    expect(map(ib, { ocaType: 3 })).not.toHaveProperty('oca');
    expect(map(ib, { ocaGroup: '1112735838', ocaType: 3, parentId: 97 })).not.toHaveProperty('oca');
    expect(map(ib, { ocaGroup: 'g', ocaType: 1 })).toMatchObject({ oca: { group: 'g', type: 1 } });
    const combo = map({ symbol: 'AAPL', secType: 'BAG' as never, exchange: 'SMART', currency: 'USD' }, { smartComboRoutingParams: [{ tag: 'NonGuaranteed', value: '1' }] });
    expect(combo.nonGuaranteed).toBe(true);
    expect(map({ symbol: 'AAPL', secType: 'BAG' as never, exchange: 'SMART', currency: 'USD' }, { smartComboRoutingParams: [{ tag: 'NonGuaranteed', value: '0' }] })).not.toHaveProperty('nonGuaranteed');
    expect(map({ conId: 12087792, symbol: 'EUR', secType: 'CASH' as never, exchange: 'IDEALPRO', currency: 'USD' }, { cashQty: 10000 })).toMatchObject({ cashQty: 10000 });
    // Conditions IB names: the order's own instrument, or a stock on SMART / an index elsewhere.
    const conds = map(ib, {
      conditions: [
        new PriceCondition(400, 0, 265598, 'SMART', true, ConjunctionConnection.AND),
        new PriceCondition(5000, 0, 416904, 'CBOE', false, ConjunctionConnection.OR),
        new TimeCondition('20261006 10:00:00 US/Eastern', true, ConjunctionConnection.AND),
        new VolumeCondition(1000, 272093, 'SMART', true, ConjunctionConnection.AND),
        new ExecutionCondition('ANY', 'STK', 'MSFT', ConjunctionConnection.AND),
      ],
      conditionsCancelOrder: true,
    }).conditions!;
    expect(conds.cancel).toBe(true);
    expect(conds.items.map((c) => [c.kind, 'contract' in c ? `${c.contract.symbol}/${c.contract.secType}/${c.contract.exchange}` : '', c.join])).toEqual([
      ['price', 'AAPL/STK/SMART', 'and'],
      ['price', '416904/IND/CBOE', 'or'],
      ['time', '', 'and'],
      ['volume', '272093/STK/SMART', 'and'],
      ['execution', '', undefined],
    ]);
  });

  it('reads algo parameters back in the request form', () => {
    const algo = (strategy: string, params: Array<[string, string]>) => orderAlgo({ orderType: 'LMT' as never, algoStrategy: strategy, algoParams: params.map(([tag, value]) => ({ tag, value })) }, now.getTime());
    expect(algo('Adaptive', [['adaptivePriority', 'Urgent']])).toEqual({ strategy: 'Adaptive', params: { adaptivePriority: 'Urgent' } });
    expect(
      algo('Vwap', [
        ['maxPctVol', '0.1'],
        ['startTime', '20261005 09:30:00 US/Eastern'],
        ['endTime', '20261005-20:00:00'],
        ['noTakeLiq', '0'],
        ['optoutClosingAuction', ''],
      ]),
    ).toEqual({ strategy: 'Vwap', params: { maxPctVol: 0.1, startTime: '09:30', endTime: '16:00', noTakeLiq: false } });
    expect(algo('AD', [['activeTimeStart', '13:30:00']])).toEqual({ strategy: 'AD', params: { activeTimeStart: '09:30' } });
    // Without an active window IB fills in both ends at the time of placement (paper: 03:12 / 03:12).
    expect(algo('AD', [['componentSize', '1'], ['activeTimeStart', '07:12:00'], ['activeTimeEnd', '07:12:00']])).toEqual({ strategy: 'AD', params: { componentSize: 1 } });
    expect(algo('AD', [['activeTimeStart', '13:30:00'], ['activeTimeEnd', '20:00:00']])).toEqual({ strategy: 'AD', params: { activeTimeStart: '09:30', activeTimeEnd: '16:00' } });
    // An algo Tape does not offer (placed in TWS) keeps its raw parameters.
    expect(algo('Jefferies', [['x', '1']])).toEqual({ strategy: 'Jefferies', params: { x: '1' } });
    expect(orderAlgo({ orderType: 'LMT' as never })).toBeUndefined();
  });

  it("maps IB's what-if answer", () => {
    const state = {
      status: 'PreSubmitted',
      initMarginBefore: 11005.5,
      initMarginChange: 110.06,
      initMarginAfter: 11115.56,
      maintMarginBefore: undefined,
      commission: 1.000003,
      commissionCurrency: 'USD',
      warningText: ' Price band ',
    } as unknown as OrderState;
    expect(mapPreview(state)).toEqual({ commission: 1.000003, commissionCurrency: 'USD', initMargin: { before: 11005.5, change: 110.06, after: 11115.56 }, warningText: 'Price band' });
    expect(mapPreview({ status: 'PreSubmitted', commission: 0 } as OrderState)).toEqual({ commission: 0 });
  });
});

describe('order mapping', () => {
  const ibAapl: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK' as never, exchange: 'SMART', currency: 'USD', localSymbol: 'AAPL', tradingClass: 'NMS' };
  const symbolOf = (conId: number) => (conId === 265598 ? 'AAPL' : undefined);

  it('keys orders by client and order id, or by permId', () => {
    expect(orderKey(101, 5, 99)).toBe('101:5');
    expect(orderKey(0, 0, 99)).toBe('p:99');
  });

  it('maps openOrder with a price condition', () => {
    const order: Order = {
      orderId: 4011,
      clientId: 7,
      permId: 1825,
      action: 'SELL' as never,
      totalQuantity: 10,
      orderType: 'LMT' as never,
      lmtPrice: 5.2,
      auxPrice: 0,
      tif: 'GTC' as never,
      outsideRth: false,
      displaySize: 0,
      account: 'DU1',
      conditions: [new PriceCondition(235, TriggerMethod.Default, 265598, 'SMART', true, ConjunctionConnection.AND)],
      conditionsIgnoreRth: false,
    };
    const opt: Contract = { conId: 777, symbol: 'AAPL', secType: 'OPT' as never, lastTradeDateOrContractMonth: '20261016', strike: 230, right: 'C' as never, multiplier: 100, exchange: 'SMART', currency: 'USD' };
    const state = { status: 'PreSubmitted' } as OrderState;
    const o = mapOpenOrder(4011, opt, order, state, undefined, 1000, symbolOf);
    expect(o).toEqual({
      orderId: 4011,
      permId: 1825,
      clientId: 7,
      account: 'DU1',
      key: 'OPT:AAPL:20261016:230:C',
      contract: { symbol: 'AAPL', secType: 'OPT', exchange: 'SMART', currency: 'USD', conId: 777, lastTradeDate: '20261016', strike: 230, right: 'C', multiplier: 100 },
      action: 'SELL',
      orderType: 'LMT',
      totalQuantity: 10,
      limitPrice: 5.2,
      tif: 'GTC',
      outsideRth: false,
      session: 'regular',
      condition: { symbol: 'AAPL', operator: '>=', price: 235, outsideRth: false },
      conditions: {
        items: [{ kind: 'price', contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: 265598 }, operator: '>=', price: 235 }],
        outsideRth: false,
      },
      status: 'PreSubmitted',
      filled: 0,
      remaining: 10,
      avgFillPrice: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(order.conditions?.[0].type).toBe(OrderConditionType.Price);

    const filled = applyOrderStatus(o, { status: 'Filled', filled: 10, remaining: 0, avgFillPrice: 5.21, whyHeld: '' }, 2000);
    expect(filled).toMatchObject({ status: 'Filled', filled: 10, remaining: 0, avgFillPrice: 5.21, createdAt: 1000, updatedAt: 2000 });
    const again = mapOpenOrder(4011, opt, order, { status: 'Filled' } as OrderState, filled, 3000, symbolOf);
    expect(again).toMatchObject({ filled: 10, avgFillPrice: 5.21, createdAt: 1000 });
  });

  it('maps the trading session, the TIF and the GTD expiry back', () => {
    const ibOvernight: Contract = { ...ibAapl, exchange: 'OVERNIGHT', primaryExch: 'NASDAQ' };
    const order = (o: Partial<Order>): Order => ({ action: 'BUY' as never, orderType: 'LMT' as never, totalQuantity: 1, lmtPrice: 1, tif: 'DAY' as never, ...o });
    const map = (c: Contract, o: Partial<Order>) => mapOpenOrder(1, c, order(o), { status: 'PreSubmitted' } as OrderState, undefined, 0, symbolOf);

    // Overnight only: the instrument stays the SMART one, the venue is the session.
    const overnight = map(ibOvernight, {});
    expect(overnight).toMatchObject({ session: 'overnight', tif: 'DAY', key: 'STK:AAPL' });
    expect(overnight.contract).toMatchObject({ exchange: 'SMART', primaryExchange: 'NASDAQ' });
    // IB reports includeOvernight orders with TIF "OVERNIGHT + DAY" and outsideRth set.
    expect(map(ibAapl, { tif: 'OVERNIGHT + DAY' as never, includeOvernight: true, outsideRth: true })).toMatchObject({ session: 'overnightDay', tif: 'DAY', outsideRth: true });
    expect(map(ibAapl, { tif: 'OVERNIGHT + DAY' as never })).toMatchObject({ session: 'overnightDay', tif: 'DAY' });
    expect(map(ibAapl, { outsideRth: true, tif: 'GTC' as never })).toMatchObject({ session: 'extended', tif: 'GTC' });
    // IB reports outsideRth for IOC / FOK, which ignore it.
    expect(map(ibAapl, { outsideRth: true, tif: 'IOC' as never })).toMatchObject({ session: 'regular', tif: 'IOC', outsideRth: true });
    const gtd = map(ibAapl, { tif: 'GTD' as never, goodTillDate: '20261009 16:00:00 US/Eastern' });
    expect(gtd).toMatchObject({ tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' });
    expect(map(ibAapl, { tif: 'DAY' as never, goodTillDate: '20261009 16:00:00 US/Eastern' })).not.toHaveProperty('goodTillDate');
    expect(ibOrderSession(ibOvernight, order({ includeOvernight: true }))).toBe('overnight');
    // IB reports an OVERNIGHT-venue order's TIF as "OVERNIGHT" (paper DUP899854, 2026-10-05).
    expect(map(ibOvernight, { tif: 'OVERNIGHT' as never })).toMatchObject({ session: 'overnight', tif: 'DAY' });
    // Completed orders keep them too.
    expect(mapCompletedOrder(ibAapl, order({ tif: 'OVERNIGHT + DAY' as never }), { status: 'Cancelled' } as OrderState, undefined, 0, symbolOf)).toMatchObject({
      session: 'overnightDay',
      tif: 'DAY',
    });
  });

  it('maps unknown condition instruments to their conId', () => {
    const order: Order = { orderType: 'MKT' as never, action: 'BUY' as never, totalQuantity: 1, conditions: [new PriceCondition(10, 0, 42, 'SMART', false, ConjunctionConnection.AND)] };
    expect(mapOpenOrder(1, ibAapl, order, undefined, undefined, 0, symbolOf).condition).toEqual({ symbol: '42', operator: '<=', price: 10, outsideRth: false });
  });

  it('maps completed orders with their final status', () => {
    const order: Order = { permId: 55, orderType: 'LMT' as never, action: 'BUY' as never, totalQuantity: 100, lmtPrice: 226.95, tif: 'DAY' as never, filledQuantity: 100 };
    const state = { status: 'Filled', completedTime: '20261004 10:31:44 US/Eastern', completedStatus: 'Filled Size: 100' } as unknown as OrderState;
    const o = mapCompletedOrder(ibAapl, order, state, undefined, 5000, symbolOf);
    expect(o).toMatchObject({ permId: 55, status: 'Filled', filled: 100, remaining: 0, message: 'Filled Size: 100', updatedAt: Date.UTC(2026, 9, 4, 14, 31, 44) });
    const cancelled = mapCompletedOrder(ibAapl, { ...order, filledQuantity: 0 }, { status: 'Cancelled' } as OrderState, undefined, 5000, symbolOf);
    expect(cancelled).toMatchObject({ status: 'Cancelled', filled: 0, remaining: 100 });
  });

  it('maps executions and correction ids', () => {
    const e = mapExecution(ibAapl, { execId: '0000e0d5.6704b3a5.01.01', orderId: 4008, permId: 9, acctNumber: 'DU1', side: 'BOT', shares: 100, price: 226.95, time: '20261004 10:31:44 US/Eastern', exchange: 'NASDAQ' }, 0);
    expect(e).toEqual({
      execId: '0000e0d5.6704b3a5.01.01',
      orderId: 4008,
      permId: 9,
      account: 'DU1',
      key: 'STK:AAPL',
      contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: 265598, localSymbol: 'AAPL', tradingClass: 'NMS' },
      side: 'BUY',
      shares: 100,
      price: 226.95,
      time: Date.UTC(2026, 9, 4, 14, 31, 44),
      exchange: 'NASDAQ',
    });
    expect(execBaseId('0000e0d5.6704b3a5.01.02')).toBe(execBaseId('0000e0d5.6704b3a5.01.01'));
  });
});

describe('notification texts', () => {
  const order = {
    contract: stock('AAPL'),
    action: 'BUY' as const,
    totalQuantity: 100,
    orderType: 'LMT',
    limitPrice: 226.95,
    tif: 'DAY',
    filled: 0,
  };

  it('describes submitted, cancelled and rejected orders like the design', () => {
    expect(orderNotice(order, 'submitted')).toEqual({
      title: { en: 'Buy 100 AAPL submitted', zh: '买入 100 AAPL 已提交' },
      body: { en: 'Limit 226.95 · DAY · awaiting fill', zh: '限价 226.95 · DAY · 等待成交' },
    });
    expect(orderNotice({ ...order, orderType: 'MKT', limitPrice: undefined }, 'submitted').body).toEqual({ en: 'Market · DAY · awaiting fill', zh: '市价 · DAY · 等待成交' });
    const cancelled = orderNotice({ ...order, action: 'SELL', filled: 40 }, 'cancelled');
    expect(cancelled.title.en).toBe('Sell 100 AAPL cancelled');
    expect(cancelled.body.en).toBe('Limit 226.95 · DAY · 40 of 100 filled');
    const rejected = orderNotice(order, 'rejected', 'The API interface is currently in Read-Only mode. (321)');
    expect(rejected.title.zh).toBe('买入 100 AAPL 被拒绝');
    expect(rejected.body.en).toBe('The API interface is currently in Read-Only mode. (321)');
    expect(orderNotice({ ...order, session: 'overnightDay' }, 'submitted').body).toEqual({
      en: 'Limit 226.95 · DAY · Overnight + Day · awaiting fill',
      zh: '限价 226.95 · DAY · 夜盘 + 日盘 · 等待成交',
    });
    // The GTD expiry is stored as a time token and shown in the time format of the moment.
    const gtd = orderNotice({ ...order, tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern', outsideRth: true }, 'submitted').body;
    expect(gtd.en).toBe(`Limit 226.95 · GTD ⟦t:${Date.UTC(2026, 9, 9, 20)}:de⟧ · Extended hours · awaiting fill`);
    expect(resolveTimeTokens(gtd.en, createClock('24h', 'en'))).toBe('Limit 226.95 · GTD 10/09 16:00 ET · Extended hours · awaiting fill');
    expect(resolveTimeTokens(gtd.en, createClock('12h', 'en'))).toBe('Limit 226.95 · GTD 10/09 4:00 PM ET · Extended hours · awaiting fill');
    expect(resolveTimeTokens(gtd.zh, createClock('12h', 'zh'))).toBe('限价 226.95 · GTD 10/09 下午 4:00 ET · 盘前盘后 · 等待成交');
    const opt = orderNotice({ ...order, contract: option('AAPL', '20261016', 230, 'C'), totalQuantity: 10, limitPrice: 3.1 }, 'submitted');
    expect(opt.title.en).toBe('Buy 10 AAPL 10/16 230 Call submitted');
  });

  it('describes the other order types, algos and all or none', () => {
    const body = (o: Partial<typeof order> & Record<string, unknown>) => orderNotice({ ...order, ...o } as never, 'submitted').body.en;
    expect(body({ orderType: 'MIT', limitPrice: undefined, auxPrice: 400 })).toBe('Market · If touched 400.00 · DAY · awaiting fill');
    expect(body({ orderType: 'LIT', limitPrice: 401, auxPrice: 400 })).toBe('Limit 401.00 · If touched 400.00 · DAY · awaiting fill');
    expect(body({ orderType: 'MOC', limitPrice: undefined })).toBe('Market · At the close · DAY · awaiting fill');
    expect(body({ orderType: 'TRAIL LIMIT', limitPrice: 300.1, auxPrice: 5, limitOffset: 0.1 })).toBe('Trail 5.00 · limit offset 0.10 · DAY · awaiting fill');
    expect(body({ orderType: 'MIDPRICE', limitPrice: undefined })).toBe('Midprice · DAY · awaiting fill');
    expect(body({ orderType: 'MIDPRICE', limitPrice: 230 })).toBe('Midprice · cap 230.00 · DAY · awaiting fill');
    expect(body({ orderType: 'REL', limitPrice: undefined, percentOffset: 0.5 })).toBe('Relative · offset 0.5% · DAY · awaiting fill');
    expect(body({ algo: { strategy: 'Adaptive', params: {} }, allOrNone: true })).toBe('Limit 226.95 · Adaptive · AON · DAY · awaiting fill');
    // Algo names as the ticket shows them, in both languages; a sell's limit is a floor.
    expect(body({ algo: { strategy: 'ArrivalPx', params: {} } })).toBe('Limit 226.95 · Arrival price · DAY · awaiting fill');
    expect(orderNotice({ ...order, algo: { strategy: 'Adaptive', params: {} } } as never, 'submitted').body.zh).toContain('自适应');
    expect(body({ orderType: 'MIDPRICE', action: 'SELL' as 'BUY', limitPrice: 230 })).toBe('Midprice · floor 230.00 · DAY · awaiting fill');
    expect(orderNotice({ ...order, orderType: 'MTL', limitPrice: undefined }, 'submitted').body.zh).toBe('市价转限价 · DAY · 等待成交');
  });

  it('describes fills like the design', () => {
    const e = { execId: 'x', orderId: 4008, key: 'STK:AAPL', contract: stock('AAPL'), side: 'BUY' as const, shares: 100, price: 226.95, time: 0 };
    expect(fillNotice(e, 226.95, 1)).toEqual({
      title: { en: 'AAPL: bought 100 shares', zh: 'AAPL 买入 100 股已成交' },
      body: { en: 'Avg 226.95 · Commission 1.00 · Order #4008', zh: '均价 226.95 · 佣金 1.00 · 订单 #4008' },
    });
    const o = fillNotice({ ...e, contract: option('AAPL', '20261016', 230, 'C'), side: 'SELL', shares: 1 }, undefined, undefined);
    expect(o.title).toEqual({ en: 'AAPL 10/16 230 Call: sold 1 contract', zh: 'AAPL 10/16 230 Call 卖出 1 张已成交' });
    expect(o.body.en).toBe('Avg 226.95 · Commission — · Order #4008');
  });
});
