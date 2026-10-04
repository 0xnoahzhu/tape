// Level 2 ladder rows (design: book / ld). Pure so it can be unit tested.

import type { DepthBook, DepthLevel } from '@shared/types';

export const DEPTH_LEVELS = 10;

export interface LadderRow {
  side: 'ask' | 'bid';
  price: number;
  size: number;
  /** Size bar width as a fraction of the largest size on screen (0–1). */
  width: number;
  /** The best bid: accent price, selection background and a top divider. */
  best: boolean;
}

export interface Ladder {
  /** Asks (highest price first), then bids (best first). */
  rows: LadderRow[];
  /** Levels per side actually shown. */
  levels: number;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
}

const valid = (l: DepthLevel) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size >= 0;

export function buildLadder(book: Pick<DepthBook, 'bids' | 'asks'> | null | undefined, levels = DEPTH_LEVELS): Ladder {
  if (!book) return { rows: [], levels: 0 };
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
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  return {
    rows,
    levels: Math.max(asks.length, bids.length),
    bestAsk,
    bestBid,
    spread: bestAsk != null && bestBid != null ? Math.round((bestAsk - bestBid) * 1e6) / 1e6 : undefined,
  };
}
