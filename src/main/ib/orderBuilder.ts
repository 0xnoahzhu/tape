// Builds the IB contract and order(s) for an OrderRequest: order types, time in force and
// trading session, iceberg, good-after time, price condition and bracket children. Pure apart
// from the TWS client's PriceCondition class (whose strValue getter the encoder needs).

import { ConjunctionConnection, PriceCondition, TriggerMethod, type Contract, type Order } from './tws';
import { parseIbDateTime, sessionOf, sessionOutsideRth, timingProblem, TIMING_PROBLEM_TEXT } from '@shared/orderTiming';
import { nyClock } from '@shared/session';
import type { OrderAction, OrderRequest } from '@shared/types';
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
  /** conId of the instrument a price condition watches (required with req.condition). */
  conditionConId?: number;
  /** Parent of an order being modified (keeps a bracket child attached). */
  parentId?: number;
  now?: Date;
}

export const oppositeAction = (a: OrderAction): OrderAction => (a === 'BUY' ? 'SELL' : 'BUY');

const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Returns a readable problem with the request, or null when it can be sent. The time in force and
 * session rules are the ones the order ticket applies (shared/orderTiming.ts), checked again here
 * so no caller can send what the ticket would not.
 */
export function validateOrderRequest(req: OrderRequest, now: number = Date.now()): string | null {
  if (!positive(req.quantity)) return 'Quantity must be greater than 0';
  if (req.contract.secType === 'IND') return `${req.contract.symbol} is an index and cannot be traded`;
  if (req.contract.secType === 'BAG' && !req.contract.comboLegs?.length) return 'A combo order needs at least one leg';
  switch (req.orderType) {
    case 'LMT':
      // Combos may be priced at zero or a credit (negative).
      if (req.contract.secType === 'BAG' ? !finite(req.limitPrice) : !positive(req.limitPrice)) return 'Limit price is required';
      break;
    case 'STP':
      if (!positive(req.stopPrice)) return 'Stop price is required';
      break;
    case 'STP LMT':
      if (!positive(req.stopPrice)) return 'Stop price is required';
      if (!positive(req.limitPrice)) return 'Limit price is required';
      break;
    case 'TRAIL':
      if (!positive(req.trailingPercent) && !positive(req.trailingAmount)) return 'Trailing percent or amount is required';
      break;
  }
  if (req.bracket) {
    if (req.bracket.takeProfit != null && !positive(req.bracket.takeProfit)) return 'Take-profit price must be greater than 0';
    if (req.bracket.stopLoss != null && !positive(req.bracket.stopLoss)) return 'Stop-loss price must be greater than 0';
  }
  if (req.condition && !positive(req.condition.price)) return 'Condition price must be greater than 0';
  if (req.displaySize != null && !(req.displaySize > 0 && req.displaySize <= req.quantity)) return 'Display size must be between 1 and the order quantity';
  if (req.goodAfterTime != null && !/^\d{1,2}:\d{2}$/.test(req.goodAfterTime.trim())) return 'Good-after time must be HH:MM';
  const timing = timingProblem(
    {
      contract: req.contract,
      orderType: req.orderType,
      tif: req.tif,
      session: sessionOf(req),
      bracket: req.bracket != null && (req.bracket.takeProfit != null || req.bracket.stopLoss != null),
      iceberg: !!req.displaySize,
      condition: !!req.condition,
      goodAfter: !!req.goodAfterTime,
      goodTill: req.tif === 'GTD' ? parseIbDateTime(req.goodTillDate) : undefined,
    },
    now,
  );
  if (timing) return TIMING_PROBLEM_TEXT[timing];
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
 * overnight-only session routes to IB's OVERNIGHT venue, which needs the primary exchange.
 */
export function orderContract(req: OrderRequest): Contract {
  const c = toIbContract(req.contract);
  if (sessionOf(req) === 'overnight') c.exchange = 'OVERNIGHT';
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

function priceFields(req: OrderRequest): Partial<Order> {
  switch (req.orderType) {
    case 'LMT':
      return { lmtPrice: req.limitPrice };
    case 'STP':
      return { auxPrice: req.stopPrice };
    case 'STP LMT':
      return { auxPrice: req.stopPrice, lmtPrice: req.limitPrice };
    case 'TRAIL':
      return {
        ...(positive(req.trailingPercent) ? { trailingPercent: req.trailingPercent } : { auxPrice: req.trailingAmount }),
        ...(positive(req.trailStopPrice) ? { trailStopPrice: req.trailStopPrice } : {}),
      };
    default:
      return {};
  }
}

/**
 * The order(s) to send for a request, parent first. With a bracket the parent is held
 * (transmit = false) and the last child transmits the whole group.
 */
export function buildOrders(req: OrderRequest, opts: BuildOptions): BuiltOrder[] {
  const problem = validateOrderRequest(req, (opts.now ?? new Date()).getTime());
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
  };
  if (req.displaySize) main.displaySize = req.displaySize;
  if (req.goodAfterTime) main.goodAfterTime = goodAfterTime(req.goodAfterTime, opts.now);
  if (req.condition) {
    if (!opts.conditionConId) throw new Error(`Could not resolve ${req.condition.contract.symbol} for the price condition`);
    const isMore = req.condition.operator === '>=';
    main.conditions = [new PriceCondition(req.condition.price, TriggerMethod.Default, opts.conditionConId, 'SMART', isMore, ConjunctionConnection.AND)];
    // IB: "conditions are also valid outside regular trading hours" when true.
    main.conditionsIgnoreRth = req.condition.outsideRth;
    main.conditionsCancelOrder = false;
  }

  const out: BuiltOrder[] = [{ orderId: opts.orderId, role: 'main', contract, order: main }];
  const tp = req.bracket?.takeProfit;
  const sl = req.bracket?.stopLoss;
  if (req.bracket && (tp != null || sl != null)) {
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
        order: { ...common, action: exit, orderType: 'STP' as Order['orderType'], auxPrice: sl, parentId: opts.orderId, transmit: false },
      });
    }
    main.transmit = false;
    out[out.length - 1].order.transmit = true;
  }
  return out;
}
