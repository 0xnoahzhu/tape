// The order ticket's Book (DepthBlock.tsx): Level 2 ladder rows and what a click on a level loads
// into the ticket. Pure so it can be unit tested.

import type { DepthBook, DepthLevel, OrderType } from '@shared/types';
import type { TicketState } from '../../state/store';
import { priceTarget } from '../panels/quickActions';

/** Levels a side of the book the ticket shows. */
export const BOOK_LEVELS = 5;

export interface LadderRow {
  side: 'ask' | 'bid';
  price: number;
  size: number;
  /** Size bar width as a fraction of the largest size on screen (0–1). */
  width: number;
  /** The best bid: a divider above it. */
  best: boolean;
}

export interface Ladder {
  /** Asks (highest price first), then bids (best first). */
  rows: LadderRow[];
}

const valid = (l: DepthLevel) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size >= 0;

export function buildLadder(book: Pick<DepthBook, 'bids' | 'asks'> | null | undefined, levels = BOOK_LEVELS): Ladder {
  if (!book) return { rows: [] };
  const asks = book.asks.filter(valid).sort((a, b) => a.price - b.price).slice(0, levels);
  const bids = book.bids.filter(valid).sort((a, b) => b.price - a.price).slice(0, levels);
  const max = Math.max(0, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const width = (size: number) => (max > 0 ? size / max : 0);
  const rows: LadderRow[] = [
    ...asks
      .slice()
      .reverse()
      .map((l) => ({ side: 'ask' as const, price: l.price, size: l.size, width: width(l.size), best: false })),
    ...bids.map((l, i) => ({ side: 'bid' as const, price: l.price, size: l.size, width: width(l.size), best: i === 0 })),
  ];
  return { rows };
}

type LevelTicket = { type: OrderType; mainKey: 'limitPrice' | 'stopPrice' | 'offset' | null; modifying: boolean };

/**
 * What a click on a level sets: a new order (`order`), or the limit or the trigger of a working
 * order being modified (the box a quote fills, quickActions.ts → priceTarget); null when it has none.
 */
export function levelTarget(t: LevelTicket): 'order' | 'limitPrice' | 'stopPrice' | null {
  if (!t.modifying) return 'order';
  const target = priceTarget(t.type, t.mainKey, true, 'quote');
  return target === 'limitPrice' || target === 'stopPrice' ? target : null;
}

/**
 * What a click on a level loads into the ticket. A new order becomes a limit order at the level's
 * price on the side that takes it (buy at an ask, sell at a bid), without the previous trigger or
 * limit offset. A working order being modified keeps its side and type (IB refuses to change them):
 * only its price follows (levelTarget); null when it has none.
 */
export function levelPatch(level: Pick<LadderRow, 'side' | 'price'>, t: LevelTicket): Partial<TicketState> | null {
  const target = levelTarget(t);
  if (target === 'order') return { orderType: 'LMT', limitPrice: level.price, side: level.side === 'ask' ? 'BUY' : 'SELL', stopPrice: null, limitOffset: null };
  return target === 'limitPrice' ? { limitPrice: level.price } : target === 'stopPrice' ? { stopPrice: level.price } : null;
}
