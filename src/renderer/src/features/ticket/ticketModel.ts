// Pure order ticket math: default prices, tick rounding and the values shown in the ticket.
// Kept free of React and the store so it can be unit tested.

import { stock } from '@shared/contract';
import { f2, parseNum, roundToTick, usd } from '@shared/format';
import type { ContractRef } from '@shared/types';
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
  /** LMT / STP LMT limit price. */
  limit?: number;
  /** STP / STP LMT trigger price, TRAIL initial stop. */
  stop?: number;
  /** Parsed trail amount (percent or dollars). */
  trail?: number;
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
  condText: string;
  condPrice?: number;
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

/** Initial stop of a trailing order from the last price. */
export function trailStop(last: number | undefined, buy: boolean, mode: 'pct' | 'amt', amount: number | undefined): number | undefined {
  if (!positive(last) || !positive(amount)) return undefined;
  const dir = buy ? 1 : -1;
  const v = mode === 'pct' ? last * (1 + (dir * amount) / 100) : last + dir * amount;
  return v > 0 ? v : undefined;
}

export function resolveTicket(t: TicketState, mkt: TicketMarket): TicketModel {
  const buy = t.side === 'BUY';
  const tick = positive(mkt.minTick) ? mkt.minTick : 0.01;
  const last = orUndef(mkt.last);
  const bid = orUndef(mkt.bid);
  const ask = orUndef(mkt.ask);
  // The side of the book a marketable order would take.
  const touch = buy ? (ask ?? last) : (bid ?? last);

  let limit: number | undefined;
  let stop: number | undefined;
  let trail: number | undefined;
  let entry: number | undefined;
  switch (t.orderType) {
    case 'LMT':
      limit = orUndef(t.limitPrice) ?? round(touch, tick);
      entry = limit;
      break;
    case 'MKT':
      entry = touch;
      break;
    case 'STP':
      stop = orUndef(t.stopPrice) ?? round(last != null ? last * (buy ? 1.01 : 0.99) : undefined, tick);
      entry = stop;
      break;
    case 'STP LMT':
      stop = orUndef(t.stopPrice) ?? round(last != null ? last * (buy ? 1.01 : 0.99) : undefined, tick);
      limit = orUndef(t.limitPrice) ?? round(stop != null ? stop * (buy ? 1.002 : 0.998) : undefined, tick);
      entry = limit;
      break;
    case 'TRAIL':
      trail = orUndef(parseNum(t.trailAmt));
      stop = orUndef(t.stopPrice) ?? round(trailStop(last, buy, t.trailMode, trail), tick);
      entry = stop;
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

  const refLast = orUndef(mkt.refLast);
  const refTick = positive(mkt.refMinTick) ? mkt.refMinTick : tick;
  const condDefault = round(refLast != null ? refLast * (t.condOp === '>=' ? 1.03 : 0.97) : undefined, refTick);
  const condText = t.condPx ?? priceInput(condDefault, refTick);

  return {
    buy,
    limit,
    stop,
    trail,
    entry,
    est,
    takeProfitText,
    stopLossText,
    takeProfit,
    stopLoss,
    takeProfitPct: distance(takeProfit),
    stopLossPct: distance(stopLoss),
    condText,
    condPrice: orUndef(parseNum(condText)),
  };
}
