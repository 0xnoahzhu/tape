// The Last column of the open-order lists (Portfolio › Orders, the Trade page's activity panel):
// which quotes the listed orders need, the price shown for each order's instrument, and how far
// the order's limit or trigger is from it.

import { useMemo } from 'react';
import { contractKey } from '@shared/contract';
import { DASH, pct, px } from '@shared/format';
import type { ContractRef, Quote, WorkingOrder } from '@shared/types';
import { lastPrice, useQuoteSubscriptions, useQuotesByKey } from '../../hooks/useQuotes';
import { markOf } from '../options/chain';
import { priceOrUndefined } from './model';

/** Quote owner of Portfolio › Orders (main process: a visible owner). */
export const ORDERS_QUOTE_OWNER = 'orders';
/** Quote owner of the activity panel's Open orders tab (main process: a visible owner). */
export const SYMBOL_ORDERS_QUOTE_OWNER = 'symbol-orders';

/**
 * The contract an order's quote line is requested for: the order's own instrument (an option's own
 * quote, a combo's combo quote, a currency pair's rate). openOrder reports the exchange; a contract
 * without one gets IB's venue for quotes. Null for a combo without legs, which cannot be quoted.
 */
export function orderQuoteContract(c: ContractRef): ContractRef | null {
  if (!c.symbol || !c.secType) return null;
  if (c.secType === 'BAG' && !c.comboLegs?.length) return null;
  if (c.exchange && c.currency) return c;
  return { ...c, exchange: c.exchange || (c.secType === 'CASH' ? 'IDEALPRO' : 'SMART'), currency: c.currency || 'USD' };
}

/** The distinct instruments of the orders (one quote line each), in list order. */
export function orderQuoteContracts(orders: readonly WorkingOrder[]): ContractRef[] {
  const seen = new Set<string>();
  const out: ContractRef[] = [];
  for (const o of orders) {
    const c = orderQuoteContract(o.contract);
    if (!c) continue;
    const key = contractKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The price the Last column shows for an instrument. Options at IB's mark, else the bid / ask
 * midpoint (their last trade is often hours old: options/chain.ts → markOf), else their last trade.
 * A combo quotes net prices, which may be zero or negative: its bid / ask midpoint, else its last.
 * Everything else: the last trade, else the midpoint, the mark or the previous close (lastPrice).
 */
export function orderLastPrice(c: Pick<ContractRef, 'secType'>, q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (c.secType === 'BAG') {
    if (finite(q.bid) && finite(q.ask)) return (q.bid + q.ask) / 2;
    return finite(q.last) ? q.last : undefined;
  }
  if (c.secType === 'OPT' || c.secType === 'FOP') return markOf(q) ?? lastPrice(q);
  return lastPrice(q);
}

/** Text of the Last column: the price as the order price beside it is written, "—" without a quote. */
export function lastPriceText(last: number | undefined): string {
  return last == null ? DASH : px(last);
}

export type OrderPriceKind = 'limit' | 'trigger';

/**
 * The order price that is compared with the last: the trigger of stop, if-touched and trailing
 * orders (the current stop of a trailing one), the limit of limit orders. Null for market orders
 * and for orders priced by an offset (relative, pegged, snap, midprice), which follow the market.
 */
export function orderReferencePrice(o: WorkingOrder): { kind: OrderPriceKind; price: number } | null {
  const lmt = priceOrUndefined(o.limitPrice);
  const aux = priceOrUndefined(o.auxPrice);
  const of = (kind: OrderPriceKind, price: number | undefined) => (price == null ? null : { kind, price });
  switch (o.orderType) {
    case 'LMT':
    case 'LOC':
      return of('limit', lmt);
    case 'STP':
    case 'STP LMT':
    case 'MIT':
    case 'LIT':
      return of('trigger', aux);
    default:
      return o.orderType.startsWith('TRAIL') ? of('trigger', priceOrUndefined(o.trailStopPrice)) : null;
  }
}

/**
 * How far the order's limit or trigger is from the last price, in percent of the last (−0.43: the
 * order price is 0.43% below it). Null without either price, or when one is not positive (a combo's
 * net price), where a percentage means nothing.
 */
export function distanceFromLast(o: WorkingOrder, last: number | undefined): { kind: OrderPriceKind; pct: number } | null {
  const ref = orderReferencePrice(o);
  if (!ref || !finite(last) || last <= 0 || ref.price <= 0) return null;
  return { kind: ref.kind, pct: ((ref.price - last) / last) * 100 };
}

export interface FromLastLabels {
  /** Receives the signed percent: "Limit −0.43% from last". */
  limitFromLast: (d: string) => string;
  triggerFromLast: (d: string) => string;
}

/** "Limit −0.43% from last", or '' when there is no distance to state. */
export function distanceText(o: WorkingOrder, last: number | undefined, m: FromLastLabels): string {
  const d = distanceFromLast(o, last);
  if (!d) return '';
  return (d.kind === 'limit' ? m.limitFromLast : m.triggerFromLast)(pct(d.pct));
}

/**
 * Tooltip of a Last cell: the price in full (a narrow cell cuts it) and the order's distance from it
 * ("23,012.25 · Limit −0.43% from last"); without a price, the line's error.
 */
export function lastCellTitle(o: WorkingOrder, last: number | undefined, q: Quote | undefined, m: FromLastLabels): string | undefined {
  if (last == null) return q?.error?.message || undefined;
  return [px(last), distanceText(o, last, m)].filter(Boolean).join(' · ');
}

/**
 * Subscribes the quotes of the listed orders' instruments under `owner` while mounted (pass [] when
 * the list is not shown: nothing is subscribed without orders) and returns them by contract key.
 * Instruments another owner already quotes share its line.
 */
export function useOrderQuotes(owner: string, orders: readonly WorkingOrder[]): Record<string, Quote> {
  const contracts = useMemo(() => orderQuoteContracts(orders), [orders]);
  useQuoteSubscriptions(owner, contracts, 'basic');
  const keys = useMemo(() => contracts.map((c) => contractKey(c)), [contracts]);
  return useQuotesByKey(keys);
}
