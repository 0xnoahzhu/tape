// Pure order ticket math: default prices, tick rounding and the values shown in the ticket.
// Kept free of React and the store so it can be unit tested.

import { stock } from '@shared/contract';
import { f2, parseNum, roundToTick, usd } from '@shared/format';
import { TRAILING_ORDER_TYPES } from '@shared/orderRules';
import type { ContractRef, OrderType } from '@shared/types';
import type { TicketState } from '../../state/store';

/** Market inputs of the ticket. Missing prices stay undefined (never invented). */
export interface TicketMarket {
  bid?: number;
  ask?: number;
  /** Best available last price (last trade, mid, mark or previous close). */
  last?: number;
  /** Last price of the price-condition reference (the underlying for options). */
  refLast?: number;
  /** Minimum tick of the condition reference; defaults to minTick. */
  refMinTick?: number;
  minTick: number;
  multiplier: number;
}

/** Values derived from the ticket state and the market. */
export interface TicketModel {
  buy: boolean;
  /** Limit price (LMT, STP LMT, LIT, LOC); the optional cap of MIDPRICE, REL and PEG MID. */
  limit?: number;
  /** Stop / trigger price (STP, STP LMT, MIT, LIT), the initial stop of trailing orders. */
  stop?: number;
  /** Parsed trail amount (percent or dollars). */
  trail?: number;
  /** TRAIL LIMIT / TRAIL LIT limit offset. */
  limitOffset?: number;
  /** REL / SNAP / PEG MID offset (an amount, or a percentage for REL in % mode). */
  offset: number;
  /** Expected execution price: drives the estimate and the bracket defaults. */
  entry?: number;
  /** quantity × entry × multiplier. */
  est?: number;
  takeProfitText: string;
  stopLossText: string;
  takeProfit?: number;
  stopLoss?: number;
  /** Distance of take-profit / stop-loss from the entry, in percent. */
  takeProfitPct?: number;
  stopLossPct?: number;
  /** Bracket stop-loss extras: STP LMT limit, trailing amount, TRAIL LIMIT offset. */
  slLimitText: string;
  slLimit?: number;
  slTrail?: number;
  slOffsetText: string;
  slOffset?: number;
  /** Adjustable stop: trigger, new stop and new limit (texts with defaults, values). */
  adjTriggerText: string;
  adjTrigger?: number;
  adjStopText: string;
  adjStop?: number;
  adjLimitText: string;
  adjLimit?: number;
  adjTrail?: number;
  /** Per condition row: the value text (a price row's default follows the reference). */
  condTexts: string[];
}

export const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

const orUndef = (n: number | null | undefined): number | undefined => (positive(n) ? n : undefined);

/** Decimals needed to show prices of an instrument: at least 2, more for sub-cent ticks. */
export function tickDecimals(minTick: number): number {
  if (!positive(minTick)) return 2;
  const d = Math.ceil(Math.round(-Math.log10(minTick) * 1e6) / 1e6);
  return Math.min(8, Math.max(2, d));
}

/** Plain price text for inputs ("1234.50", no separators). */
export function priceInput(n: number | undefined, minTick: number): string {
  return positive(n) ? n.toFixed(tickDecimals(minTick)) : '';
}

/** Display price with separators ("1,234.50") or "—". */
export function priceText(n: number | undefined, minTick: number): string {
  return f2(n, tickDecimals(minTick));
}

/** Amount in the instrument's currency: "$46,393.00" for USD, "46,393.00 EUR" otherwise. */
export function money(n: number | undefined, currency: string | undefined): string {
  return !currency || currency === 'USD' || !Number.isFinite(n) ? usd(n) : `${f2(n)} ${currency}`;
}

/**
 * Buying power left after the order. A buy subtracts the estimate, which is only possible when it
 * is in the account's currency (no FX rate is known here); otherwise undefined ("—").
 */
export function buyingPowerAfter(
  account: { buyingPower?: number; currency?: string } | null | undefined,
  est: number | undefined,
  currency: string,
  buy: boolean,
): number | undefined {
  const bp = account?.buyingPower;
  if (bp == null || !Number.isFinite(bp)) return undefined;
  if (!buy) return bp;
  if (est == null || (account?.currency || 'USD') !== (currency || 'USD')) return undefined;
  return bp - est;
}

const round = (n: number | undefined, minTick: number): number | undefined => (positive(n) ? roundToTick(n, minTick) : undefined);

/** Quantity steps from the design: ±100 at 100 and above, ±10 above 10, ±1 below. */
export function stepQty(qty: number, dir: 1 | -1): number {
  const q = Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 0;
  if (dir > 0) return q + (q >= 100 ? 100 : q >= 10 ? 10 : 1);
  return Math.max(1, q - (q > 100 ? 100 : q > 10 ? 10 : 1));
}

/** The instrument a price condition watches: the underlying stock for options, else the instrument itself. */
export function conditionContract(c: ContractRef): ContractRef {
  return c.secType === 'OPT' ? stock(c.symbol) : c;
}

/**
 * Touched orders trigger on the opposite side of the market from stops: a buy below, a sell above
 * (a stop buys above and sells below).
 */
export const isTouched = (type: OrderType): boolean => type === 'MIT' || type === 'LIT' || type === 'TRAIL MIT' || type === 'TRAIL LIT';

/** Initial stop of a trailing stop from the last price (pass !buy for a trailing touched order). */
export function trailStop(last: number | undefined, buy: boolean, mode: 'pct' | 'amt', amount: number | undefined): number | undefined {
  if (!positive(last) || !positive(amount)) return undefined;
  const dir = buy ? 1 : -1;
  const v = mode === 'pct' ? last * (1 + (dir * amount) / 100) : last + dir * amount;
  return v > 0 ? v : undefined;
}

/** Default limit offset of trailing limit orders: 0.2% of the stop, at least one tick. */
export function defaultLimitOffset(stop: number | undefined, tick: number): number {
  return positive(stop) ? Math.max(tick, roundToTick(stop * 0.002, tick)) : tick * 5;
}

export function resolveTicket(t: TicketState, mkt: TicketMarket): TicketModel {
  const buy = t.side === 'BUY';
  const tick = positive(mkt.minTick) ? mkt.minTick : 0.01;
  const last = orUndef(mkt.last);
  const bid = orUndef(mkt.bid);
  const ask = orUndef(mkt.ask);
  // The side of the book a marketable order would take, the side a passive order joins, the midpoint.
  const touch = buy ? (ask ?? last) : (bid ?? last);
  const join = buy ? (bid ?? last) : (ask ?? last);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : last;
  /** A stop beyond the market (buy above, sell below); touched orders trigger the other way. */
  const stopDefault = round(last != null ? last * (buy ? 1.01 : 0.99) : undefined, tick);
  const touchedDefault = round(last != null ? last * (buy ? 0.99 : 1.01) : undefined, tick);

  let limit: number | undefined;
  let stop: number | undefined;
  let trail: number | undefined;
  let entry: number | undefined;
  let limitOffset: number | undefined;
  const offset = typeof t.offset === 'number' && Number.isFinite(t.offset) && t.offset >= 0 ? t.offset : 0;
  switch (t.orderType) {
    case 'LMT':
      limit = orUndef(t.limitPrice) ?? round(touch, tick);
      entry = limit;
      break;
    case 'MKT':
    case 'MTL':
      entry = touch;
      break;
    case 'MOC':
      entry = last;
      break;
    case 'LOC':
      limit = orUndef(t.limitPrice) ?? round(touch, tick);
      entry = limit;
      break;
    case 'STP':
      stop = orUndef(t.stopPrice) ?? stopDefault;
      entry = stop;
      break;
    case 'STP LMT':
      stop = orUndef(t.stopPrice) ?? stopDefault;
      limit = orUndef(t.limitPrice) ?? round(stop != null ? stop * (buy ? 1.002 : 0.998) : undefined, tick);
      entry = limit;
      break;
    case 'MIT':
      stop = orUndef(t.stopPrice) ?? touchedDefault;
      entry = stop;
      break;
    case 'LIT':
      stop = orUndef(t.stopPrice) ?? touchedDefault;
      limit = orUndef(t.limitPrice) ?? round(stop != null ? stop * (buy ? 1.002 : 0.998) : undefined, tick);
      entry = limit;
      break;
    case 'TRAIL':
    case 'TRAIL LIMIT':
    case 'TRAIL MIT':
    case 'TRAIL LIT':
      trail = orUndef(parseNum(t.trailAmt));
      // A trailing touched order starts on the touched side: a buy below the market, a sell above.
      stop = orUndef(t.stopPrice) ?? round(trailStop(last, isTouched(t.orderType) ? !buy : buy, t.trailMode, trail), tick);
      entry = stop;
      if (t.orderType === 'TRAIL LIMIT' || t.orderType === 'TRAIL LIT') {
        limitOffset = t.limitOffset != null && Number.isFinite(t.limitOffset) && t.limitOffset >= 0 ? t.limitOffset : defaultLimitOffset(stop, tick);
      }
      break;
    case 'MIDPRICE':
      limit = orUndef(t.limitPrice);
      entry = mid;
      break;
    case 'REL':
      limit = orUndef(t.limitPrice);
      entry = join;
      break;
    case 'PEG MID':
      limit = orUndef(t.limitPrice);
      entry = mid;
      break;
    case 'SNAP MID':
      entry = mid;
      break;
    case 'SNAP MKT':
      entry = touch;
      break;
  }

  const qty = positive(t.qty) ? t.qty : 0;
  const est = positive(entry) && qty > 0 ? qty * entry * (positive(mkt.multiplier) ? mkt.multiplier : 1) : undefined;

  const tpDefault = round(entry != null ? entry * (buy ? 1.03 : 0.97) : undefined, tick);
  const slDefault = round(entry != null ? entry * (buy ? 0.98 : 1.02) : undefined, tick);
  const takeProfitText = t.takeProfit ?? priceInput(tpDefault, tick);
  const stopLossText = t.stopLoss ?? priceInput(slDefault, tick);
  const takeProfit = orUndef(parseNum(takeProfitText));
  const stopLoss = orUndef(parseNum(stopLossText));
  const distance = (p: number | undefined) => (p != null && entry != null ? (p / entry - 1) * 100 : undefined);

  // The stop-loss is the opposite side: a sell stop below a long entry, its limit a little lower.
  const slLimitText = t.slLimit ?? priceInput(round(stopLoss != null ? stopLoss * (buy ? 0.998 : 1.002) : undefined, tick), tick);
  const slOffsetText = t.slOffset ?? priceInput(defaultLimitOffset(stopLoss, tick), tick);

  // Adjustable stop: on the bracket's stop-loss (once price reaches +2% move it to the entry),
  // or on the order itself when it is a stop (a sell stop protects a long: trigger above it).
  const onBracket = t.bracket && t.modifyingOrderId == null;
  const stopAction = onBracket ? (buy ? 'SELL' : 'BUY') : t.side;
  const protectsLong = stopAction === 'SELL';
  const base = onBracket ? entry : stop;
  const adjTriggerText = t.adjTrigger ?? priceInput(round(base != null ? base * (protectsLong ? 1.02 : 0.98) : undefined, tick), tick);
  const adjTrigger = orUndef(parseNum(adjTriggerText));
  const adjStopDefault = onBracket ? round(entry, tick) : round(stop != null ? stop * (protectsLong ? 1.01 : 0.99) : undefined, tick);
  const adjStopText = t.adjStop ?? priceInput(adjStopDefault, tick);
  const adjStop = orUndef(parseNum(adjStopText));
  const adjLimitText = t.adjLimit ?? priceInput(round(adjStop != null ? adjStop * (protectsLong ? 0.998 : 1.002) : undefined, tick), tick);

  const refLast = orUndef(mkt.refLast);
  const refTick = positive(mkt.refMinTick) ? mkt.refMinTick : tick;
  const condTexts = t.conds.map((c) => {
    if (c.kind === 'price' && c.value == null && c.contract == null) {
      return priceInput(round(refLast != null ? refLast * (c.op === '>=' ? 1.03 : 0.97) : undefined, refTick), refTick);
    }
    return c.value ?? '';
  });

  return {
    buy,
    limit,
    stop,
    trail,
    limitOffset,
    offset,
    entry,
    est,
    takeProfitText,
    stopLossText,
    takeProfit,
    stopLoss,
    takeProfitPct: distance(takeProfit),
    stopLossPct: distance(stopLoss),
    slLimitText,
    slLimit: orUndef(parseNum(slLimitText)),
    slTrail: orUndef(parseNum(t.slTrail)),
    slOffsetText,
    slOffset: nonNegative(parseNum(slOffsetText)),
    adjTriggerText,
    adjTrigger,
    adjStopText,
    adjStop,
    adjLimitText,
    adjLimit: orUndef(parseNum(adjLimitText)),
    adjTrail: orUndef(parseNum(t.adjTrail)),
    condTexts,
  };
}

const nonNegative = (n: number): number | undefined => (Number.isFinite(n) && n >= 0 ? n : undefined);

/** Trailing order types (the trail row and its initial stop). */
export const isTrailing = (t: TicketState['orderType']): boolean => TRAILING_ORDER_TYPES.includes(t);
