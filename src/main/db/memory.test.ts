import { describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { createMemoryDatabase } from './memory';

const bar = (time: number, close = time): Bar => ({ time, open: close, high: close, low: close, close, volume: 1 });

describe('memory bar cache', () => {
  it('keeps series sorted and unique, later bars winning', async () => {
    const db = createMemoryDatabase();
    await db.bars.put('s', [bar(30), bar(10), bar(20)]);
    await db.bars.put('s', [bar(20, 21), bar(40), bar(5)]);
    await db.bars.put('s', [bar(50), bar(50, 51)]);
    expect((await db.bars.get('s')).map((b) => [b.time, b.close])).toEqual([
      [5, 5],
      [10, 10],
      [20, 21],
      [30, 30],
      [40, 40],
      [50, 51],
    ]);
    expect(await db.bars.last('s')).toBe(50);
    expect(await db.bars.last('none')).toBeUndefined();
  });

  it('reads from a time on (inclusive) and returns copies', async () => {
    const db = createMemoryDatabase();
    await db.bars.put('s', [bar(10), bar(20), bar(30)]);
    expect((await db.bars.get('s', 20)).map((b) => b.time)).toEqual([20, 30]);
    expect((await db.bars.get('s', 21)).map((b) => b.time)).toEqual([30]);
    expect(await db.bars.get('s', 31)).toEqual([]);
    // An upper bound is exclusive.
    expect((await db.bars.get('s', 10, 30)).map((b) => b.time)).toEqual([10, 20]);
    expect((await db.bars.get('s', undefined, 11)).map((b) => b.time)).toEqual([10]);
    expect(await db.bars.get('s', 20, 20)).toEqual([]);
    expect(await db.bars.get('s', 25, 15)).toEqual([]);
    const [first] = await db.bars.get('s');
    first.close = -1;
    expect((await db.bars.get('s'))[0].close).toBe(10);
  });

  it('handles series far beyond the spread-argument limit', async () => {
    const db = createMemoryDatabase();
    const n = 300_000;
    const bars = Array.from({ length: n }, (_, i) => bar(i * 60));
    await db.bars.put('big', bars);
    await db.bars.put('big', [bar(n * 60)]);
    expect(await db.bars.last('big')).toBe(n * 60);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) await db.bars.get('big', (n - 10) * 60);
    expect(performance.now() - t0).toBeLessThan(500);
    expect((await db.bars.get('big', (n - 1) * 60)).map((b) => b.time)).toEqual([(n - 1) * 60, n * 60]);
  });

  it('stores kv values as JSON copies', async () => {
    const db = createMemoryDatabase();
    const value = { a: 1, b: undefined as number | undefined };
    await db.kv.set('ns', 'k', value);
    value.a = 2;
    const row = await db.kv.get<{ a: number; b?: number }>('ns', 'k');
    expect(row?.value).toEqual({ a: 1 });
    expect(row && 'b' in row.value).toBe(false);
  });
});
