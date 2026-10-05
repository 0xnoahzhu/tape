// Builds the IB contract and order(s) for an OrderRequest: order types and their prices, time in
// force and trading session, fill attributes (all or none, minimum quantity, hidden, sweep,
// discretionary, iceberg), trigger method, IB algos, conditions, adjustable stops, OCA groups,
// directed routing, combo routing, good-after time and bracket children. Every request is checked
// against the shared rules first (shared/orderRules.ts, shared/orderTiming.ts). Pure apart from
// the TWS client's condition classes (whose strValue getter the encoder needs).

import {
  ConjunctionConnection,
  ExecutionCondition,
  MarginCondition,
  PercentChangeCondition,
  PriceCondition,
  TimeCondition,
  VolumeCondition,
  type Contract,
  type Order,
  type OrderCondition,
  type TagValue,
} from './tws';
import { algoInfo, ORDER_PROBLEM_TEXT, orderProblems, orderProblemText, requestConditions, UTC_TIME_PARAMS, type OrderProblem, type OrderRulesContext } from '@shared/orderRules';
import { NEW_YORK, parseIbDateTime, sessionOf, sessionOutsideRth, timingProblem, TIMING_PROBLEM_TEXT, zonedToUtc } from '@shared/orderTiming';
import { nyClock } from '@shared/session';
import type { AdjustedStop, AlgoSpec, OrderAction, OrderRequest } from '@shared/types';
import { toIbContract } from './ibContract';

export interface BuiltOrder {
  orderId: number;
  role: 'main' | 'takeProfit' | 'stopLoss';
  contract: Contract;
  order: Order;
}

export interface BuildOptions {
  orderId: number;
  /** Allocates ids for bracket children (called in order: take profit, stop loss). */
  nextOrderId: () => number;
  account?: string;
  /** conId of the instrument a single price condition (req.condition) watches. */
  conditionConId?: number;
  /**
   * conIds of the instruments the conditions watch, by position in requestConditions(req).items
   * (undefined for time, margin and execution conditions).
   */
  conditionConIds?: ReadonlyArray<number | undefined>;
  /** Parent of an order being modified (keeps a bracket child attached). */
  parentId?: number;
  /** What IB says the contract takes (ContractInfo), checked when known. */
  rules?: OrderRulesContext;
  now?: Date;
}

export const oppositeAction = (a: OrderAction): OrderAction => (a === 'BUY' ? 'SELL' : 'BUY');

const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Asset classes traded in whole units through the API (fractional shares: IB 10243). */
const WHOLE_UNITS = new Set(['STK', 'OPT', 'FUT', 'FOP', 'BAG', 'WAR']);

const PRICE_PROBLEMS: ReadonlySet<OrderProblem> = new Set(['limitPrice', 'stopPrice', 'trailAmount', 'trailStop', 'limitOffset', 'offset', 'percentOffset']);

/**
 * Returns a readable problem with the request, or null when it can be sent. The order type,
 * attribute and time in force rules are the ones the order ticket applies (shared/orderRules.ts,
 * shared/orderTiming.ts), checked again here so no caller can send what the ticket would not.
 */
export function validateOrderRequest(req: OrderRequest, now: number = Date.now(), ctx?: OrderRulesContext): string | null {
  const byCash = req.cashQty != null && req.quantity === 0;
  if (!byCash && !positive(req.quantity)) return 'Quantity must be greater than 0';
  if (WHOLE_UNITS.has(req.contract.secType) && !Number.isInteger(req.quantity)) return 'Quantity must be a whole number (IB takes no fractional orders through the API)';
  if (req.contract.secType === 'IND') return `${req.contract.symbol} is an index and cannot be traded`;
  if (req.contract.secType === 'BAG' && !req.contract.comboLegs?.length) return 'A combo order needs at least one leg';
  if (req.bracket) {
    if (req.bracket.takeProfit != null && !positive(req.bracket.takeProfit)) return 'Take-profit price must be greater than 0';
    if (req.bracket.stopLoss != null && !positive(req.bracket.stopLoss)) return 'Stop-loss price must be greater than 0';
  }
  if (req.condition && !positive(req.condition.price)) return 'Condition price must be greater than 0';
  if (req.displaySize != null && !(req.displaySize > 0 && req.displaySize <= req.quantity)) return 'Display size must be between 1 and the order quantity';
  if (req.goodAfterTime != null && !/^\d{1,2}:\d{2}$/.test(req.goodAfterTime.trim())) return 'Good-after time must be HH:MM';
  const problems = orderProblems(req, ctx);
  const price = problems.find((p) => PRICE_PROBLEMS.has(p));
  if (price) return ORDER_PROBLEM_TEXT[price];
  const timing = timingProblem(
    {
      contract: req.contract,
      orderType: req.orderType,
      tif: req.tif,
      session: sessionOf(req),
      bracket: req.bracket != null && (req.bracket.takeProfit != null || req.bracket.stopLoss != null),
      iceberg: !!req.displaySize,
      condition: !!requestConditions(req),
      goodAfter: !!req.goodAfterTime,
      goodTill: req.tif === 'GTD' ? parseIbDateTime(req.goodTillDate) : undefined,
    },
    now,
  );
  if (timing) return TIMING_PROBLEM_TEXT[timing];
  if (problems.length) return orderProblemText(req, problems[0]);
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function addDays(ymd: string, days: number): string {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) + days));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/**
 * "09:35" -> "20261005 09:35:00 US/Eastern": today when that time is still ahead in New York
 * on a weekday, otherwise the next weekday.
 */
export function goodAfterTime(hhmm: string, now: Date = new Date()): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Good-after time must be HH:MM');
  const h = Number(m[1]);
  const min = Number(m[2]);
  const ny = nyClock(now);
  const weekday = (w: number) => w >= 1 && w <= 5;
  let ymd = ny.ymd;
  let day = ny.weekday;
  if (!(weekday(day) && h * 60 + min > ny.minutes)) {
    do {
      ymd = addDays(ymd, 1);
      day = (day + 1) % 7;
    } while (!weekday(day));
  }
  return `${ymd} ${pad(h)}:${pad(min)}:00 US/Eastern`;
}

/**
 * The IB contract for an order. Combos (BAG) are routed through SMART with the given legs; the
 * overnight-only session routes to IB's OVERNIGHT venue, which needs the primary exchange; a
 * directed order goes to its exchange (the primary exchange is kept).
 */
export function orderContract(req: OrderRequest): Contract {
  const c = toIbContract(req.contract);
  if (sessionOf(req) === 'overnight') c.exchange = 'OVERNIGHT';
  else if (req.route && req.route !== 'SMART' && req.contract.secType !== 'BAG') c.exchange = req.route;
  return c;
}

/** Time in force and session fields, shared by an order and its bracket children. */
function timingFields(req: OrderRequest): Partial<Order> {
  const session = sessionOf(req);
  return {
    tif: req.tif as Order['tif'],
    outsideRth: sessionOutsideRth(session),
    // "OVERNIGHT + DAY": SMART with includeOvernight (server version 189+).
    ...(session === 'overnightDay' ? { includeOvernight: true } : {}),
    ...(req.tif === 'GTD' ? { goodTillDate: req.goodTillDate } : {}),
  };
}

/** Trailing amount (auxPrice) or percent, and the initial stop. */
function trailFields(percent: number | undefined, amount: number | undefined, stop: number | undefined): Partial<Order> {
  return {
    ...(positive(percent) ? { trailingPercent: percent } : { auxPrice: amount }),
    ...(positive(stop) ? { trailStopPrice: stop } : {}),
  };
}

const cap = (req: OrderRequest): Partial<Order> => (positive(req.limitPrice) ? { lmtPrice: req.limitPrice } : {});

function priceFields(req: OrderRequest): Partial<Order> {
  switch (req.orderType) {
    case 'LMT':
    case 'LOC':
      return { lmtPrice: req.limitPrice };
    case 'MKT':
    case 'MOC':
    case 'MTL':
      return {};
    case 'STP':
    case 'MIT':
      return { auxPrice: req.stopPrice };
    case 'STP LMT':
    case 'LIT':
      return { auxPrice: req.stopPrice, lmtPrice: req.limitPrice };
    case 'TRAIL':
    case 'TRAIL MIT':
      return trailFields(req.trailingPercent, req.trailingAmount, req.trailStopPrice);
    case 'TRAIL LIMIT':
    case 'TRAIL LIT':
      // Never lmtPrice as well: IB wants exactly one of them (321).
      return { ...trailFields(req.trailingPercent, req.trailingAmount, req.trailStopPrice), lmtPriceOffset: req.limitOffset };
    case 'MIDPRICE':
      return cap(req);
    case 'REL':
      return { ...(positive(req.percentOffset) ? { percentOffset: req.percentOffset } : { auxPrice: req.offset ?? 0 }), ...cap(req) };
    case 'SNAP MID':
    case 'SNAP MKT':
      return { auxPrice: req.offset ?? 0 };
    case 'PEG MID':
      return { auxPrice: req.offset ?? 0, ...cap(req) };
  }
}

/** "HH:MM" New York time today -> "HH:MM:SS" UTC (the accumulate / distribute algo's format). */
function utcTimeOf(hhmm: string, now: Date): string {
  const t = new Date(zonedToUtc(nyClock(now).ymd, hhmm.padStart(5, '0'), NEW_YORK));
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

/** Algo parameters as IB's tag / value strings: switches 1 / 0, times in New York time. */
export function algoParams(algo: AlgoSpec, now: Date = new Date()): TagValue[] {
  const info = algoInfo(algo.strategy);
  if (!info) return [];
  const out: TagValue[] = [];
  for (const p of info.params) {
    const v = algo.params[p.tag];
    if (v == null || v === '') continue;
    let value: string;
    if (p.kind === 'switch') value = v ? '1' : '0';
    else if (p.kind === 'time') value = UTC_TIME_PARAMS.has(p.tag) ? utcTimeOf(String(v), now) : `${String(v).padStart(5, '0')}:00 US/Eastern`;
    else value = String(v);
    out.push({ tag: p.tag, value });
  }
  return out;
}

/** IB's adjusted-stop fields. */
function adjustFields(a: AdjustedStop): Partial<Order> {
  const out: Partial<Order> = { triggerPrice: a.trigger, adjustedOrderType: a.type };
  if (a.stopPrice != null) out.adjustedStopPrice = a.stopPrice;
  if (a.type === 'STP LMT' && a.limitPrice != null) out.adjustedStopLimitPrice = a.limitPrice;
  if (a.type === 'TRAIL') {
    out.adjustedTrailingAmount = a.trailAmount;
    out.adjustableTrailingUnit = a.trailUnit === 'percent' ? 1 : 0;
  }
  return out;
}

/** The IB conditions of a request; conIds by position (see BuildOptions.conditionConIds). */
function conditionList(req: OrderRequest, opts: BuildOptions): Partial<Order> {
  const conds = requestConditions(req);
  if (!conds) return {};
  const n = conds.items.length;
  const conditions: OrderCondition[] = conds.items.map((c, i) => {
    // A condition's conjunction joins it with the next one.
    const conj = i < n - 1 && c.join === 'or' ? ConjunctionConnection.OR : ConjunctionConnection.AND;
    const conId = () => {
      const id = opts.conditionConIds?.[i] ?? (n === 1 ? opts.conditionConId : undefined) ?? ('contract' in c ? c.contract.conId : undefined);
      if (!id) throw new Error(`Could not resolve ${'contract' in c ? c.contract.symbol : ''} for the ${c.kind === 'price' ? 'price ' : ''}condition`);
      return id;
    };
    switch (c.kind) {
      case 'price':
        // Stocks are watched on SMART, an index or a future on its own exchange (e.g. CBOE).
        return new PriceCondition(c.price, c.triggerMethod ?? 0, conId(), c.contract.exchange || 'SMART', c.operator === '>=', conj);
      case 'time':
        return new TimeCondition(c.time, true, conj);
      case 'percentChange':
        return new PercentChangeCondition(c.percent, conId(), c.contract.exchange || 'SMART', c.operator === '>=', conj);
      case 'volume':
        // IB evaluates volume conditions on SMART.
        return new VolumeCondition(c.volume, conId(), 'SMART', c.operator === '>=', conj);
      case 'margin':
        return new MarginCondition(c.percent, c.operator === '>=', conj);
      case 'execution':
        return new ExecutionCondition('SMART', c.secType, c.symbol.trim().toUpperCase(), conj);
    }
  });
  // IB: with conditionsIgnoreRth "conditions are also valid outside regular trading hours".
  return { conditions, conditionsIgnoreRth: conds.outsideRth, conditionsCancelOrder: !!conds.cancel };
}

/** The attributes of the main order (not of bracket children: IB refuses AON on them, 10257). */
function attributeFields(req: OrderRequest, opts: BuildOptions): Partial<Order> {
  const o: Partial<Order> = {};
  if (req.displaySize) o.displaySize = req.displaySize;
  if (req.goodAfterTime) o.goodAfterTime = goodAfterTime(req.goodAfterTime, opts.now);
  if (req.allOrNone) o.allOrNone = true;
  if (req.minQty) o.minQty = req.minQty;
  if (req.hidden) o.hidden = true;
  if (req.sweepToFill) o.sweepToFill = true;
  if (req.discretionaryAmt) o.discretionaryAmt = req.discretionaryAmt;
  if (req.triggerMethod) o.triggerMethod = req.triggerMethod;
  if (req.orderRef?.trim()) o.orderRef = req.orderRef.trim();
  if (req.oca) Object.assign(o, { ocaGroup: req.oca.group.trim(), ocaType: req.oca.type });
  if (req.algo) Object.assign(o, { algoStrategy: req.algo.strategy, algoParams: algoParams(req.algo, opts.now) });
  if (req.adjustStop) Object.assign(o, adjustFields(req.adjustStop));
  if (req.nonGuaranteed && req.contract.secType === 'BAG') o.smartComboRoutingParams = [{ tag: 'NonGuaranteed', value: '1' }];
  if (req.cashQty != null) o.cashQty = req.cashQty;
  return Object.assign(o, conditionList(req, opts));
}

/** The stop-loss child's type and prices. */
function stopLossFields(b: NonNullable<OrderRequest['bracket']>, sl: number): Partial<Order> {
  switch (b.stopType ?? 'STP') {
    case 'STP':
      return { orderType: 'STP' as Order['orderType'], auxPrice: sl };
    case 'STP LMT':
      return { orderType: 'STP LMT' as Order['orderType'], auxPrice: sl, lmtPrice: b.stopLimit };
    case 'TRAIL':
      return { orderType: 'TRAIL' as Order['orderType'], ...trailFields(b.stopTrailPercent, b.stopTrailAmount, sl) };
    case 'TRAIL LIMIT':
      return { orderType: 'TRAIL LIMIT' as Order['orderType'], ...trailFields(b.stopTrailPercent, b.stopTrailAmount, sl), lmtPriceOffset: b.stopLimitOffset };
  }
}

/**
 * The order(s) to send for a request, parent first. With a bracket the parent is held
 * (transmit = false) and the last child transmits the whole group.
 */
export function buildOrders(req: OrderRequest, opts: BuildOptions): BuiltOrder[] {
  const problem = validateOrderRequest(req, (opts.now ?? new Date()).getTime(), opts.rules);
  if (problem) throw new Error(problem);
  const contract = orderContract(req);
  const common: Partial<Order> = {
    totalQuantity: req.quantity,
    ...timingFields(req),
    ...(opts.account ? { account: opts.account } : {}),
  };

  const main: Order = {
    ...common,
    action: req.action as Order['action'],
    orderType: req.orderType as Order['orderType'],
    ...priceFields(req),
    transmit: true,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...attributeFields(req, opts),
  };

  const out: BuiltOrder[] = [{ orderId: opts.orderId, role: 'main', contract, order: main }];
  const b = req.bracket;
  const tp = b?.takeProfit;
  const sl = b?.stopLoss;
  if (b && (tp != null || sl != null)) {
    const exit = oppositeAction(req.action) as Order['action'];
    if (tp != null) {
      out.push({
        orderId: opts.nextOrderId(),
        role: 'takeProfit',
        contract,
        order: { ...common, action: exit, orderType: 'LMT' as Order['orderType'], lmtPrice: tp, parentId: opts.orderId, transmit: false },
      });
    }
    if (sl != null) {
      out.push({
        orderId: opts.nextOrderId(),
        role: 'stopLoss',
        contract,
        order: { ...common, action: exit, ...stopLossFields(b, sl), ...(b.adjust ? adjustFields(b.adjust) : {}), parentId: opts.orderId, transmit: false } as Order,
      });
    }
    main.transmit = false;
    out[out.length - 1].order.transmit = true;
  }
  return out;
}

/**
 * The what-if order of a request (IB's margin and commission estimate): the main order alone,
 * transmitted (IB refuses a what-if without transmit: 321), never attached to a parent.
 */
export function buildPreviewOrder(req: OrderRequest, opts: Omit<BuildOptions, 'nextOrderId' | 'parentId'>): BuiltOrder {
  const [main] = buildOrders({ ...req, bracket: undefined }, { ...opts, nextOrderId: () => opts.orderId });
  return { ...main, order: { ...main.order, whatIf: true, transmit: true } };
}
