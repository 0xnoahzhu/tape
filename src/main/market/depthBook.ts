// Level 2 book maintenance from updateMktDepth / updateMktDepthL2 (pure, unit-tested).

import type { DepthLevel } from '@shared/types';

/** Rows a side requested from IB: the order ticket's Book shows 5 levels. */
export const DEPTH_ROWS = 5;

export const DepthOp = { insert: 0, update: 1, remove: 2 } as const;
export const DepthSide = { ask: 0, bid: 1 } as const;

export interface DepthUpdate {
  position: number;
  operation: number;
  side: number;
  price: number;
  size: number;
  marketMaker?: string;
}

export interface BookSides {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

/** Applies one row operation in place. Returns true when the book changed. */
export function applyDepthUpdate(book: BookSides, u: DepthUpdate, maxRows = DEPTH_ROWS): boolean {
  const rows = u.side === DepthSide.bid ? book.bids : book.asks;
  const pos = Math.max(0, Math.floor(u.position));
  const level: DepthLevel = { price: u.price, size: Number.isFinite(u.size) ? u.size : 0 };
  if (u.marketMaker) level.marketMaker = u.marketMaker;
  switch (u.operation) {
    case DepthOp.insert:
      rows.splice(Math.min(pos, rows.length), 0, level);
      if (rows.length > maxRows) rows.length = maxRows;
      return true;
    case DepthOp.update:
      if (pos < rows.length) rows[pos] = level;
      else if (pos === rows.length && pos < maxRows) rows.push(level);
      else return false;
      return true;
    case DepthOp.remove:
      if (pos >= rows.length) return false;
      rows.splice(pos, 1);
      return true;
    default:
      return false;
  }
}

export function clearBook(book: BookSides): void {
  book.bids.length = 0;
  book.asks.length = 0;
}
