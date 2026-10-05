import { describe, expect, it } from 'vitest';
import { index, option, stock } from './contract';
import {
  algoParamProblem,
  ALGOS,
  isOrderProblem,
  isOrderType,
  MAIN_ORDER_TYPES,
  modifyProblems,
  ORDER_PROBLEM_TEXT,
  ORDER_TYPE_FIELDS,
  ORDER_TYPE_GROUPS,
  ORDER_TYPES,
  orderProblem,
  orderProblems,
  orderProblemText,
  problemsInvolving,
  requestConditions,
  triggerMethodsFor,
  withOrderAttributes,
} from './orderRules';
import type { ContractRef, OrderRequest, WorkingOrder } from './types';

const AAPL = { ...stock('AAPL'), conId: 265598 };
const OPT = { ...option('AAPL', '20261120', 400, 'C'), conId: 845042719 };
const MES: ContractRef = { symbol: 'MES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', conId: 815824257 };
const EUR: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD', conId: 12087792 };
const BAG: ContractRef = {
  symbol: 'AAPL',
  secType: 'BAG',
  exchange: 'SMART',
  currency: 'USD',
  comboLegs: [
    { conId: 1, ratio: 1, action: 'BUY', exchange: 'SMART' },
    { conId: 2, ratio: 1, action: 'SELL', exchange: 'SMART' },
  ],
};
const lmt: OrderRequest = { contract: AAPL, action: 'BUY', orderType: 'LMT', quantity: 10, limitPrice: 1, tif: 'DAY', outsideRth: false };
const p = (r: Partial<OrderRequest>) => orderProblems({ ...lmt, ...r });

/** IB's ContractDetails.orderTypes of AAPL, MES and an AAPL option (paper account, 2026-10-05). */
const AAPL_CODES =
  'ACTIVETIM,AD,ADDONT,ADJUST,ALERT,ALGO,ALLOC,AON,AVGCOST,BASKET,BENCHPX,CASHQTY,COND,CONDORDER,DARKONLY,DARKPOLL,DAY,DEACT,DEACTDIS,DEACTEOD,DIS,DUR,GAT,GTC,GTD,GTT,HID,IBKRATS,ICE,IMB,IOC,LIT,LMT,LOC,MIDPX,MIT,MKT,MOC,MTL,NGCOMB,NODARK,NONALGO,OCA,OPG,OPGREROUT,PEGBENCH,PEGMID,POSTATS,POSTONLY,PREOPGRTH,PRICECHK,REL,REL2MID,RELPCTOFS,RPI,RTH,SCALE,SCALEODD,SCALERST,SIZECHK,SMARTSTG,SNAPMID,SNAPMKT,SNAPREL,STP,STPLMT,SWEEP,TRAIL,TRAILLIT,TRAILLMT,TRAILMIT,WHATIF'.split(
    ',',
  );
const MES_CODES =
  'ACTIVETIM,AD,ADJUST,ALERT,ALGO,ALLOC,AVGCOST,BASKET,BENCHPX,COND,CONDORDER,DAY,DEACT,DEACTDIS,DEACTEOD,GAT,GTC,GTD,GTT,HID,ICE,IOC,LIT,LMT,LTH,MIT,MKT,MTL,NGCOMB,NONALGO,OCA,PEGBENCH,SCALE,SCALERST,SNAPMID,SNAPMKT,SNAPREL,STP,STPLMT,TRAIL,TRAILLIT,TRAILLMT,TRAILMIT,WHATIF'.split(
    ',',
  );

describe('order types', () => {
  it('lists the main row and the More groups once each', () => {
    expect(MAIN_ORDER_TYPES).toEqual(['LMT', 'MKT', 'STP', 'STP LMT', 'TRAIL']);
    expect(new Set(ORDER_TYPES).size).toBe(ORDER_TYPES.length);
    expect(ORDER_TYPES).toHaveLength(Object.keys(ORDER_TYPE_FIELDS).length);
    expect(ORDER_TYPE_GROUPS.flatMap((g) => g.types)).toContain('MIDPRICE');
    expect(isOrderType('TRAIL LIMIT')).toBe(true);
    expect(isOrderType('MKT PRT')).toBe(false);
  });

  it('asks for the prices each type needs', () => {
    expect(p({ orderType: 'MIT' })).toContain('stopPrice');
    expect(p({ orderType: 'MIT', stopPrice: 400 })).toEqual([]);
    expect(p({ orderType: 'LIT', limitPrice: undefined, stopPrice: 400 })).toContain('limitPrice');
    expect(p({ orderType: 'LOC', limitPrice: undefined })).toContain('limitPrice');
    expect(p({ orderType: 'MOC', limitPrice: undefined })).toEqual([]);
    expect(p({ orderType: 'MTL', limitPrice: undefined })).toEqual([]);
    // TRAIL LIMIT: the initial stop and the limit offset are required (321 without them).
    expect(p({ orderType: 'TRAIL LIMIT', trailingAmount: 1 })).toEqual(['trailStop', 'limitOffset']);
    expect(p({ orderType: 'TRAIL LIMIT', trailingPercent: 2, trailStopPrice: 300, limitOffset: 0 })).toEqual([]);
    expect(p({ orderType: 'TRAIL LIT', trailingAmount: 1, trailStopPrice: 400 })).toEqual(['limitOffset']);
    expect(p({ orderType: 'TRAIL MIT', trailingAmount: 1 })).toEqual(['trailStop']);
    // The price cap of a midprice order is optional.
    expect(p({ orderType: 'MIDPRICE', limitPrice: undefined })).toEqual([]);
    expect(p({ orderType: 'MIDPRICE', limitPrice: -1 })).toEqual(['limitPrice']);
    expect(p({ orderType: 'REL', limitPrice: undefined })).toEqual(['offset']);
    expect(p({ orderType: 'REL', offset: 0 })).toEqual([]);
    expect(p({ orderType: 'REL', percentOffset: 0.5 })).toEqual([]);
    expect(p({ orderType: 'REL', percentOffset: 150 })).toEqual(['percentOffset']);
    expect(p({ orderType: 'REL', percentOffset: 0.5, offset: 0.01 })).toEqual(['percentOffset']);
    expect(p({ percentOffset: 0.5 })).toEqual(['percentOffset']);
    expect(p({ orderType: 'SNAP MID', limitPrice: undefined })).toEqual([]);
    expect(p({ orderType: 'SNAP MKT', offset: -0.01 })).toEqual(['offset']);
    expect(p({ orderType: 'PEG MID', offset: 0, limitPrice: 1 })).toEqual([]);
    // Combos may be priced at zero or a credit.
    expect(p({ contract: BAG, limitPrice: -0.3 })).toEqual([]);
  });

  it('offers each type for the instruments IB takes it for', () => {
    expect(p({ contract: OPT, orderType: 'MIDPRICE' })).toContain('typeInstrument');
    expect(p({ contract: OPT, orderType: 'MOC' })).toContain('typeInstrument');
    expect(p({ contract: MES, orderType: 'LOC' })).toContain('typeInstrument');
    expect(p({ contract: MES, orderType: 'MIT', stopPrice: 9000 })).toEqual([]);
    expect(p({ contract: EUR, orderType: 'TRAIL LIMIT', trailingAmount: 0.01, trailStopPrice: 2, limitOffset: 0 })).toEqual([]);
    expect(p({ contract: BAG, orderType: 'STP', stopPrice: 1 })).toContain('typeInstrument');
    expect(p({ contract: BAG, orderType: 'MKT' })).toEqual([]);
  });

  it("checks IB's list of what the contract takes when it is known", () => {
    expect(orderProblems({ ...lmt, orderType: 'MIDPRICE' }, { orderTypes: AAPL_CODES })).toEqual([]);
    expect(orderProblems({ ...lmt, contract: MES, orderType: 'SNAP MID' }, { orderTypes: MES_CODES })).toEqual([]);
    // REL is in the static table for futures, but MES does not list it.
    expect(orderProblems({ ...lmt, contract: MES, orderType: 'REL', offset: 0 }, { orderTypes: MES_CODES })).toEqual(['typeContract']);
    expect(orderProblems({ ...lmt, contract: OPT, hidden: true }, { orderTypes: ['LMT'] })).toContain('hiddenInstrument');
    expect(orderProblems({ ...lmt, allOrNone: true }, { orderTypes: ['LMT', 'MKT'] })).toEqual(['attributeContract']);
    // Without a list only the static rules apply.
    expect(orderProblems({ ...lmt, allOrNone: true }, { orderTypes: [] })).toEqual([]);
  });

  it('keeps PEG MID in regular hours (IB drops outside RTH for it)', () => {
    expect(p({ orderType: 'PEG MID', limitPrice: undefined, offset: 0, session: 'extended', outsideRth: true })).toEqual(['typeSession']);
    expect(p({ orderType: 'SNAP MID', limitPrice: undefined, offset: 0, session: 'extended', outsideRth: true })).toEqual([]);
  });

  it('keeps regular-hours and DAY-only types in their session and TIF', () => {
    for (const orderType of ['MOC', 'MIT', 'MTL', 'MIDPRICE'] as const) {
      expect(p({ orderType, stopPrice: 400, session: 'extended' })).toContain('typeSession');
      expect(p({ orderType, stopPrice: 400, session: 'regular' })).not.toContain('typeSession');
    }
    expect(p({ orderType: 'LIT', stopPrice: 400, session: 'extended' })).toEqual([]);
    expect(p({ orderType: 'REL', offset: 0.01, session: 'extended' })).toEqual([]);
    expect(p({ orderType: 'MOC', tif: 'GTC' })).toEqual(['typeTif']);
    expect(p({ orderType: 'LOC', tif: 'DAY' })).toEqual([]);
  });
});

describe('fill attributes', () => {
  it('takes all or none for stocks and options outside the overnight sessions', () => {
    expect(p({ allOrNone: true })).toEqual([]);
    expect(p({ allOrNone: true, contract: OPT })).toEqual([]);
    expect(p({ allOrNone: true, contract: MES })).toEqual(['aonInstrument']);
    expect(p({ allOrNone: true, contract: BAG })).toEqual(['aonInstrument']);
    expect(p({ allOrNone: true, session: 'overnightDay' })).toEqual(['aonSession']);
    expect(p({ allOrNone: true, displaySize: 5 })).toEqual(['aonIceberg']);
    expect(p({ allOrNone: true, algo: { strategy: 'Adaptive', params: { adaptivePriority: 'Normal' } } })).toEqual(['aonAlgo']);
    // The parent of a bracket may be AON (its children are sent without it).
    expect(p({ allOrNone: true, bracket: { takeProfit: 2, stopLoss: 0.5 } })).toEqual([]);
  });

  it('takes a minimum quantity for options only', () => {
    expect(p({ contract: OPT, minQty: 5 })).toEqual([]);
    expect(p({ minQty: 5 })).toEqual(['minQtyInstrument']);
    expect(p({ contract: OPT, minQty: 11 })).toEqual(['minQty']);
    expect(p({ contract: OPT, minQty: 1.5 })).toEqual(['minQty']);
    expect(p({ minQty: 0 })).toEqual([]);
  });

  it('takes hidden and sweep to fill for stocks, discretion for stock and option limits', () => {
    expect(p({ hidden: true })).toEqual([]);
    expect(p({ hidden: true, contract: OPT })).toEqual(['hiddenInstrument']);
    expect(p({ hidden: true, displaySize: 5 })).toEqual(['hiddenIceberg']);
    expect(p({ sweepToFill: true })).toEqual([]);
    expect(p({ sweepToFill: true, contract: OPT })).toEqual(['sweepInstrument']);
    expect(p({ sweepToFill: true, route: 'NASDAQ' })).toEqual(['sweepInstrument']);
    expect(p({ sweepToFill: true, orderType: 'MKT' })).toEqual(['sweepType']);
    expect(p({ discretionaryAmt: 0.05 })).toEqual([]);
    expect(p({ discretionaryAmt: 0.05, orderType: 'MKT' })).toEqual(['discretionaryType']);
    expect(p({ discretionaryAmt: 0.05, contract: MES })).toEqual(['discretionaryInstrument']);
    expect(p({ discretionaryAmt: 0.05, displaySize: 5 })).toEqual(['discretionaryIceberg']);
    // Options: at most 10 % of the limit price.
    expect(p({ contract: OPT, limitPrice: 1, discretionaryAmt: 0.1 })).toEqual([]);
    expect(p({ contract: OPT, limitPrice: 1, discretionaryAmt: 0.2 })).toEqual(['discretionaryAmt']);
    expect(p({ discretionaryAmt: -1 })).toEqual(['discretionaryAmt']);
  });

  it('refuses sweep to fill and discretion overnight, and hidden opening orders', () => {
    // Overnight: sweep 10267 / 201, discretion 201 (overnight + day) or dropped (overnight venue).
    expect(p({ sweepToFill: true, session: 'overnight', outsideRth: true })).toContain('sweepSession');
    expect(p({ sweepToFill: true, session: 'overnightDay', outsideRth: true })).toContain('sweepSession');
    expect(p({ discretionaryAmt: 0.05, session: 'overnight', outsideRth: true })).toContain('discretionarySession');
    expect(p({ discretionaryAmt: 0.05, session: 'overnightDay', outsideRth: true })).toContain('discretionarySession');
    expect(p({ sweepToFill: true, discretionaryAmt: 0.05, session: 'extended', outsideRth: true })).toEqual([]);
    // 201 "Only DAY/LIMIT allowed for hidden order" (GTC and GTD were accepted).
    expect(p({ hidden: true, tif: 'OPG' })).toEqual(['hiddenTif']);
    expect(p({ hidden: true, tif: 'GTC' })).toEqual([]);
  });

  it('takes a display size on limit orders only, not when directed', () => {
    expect(p({ displaySize: 5 })).toEqual([]);
    expect(p({ displaySize: 5, orderType: 'STP LMT', stopPrice: 400 })).toEqual(['icebergType']);
    expect(p({ displaySize: 5, orderType: 'STP', stopPrice: 400 })).toEqual(['icebergType']);
    expect(p({ displaySize: 5, route: 'ARCA' })).toEqual(['icebergRoute']);
    expect(orderProblems({ ...lmt, contract: EUR, displaySize: 5 }, { orderTypes: ['LMT'] })).toEqual(['attributeContract']);
  });

  it('offers trigger methods for trigger types, bid/ask ones for forex', () => {
    expect(p({ orderType: 'STP', stopPrice: 400, triggerMethod: 8 })).toEqual([]);
    expect(p({ triggerMethod: 2 })).toEqual(['triggerType']);
    expect(p({ contract: EUR, orderType: 'STP', stopPrice: 2, triggerMethod: 2 })).toEqual(['triggerInstrument']);
    expect(p({ contract: EUR, orderType: 'STP', stopPrice: 2, triggerMethod: 4 })).toEqual([]);
    expect(triggerMethodsFor('CASH')).toEqual([0, 4, 8]);
    expect(triggerMethodsFor('OPT')).toContain(1);
  });
});

describe('algos', () => {
  const adaptive = { strategy: 'Adaptive' as const, params: { adaptivePriority: 'Normal' } };

  it('checks instrument, order type, session and routing', () => {
    expect(p({ algo: adaptive })).toEqual([]);
    expect(p({ algo: adaptive, contract: OPT })).toEqual([]);
    expect(p({ algo: adaptive, contract: MES })).toEqual([]);
    expect(p({ algo: adaptive, session: 'extended' })).toEqual(['algoSession']);
    expect(p({ algo: adaptive, session: 'overnightDay' })).toEqual(['algoSession']);
    expect(p({ algo: adaptive, orderType: 'STP', stopPrice: 400 })).toEqual(['algoType']);
    expect(p({ algo: adaptive, route: 'NASDAQ' })).toEqual(['algoRoute']);
    // VWAP is for stocks (439 on options), MinImpact for options.
    expect(p({ algo: { strategy: 'Vwap', params: { maxPctVol: 0.1 } }, contract: OPT })).toEqual(['algoInstrument']);
    expect(p({ algo: { strategy: 'MinImpact', params: { maxPctVol: 0.1 } }, contract: OPT })).toEqual([]);
    expect(p({ algo: { strategy: 'Nope' as never, params: {} } })).toEqual(['algoUnknown']);
    expect(orderProblems({ ...lmt, algo: adaptive }, { orderTypes: ['LMT'] })).toEqual(['attributeContract']);
  });

  it('refuses what IB refuses with an algo: fill attributes, TIFs other than DAY, good-after times', () => {
    // Paper: hidden 152, sweep / discretionary 201, iceberg 10255, minimum quantity 10256.
    expect(p({ algo: adaptive, hidden: true })).toEqual(['algoAttribute']);
    expect(p({ algo: adaptive, sweepToFill: true })).toEqual(['algoAttribute']);
    expect(p({ algo: adaptive, discretionaryAmt: 0.05 })).toEqual(['algoAttribute']);
    expect(p({ algo: adaptive, contract: OPT, displaySize: 1 })).toEqual(['algoAttribute']);
    expect(p({ algo: adaptive, contract: OPT, minQty: 1 })).toEqual(['algoAttribute']);
    expect(p({ algo: adaptive, discretionaryAmt: 0, minQty: 0, hidden: false })).toEqual([]);
    // 201 "GTC orders are not allowed for X IB algorithmic orders" except Adaptive and AD.
    expect(p({ algo: adaptive, tif: 'GTC' })).toEqual([]);
    expect(p({ algo: { strategy: 'Vwap', params: { maxPctVol: 0.1 } }, tif: 'GTC' })).toEqual(['algoTif']);
    expect(p({ algo: adaptive, tif: 'GTD', goodTillDate: '20991231 16:00:00 US/Eastern' })).toEqual(['algoTif']);
    expect(p({ algo: adaptive, tif: 'IOC' })).toEqual(['algoTif']);
    expect(p({ algo: adaptive, tif: 'OPG' })).toEqual(['algoTif']);
    expect(p({ algo: adaptive, goodAfterTime: '09:45' })).toEqual(['algoGoodAfter']);
    expect(problemsInvolving({ ...lmt, algo: adaptive, goodAfterTime: '09:45' }, 'goodAfter')).toEqual(['algoGoodAfter']);
    expect(problemsInvolving({ ...lmt, algo: adaptive, hidden: true }, 'hidden')).toEqual(['algoAttribute']);
  });

  it('checks the parameters', () => {
    expect(algoParamProblem({ strategy: 'Adaptive', params: {} })).toBe('adaptivePriority');
    expect(algoParamProblem({ strategy: 'Adaptive', params: { adaptivePriority: 'Fast' } })).toBe('adaptivePriority');
    expect(algoParamProblem({ strategy: 'Vwap', params: { maxPctVol: 0.1, startTime: '09:30', endTime: '16:00', allowPastEndTime: true } })).toBeNull();
    expect(algoParamProblem({ strategy: 'Vwap', params: { maxPctVol: 0.9 } })).toBe('maxPctVol');
    expect(algoParamProblem({ strategy: 'Vwap', params: { startTime: '9.30' } })).toBe('startTime');
    expect(algoParamProblem({ strategy: 'Vwap', params: { noTakeLiq: 1 } })).toBe('noTakeLiq');
    expect(algoParamProblem({ strategy: 'PctVol', params: {} })).toBe('pctVol');
    expect(algoParamProblem({ strategy: 'ArrivalPx', params: { riskAversion: 'Get Done' } })).toBeNull();
    expect(algoParamProblem({ strategy: 'AD', params: { componentSize: 1, timeBetweenOrders: 60 } })).toBeNull();
    expect(algoParamProblem({ strategy: 'AD', params: { componentSize: 1.5, timeBetweenOrders: 60 } })).toBe('componentSize');
    const req = { ...lmt, algo: { strategy: 'DarkIce' as const, params: {} } };
    expect(orderProblem(req)).toBe('algoParam');
    expect(orderProblemText(req, 'algoParam')).toBe('An algo parameter is missing or out of range: displaySize');
    // TWAP's strategyType is refused by IB (443), so it is not offered.
    expect(ALGOS.find((a) => a.strategy === 'Twap')?.params.map((x) => x.tag)).not.toContain('strategyType');
  });
});

describe('conditions', () => {
  const price = { kind: 'price' as const, contract: AAPL, operator: '>=' as const, price: 400 };

  it('converts the single price condition', () => {
    expect(requestConditions({ condition: { contract: AAPL, operator: '<=', price: 300, outsideRth: true } })).toEqual({
      items: [{ kind: 'price', contract: AAPL, operator: '<=', price: 300 }],
      outsideRth: true,
    });
    expect(requestConditions({})).toBeUndefined();
    expect(p({ condition: { contract: AAPL, operator: '<=', price: 300, outsideRth: true }, conditions: { items: [price], outsideRth: false } })).toEqual(['conditionBoth']);
  });

  it('submits market, limit, midprice, relative and snap orders only (148)', () => {
    const conditions = { items: [price], outsideRth: false };
    expect(p({ conditions })).toEqual([]);
    expect(p({ conditions, orderType: 'MIDPRICE' })).toEqual([]);
    for (const orderType of ['STP', 'STP LMT', 'TRAIL', 'MIT'] as const) {
      expect(p({ conditions, orderType, stopPrice: 400, trailingAmount: 1 })).toEqual(['conditionType']);
    }
    // The ticket's single condition on a stop order (Tape allowed it before; IB refuses it).
    expect(p({ orderType: 'STP', stopPrice: 400, condition: { contract: AAPL, operator: '>=', price: 1, outsideRth: false } })).toEqual(['conditionType']);
  });

  it('cancels limit and midprice orders only', () => {
    const conditions = { items: [price], outsideRth: false, cancel: true };
    expect(p({ conditions })).toEqual([]);
    expect(p({ conditions, orderType: 'MIDPRICE' })).toEqual([]);
    expect(p({ conditions, orderType: 'MKT' })).toEqual(['conditionCancelType']);
  });

  it('checks every kind of condition', () => {
    const one = (item: object) => p({ conditions: { items: [item as never], outsideRth: false } });
    expect(one({ kind: 'time', time: '20261005 10:00:00 US/Eastern' })).toEqual([]);
    expect(one({ kind: 'time', time: '20261005-14:00:00' })).toEqual([]);
    expect(one({ kind: 'time', time: '10:00' })).toEqual(['conditionValue']);
    expect(one({ kind: 'percentChange', contract: AAPL, operator: '<=', percent: -5 })).toEqual([]);
    expect(one({ kind: 'percentChange', contract: AAPL, operator: '<=', percent: 0 })).toEqual(['conditionValue']);
    expect(one({ kind: 'volume', contract: AAPL, operator: '>=', volume: 100_000_000 })).toEqual([]);
    // The volume is an int on the wire (320 beyond).
    expect(one({ kind: 'volume', contract: AAPL, operator: '>=', volume: 1e12 })).toEqual(['conditionValue']);
    expect(one({ kind: 'margin', operator: '<=', percent: 30 })).toEqual([]);
    expect(one({ kind: 'margin', operator: '<=', percent: 130 })).toEqual(['conditionValue']);
    expect(one({ kind: 'execution', symbol: 'MSFT', secType: 'STK' })).toEqual([]);
    expect(one({ kind: 'execution', symbol: ' ', secType: 'STK' })).toEqual(['conditionValue']);
    expect(one({ ...price, triggerMethod: 8 })).toEqual([]);
    expect(one({ ...price, contract: EUR, triggerMethod: 2 })).toEqual(['conditionValue']);
    expect(one({ ...price, contract: index('SPX', 'CBOE'), price: 6000 })).toEqual([]);
    expect(one({ ...price, join: 'xor' })).toEqual(['conditionValue']);
    expect(p({ conditions: { items: Array(6).fill(price), outsideRth: false } })).toEqual(['conditionCount']);
    expect(p({ conditions: { items: [], outsideRth: false } })).toEqual(['conditionCount']);
  });
});

describe('linked orders', () => {
  it('builds stop-loss types with their prices; trailing ones only under limit parents (328)', () => {
    expect(p({ bracket: { takeProfit: 2, stopLoss: 0.5, stopType: 'STP LMT', stopLimit: 0.45 } })).toEqual([]);
    expect(p({ bracket: { stopLoss: 0.5, stopType: 'STP LMT' } })).toEqual(['bracketStopFields']);
    expect(p({ bracket: { stopLoss: 0.5, stopType: 'TRAIL', stopTrailAmount: 0.2 } })).toEqual([]);
    expect(p({ bracket: { stopLoss: 0.5, stopType: 'TRAIL', stopTrailAmount: 0.2, stopTrailPercent: 1 } })).toEqual(['bracketStopFields']);
    expect(p({ bracket: { stopLoss: 0.5, stopType: 'TRAIL LIMIT', stopTrailPercent: 1 } })).toEqual(['bracketStopFields']);
    expect(p({ bracket: { stopLoss: 0.5, stopType: 'TRAIL LIMIT', stopTrailPercent: 1, stopLimitOffset: 0.05 } })).toEqual([]);
    expect(p({ orderType: 'MKT', bracket: { stopLoss: 0.5, stopType: 'TRAIL', stopTrailAmount: 0.2 } })).toEqual(['bracketTrailParent']);
    expect(p({ orderType: 'MKT', bracket: { stopLoss: 0.5, stopType: 'STP LMT', stopLimit: 0.4 } })).toEqual([]);
    expect(p({ bracket: { stopLoss: 0.5, stopType: 'MIT' as never } })).toEqual(['bracketStopType']);
  });

  it('adjusts stops when the trigger is beyond the stop', () => {
    // A BUY order's stop-loss sells: its trigger is above the stop.
    expect(p({ bracket: { stopLoss: 0.5, adjust: { trigger: 2, type: 'STP', stopPrice: 1 } } })).toEqual([]);
    expect(p({ bracket: { stopLoss: 0.5, adjust: { trigger: 0.4, type: 'STP', stopPrice: 1 } } })).toEqual(['adjustFields']);
    expect(p({ bracket: { stopLoss: 0.5, adjust: { trigger: 2, type: 'TRAIL', trailAmount: 0.5 } } })).toEqual([]);
    expect(p({ bracket: { stopLoss: 0.5, adjust: { trigger: 2, type: 'STP LMT', stopPrice: 1 } } })).toEqual(['adjustFields']);
    expect(p({ bracket: { takeProfit: 2, adjust: { trigger: 2, type: 'STP', stopPrice: 1 } } })).toEqual(['adjustType']);
    expect(p({ bracket: { stopLoss: 0.5, stopType: 'TRAIL LIMIT', stopTrailAmount: 1, stopLimitOffset: 0, adjust: { trigger: 2, type: 'STP', stopPrice: 1 } } })).toEqual(['adjustType']);
    // A standalone BUY stop (closing a short): its trigger is below the stop.
    expect(p({ orderType: 'STP', stopPrice: 10000, adjustStop: { trigger: 5000, type: 'STP', stopPrice: 9000 } })).toEqual([]);
    expect(p({ orderType: 'STP', stopPrice: 10000, adjustStop: { trigger: 11000, type: 'STP', stopPrice: 9000 } })).toEqual(['adjustFields']);
    expect(p({ adjustStop: { trigger: 5000, type: 'STP', stopPrice: 9000 } })).toEqual(['adjustType']);
  });

  it('puts orders into one-cancels-all groups', () => {
    expect(p({ oca: { group: 'exit', type: 1 } })).toEqual([]);
    expect(p({ oca: { group: ' ', type: 1 } })).toEqual(['ocaGroup']);
    expect(p({ oca: { group: 'exit', type: 4 as never } })).toEqual(['ocaGroup']);
    expect(p({ oca: { group: 'exit', type: 1 }, bracket: { takeProfit: 2 } })).toEqual(['ocaBracket']);
    expect(p({ contract: BAG, oca: { group: 'exit', type: 1 } })).toEqual(['ocaCombo']);
    expect(p({ contract: BAG, oca: { group: 'exit', type: 3 } })).toEqual([]);
  });
});

describe('routing, combos and cash quantity', () => {
  it('routes stocks to a valid exchange', () => {
    expect(p({ route: 'NASDAQ' })).toEqual([]);
    expect(p({ route: 'SMART' })).toEqual([]);
    expect(p({ route: 'NASDAQ', contract: OPT })).toEqual(['routeInstrument']);
    expect(p({ route: 'OVERNIGHT' })).toEqual(['routeName']);
    expect(p({ route: 'nasdaq' })).toEqual(['routeName']);
    expect(orderProblems({ ...lmt, route: 'ISLAND' }, { validExchanges: ['SMART', 'NASDAQ', 'ARCA'] })).toEqual(['routeExchange']);
    expect(p({ route: 'NASDAQ', session: 'overnight' })).toEqual(['routeSession']);
    expect(p({ route: 'NASDAQ', orderType: 'MIDPRICE' })).toEqual(['routeType']);
  });

  it('refuses control characters in free text sent to IB', () => {
    expect(p({ orderRef: 'x\u0000INJECTED' })).toEqual(['orderRef']);
    expect(p({ orderRef: 'core 备注' })).toEqual([]);
    expect(p({ oca: { group: 'g\u00001', type: 1 } })).toEqual(['ocaGroup']);
    expect(p({ conditions: { items: [{ kind: 'execution', symbol: 'A\u0000B', secType: 'STK' }], outsideRth: false } })).toEqual(['conditionValue']);
    expect(p({ conditions: { items: [{ kind: 'execution', symbol: 'BRK B', secType: 'STK' }], outsideRth: false } })).toEqual([]);
    expect(p({ conditions: { items: [{ kind: 'time', time: '20261005 10:00:00 US/Eastern\u0000X' }], outsideRth: false } })).toEqual(['conditionValue']);
    expect(p({ conditions: { items: [{ kind: 'time', time: '20261005 10:00:00 US/Eastern' }], outsideRth: false } })).toEqual([]);
  });

  it("does not count the instrument's own exchange as a directed route", () => {
    const hk: ContractRef = { symbol: '700', secType: 'STK', exchange: 'SEHK', currency: 'HKD', conId: 152791428 };
    expect(p({ contract: hk, route: 'SEHK', orderType: 'TRAIL', limitPrice: undefined, trailingPercent: 2, action: 'SELL' })).toEqual([]);
    expect(p({ contract: hk, route: 'SEHK', displaySize: 5 })).toEqual([]);
  });

  it('routes combos non-guaranteed only', () => {
    expect(p({ contract: BAG, nonGuaranteed: true })).toEqual([]);
    expect(p({ nonGuaranteed: true })).toEqual(['nonGuaranteedInstrument']);
  });

  it('sizes forex orders by cash', () => {
    expect(p({ contract: EUR, quantity: 0, cashQty: 10000 })).toEqual([]);
    expect(p({ quantity: 0, cashQty: 100 })).toEqual(['cashQtyInstrument']);
    expect(p({ contract: EUR, quantity: 10, cashQty: 10000 })).toEqual(['cashQtyQuantity']);
    expect(p({ contract: EUR, quantity: 0, cashQty: 10000, orderType: 'STP', stopPrice: 2 })).toEqual(['cashQtyType']);
  });
});

describe('problem texts and fields', () => {
  it('has a text for every problem', () => {
    for (const [k, v] of Object.entries(ORDER_PROBLEM_TEXT)) {
      expect(isOrderProblem(k)).toBe(true);
      expect(v.length).toBeGreaterThan(5);
    }
  });

  it('names the problems a choice can resolve', () => {
    const req = { ...lmt, allOrNone: true, displaySize: 5, session: 'overnightDay' as const };
    expect(problemsInvolving(req, 'iceberg')).toEqual(['aonIceberg']);
    expect(problemsInvolving(req, 'allOrNone')).toEqual(['aonSession', 'aonIceberg']);
    expect(problemsInvolving(req, 'algo')).toEqual([]);
  });
});

describe('modifying', () => {
  const working: WorkingOrder = {
    orderId: 7,
    clientId: 303,
    key: 'STK:AAPL',
    contract: AAPL,
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 10,
    limitPrice: 1,
    tif: 'DAY',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 10,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
    allOrNone: true,
    algo: { strategy: 'Adaptive', params: { adaptivePriority: 'Normal' } },
    oca: { group: 'g1', type: 1 },
    conditions: { items: [{ kind: 'price', contract: AAPL, operator: '>=', price: 400 }], outsideRth: false },
    orderRef: 'note',
  };

  it('keeps the attributes a request leaves out, and turns off what it sets false', () => {
    const full = withOrderAttributes({ ...lmt, limitPrice: 1.01 }, working);
    expect(full).toMatchObject({ limitPrice: 1.01, allOrNone: true, algo: working.algo, oca: working.oca, conditions: working.conditions, orderRef: 'note' });
    expect(withOrderAttributes({ ...lmt, allOrNone: false, orderRef: '' }, working)).toMatchObject({ allOrNone: false, orderRef: '' });
    // A single price condition of the request replaces the list.
    const single = withOrderAttributes({ ...lmt, condition: { contract: AAPL, operator: '>=', price: 401, outsideRth: false } }, working);
    expect(single.conditions).toBeUndefined();
    expect(modifyProblems(working, single)).toEqual([]);
  });

  it('refuses what IB refuses or ignores on a working order', () => {
    const full = withOrderAttributes(lmt, working);
    expect(modifyProblems(working, full)).toEqual([]);
    expect(modifyProblems(working, { ...full, algo: { strategy: 'Adaptive', params: { adaptivePriority: 'Urgent' } } })).toEqual([]);
    expect(modifyProblems(working, { ...full, algo: { strategy: 'Vwap', params: {} } })).toEqual(['algo']);
    expect(modifyProblems({ ...working, algo: undefined }, full)).toEqual(['algo']);
    expect(modifyProblems(working, { ...full, oca: { group: 'g2', type: 1 } })).toEqual(['oca']);
    expect(modifyProblems(working, { ...full, oca: { group: 'g1', type: 3 } })).toEqual(['oca']);
    expect(modifyProblems(working, { ...full, conditions: { ...full.conditions!, cancel: true } })).toEqual(['conditions']);
    expect(modifyProblems(working, { ...full, conditions: { items: [...full.conditions!.items, { kind: 'margin', operator: '<=', percent: 20 }], outsideRth: false } })).toEqual(['conditions']);
    // Condition values can change.
    expect(modifyProblems(working, { ...full, conditions: { items: [{ kind: 'price', contract: AAPL, operator: '>=', price: 410 }], outsideRth: true } })).toEqual([]);
    expect(modifyProblems(working, { ...full, orderType: 'MKT' })).toEqual(['orderType']);
    expect(modifyProblems(working, { ...full, action: 'SELL' })).toEqual(['action']);
    expect(modifyProblems(working, { ...full, contract: OPT })).toEqual(['contract']);
    expect(modifyProblems(working, { ...full, route: 'NASDAQ' })).toEqual(['route']);
    expect(modifyProblems(working, { ...full, nonGuaranteed: true })).toEqual(['nonGuaranteed']);
  });

  it('refuses the changes IB ignores without a word or refuses after taking the order', () => {
    const full = withOrderAttributes(lmt, working);
    // Condition operators and joins stay as they were (their values change).
    expect(modifyProblems(working, { ...full, conditions: { items: [{ kind: 'price', contract: AAPL, operator: '<=', price: 400 }], outsideRth: false } })).toEqual(['conditions']);
    const two = { ...working, conditions: { items: [{ kind: 'price' as const, contract: AAPL, operator: '>=' as const, price: 400, join: 'or' as const }, { kind: 'margin' as const, operator: '<=' as const, percent: 5 }], outsideRth: false } };
    const twoReq = withOrderAttributes(lmt, two);
    expect(modifyProblems(two, twoReq)).toEqual([]);
    expect(modifyProblems(two, { ...twoReq, conditions: { ...two.conditions, items: [{ ...two.conditions.items[0], join: 'and' }, two.conditions.items[1]] } })).toEqual(['conditions']);
    // A single price condition summary (orders without the full list) keeps its operator too.
    const legacy: WorkingOrder = { ...working, conditions: undefined, condition: { symbol: 'AAPL', operator: '>=', price: 400, outsideRth: false } };
    expect(modifyProblems(legacy, { ...full, conditions: { items: [{ kind: 'price', contract: AAPL, operator: '<=', price: 400 }], outsideRth: false } })).toEqual(['conditions']);
    // The trigger method stays (2 → 8, 0 → 2 and 2 → 0 were ignored).
    const stp: WorkingOrder = { ...working, orderType: 'STP', limitPrice: undefined, auxPrice: 500, triggerMethod: 2, algo: undefined, conditions: undefined };
    const stpReq: OrderRequest = withOrderAttributes({ ...lmt, orderType: 'STP', limitPrice: undefined, stopPrice: 500 }, stp);
    expect(modifyProblems(stp, stpReq)).toEqual([]);
    expect(modifyProblems(stp, { ...stpReq, triggerMethod: 8 })).toEqual(['triggerMethod']);
    expect(modifyProblems(stp, { ...stpReq, triggerMethod: 0 })).toEqual(['triggerMethod']);
    // Sweep to fill: off is ignored, on is refused ("Revision to SweepToFill is disallowed").
    expect(modifyProblems({ ...working, sweepToFill: true }, { ...full, sweepToFill: false })).toEqual(['sweepToFill']);
    expect(modifyProblems(working, { ...full, sweepToFill: true })).toEqual(['sweepToFill']);
    // REL percent ↔ amount offset: 201 "Modify Mismatch on field # 9822".
    const rel: WorkingOrder = { ...working, orderType: 'REL', percentOffset: 0.5, algo: undefined, conditions: undefined };
    const relReq = withOrderAttributes({ ...lmt, orderType: 'REL', percentOffset: 0.5 }, rel);
    expect(modifyProblems(rel, relReq)).toEqual([]);
    expect(modifyProblems(rel, { ...relReq, percentOffset: undefined, offset: 0.02 })).toEqual(['offsetMode']);
    // An order sized by cash cannot be modified through the API (10241).
    expect(modifyProblems({ ...working, cashQty: 10000 }, full)).toEqual(['cashQty']);
    // Dropping a discretionary amount, good-after time or note keeps IB's value.
    expect(modifyProblems({ ...working, discretionaryAmt: 0.05 }, { ...full, discretionaryAmt: 0 })).toEqual(['clearAttribute']);
    expect(modifyProblems({ ...working, discretionaryAmt: 0.05 }, { ...full, discretionaryAmt: 0.06 })).toEqual([]);
    expect(modifyProblems({ ...working, goodAfterTime: '10:15' }, full)).toEqual(['clearAttribute']);
    expect(modifyProblems({ ...working, goodAfterTime: '10:15' }, { ...full, goodAfterTime: '10:30' })).toEqual([]);
    expect(modifyProblems(working, { ...full, orderRef: '' })).toEqual(['clearAttribute']);
    expect(modifyProblems(working, { ...full, orderRef: 'other' })).toEqual([]);
  });
});
