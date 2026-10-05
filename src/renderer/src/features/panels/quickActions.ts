// The floating ticket's quick actions (features/panels/TicketFloat): quantity chips, the position
// size, and limit prices from the quote (bid / mid / ask) or one tick away. Pure.

import { roundToTick } from '@shared/format';
import type { OrderAction, OrderType } from '@shared/types';

/** Quantity chips: 100, 500, 1K. */
export const QTY_CHIPS: readonly number[] = [100, 500, 1000];

/** "1K" for 1000, else the number. */
export const qtyChipText = (n: number): string => (n >= 1000 && n % 1000 === 0 ? `${n / 1000}K` : String(n));

/** The quantity that closes the position (its size), or null without one. */
export function positionQty(position: number | undefined): number | null {
  if (position == null || !Number.isFinite(position) || position === 0) return null;
  return Math.abs(position);
}

/** The side that closes a position: a long one is sold, a short one bought back. */
export const closingSide = (position: number): OrderAction => (position > 0 ? 'SELL' : 'BUY');

const ok = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n > 0;

/**
 * A limit price from the quote, on the contract's tick. The midpoint between two ticks goes to the
 * passive side (a buy rounds down, a sell up), so the price never crosses it. Null when the quote
 * lacks the side(s) it needs.
 */
export function quotePrice(which: 'bid' | 'mid' | 'ask', quote: { bid?: number; ask?: number }, minTick: number, side: OrderAction): number | null {
  const { bid, ask } = quote;
  if (which === 'bid') return ok(bid) ? roundToTick(bid, minTick) : null;
  if (which === 'ask') return ok(ask) ? roundToTick(ask, minTick) : null;
  if (!ok(bid) || !ok(ask)) return null;
  const mid = (bid + ask) / 2;
  const tick = minTick > 0 ? minTick : 0.01;
  // A tiny epsilon keeps a mid that is exactly on a tick (in decimal) from moving a tick away.
  const steps = mid / tick;
  const n = side === 'BUY' ? Math.floor(steps + 1e-9) : Math.ceil(steps - 1e-9);
  return roundToTick(n * tick, tick);
}

/** The price one tick lower or higher (never below one tick). */
export function stepPrice(price: number | undefined, dir: 1 | -1, minTick: number): number | null {
  if (!ok(price)) return null;
  const tick = minTick > 0 ? minTick : 0.01;
  return Math.max(tick, roundToTick(price + dir * tick, tick));
}

/**
 * Where a price from the quote goes in the ticket. `quote`: a click on the bid / ask boxes or a
 * depth level fills the limit price (for a stop limit or limit-if-touched, its limit); `chip`: the
 * Bid / Mid / Ask chips under the price box fill that box (the trigger, for those). A market order
 * becomes a limit order (`toLimit`; not while modifying: the type stays). Null: nothing to fill.
 */
export function priceTarget(
  type: OrderType,
  mainKey: 'limitPrice' | 'stopPrice' | 'offset' | null,
  modifying: boolean,
  source: 'quote' | 'chip',
): 'limitPrice' | 'stopPrice' | 'toLimit' | null {
  if (mainKey === 'limitPrice') return 'limitPrice';
  if (mainKey === 'stopPrice') return source === 'quote' && (type === 'STP LMT' || type === 'LIT') ? 'limitPrice' : 'stopPrice';
  if (mainKey == null && !modifying && (type === 'MKT' || type === 'MTL')) return 'toLimit';
  return null;
}
