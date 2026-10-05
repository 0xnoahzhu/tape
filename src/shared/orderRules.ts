// Order type, price, attribute, algo, condition and linked-order rules, shared by the order ticket
// (which disables what does not combine and says why) and the main process (orderBuilder checks
// every request again, for every caller). Time in force and session rules are in orderTiming.ts.
//
// The rules follow what IB answered on the paper account (docs/ARCHITECTURE.md › Orders, "Order
// types and attributes"), with IB's error codes next to each rule. Where a contract's details are
// known, IB's own list of what the contract takes (ContractInfo.orderTypes: "MIT", "AON", "ALGO",
// …) is checked as well; it is not complete (stocks list CASHQTY, which the API refuses with
// 10244), so the static tables below always apply.

import { isOvernight, sessionOf } from './orderTiming';
import type {
  AdjustedStop,
  AlgoParamValue,
  AlgoSpec,
  AlgoStrategy,
  ContractRef,
  OrderConditionItem,
  OrderConditions,
  OrderRequest,
  OrderType,
  SecType,
  StopOrderType,
  TriggerMethod,
  WorkingOrder,
} from './types';

// ---------------------------------------------------------------------------
// Order types

/** The ticket's main row. */
export const MAIN_ORDER_TYPES: readonly OrderType[] = ['LMT', 'MKT', 'STP', 'STP LMT', 'TRAIL'];

/** The other order types, grouped as the ticket's "More" menu shows them. */
export const ORDER_TYPE_GROUPS: ReadonlyArray<{ id: 'touched' | 'trailing' | 'auction' | 'midpoint' | 'other'; types: readonly OrderType[] }> = [
  { id: 'touched', types: ['MIT', 'LIT'] },
  { id: 'trailing', types: ['TRAIL LIMIT', 'TRAIL MIT', 'TRAIL LIT'] },
  { id: 'auction', types: ['MOC', 'LOC'] },
  { id: 'midpoint', types: ['MIDPRICE', 'REL', 'SNAP MID', 'SNAP MKT', 'PEG MID'] },
  { id: 'other', types: ['MTL'] },
];

export const ORDER_TYPES: readonly OrderType[] = [...MAIN_ORDER_TYPES, ...ORDER_TYPE_GROUPS.flatMap((g) => g.types)];

export const isOrderType = (s: string): s is OrderType => (ORDER_TYPES as readonly string[]).includes(s);

type Need = 'required' | 'optional' | 'none';

/** The price fields of an order type (OrderRequest field names in the comments). */
export interface OrderTypeFields {
  /** limitPrice: the limit, or for MIDPRICE / REL / PEG MID an optional price cap. */
  limit: Need;
  /** stopPrice: the stop (STP, STP LMT) or trigger (MIT, LIT) price. */
  stop: Need;
  /** trailingAmount or trailingPercent. */
  trail: Need;
  /** trailStopPrice: the initial stop of a trailing order. */
  trailStop: Need;
  /** limitOffset: the limit's distance from the trailing stop. */
  limitOffset: Need;
  /** offset (or percentOffset for REL): distance from the reference price. */
  offset: Need;
}

const F = (o: Partial<OrderTypeFields>): OrderTypeFields => ({ limit: 'none', stop: 'none', trail: 'none', trailStop: 'none', limitOffset: 'none', offset: 'none', ...o });

export const ORDER_TYPE_FIELDS: Readonly<Record<OrderType, OrderTypeFields>> = {
  LMT: F({ limit: 'required' }),
  MKT: F({}),
  STP: F({ stop: 'required' }),
  'STP LMT': F({ stop: 'required', limit: 'required' }),
  TRAIL: F({ trail: 'required', trailStop: 'optional' }),
  // IB refuses a trailing stop limit without the initial stop (321) and with both or neither of
  // limit price and offset (321); the offset is always sent, so IB Gateway's preset never applies.
  'TRAIL LIMIT': F({ trail: 'required', trailStop: 'required', limitOffset: 'required' }),
  MIT: F({ stop: 'required' }),
  LIT: F({ stop: 'required', limit: 'required' }),
  MOC: F({}),
  LOC: F({ limit: 'required' }),
  MTL: F({}),
  MIDPRICE: F({ limit: 'optional' }),
  REL: F({ offset: 'required', limit: 'optional' }),
  // IB ignores a price cap of snap orders (it echoes lmtPrice 0).
  'SNAP MID': F({ offset: 'optional' }),
  'SNAP MKT': F({ offset: 'optional' }),
  'PEG MID': F({ offset: 'optional', limit: 'optional' }),
  'TRAIL MIT': F({ trail: 'required', trailStop: 'required' }),
  'TRAIL LIT': F({ trail: 'required', trailStop: 'required', limitOffset: 'required' }),
};

/** Order types with a trigger (IB-simulated stops and touched orders): the trigger method applies. */
export const TRIGGER_ORDER_TYPES: readonly OrderType[] = ['STP', 'STP LMT', 'TRAIL', 'TRAIL LIMIT', 'MIT', 'LIT', 'TRAIL MIT', 'TRAIL LIT'];
export const TRAILING_ORDER_TYPES: readonly OrderType[] = ['TRAIL', 'TRAIL LIMIT', 'TRAIL MIT', 'TRAIL LIT'];

const ALL: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'BAG', 'CFD', 'BOND', 'WAR', 'CRYPTO'];
const DERIV_AND_STK: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'CFD', 'BOND', 'WAR'];

/**
 * Instruments each order type is offered for. Combos take LMT and MKT; crypto LMT and MKT
 * (IB's rules). On the paper account options and futures refused MIDPRICE, MOC and LOC (387).
 */
export const ORDER_TYPE_SEC_TYPES: Readonly<Record<OrderType, readonly SecType[]>> = {
  LMT: ALL,
  MKT: ALL,
  STP: DERIV_AND_STK,
  'STP LMT': DERIV_AND_STK,
  TRAIL: DERIV_AND_STK,
  'TRAIL LIMIT': DERIV_AND_STK,
  MIT: DERIV_AND_STK,
  LIT: DERIV_AND_STK,
  MOC: ['STK', 'CFD', 'WAR'],
  LOC: ['STK', 'CFD', 'WAR'],
  MTL: ['STK', 'OPT', 'FUT', 'FOP', 'CFD', 'WAR'],
  MIDPRICE: ['STK'],
  REL: ['STK', 'OPT', 'FUT', 'CASH', 'CFD'],
  'SNAP MID': ['STK', 'OPT', 'FUT', 'FOP'],
  'SNAP MKT': ['STK'],
  'PEG MID': ['STK'],
  'TRAIL MIT': ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'WAR'],
  'TRAIL LIT': ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'WAR'],
};

/** IB's codes in ContractInfo.orderTypes for the order types and attributes. */
const TYPE_CODE: Readonly<Record<OrderType, string>> = {
  LMT: 'LMT',
  MKT: 'MKT',
  STP: 'STP',
  'STP LMT': 'STPLMT',
  TRAIL: 'TRAIL',
  'TRAIL LIMIT': 'TRAILLMT',
  MIT: 'MIT',
  LIT: 'LIT',
  MOC: 'MOC',
  LOC: 'LOC',
  MTL: 'MTL',
  MIDPRICE: 'MIDPX',
  REL: 'REL',
  'SNAP MID': 'SNAPMID',
  'SNAP MKT': 'SNAPMKT',
  'PEG MID': 'PEGMID',
  'TRAIL MIT': 'TRAILMIT',
  'TRAIL LIT': 'TRAILLIT',
};

/**
 * Regular trading hours only: IB ignores outside RTH for MOC, LOC, MIT, MTL (2109) and PEG MID
 * (its echo has outsideRth false), and refuses it for MIDPRICE (321). TRAIL MIT is treated like MIT.
 */
export const REGULAR_HOURS_TYPES: readonly OrderType[] = ['MOC', 'LOC', 'MIT', 'MTL', 'MIDPRICE', 'TRAIL MIT', 'PEG MID'];
/** At-the-close orders are DAY orders (201 "Invalid time-in-force for at-the-closing order"). */
export const DAY_ONLY_TYPES: readonly OrderType[] = ['MOC', 'LOC'];
/** Conditional submission: IB 148 "… Limit, Market, MidPrice, Relative and Snap only". */
export const CONDITION_SUBMIT_TYPES: readonly OrderType[] = ['LMT', 'MKT', 'MIDPRICE', 'REL', 'SNAP MID', 'SNAP MKT'];
/** Conditional cancel: limit and midprice orders only (148). */
export const CONDITION_CANCEL_TYPES: readonly OrderType[] = ['LMT', 'MIDPRICE'];
/** Iceberg: IB refuses a display size on stop orders (10255); limit orders only. */
export const ICEBERG_TYPES: readonly OrderType[] = ['LMT'];
/** Directed routing was checked with these types (MIDPRICE, PEG MID: 387 on direct venues). */
export const ROUTE_TYPES: readonly OrderType[] = ['LMT', 'MKT', 'STP', 'STP LMT'];
/** Order types of an adjustable stop (on the order itself or a bracket's stop-loss). */
export const ADJUSTABLE_TYPES: readonly OrderType[] = ['STP', 'STP LMT', 'TRAIL'];
export const STOP_LOSS_TYPES: readonly StopOrderType[] = ['STP', 'STP LMT', 'TRAIL', 'TRAIL LIMIT'];

// ---------------------------------------------------------------------------
// Trigger methods

export const TRIGGER_METHODS: readonly TriggerMethod[] = [0, 1, 2, 3, 4, 7, 8];

/**
 * Trigger methods offered for an instrument. Forex (and CFDs, commodities) have no trades, so a
 * last-price method could never trigger (IB still accepts it); 0 is IB's default, which for US
 * options is double bid/ask.
 */
export function triggerMethodsFor(secType: SecType): readonly TriggerMethod[] {
  if (secType === 'CASH' || secType === 'CFD' || secType === 'CRYPTO') return [0, 4, 8];
  return TRIGGER_METHODS;
}

// ---------------------------------------------------------------------------
// Algos

export type AlgoParamKind = 'choice' | 'fraction' | 'integer' | 'switch' | 'time';

export interface AlgoParam {
  tag: string;
  kind: AlgoParamKind;
  /** 'choice': IB's values. */
  options?: readonly string[];
  /** 'fraction' (0.1 = 10 %) and 'integer' bounds, inclusive. */
  min?: number;
  max?: number;
  required?: boolean;
}

export interface AlgoInfo {
  strategy: AlgoStrategy;
  secTypes: readonly SecType[];
  params: readonly AlgoParam[];
}

const RISK = ['Get Done', 'Aggressive', 'Neutral', 'Passive'] as const;
const P = {
  maxPctVol: { tag: 'maxPctVol', kind: 'fraction', min: 0.01, max: 0.5 },
  pctVol: { tag: 'pctVol', kind: 'fraction', min: 0.01, max: 0.5, required: true },
  start: { tag: 'startTime', kind: 'time' },
  end: { tag: 'endTime', kind: 'time' },
  pastEnd: { tag: 'allowPastEndTime', kind: 'switch' },
  noTakeLiq: { tag: 'noTakeLiq', kind: 'switch' },
  risk: { tag: 'riskAversion', kind: 'choice', options: RISK },
  force: { tag: 'forceCompletion', kind: 'switch' },
} satisfies Record<string, AlgoParam>;

/**
 * IB algos and their parameters, as the paper account took them. Times are "HH:MM" New York time
 * in a request ("09:30"). TWAP's strategyType is refused (443 "Unknown algo attribute"), so it is
 * not offered; IB algos only work in regular hours (201 for outside RTH).
 */
export const ALGOS: readonly AlgoInfo[] = [
  { strategy: 'Adaptive', secTypes: ['STK', 'OPT', 'FUT'], params: [{ tag: 'adaptivePriority', kind: 'choice', options: ['Patient', 'Normal', 'Urgent'], required: true }] },
  { strategy: 'Vwap', secTypes: ['STK'], params: [P.maxPctVol, P.start, P.end, P.pastEnd, P.noTakeLiq, { tag: 'speedUp', kind: 'switch' }] },
  { strategy: 'Twap', secTypes: ['STK'], params: [P.start, P.end, P.pastEnd] },
  { strategy: 'ArrivalPx', secTypes: ['STK'], params: [P.maxPctVol, P.risk, P.start, P.end, P.pastEnd, P.force] },
  { strategy: 'ClosePx', secTypes: ['STK'], params: [P.maxPctVol, P.risk, P.start, P.force] },
  { strategy: 'PctVol', secTypes: ['STK'], params: [P.pctVol, P.start, P.end, P.noTakeLiq] },
  {
    strategy: 'PctVolPx',
    secTypes: ['STK'],
    params: [
      P.pctVol,
      { tag: 'deltaPctVol', kind: 'fraction', min: 0.01, max: 0.5 },
      { tag: 'minPctVol4Px', kind: 'fraction', min: 0.01, max: 0.5 },
      { tag: 'maxPctVol4Px', kind: 'fraction', min: 0.01, max: 0.5 },
      P.start,
      P.end,
      P.noTakeLiq,
    ],
  },
  {
    strategy: 'PctVolSz',
    secTypes: ['STK'],
    params: [{ tag: 'startPctVol', kind: 'fraction', min: 0.01, max: 0.5, required: true }, { tag: 'endPctVol', kind: 'fraction', min: 0.01, max: 0.5, required: true }, P.start, P.end, P.noTakeLiq],
  },
  {
    strategy: 'PctVolTm',
    secTypes: ['STK'],
    params: [{ tag: 'startPctVol', kind: 'fraction', min: 0.01, max: 0.5, required: true }, { tag: 'endPctVol', kind: 'fraction', min: 0.01, max: 0.5, required: true }, P.start, P.end, P.noTakeLiq],
  },
  { strategy: 'DarkIce', secTypes: ['STK'], params: [{ tag: 'displaySize', kind: 'integer', min: 1, required: true }, P.start, P.end, P.pastEnd] },
  {
    // Accumulate / distribute. IB wants its active times as "HH:MM:SS" UTC (10315 otherwise).
    strategy: 'AD',
    secTypes: ['STK'],
    params: [
      { tag: 'componentSize', kind: 'integer', min: 1, required: true },
      { tag: 'timeBetweenOrders', kind: 'integer', min: 1, required: true },
      { tag: 'randomizeTime20', kind: 'switch' },
      { tag: 'randomizeSize55', kind: 'switch' },
      { tag: 'giveUp', kind: 'integer', min: 0 },
      { tag: 'catchUp', kind: 'switch' },
      { tag: 'waitForFill', kind: 'switch' },
      { tag: 'activeTimeStart', kind: 'time' },
      { tag: 'activeTimeEnd', kind: 'time' },
    ],
  },
  { strategy: 'MinImpact', secTypes: ['OPT'], params: [P.maxPctVol] },
  { strategy: 'BalanceImpactRisk', secTypes: ['OPT'], params: [P.maxPctVol, P.risk, P.force] },
];

export const algoInfo = (s: string): AlgoInfo | undefined => ALGOS.find((a) => a.strategy === s);
/** Algos are placed on market and limit orders. */
export const ALGO_ORDER_TYPES: readonly OrderType[] = ['LMT', 'MKT'];
/** Algo parameters whose times IB takes in UTC without a date. */
export const UTC_TIME_PARAMS: ReadonlySet<string> = new Set(['activeTimeStart', 'activeTimeEnd']);

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** The first parameter of an algo that is missing or out of range, or null. */
export function algoParamProblem(algo: AlgoSpec): string | null {
  const info = algoInfo(algo.strategy);
  if (!info) return null;
  for (const p of info.params) {
    const v = algo.params[p.tag];
    if (v == null || v === '') {
      if (p.required) return p.tag;
      continue;
    }
    if (!algoParamValid(p, v)) return p.tag;
  }
  return null;
}

function algoParamValid(p: AlgoParam, v: AlgoParamValue): boolean {
  switch (p.kind) {
    case 'switch':
      return typeof v === 'boolean';
    case 'choice':
      return typeof v === 'string' && !!p.options?.includes(v);
    case 'time':
      return typeof v === 'string' && HHMM.test(v);
    case 'fraction':
    case 'integer': {
      const n = typeof v === 'number' ? v : Number.NaN;
      if (!Number.isFinite(n) || (p.kind === 'integer' && !Number.isInteger(n))) return false;
      return (p.min == null || n >= p.min) && (p.max == null || n <= p.max);
    }
  }
}

// ---------------------------------------------------------------------------
// Problems

export type OrderProblem =
  // prices
  | 'limitPrice'
  | 'stopPrice'
  | 'trailAmount'
  | 'trailStop'
  | 'limitOffset'
  | 'offset'
  | 'percentOffset'
  // order type
  | 'typeInstrument'
  | 'typeContract'
  | 'typeSession'
  | 'typeTif'
  // attributes
  | 'aonInstrument'
  | 'aonSession'
  | 'aonIceberg'
  | 'aonAlgo'
  | 'minQty'
  | 'minQtyInstrument'
  | 'hiddenInstrument'
  | 'hiddenIceberg'
  | 'hiddenTif'
  | 'sweepInstrument'
  | 'sweepType'
  | 'sweepSession'
  | 'discretionaryAmt'
  | 'discretionaryType'
  | 'discretionaryInstrument'
  | 'discretionaryIceberg'
  | 'discretionarySession'
  | 'icebergType'
  | 'icebergRoute'
  | 'triggerType'
  | 'triggerInstrument'
  | 'attributeContract'
  // algos
  | 'algoUnknown'
  | 'algoInstrument'
  | 'algoType'
  | 'algoSession'
  | 'algoRoute'
  | 'algoParam'
  | 'algoAttribute'
  | 'algoTif'
  | 'algoGoodAfter'
  // conditions
  | 'conditionBoth'
  | 'conditionCount'
  | 'conditionType'
  | 'conditionCancelType'
  | 'conditionValue'
  // linked orders
  | 'bracketStopType'
  | 'bracketStopFields'
  | 'bracketTrailParent'
  | 'adjustType'
  | 'adjustFields'
  | 'ocaGroup'
  | 'ocaBracket'
  | 'ocaCombo'
  // routing, combos, cash quantity
  | 'routeInstrument'
  | 'routeName'
  | 'routeExchange'
  | 'routeSession'
  | 'routeType'
  | 'nonGuaranteedInstrument'
  | 'cashQtyInstrument'
  | 'cashQtyType'
  | 'cashQtyQuantity'
  | 'cashQtyBracket'
  | 'orderRef';

/** The choices of the ticket a problem depends on: changing any of them can resolve it. */
export type OrderField =
  | 'prices'
  | 'orderType'
  | 'tif'
  | 'session'
  | 'bracket'
  | 'iceberg'
  | 'conditions'
  | 'allOrNone'
  | 'minQty'
  | 'hidden'
  | 'sweepToFill'
  | 'discretionary'
  | 'triggerMethod'
  | 'adjustStop'
  | 'algo'
  | 'oca'
  | 'route'
  | 'nonGuaranteed'
  | 'cashQty'
  | 'goodAfter';

const INVOLVES: Record<OrderProblem, readonly OrderField[]> = {
  limitPrice: ['prices'],
  stopPrice: ['prices'],
  trailAmount: ['prices'],
  trailStop: ['prices'],
  limitOffset: ['prices'],
  offset: ['prices'],
  percentOffset: ['prices'],
  typeInstrument: ['orderType'],
  typeContract: ['orderType'],
  typeSession: ['orderType', 'session'],
  typeTif: ['orderType', 'tif'],
  aonInstrument: ['allOrNone'],
  aonSession: ['allOrNone', 'session'],
  aonIceberg: ['allOrNone', 'iceberg'],
  aonAlgo: ['allOrNone', 'algo'],
  minQty: ['minQty'],
  minQtyInstrument: ['minQty'],
  hiddenInstrument: ['hidden'],
  hiddenIceberg: ['hidden', 'iceberg'],
  hiddenTif: ['hidden', 'tif'],
  sweepInstrument: ['sweepToFill', 'route'],
  sweepType: ['sweepToFill', 'orderType'],
  sweepSession: ['sweepToFill', 'session'],
  discretionaryAmt: ['discretionary'],
  discretionaryType: ['discretionary', 'orderType'],
  discretionaryInstrument: ['discretionary'],
  discretionaryIceberg: ['discretionary', 'iceberg'],
  discretionarySession: ['discretionary', 'session'],
  icebergType: ['iceberg', 'orderType'],
  icebergRoute: ['iceberg', 'route'],
  triggerType: ['triggerMethod', 'orderType'],
  triggerInstrument: ['triggerMethod'],
  attributeContract: ['allOrNone', 'hidden', 'sweepToFill', 'discretionary', 'iceberg', 'oca', 'adjustStop', 'conditions'],
  algoUnknown: ['algo'],
  algoInstrument: ['algo'],
  algoType: ['algo', 'orderType'],
  algoSession: ['algo', 'session'],
  algoRoute: ['algo', 'route'],
  algoParam: ['algo'],
  algoAttribute: ['algo', 'hidden', 'sweepToFill', 'discretionary', 'iceberg', 'minQty'],
  algoTif: ['algo', 'tif'],
  algoGoodAfter: ['algo', 'goodAfter'],
  conditionBoth: ['conditions'],
  conditionCount: ['conditions'],
  conditionType: ['conditions', 'orderType'],
  conditionCancelType: ['conditions', 'orderType'],
  conditionValue: ['conditions'],
  bracketStopType: ['bracket'],
  bracketStopFields: ['bracket'],
  bracketTrailParent: ['bracket', 'orderType'],
  adjustType: ['adjustStop', 'orderType', 'bracket'],
  adjustFields: ['adjustStop', 'bracket'],
  ocaGroup: ['oca'],
  ocaBracket: ['oca', 'bracket'],
  ocaCombo: ['oca'],
  routeInstrument: ['route'],
  routeName: ['route'],
  routeExchange: ['route'],
  routeSession: ['route', 'session'],
  routeType: ['route', 'orderType'],
  nonGuaranteedInstrument: ['nonGuaranteed'],
  cashQtyInstrument: ['cashQty'],
  cashQtyType: ['cashQty', 'orderType'],
  cashQtyQuantity: ['cashQty'],
  cashQtyBracket: ['cashQty', 'bracket', 'iceberg'],
  orderRef: [],
};

/** What is known about the contract (ContractInfo), when it is. */
export interface OrderRulesContext {
  /** IB's codes of what the contract takes (ContractInfo.orderTypes). */
  orderTypes?: readonly string[];
  /** Exchanges the contract can be routed to (ContractInfo.validExchanges). */
  validExchanges?: readonly string[];
}

const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const nonNegative = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const INT32_MAX = 2 ** 31 - 1;
/** Free text sent to IB: no control characters (a NUL would split the field on the wire). */
const plainText = (s: string, max: number) => s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
/** Conditions per order Tape sends (IB's own limit was not reached on the paper account). */
export const MAX_CONDITIONS = 5;

/** The conditions of a request in the general form (a single price condition is converted). */
export function requestConditions(req: Pick<OrderRequest, 'condition' | 'conditions'>): OrderConditions | undefined {
  if (req.conditions?.items.length) return req.conditions;
  const c = req.condition;
  if (!c) return undefined;
  return { items: [{ kind: 'price', contract: c.contract, operator: c.operator, price: c.price }], outsideRth: c.outsideRth };
}

/** A request routed to a venue other than SMART and other than the instrument's own exchange. */
const directedRoute = (req: OrderRequest) => !!req.route && req.route !== 'SMART' && req.route !== req.contract.exchange;
const hasBracket = (req: OrderRequest) => req.bracket != null && (req.bracket.takeProfit != null || req.bracket.stopLoss != null);
const isOption = (c: Pick<ContractRef, 'secType'>) => c.secType === 'OPT' || c.secType === 'FOP';

/** Every problem of a request with these rules, most fundamental first. */
export function orderProblems(req: OrderRequest, ctx: OrderRulesContext = {}): OrderProblem[] {
  const out: OrderProblem[] = [];
  const secType = req.contract.secType;
  const type = req.orderType;
  const session = sessionOf(req);
  const codes = ctx.orderTypes?.length ? new Set(ctx.orderTypes) : null;
  const lacks = (code: string) => codes != null && !codes.has(code);

  // Prices
  const f = ORDER_TYPE_FIELDS[type] ?? F({});
  if (f.limit === 'required') {
    // Combos may be priced at zero or a credit (negative).
    if (secType === 'BAG' && type === 'LMT' ? !finite(req.limitPrice) : !positive(req.limitPrice)) out.push('limitPrice');
  } else if (f.limit === 'optional' && req.limitPrice != null && !positive(req.limitPrice)) out.push('limitPrice');
  if (f.stop === 'required' && !positive(req.stopPrice)) out.push('stopPrice');
  if (f.trail === 'required' && !positive(req.trailingPercent) && !positive(req.trailingAmount)) out.push('trailAmount');
  if ((f.trailStop === 'required' && !positive(req.trailStopPrice)) || (f.trailStop === 'optional' && req.trailStopPrice != null && !positive(req.trailStopPrice))) out.push('trailStop');
  if (f.limitOffset === 'required' && !finite(req.limitOffset)) out.push('limitOffset');
  if (f.offset !== 'none') {
    if (type === 'REL' && req.percentOffset != null) {
      // IB: 0 to 100 (159); the offset amount is not sent with it.
      if (!(positive(req.percentOffset) && req.percentOffset <= 100) || req.offset != null) out.push('percentOffset');
    } else if (f.offset === 'required' ? !nonNegative(req.offset) : req.offset != null && !nonNegative(req.offset)) out.push('offset');
  } else if (req.percentOffset != null) out.push('percentOffset');

  // Order type
  if (!(ORDER_TYPE_SEC_TYPES[type] ?? []).includes(secType)) out.push('typeInstrument');
  else if (lacks(TYPE_CODE[type])) out.push('typeContract');
  if (REGULAR_HOURS_TYPES.includes(type) && session === 'extended') out.push('typeSession');
  if (DAY_ONLY_TYPES.includes(type) && req.tif !== 'DAY') out.push('typeTif');

  // Fill attributes
  if (req.allOrNone) {
    // IB refuses AON for futures and combos (10257), in the overnight sessions (201 / 10257), with
    // an iceberg (201 "Iceberg order cannot be a AON variant") and with an IB algo (10257).
    if (!(secType === 'STK' || isOption(req.contract))) out.push('aonInstrument');
    else if (lacks('AON')) out.push('attributeContract');
    if (isOvernight(session)) out.push('aonSession');
    if (req.displaySize) out.push('aonIceberg');
    if (req.algo) out.push('aonAlgo');
  }
  if (req.minQty != null && req.minQty !== 0) {
    // Stocks and futures refused a minimum quantity at any size (10256); options take it.
    if (!isOption(req.contract)) out.push('minQtyInstrument');
    if (!(Number.isInteger(req.minQty) && req.minQty > 0 && req.minQty <= req.quantity)) out.push('minQty');
  }
  if (req.hidden) {
    if (secType !== 'STK') out.push('hiddenInstrument');
    else if (lacks('HID')) out.push('attributeContract');
    if (req.displaySize) out.push('hiddenIceberg'); // 10255
    // 201 "Only DAY/LIMIT allowed for hidden order" (GTC and GTD were accepted).
    if (req.tif === 'OPG') out.push('hiddenTif');
  }
  if (req.sweepToFill) {
    // US stocks via SMART only (131; options: 10267).
    if (secType !== 'STK' || directedRoute(req)) out.push('sweepInstrument');
    else if (lacks('SWEEP')) out.push('attributeContract');
    if (type !== 'LMT') out.push('sweepType');
    // Overnight: 10267; overnight + day: 201 "not supported for this combination".
    if (isOvernight(session)) out.push('sweepSession');
  }
  if (req.discretionaryAmt != null && req.discretionaryAmt !== 0) {
    if (!positive(req.discretionaryAmt)) out.push('discretionaryAmt');
    if (type !== 'LMT') out.push('discretionaryType');
    if (!(secType === 'STK' || secType === 'OPT')) out.push('discretionaryInstrument');
    else if (lacks('DIS')) out.push('attributeContract');
    // Options: IB refuses more than 10 % of the limit price (201).
    else if (secType === 'OPT' && positive(req.limitPrice) && positive(req.discretionaryAmt) && req.discretionaryAmt > req.limitPrice * 0.1 + 1e-9) out.push('discretionaryAmt');
    if (req.displaySize) out.push('discretionaryIceberg'); // 157
    // Overnight + day: 201; the OVERNIGHT venue drops the amount without a word.
    if (isOvernight(session)) out.push('discretionarySession');
  }
  if (req.displaySize) {
    if (!ICEBERG_TYPES.includes(type)) out.push('icebergType');
    if (secType === 'STK' && directedRoute(req)) out.push('icebergRoute'); // 10255
    if (lacks('ICE')) out.push('attributeContract');
  }
  if (req.triggerMethod) {
    if (!TRIGGER_ORDER_TYPES.includes(type)) out.push('triggerType');
    if (!triggerMethodsFor(secType).includes(req.triggerMethod)) out.push('triggerInstrument');
  }

  // Algos
  if (req.algo) {
    const info = algoInfo(req.algo.strategy);
    if (!info) out.push('algoUnknown');
    else {
      if (!info.secTypes.includes(secType)) out.push('algoInstrument');
      else if (lacks('ALGO') || (req.algo.strategy === 'AD' && lacks('AD'))) out.push('attributeContract');
      if (!ALGO_ORDER_TYPES.includes(type)) out.push('algoType');
      if (algoParamProblem(req.algo)) out.push('algoParam');
    }
    // 201 "Only RTH orders are allowed for IB algorithmic orders".
    if (session !== 'regular') out.push('algoSession');
    if (directedRoute(req)) out.push('algoRoute');
    // Hidden 152; sweep and discretionary 201 "not supported for IB algorithmic orders"; display
    // size 10255 and minimum quantity 10256.
    if (req.hidden || req.sweepToFill || (req.discretionaryAmt != null && req.discretionaryAmt !== 0) || req.displaySize || (req.minQty != null && req.minQty !== 0)) out.push('algoAttribute');
    // DAY only, GTC also for Adaptive and AD (201 "GTC orders are not allowed for X IB algorithmic
    // orders", "Good-until orders are not allowed", IOC "Only RTH orders", OPG "invalid").
    if (!(req.tif === 'DAY' || (req.tif === 'GTC' && (req.algo.strategy === 'Adaptive' || req.algo.strategy === 'AD')))) out.push('algoTif');
    // 201 "Good-after orders are not allowed for … IB algorithmic orders".
    if (req.goodAfterTime) out.push('algoGoodAfter');
  }

  // Conditions
  const conds = requestConditions(req);
  if (req.condition && req.conditions?.items.length) out.push('conditionBoth');
  if (conds) {
    if (conds.items.length > MAX_CONDITIONS) out.push('conditionCount');
    if (lacks('COND')) out.push('attributeContract');
    if (conds.cancel ? !CONDITION_CANCEL_TYPES.includes(type) : !CONDITION_SUBMIT_TYPES.includes(type)) out.push(conds.cancel ? 'conditionCancelType' : 'conditionType');
    if (conds.items.some((c) => !conditionValid(c))) out.push('conditionValue');
  } else if (req.conditions && !req.conditions.items.length) out.push('conditionCount');

  // Linked orders
  if (hasBracket(req)) {
    const b = req.bracket!;
    const stopType = b.stopType ?? 'STP';
    if (!STOP_LOSS_TYPES.includes(stopType)) out.push('bracketStopType');
    else if (b.stopLoss != null && !bracketStopValid(b)) out.push('bracketStopFields');
    // 328 "Trailing stop orders can be attached to limit or stop-limit orders only".
    if (b.stopLoss != null && (stopType === 'TRAIL' || stopType === 'TRAIL LIMIT') && type !== 'LMT' && type !== 'STP LMT') out.push('bracketTrailParent');
    if (b.adjust) {
      if (b.stopLoss == null || !ADJUSTABLE_TYPES.includes(stopType)) out.push('adjustType');
      else if (lacks('ADJUST')) out.push('attributeContract');
      if (!adjustValid(b.adjust, req.action === 'BUY' ? 'SELL' : 'BUY', b.stopLoss)) out.push('adjustFields');
    }
  } else if (req.bracket?.adjust) out.push('adjustType');
  if (req.adjustStop) {
    if (!ADJUSTABLE_TYPES.includes(type)) out.push('adjustType');
    else if (lacks('ADJUST')) out.push('attributeContract');
    if (!adjustValid(req.adjustStop, req.action, type === 'TRAIL' ? req.trailStopPrice : req.stopPrice)) out.push('adjustFields');
  }
  if (req.oca) {
    if (!req.oca.group.trim() || !plainText(req.oca.group, 64) || ![1, 2, 3].includes(req.oca.type)) out.push('ocaGroup');
    else if (lacks('OCA')) out.push('attributeContract');
    // The bracket's children are an OCA group of their own.
    if (hasBracket(req)) out.push('ocaBracket');
    // Combos only take type 3 (359).
    if (secType === 'BAG' && req.oca.type !== 3) out.push('ocaCombo');
  }

  // Routing, combos, cash quantity (a route to the instrument's own exchange is no directed route:
  // stocks IB does not reach through SMART are traded there)
  if (directedRoute(req)) {
    const route = req.route!;
    if (secType !== 'STK') out.push('routeInstrument');
    else if (!/^[A-Z][A-Z0-9.]*$/.test(route) || route === 'OVERNIGHT') out.push('routeName');
    else if (ctx.validExchanges?.length && !ctx.validExchanges.includes(route)) out.push('routeExchange');
    if (isOvernight(session)) out.push('routeSession');
    if (!ROUTE_TYPES.includes(type)) out.push('routeType');
  }
  if (req.nonGuaranteed && secType !== 'BAG') out.push('nonGuaranteedInstrument');
  if (req.cashQty != null) {
    // IB takes cash quantities through the API for forex only (stocks: 10244).
    if (secType !== 'CASH') out.push('cashQtyInstrument');
    if (type !== 'LMT' && type !== 'MKT') out.push('cashQtyType');
    if (!positive(req.cashQty) || req.quantity !== 0) out.push('cashQtyQuantity');
    if (hasBracket(req) || req.displaySize) out.push('cashQtyBracket');
  }
  if (req.orderRef != null && !plainText(req.orderRef, 128)) out.push('orderRef');
  return out;
}

function conditionValid(c: OrderConditionItem): boolean {
  if (c.join != null && c.join !== 'and' && c.join !== 'or') return false;
  switch (c.kind) {
    case 'price':
      return finite(c.price) && c.price > 0 && (c.triggerMethod == null || triggerMethodsFor(c.contract.secType).includes(c.triggerMethod));
    case 'time':
      // IB takes "after" only (201 "Invalid conditional order" for before).
      return /^\d{8} \d{2}:\d{2}:\d{2} [A-Za-z][A-Za-z0-9/_+-]*$/.test(c.time) || /^\d{8}-\d{2}:\d{2}:\d{2}$/.test(c.time);
    case 'percentChange':
      return finite(c.percent) && c.percent !== 0;
    case 'volume':
      // The volume is an int on the wire (320 "Unable to parse field" beyond).
      return Number.isInteger(c.volume) && c.volume > 0 && c.volume <= INT32_MAX;
    case 'margin':
      return Number.isInteger(c.percent) && c.percent >= 0 && c.percent <= 100;
    case 'execution':
      return /^[A-Za-z0-9. /-]{1,20}$/.test(c.symbol) && !!c.symbol.trim() && !!c.secType;
    default:
      return false;
  }
}

function bracketStopValid(b: NonNullable<OrderRequest['bracket']>): boolean {
  if (!positive(b.stopLoss)) return false;
  switch (b.stopType ?? 'STP') {
    case 'STP':
      return true;
    case 'STP LMT':
      return positive(b.stopLimit);
    case 'TRAIL':
      return positive(b.stopTrailAmount) !== positive(b.stopTrailPercent);
    case 'TRAIL LIMIT':
      return positive(b.stopTrailAmount) !== positive(b.stopTrailPercent) && finite(b.stopLimitOffset);
  }
}

/**
 * An adjustable stop of a `stopAction` stop (SELL protects a long position) at `stop`: the fields
 * its new type needs, and a trigger on the profitable side of the stop (IB 362–364).
 */
function adjustValid(a: AdjustedStop, stopAction: 'BUY' | 'SELL', stop: number | undefined): boolean {
  if (!positive(a.trigger)) return false;
  if (positive(stop) && (stopAction === 'SELL' ? a.trigger <= stop : a.trigger >= stop)) return false;
  switch (a.type) {
    case 'STP':
      return positive(a.stopPrice);
    case 'STP LMT':
      return positive(a.stopPrice) && positive(a.limitPrice);
    case 'TRAIL':
      return positive(a.trailAmount) && (a.stopPrice == null || positive(a.stopPrice)) && (a.trailUnit == null || a.trailUnit === 'amount' || a.trailUnit === 'percent');
    default:
      return false;
  }
}

export function orderProblem(req: OrderRequest, ctx?: OrderRulesContext): OrderProblem | null {
  return orderProblems(req, ctx)[0] ?? null;
}

/** The problems of a request that changing `field` can resolve (the ticket greys that choice out with the first). */
export function problemsInvolving(req: OrderRequest, field: OrderField, ctx?: OrderRulesContext): OrderProblem[] {
  return orderProblems(req, ctx).filter((p) => INVOLVES[p].includes(field));
}

/** English texts of the problems (main process errors). */
export const ORDER_PROBLEM_TEXT: Readonly<Record<OrderProblem, string>> = {
  limitPrice: 'Limit price is required',
  stopPrice: 'Stop price is required',
  trailAmount: 'Trailing percent or amount is required',
  trailStop: 'This trailing order needs an initial stop price',
  limitOffset: 'This trailing order needs a limit offset',
  offset: 'This order type needs an offset of 0 or more',
  percentOffset: 'A percent offset must be between 0 and 100, without an offset amount (relative orders only)',
  typeInstrument: 'This order type is not available for this instrument',
  typeContract: 'IB does not offer this order type for this contract',
  typeSession: 'This order type works in regular trading hours only',
  typeTif: 'Market and limit on close orders are DAY orders',
  aonInstrument: 'All or none is available for stocks and options only',
  aonSession: 'The overnight sessions do not take all-or-none orders',
  aonIceberg: 'An iceberg order cannot be all or none',
  aonAlgo: 'An IB algo order cannot be all or none',
  minQty: 'Minimum quantity must be a whole number between 1 and the order quantity',
  minQtyInstrument: 'A minimum quantity is available for options only',
  hiddenInstrument: 'Hidden orders are available for stocks only',
  hiddenIceberg: 'A hidden order cannot have a display size',
  hiddenTif: 'A hidden order cannot be an opening (OPG) order',
  sweepInstrument: 'Sweep to fill is available for stocks routed through SMART only',
  sweepType: 'Sweep to fill works with limit orders only',
  sweepSession: 'The overnight sessions do not take sweep-to-fill orders',
  discretionaryAmt: 'The discretionary amount must be greater than 0 (for options at most 10% of the limit price)',
  discretionaryType: 'A discretionary amount works with limit orders only',
  discretionaryInstrument: 'A discretionary amount is available for stocks and options only',
  discretionaryIceberg: 'A discretionary order cannot have a display size',
  discretionarySession: 'The overnight sessions do not take a discretionary amount',
  icebergType: 'A display size (iceberg) works with limit orders only',
  icebergRoute: 'Directed stock orders cannot have a display size',
  triggerType: 'The trigger method applies to stop, trailing and touched orders only',
  triggerInstrument: 'This trigger method is not available for this instrument',
  attributeContract: 'IB does not offer this order attribute for this contract',
  algoUnknown: 'Unknown algo',
  algoInstrument: 'This algo is not available for this instrument',
  algoType: 'IB algos work with market and limit orders only',
  algoSession: 'IB algos work in regular trading hours only',
  algoRoute: 'IB algos are routed through SMART',
  algoParam: 'An algo parameter is missing or out of range',
  algoAttribute: 'IB algo orders cannot be hidden, sweep to fill, discretionary, iceberg or have a minimum quantity',
  algoTif: 'IB algo orders are DAY orders (Adaptive and Accumulate/distribute also GTC)',
  algoGoodAfter: 'IB algo orders cannot have a good-after time',
  conditionBoth: 'Send either a price condition or a list of conditions, not both',
  conditionCount: `An order takes 1 to ${MAX_CONDITIONS} conditions`,
  conditionType: 'Conditional orders must be market, limit, midprice, relative or snap orders',
  conditionCancelType: 'Only limit and midprice orders can be cancelled by a condition',
  conditionValue: 'A condition is incomplete or out of range',
  bracketStopType: 'Unknown stop-loss order type',
  bracketStopFields: 'The stop-loss is missing a price (stop limit: limit price; trailing: amount or percent; trailing limit: also the limit offset)',
  bracketTrailParent: 'A trailing stop-loss can only be attached to a limit or stop-limit order',
  adjustType: 'Only a stop, stop-limit or trailing stop can be adjusted',
  adjustFields: 'The adjusted stop needs a trigger price beyond the stop and the new stop’s prices',
  ocaGroup: 'A one-cancels-all group needs a name and a type (1, 2 or 3)',
  ocaBracket: 'An order with take-profit / stop-loss cannot join a one-cancels-all group',
  ocaCombo: 'Combo orders can only join a one-cancels-all group of type 3 (reduce, no block)',
  routeInstrument: 'Directed routing is available for stocks only',
  routeName: 'Unknown exchange',
  routeExchange: 'The contract cannot be routed to this exchange',
  routeSession: 'The overnight sessions are routed by IB',
  routeType: 'Directed orders must be market, limit, stop or stop-limit orders',
  nonGuaranteedInstrument: 'Non-guaranteed routing applies to combos only',
  cashQtyInstrument: 'IB takes a cash quantity through the API for forex only',
  cashQtyType: 'A cash quantity works with market and limit orders only',
  cashQtyQuantity: 'With a cash quantity, the amount must be greater than 0 and the quantity 0',
  cashQtyBracket: 'An order sized by cash cannot have take-profit / stop-loss or a display size',
  orderRef: 'The note must be at most 128 characters, without control characters',
};

export const isOrderProblem = (s: string): s is OrderProblem => Object.hasOwn(ORDER_PROBLEM_TEXT, s);

/** The text of a request's first problem, naming the algo parameter where one is the problem. */
export function orderProblemText(req: OrderRequest, p: OrderProblem): string {
  if (p === 'algoParam' && req.algo) return `${ORDER_PROBLEM_TEXT.algoParam}: ${algoParamProblem(req.algo)}`;
  return ORDER_PROBLEM_TEXT[p];
}

// ---------------------------------------------------------------------------
// Modifying a working order

/**
 * What IB does not change on a working order. The session and TIF rules are in orderTiming.ts
 * (tifChangeAllowed); these are the others the paper account showed: an algo cannot be dropped
 * or changed (440) nor added (439), only its parameters change; an OCA group or type cannot be
 * changed or added (10326 / 10327); conditions cannot be added or removed, nor switched between
 * submit and cancel (IB answers nothing and keeps the order as it was), only their values change;
 * the venue cannot change (105). The instrument, side and order type stay too.
 */
export type ModifyProblem =
  | 'contract'
  | 'action'
  | 'orderType'
  | 'algo'
  | 'oca'
  | 'conditions'
  | 'route'
  | 'nonGuaranteed'
  | 'triggerMethod'
  | 'sweepToFill'
  | 'offsetMode'
  | 'cashQty'
  | 'clearAttribute';

export const MODIFY_PROBLEM_TEXT: Readonly<Record<ModifyProblem, string>> = {
  contract: 'cannot change its instrument',
  action: 'cannot change between buy and sell',
  orderType: 'cannot change its order type',
  algo: 'cannot add, remove or change its algo (only the algo’s parameters change)',
  oca: 'cannot join, leave or change a one-cancels-all group',
  conditions: 'cannot add or remove conditions, or switch between submit and cancel (only their values change)',
  route: 'cannot change its destination',
  nonGuaranteed: 'cannot change between guaranteed and non-guaranteed routing',
  triggerMethod: 'cannot change its trigger method',
  sweepToFill: 'cannot switch sweep to fill on or off',
  offsetMode: 'cannot change between a percent and an amount offset',
  cashQty: 'is sized by cash amount and cannot be modified through the API',
  clearAttribute: 'cannot drop its discretionary amount, good-after time or note',
};

const sameContract = (a: ContractRef, b: ContractRef) =>
  a.conId && b.conId ? a.conId === b.conId : a.symbol === b.symbol && a.secType === b.secType && (a.lastTradeDate ?? '') === (b.lastTradeDate ?? '') && (a.strike ?? 0) === (b.strike ?? 0) && (a.right ?? '') === (b.right ?? '');

/** What IB keeps of a working order's conditions: their kinds, operators and joins, and the mode. */
const conditionShape = (c: OrderConditions | undefined) => {
  if (!c?.items.length) return '';
  const n = c.items.length;
  const item = (i: OrderConditionItem, k: number) => `${i.kind}${'operator' in i ? i.operator : ''}${k < n - 1 ? (i.join ?? 'and') : ''}`;
  return `${c.cancel ? 'cancel' : 'submit'}:${c.items.map(item).join(',')}`;
};

/** The changes IB would refuse (or silently ignore) when `existing` is modified to `req`. */
export function modifyProblems(existing: WorkingOrder, req: OrderRequest): ModifyProblem[] {
  const out: ModifyProblem[] = [];
  if (existing.contract.secType !== 'BAG' && !sameContract(existing.contract, req.contract)) out.push('contract');
  if (existing.action !== req.action) out.push('action');
  if (existing.orderType !== req.orderType) out.push('orderType');
  if ((existing.algo?.strategy ?? '') !== (req.algo?.strategy ?? '')) out.push('algo');
  if ((existing.oca?.group ?? '') !== (req.oca?.group ?? '') || (existing.oca?.type ?? 0) !== (req.oca?.type ?? 0)) out.push('oca');
  const had = existing.conditions ?? (existing.condition ? { items: [{ kind: 'price' as const, operator: existing.condition.operator }], outsideRth: existing.condition.outsideRth } : undefined);
  if (conditionShape(had as OrderConditions | undefined) !== conditionShape(requestConditions(req))) out.push('conditions');
  if ((existing.route ?? 'SMART') !== (req.route ?? 'SMART')) out.push('route');
  if (!!existing.nonGuaranteed !== !!req.nonGuaranteed) out.push('nonGuaranteed');
  // The paper account: IB keeps the trigger method and an unchecked sweep to fill without a word,
  // and refuses checking it (201 "Revision to SweepToFill is disallowed").
  if ((existing.triggerMethod ?? 0) !== (req.triggerMethod ?? 0)) out.push('triggerMethod');
  if (!!existing.sweepToFill !== !!req.sweepToFill) out.push('sweepToFill');
  // 201 "Modify Mismatch on field # 9822".
  if (existing.orderType === 'REL' && (existing.percentOffset != null) !== (req.percentOffset != null)) out.push('offsetMode');
  // 10241 "Order Quantity is expressed in monetary terms. Modification is not supported via API".
  if (existing.cashQty != null) out.push('cashQty');
  // An empty field keeps IB's value: a discretionary amount, good-after time or note stays.
  const dropped = (has: unknown, keeps: unknown) => !!has && !keeps;
  if (dropped(existing.discretionaryAmt, req.discretionaryAmt) || dropped(existing.goodAfterTime, req.goodAfterTime) || dropped(existing.orderRef?.trim(), req.orderRef?.trim())) out.push('clearAttribute');
  return out;
}

/**
 * A modify request with the working order's attributes filled in where the request leaves them
 * out: IB replaces the whole order on a modify, so an attribute that is not sent again is turned
 * off (shown with all-or-none on the paper account). false, 0 and '' turn one off explicitly.
 * Prices, quantity, timing, iceberg and good-after time are always the request's own.
 */
export function withOrderAttributes(req: OrderRequest, existing: WorkingOrder): OrderRequest {
  const out: OrderRequest = { ...req };
  const keep = <K extends keyof OrderRequest & keyof WorkingOrder>(k: K) => {
    if (out[k] === undefined && existing[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = existing[k];
  };
  keep('allOrNone');
  keep('minQty');
  keep('hidden');
  keep('sweepToFill');
  keep('discretionaryAmt');
  keep('triggerMethod');
  keep('adjustStop');
  keep('algo');
  keep('oca');
  keep('route');
  keep('nonGuaranteed');
  keep('orderRef');
  if (!out.condition && !out.conditions && existing.conditions?.items.length) out.conditions = existing.conditions;
  return out;
}
