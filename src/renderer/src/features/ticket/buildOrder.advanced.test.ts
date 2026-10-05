// The ticket's other order types and its Advanced choices: what each sends, what the shared order
// rules refuse (the problems IB answered on the paper account), what a choice is greyed out for,
// and the review rows.

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { option, stock } from '@shared/contract';
import { CLOCK_24H } from '@shared/timeFormat';
import type { ContractRef, OrderRequest } from '@shared/types';
import { initialTicket, type TicketState } from '../../state/store';
import { buildOrderRequest, choiceProblem, combinationProblem, composeOrder, pendingOrder, typePriceText, type BuildResult, type OrderInput, type ReviewLabels } from './buildOrder';
import { useTicketM } from './messages';
import { newCondition } from './ticketConditions';
import type { TicketMarket } from './ticketModel';

const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...initialTicket(defaultSettings()), ...patch });
const mkt: TicketMarket = { bid: 227.48, ask: 227.49, last: 227.5, refLast: 227.5, minTick: 0.01, multiplier: 1 };
const AAPL = stock('AAPL');
const OPT = option('AAPL', '20261016', 230, 'C');
const MES: ContractRef = { symbol: 'MES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 5 };
const EURUSD: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };
// 2026-10-05 is a Monday; 14:00 UTC = 10:00 New York (EDT).
const NOW = Date.UTC(2026, 9, 5, 14, 0);

const input = (patch: Partial<TicketState>, contract: ContractRef = AAPL, market: TicketMarket = mkt): OrderInput => ({ contract, ticket: ticket(patch), market, now: NOW, timeFormat: '24h' });
const build = (patch: Partial<TicketState>, contract?: ContractRef, market?: TicketMarket) => buildOrderRequest(input(patch, contract, market));
function ok(r: BuildResult): OrderRequest {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.request;
}
const err = (patch: Partial<TicketState>, contract?: ContractRef, market?: TicketMarket) => {
  const r = build(patch, contract, market);
  return r.ok ? null : r.error;
};

const en = useTicketM.for('en');
const labels: ReviewLabels = {
  contract: 'Contract',
  side: 'Side',
  qty: 'Qty',
  typePrice: 'Type / Price',
  tif: 'TIF',
  trigger: 'Trigger',
  estAmount: 'Est. amount',
  tpSl: 'Take profit / Stop loss',
  buy: 'Buy',
  sell: 'Sell',
  orderTypes: en.orderTypes,
  sessions: { regular: 'Regular hours', extended: 'Extended hours', overnight: 'Overnight', overnightDay: 'Overnight + Day' },
  clock: CLOCK_24H,
  extras: en.extras,
  review: en.review,
  stopTypes: en.stopTypes,
  attr: en.attr,
};

describe('order types beyond the main row', () => {
  it('MIT and LIT trigger on the other side of the market (buy below)', () => {
    expect(ok(build({ orderType: 'MIT' }))).toMatchObject({ orderType: 'MIT', stopPrice: 225.23 });
    expect(ok(build({ orderType: 'MIT', side: 'SELL' })).stopPrice).toBe(229.78);
    const lit = ok(build({ orderType: 'LIT', stopPrice: 225 }));
    expect(lit).toMatchObject({ orderType: 'LIT', stopPrice: 225, limitPrice: 225.45 });
  });

  it('MOC sends no price; LOC a limit; both are DAY orders of the regular session', () => {
    const moc = ok(build({ orderType: 'MOC' }));
    expect(moc.limitPrice).toBeUndefined();
    expect(moc.stopPrice).toBeUndefined();
    expect(ok(build({ orderType: 'LOC' })).limitPrice).toBe(227.49);
    expect(err({ orderType: 'MOC', tif: 'GTC' })).toBe('typeTif');
    expect(err({ orderType: 'LOC', session: 'extended' })).toBe('typeSession');
  });

  it('MTL and SNAP MKT send no price; MIDPRICE an optional cap', () => {
    expect(ok(build({ orderType: 'MTL' }))).not.toHaveProperty('limitPrice');
    expect(ok(build({ orderType: 'MIDPRICE' }))).not.toHaveProperty('limitPrice');
    expect(ok(build({ orderType: 'MIDPRICE', limitPrice: 228 })).limitPrice).toBe(228);
    // IB refuses midprice orders outside regular hours (321).
    expect(err({ orderType: 'MIDPRICE', session: 'extended' })).toBe('typeSession');
    expect(ok(build({ orderType: 'SNAP MKT', offset: 0.02 })).offset).toBe(0.02);
  });

  it('REL takes an offset amount or a percentage, and an optional cap', () => {
    expect(ok(build({ orderType: 'REL' }))).toMatchObject({ orderType: 'REL', offset: 0 });
    expect(ok(build({ orderType: 'REL', offset: 0.05, limitPrice: 228 }))).toMatchObject({ offset: 0.05, limitPrice: 228 });
    const pct = ok(build({ orderType: 'REL', offsetMode: 'pct', offset: 0.5 }));
    expect(pct.percentOffset).toBe(0.5);
    expect(pct.offset).toBeUndefined();
    expect(err({ orderType: 'REL', offsetMode: 'pct', offset: null })).toBe('percentOffset');
  });

  it('PEG MID and SNAP MID take an offset (0 by default)', () => {
    expect(ok(build({ orderType: 'PEG MID', limitPrice: 228 }))).toMatchObject({ offset: 0, limitPrice: 228 });
    expect(ok(build({ orderType: 'SNAP MID', offset: 0.01 }))).toMatchObject({ offset: 0.01 });
  });

  it('TRAIL LIMIT always sends the initial stop and the limit offset (IB 321 without them)', () => {
    const r = ok(build({ orderType: 'TRAIL LIMIT', side: 'SELL', trailAmt: '3' }));
    expect(r).toMatchObject({ orderType: 'TRAIL LIMIT', trailingPercent: 3, trailStopPrice: 220.67, limitOffset: 0.44 });
    expect(r.limitPrice).toBeUndefined();
    expect(ok(build({ orderType: 'TRAIL LIMIT', side: 'SELL', limitOffset: 0.1 })).limitOffset).toBe(0.1);
    // Without a last price there is no initial stop: IB would refuse it.
    expect(err({ orderType: 'TRAIL LIMIT', side: 'SELL' }, AAPL, { minTick: 0.01, multiplier: 1 })).toBe('trailStop');
  });

  it('TRAIL MIT and TRAIL LIT trail a trigger on the touched side (sell above, buy below)', () => {
    expect(ok(build({ orderType: 'TRAIL MIT', side: 'SELL', trailMode: 'amt', trailAmt: '2' }))).toMatchObject({ trailingAmount: 2, trailStopPrice: 229.5 });
    expect(ok(build({ orderType: 'TRAIL MIT', side: 'BUY', trailMode: 'amt', trailAmt: '2' }))).toMatchObject({ trailingAmount: 2, trailStopPrice: 225.5 });
    expect(ok(build({ orderType: 'TRAIL LIT', side: 'SELL', limitOffset: 0.05 }))).toMatchObject({ trailingPercent: 3, trailStopPrice: 234.33, limitOffset: 0.05 });
    expect(ok(build({ orderType: 'TRAIL LIT', side: 'BUY', limitOffset: 0.05 })).trailStopPrice).toBe(220.67);
  });

  it('refuses a touched trigger already through the market (it would trigger at once)', () => {
    // Paper: a BUY TRAIL LIT with its trigger above the market filled immediately.
    expect(err({ orderType: 'TRAIL LIT', side: 'BUY', stopPrice: 230, limitOffset: 0.05 })).toBe('triggerBelow');
    expect(err({ orderType: 'TRAIL MIT', side: 'SELL', stopPrice: 225 })).toBe('triggerAbove');
    expect(err({ orderType: 'MIT', side: 'BUY', stopPrice: 227.5 })).toBe('triggerBelow');
    expect(err({ orderType: 'LIT', side: 'SELL', stopPrice: 226, limitPrice: 226 })).toBe('triggerAbove');
    expect(err({ orderType: 'MIT', side: 'SELL', stopPrice: 228 })).toBeNull();
    // Stops trigger on the other side and are not touched by this check.
    expect(err({ orderType: 'STP', side: 'BUY', stopPrice: 230 })).toBeNull();
    // Without a last price there is nothing to compare with.
    expect(err({ orderType: 'MIT', side: 'BUY', stopPrice: 230 }, AAPL, { minTick: 0.01, multiplier: 1 })).toBeNull();
  });

  it('offers each type only for the instruments IB takes it for', () => {
    expect(err({ orderType: 'MIDPRICE' }, OPT)).toBe('typeInstrument');
    expect(err({ orderType: 'MOC', limitPrice: 5 }, OPT)).toBe('typeInstrument');
    expect(err({ orderType: 'LOC', limitPrice: 5000 }, MES)).toBe('typeInstrument');
    expect(ok(build({ orderType: 'MIT', stopPrice: 5000 }, MES, { last: 6800, minTick: 0.25, multiplier: 5 })).orderType).toBe('MIT');
    // With the contract's own list, a type it does not list is refused too.
    expect(buildOrderRequest({ ...input({ orderType: 'MIT' }), rules: { orderTypes: ['LMT', 'MKT', 'STP'] } })).toEqual({ ok: false, error: 'typeContract' });
  });

  it('writes every type in the review', () => {
    const t = (patch: Partial<TicketState>) => typePriceText(ok(build(patch)), labels, 0.01);
    expect(t({ orderType: 'MIT', stopPrice: 225 })).toBe('Market if touched 225.00');
    expect(t({ orderType: 'LIT', stopPrice: 225, limitPrice: 225.2 })).toBe('Limit if touched 225.00 / 225.20');
    expect(t({ orderType: 'MOC' })).toBe('Market on close');
    expect(t({ orderType: 'MIDPRICE', limitPrice: 228 })).toBe('Midprice ≤ 228.00');
    // A sell's limit is the lowest price it takes.
    expect(t({ orderType: 'MIDPRICE', side: 'SELL', limitPrice: 228 })).toBe('Midprice ≥ 228.00');
    expect(t({ orderType: 'PEG MID', side: 'SELL', offset: 0.01, limitPrice: 228 })).toBe('Pegged to midpoint ±0.01 · ≥ 228.00');
    expect(t({ orderType: 'REL', offset: 0.05 })).toBe('Relative ±0.05');
    expect(t({ orderType: 'TRAIL LIMIT', side: 'SELL', limitOffset: 0.1 })).toBe('Trail limit 3% · 220.67 · ±0.10');
  });
});

describe('fill attributes', () => {
  it('sends all or none, hidden, sweep and a discretionary amount for stocks', () => {
    expect(ok(build({ allOrNone: true }))).toMatchObject({ allOrNone: true });
    expect(ok(build({ hidden: true, sweep: true, disc: true, discAmt: '0.05' }))).toMatchObject({ hidden: true, sweepToFill: true, discretionaryAmt: 0.05 });
  });

  it('refuses the combinations IB refused', () => {
    expect(err({ allOrNone: true, orderType: 'LMT', limitPrice: 5000 }, MES)).toBe('aonInstrument'); // 10257
    expect(err({ allOrNone: true, session: 'overnightDay' })).toBe('aonSession'); // 201
    expect(err({ allOrNone: true, iceberg: true, iceQty: '10' })).toBe('aonIceberg'); // 201
    expect(err({ minQtyOn: true, minQty: '10' })).toBe('minQtyInstrument'); // 10256
    expect(ok(build({ minQtyOn: true, minQty: '2', qty: 5, limitPrice: 4.25 }, OPT)).minQty).toBe(2);
    expect(err({ minQtyOn: true, minQty: '9', qty: 5, limitPrice: 4.25 }, OPT)).toBe('minQty');
    expect(err({ hidden: true, iceberg: true, iceQty: '10' })).toBe('hiddenIceberg'); // 10255
    expect(err({ sweep: true, limitPrice: 4.25 }, OPT)).toBe('sweepInstrument'); // 10267
    expect(err({ disc: true, discAmt: '1', limitPrice: 4.25 }, OPT)).toBe('discretionaryAmt'); // over 10% of the limit
  });

  it('keeps iceberg and conditions off stop orders (IB 10255 / 148)', () => {
    expect(err({ orderType: 'STP', iceberg: true, iceQty: '10' })).toBe('icebergType');
    expect(err({ orderType: 'STP LMT', iceberg: true, iceQty: '10' })).toBe('icebergType');
    expect(err({ orderType: 'STP', condition: true })).toBe('conditionType');
    expect(err({ orderType: 'TRAIL', condition: true })).toBe('conditionType');
    expect(ok(build({ orderType: 'MKT', condition: true })).conditions?.items).toHaveLength(1);
  });

  it('sizes a forex order by amount', () => {
    const r = ok(build({ cashQtyOn: true, cashQty: '20000', limitPrice: 1.07 }, EURUSD, { ...mkt, minTick: 0.00005 }));
    expect(r).toMatchObject({ quantity: 0, cashQty: 20000 });
    // Only forex: stocks ignore the switch.
    expect(ok(build({ cashQtyOn: true })).cashQty).toBeUndefined();
  });
});

describe('trigger method', () => {
  it('is sent with stops and touched orders only', () => {
    expect(ok(build({ orderType: 'STP', triggerMethod: 8 })).triggerMethod).toBe(8);
    expect(ok(build({ orderType: 'MIT', triggerMethod: 2 })).triggerMethod).toBe(2);
    expect(ok(build({ triggerMethod: 8 })).triggerMethod).toBeUndefined();
  });

  it('offers no last-price methods for forex', () => {
    expect(err({ orderType: 'STP', triggerMethod: 2, stopPrice: 1.2 }, EURUSD)).toBe('triggerInstrument');
    expect(ok(build({ orderType: 'STP', triggerMethod: 4, stopPrice: 1.2 }, EURUSD)).triggerMethod).toBe(4);
  });
});

describe('IB algos', () => {
  it('sends the algo with its parameters as IB values', () => {
    expect(ok(build({ algo: 'Adaptive', algoParams: { adaptivePriority: 'Urgent' } })).algo).toEqual({ strategy: 'Adaptive', params: { adaptivePriority: 'Urgent' } });
    const vwap = ok(build({ algo: 'Vwap', algoParams: { maxPctVol: '12.5', startTime: '9:45', endTime: '3:30 PM', noTakeLiq: true, allowPastEndTime: false } }));
    expect(vwap.algo).toEqual({ strategy: 'Vwap', params: { maxPctVol: 0.125, startTime: '09:45', endTime: '15:30', noTakeLiq: true } });
  });

  it('works in regular hours, without all or none, with market and limit orders', () => {
    expect(err({ algo: 'Adaptive', algoParams: { adaptivePriority: 'Normal' }, session: 'extended' })).toBe('algoSession');
    expect(err({ algo: 'Adaptive', algoParams: { adaptivePriority: 'Normal' }, allOrNone: true })).toBe('aonAlgo');
    expect(err({ algo: 'Adaptive', algoParams: { adaptivePriority: 'Normal' }, orderType: 'STP' })).toBe('algoType');
    expect(err({ algo: 'Vwap', algoParams: {}, limitPrice: 4.25 }, OPT)).toBe('algoInstrument'); // 439
  });

  it('names a missing or out-of-range parameter', () => {
    expect(err({ algo: 'PctVol', algoParams: {} })).toBe('algoParam');
    expect(err({ algo: 'PctVol', algoParams: { pctVol: '80' } })).toBe('algoParam');
    expect(err({ algo: 'Vwap', algoParams: { startTime: '25:00' } })).toBe('algoParam');
  });
});

describe('conditions', () => {
  it('joins several conditions with and / or and can cancel the order instead', () => {
    const conds = [
      newCondition('price', { value: '235', trigger: 8, join: 'or' }),
      newCondition('percentChange', { op: '<=', value: '-2', contract: stock('SPY') }),
      newCondition('volume', { value: '5000000', join: 'and' }),
      newCondition('margin', { value: '20' }),
    ];
    const r = ok(build({ condition: true, conds, condCancel: true }));
    expect(r.conditions).toEqual({
      items: [
        { kind: 'price', contract: AAPL, operator: '>=', price: 235, triggerMethod: 8, join: 'or' },
        { kind: 'percentChange', contract: stock('SPY'), operator: '<=', percent: -2, join: 'and' },
        { kind: 'volume', contract: AAPL, operator: '>=', volume: 5000000, join: 'and' },
        { kind: 'margin', operator: '<=', percent: 20 },
      ],
      cancel: true,
      outsideRth: false,
    });
  });

  it('sends a time (New York, an hour ahead by default) and an execution of the instrument by default', () => {
    const r = ok(build({ condition: true, conds: [newCondition('time'), newCondition('execution')] }));
    expect(r.conditions?.items).toEqual([
      { kind: 'time', time: '20261005 11:00:00 US/Eastern', join: 'and' },
      { kind: 'execution', symbol: 'AAPL', secType: 'STK' },
    ]);
    expect(ok(build({ condition: true, conds: [newCondition('time', { time: '2026-10-09T10:30' })] })).conditions?.items[0]).toEqual({ kind: 'time', time: '20261009 10:30:00 US/Eastern' });
  });

  it('refuses a cancel condition on orders IB does not cancel by condition, and bad values', () => {
    expect(err({ orderType: 'MKT', condition: true, condCancel: true })).toBe('conditionCancelType'); // 148
    expect(ok(build({ orderType: 'MIDPRICE', condition: true, condCancel: true })).conditions?.cancel).toBe(true);
    expect(err({ condition: true, conds: [newCondition('volume', { value: '1e12' })] })).toBe('conditionValue');
    expect(err({ condition: true, conds: [newCondition('margin', { value: '30.5' })] })).toBe('conditionValue');
  });
});

describe('take-profit / stop-loss and adjustable stops', () => {
  it('sends the stop-loss type with its extra values', () => {
    expect(ok(build({ bracket: true, limitPrice: 100, slType: 'STP LMT' })).bracket).toEqual({ takeProfit: 103, stopLoss: 98, stopType: 'STP LMT', stopLimit: 97.8 });
    expect(ok(build({ bracket: true, limitPrice: 100, slType: 'TRAIL', slTrail: '2' })).bracket).toEqual({ takeProfit: 103, stopLoss: 98, stopType: 'TRAIL', stopTrailPercent: 2 });
    expect(ok(build({ bracket: true, limitPrice: 100, slType: 'TRAIL LIMIT', slTrailMode: 'amt', slTrail: '1.5', slOffset: '0.2' })).bracket).toEqual({
      takeProfit: 103,
      stopLoss: 98,
      stopType: 'TRAIL LIMIT',
      stopTrailAmount: 1.5,
      stopLimitOffset: 0.2,
    });
  });

  it('attaches a trailing stop-loss to limit and stop-limit orders only (IB 328)', () => {
    expect(err({ bracket: true, orderType: 'MKT', slType: 'TRAIL' })).toBe('bracketTrailParent');
    expect(ok(build({ bracket: true, orderType: 'MKT', slType: 'STP LMT' })).bracket?.stopType).toBe('STP LMT');
  });

  it('moves the bracket stop to the entry once the price is 2% in favor, by default', () => {
    expect(ok(build({ bracket: true, limitPrice: 100, adjust: true })).bracket?.adjust).toEqual({ trigger: 102, type: 'STP', stopPrice: 100 });
    expect(ok(build({ bracket: true, limitPrice: 100, adjust: true, adjType: 'TRAIL', adjTrail: '1.5' })).bracket?.adjust).toEqual({ trigger: 102, type: 'TRAIL', trailAmount: 1.5, trailUnit: 'percent' });
  });

  it('adjusts a stop order itself, and refuses other types', () => {
    const r = ok(build({ orderType: 'STP', side: 'SELL', stopPrice: 220, adjust: true }));
    expect(r.adjustStop).toEqual({ trigger: 224.4, type: 'STP', stopPrice: 222.2 });
    expect(err({ adjust: true })).toBe('adjustType');
    // The trigger must be on the profitable side of the stop (IB 362-364).
    expect(err({ orderType: 'STP', side: 'SELL', stopPrice: 220, adjust: true, adjTrigger: '219' })).toBe('adjustFields');
  });
});

describe('OCA group, destination and note', () => {
  it('sends the OCA group and refuses it with a bracket', () => {
    expect(ok(build({ oca: true, ocaGroup: ' exits ', ocaType: 3 })).oca).toEqual({ group: 'exits', type: 3 });
    expect(err({ oca: true, ocaGroup: '' })).toBe('ocaGroup');
    expect(err({ oca: true, ocaGroup: 'x', bracket: true })).toBe('ocaBracket');
  });

  it('routes a stock directly to a valid exchange', () => {
    expect(ok(build({ route: 'NASDAQ' })).route).toBe('NASDAQ');
    expect(ok(build({ route: 'SMART' })).route).toBeUndefined();
    expect(buildOrderRequest({ ...input({ route: 'IEX' }), rules: { validExchanges: ['SMART', 'NASDAQ'] } })).toEqual({ ok: false, error: 'routeExchange' });
    expect(err({ route: 'NASDAQ', orderType: 'MIDPRICE' })).toBe('routeType');
    expect(err({ route: 'NASDAQ', iceberg: true, iceQty: '10' })).toBe('icebergRoute');
  });

  it('sends a trimmed note', () => {
    expect(ok(build({ orderRef: '  swing 1 ' })).orderRef).toBe('swing 1');
    expect(ok(build({ orderRef: '   ' }))).not.toHaveProperty('orderRef');
  });
});

describe('modify', () => {
  it('sends switched-off attributes explicitly, since IB replaces the whole order', () => {
    const r = ok(build({ orderType: 'STP', stopPrice: 230, modifyingOrderId: 12 }));
    expect(r).toMatchObject({ allOrNone: false, minQty: 0, hidden: false, sweepToFill: false, discretionaryAmt: 0, triggerMethod: 0, orderRef: '' });
    // A new order carries only what is on.
    expect(ok(build({ orderType: 'STP', stopPrice: 230 }))).not.toHaveProperty('allOrNone');
  });
});

describe('choices the ticket greys out', () => {
  it('says why an order type, a switch or a session does not combine', () => {
    expect(choiceProblem(input({ condition: true }), { orderType: 'STP' }, 'orderType')).toBe('conditionType');
    expect(choiceProblem(input({ orderType: 'STP' }), { condition: true }, 'conditions')).toBe('conditionType');
    expect(choiceProblem(input({ limitPrice: 4.25 }, OPT), { orderType: 'MIDPRICE' }, 'orderType')).toBe('typeInstrument');
    expect(choiceProblem(input({}, MES), { allOrNone: true }, 'allOrNone')).toBe('aonInstrument');
    expect(choiceProblem(input({ algo: 'Adaptive', algoParams: { adaptivePriority: 'Normal' } }), { session: 'extended' }, 'session')).toBe('algoSession');
    expect(choiceProblem(input({}), { orderType: 'MIT' }, 'orderType')).toBeNull();
  });

  it('never greys out a choice for a value still to be typed', () => {
    expect(choiceProblem(input({}), { oca: true }, 'oca')).toBeNull(); // the group name is typed next
    expect(choiceProblem(input({}), { algo: 'PctVol', algoParams: {} }, 'algo')).toBeNull();
    expect(choiceProblem(input({}, OPT, { minTick: 0.05, multiplier: 100 }), { minQtyOn: true, minQty: '' }, 'minQty')).toBeNull();
  });

  it('reports the ticket’s combination problem inline', () => {
    expect(combinationProblem(input({ orderType: 'STP', iceberg: true }))).toBe('icebergType');
    expect(combinationProblem(input({ oca: true, ocaGroup: '' }))).toBeNull();
  });

  it('builds the request even while a value is missing', () => {
    const c = composeOrder(input({ bracket: true, takeProfit: 'x' }));
    expect(c.error).toBe('tp');
    expect(c.request.bracket?.stopLoss).toBe(222.94);
  });
});

describe('review rows of the advanced choices', () => {
  it('lists fill, trigger, algo, conditions, adjustable stop, OCA, destination and note', () => {
    const r = build({
      orderType: 'LMT',
      limitPrice: 100,
      allOrNone: true,
      disc: true,
      discAmt: '0.05',
      algo: 'Adaptive',
      algoParams: { adaptivePriority: 'Patient' },
      condition: true,
      conds: [newCondition('price', { value: '235', join: 'or' }), newCondition('margin', { value: '25' })],
      condRth: true,
      oca: true,
      ocaGroup: 'exits',
      orderRef: 'core',
    });
    expect(r).toEqual({ ok: false, error: 'aonAlgo' });
    const s = ok(build({ orderType: 'STP', stopPrice: 230, triggerMethod: 8, adjust: true, route: 'NASDAQ', orderRef: 'core' }));
    const rows = Object.fromEntries(pendingOrder(s, composeOrder(input({ orderType: 'STP', stopPrice: 230 })).model, labels, mkt).rows.map((x) => [x.label, x.value]));
    expect(rows['Trigger method']).toBe('Midpoint');
    expect(rows['Adjustable stop']).toBe('At 225.40 → stop 227.70');
    expect(rows['Destination']).toBe('NASDAQ');
    expect(rows['Note']).toBe('core');

    const a = ok(
      build({
        limitPrice: 100,
        algo: 'Adaptive',
        algoParams: { adaptivePriority: 'Patient' },
        condition: true,
        conds: [newCondition('price', { value: '235', join: 'or' }), newCondition('margin', { value: '25' })],
        condRth: true,
        oca: true,
        ocaGroup: 'exits',
      }),
    );
    const rows2 = Object.fromEntries(pendingOrder(a, composeOrder(input({ limitPrice: 100 })).model, labels, mkt).rows.map((x) => [x.label, x.value]));
    expect(rows2['Fill']).toBeUndefined();
    const d = ok(build({ limitPrice: 100, disc: true, discAmt: '0.05' }));
    expect(pendingOrder(d, composeOrder(input({ limitPrice: 100 })).model, labels, mkt).rows.find((x) => x.label === 'Fill')?.value).toBe('Disc 0.05');
    expect(rows2['Algo']).toBe('Adaptive · Priority Patient');
    // Its lines break between parameters only.
    expect(pendingOrder(a, composeOrder(input({ limitPrice: 100 })).model, labels, mkt).rows.find((x) => x.label === 'Algo')?.parts).toBe(true);
    expect(rows2['Conditions']).toBe('AAPL ≥ 235.00 or margin cushion ≤ 25% (incl. ext. hours)');
    expect(rows2['OCA group']).toBe('exits · Cancel the others');
  });

  it('shows the stop-loss type and a forex amount', () => {
    const b = ok(build({ bracket: true, limitPrice: 100, slType: 'TRAIL', slTrail: '2' }));
    expect(pendingOrder(b, composeOrder(input({ limitPrice: 100 })).model, labels, mkt).rows.find((x) => x.label === 'Take profit / Stop loss')?.value).toBe('103.00 / Trail 2% · 98.00');
    const fx = ok(build({ cashQtyOn: true, cashQty: '20000', limitPrice: 1.07 }, EURUSD));
    const p = pendingOrder(fx, composeOrder(input({ limitPrice: 1.07 }, EURUSD)).model, labels, mkt);
    expect(p.rows.find((x) => x.label === 'Qty')?.value).toBe('Cash 20,000.00 USD');
    expect(p.summary).toBe('Buy 20,000 USD EUR.USD');
  });
});
