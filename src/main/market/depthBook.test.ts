import { describe, expect, it } from 'vitest';
import { applyDepthUpdate, type BookSides, clearBook, DepthOp, DepthSide } from './depthBook';

const empty = (): BookSides => ({ bids: [], asks: [] });

describe('applyDepthUpdate', () => {
  it('inserts, updates and deletes rows per side', () => {
    const b = empty();
    applyDepthUpdate(b, { position: 0, operation: DepthOp.insert, side: DepthSide.bid, price: 10, size: 100, marketMaker: 'NSDQ' });
    applyDepthUpdate(b, { position: 0, operation: DepthOp.insert, side: DepthSide.ask, price: 10.01, size: 200 });
    applyDepthUpdate(b, { position: 1, operation: DepthOp.insert, side: DepthSide.bid, price: 9.99, size: 300 });
    // Insert in the middle shifts the rest down.
    applyDepthUpdate(b, { position: 1, operation: DepthOp.insert, side: DepthSide.bid, price: 9.995, size: 50 });
    expect(b.bids.map((l) => l.price)).toEqual([10, 9.995, 9.99]);
    expect(b.bids[0].marketMaker).toBe('NSDQ');
    applyDepthUpdate(b, { position: 0, operation: DepthOp.update, side: DepthSide.ask, price: 10.02, size: 250 });
    expect(b.asks).toEqual([{ price: 10.02, size: 250 }]);
    applyDepthUpdate(b, { position: 1, operation: DepthOp.remove, side: DepthSide.bid, price: 0, size: 0 });
    expect(b.bids.map((l) => l.price)).toEqual([10, 9.99]);
  });

  it('treats an update just past the end as an append and ignores out-of-range rows', () => {
    const b = empty();
    expect(applyDepthUpdate(b, { position: 0, operation: DepthOp.update, side: DepthSide.bid, price: 1, size: 1 })).toBe(true);
    expect(applyDepthUpdate(b, { position: 5, operation: DepthOp.update, side: DepthSide.bid, price: 1, size: 1 })).toBe(false);
    expect(applyDepthUpdate(b, { position: 3, operation: DepthOp.remove, side: DepthSide.bid, price: 1, size: 1 })).toBe(false);
    expect(applyDepthUpdate(b, { position: 0, operation: 9, side: DepthSide.bid, price: 1, size: 1 })).toBe(false);
  });

  it('caps the book at the requested rows', () => {
    const b = empty();
    for (let i = 0; i < 12; i++) applyDepthUpdate(b, { position: i, operation: DepthOp.insert, side: DepthSide.ask, price: 10 + i, size: 1 }, 10);
    expect(b.asks).toHaveLength(10);
    clearBook(b);
    expect(b).toEqual(empty());
  });
});
