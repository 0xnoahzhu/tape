import { describe, expect, it } from 'vitest';
import type { ApiLogEntry, Quote } from '@shared/types';
import { appendLog, mergeQuotes, withLoadedLog } from './bridge';

const entry = (seq: number): ApiLogEntry => ({ seq, t: seq, dir: 'in', msgId: '1', name: 'x', fields: [], bytes: 0, err: false, raw: '' });
const seqs = (log: ApiLogEntry[]) => log.map((e) => e.seq);

describe('appendLog', () => {
  it('skips entries the log already holds', () => {
    const log = [1, 2, 3].map(entry);
    expect(seqs(appendLog(log, [2, 3, 4, 5].map(entry)))).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns the same array when nothing is new', () => {
    const log = [1, 2].map(entry);
    expect(appendLog(log, [1, 2].map(entry))).toBe(log);
  });

  it('keeps the newest entries up to the limit', () => {
    expect(seqs(appendLog([1, 2].map(entry), [3, 4].map(entry), 3))).toEqual([2, 3, 4]);
  });
});

describe('withLoadedLog', () => {
  it('keeps batch entries that arrived before the loaded log and are newer than it', () => {
    // Streaming started at seq 100; a batch (101-106) arrived before getApiLog answered (..104).
    const held = [1, 2, ...[101, 102, 103, 104, 105, 106]].map(entry);
    const loaded = [...[3, 4], ...[100, 101, 102, 103, 104]].map(entry);
    expect(seqs(withLoadedLog(held, loaded))).toEqual([3, 4, 100, 101, 102, 103, 104, 105, 106]);
  });

  it('replaces an older copy and lets later batches append without duplicates', () => {
    const loaded = withLoadedLog([1, 2, 3].map(entry), [1, 2, 3, 4, 5].map(entry));
    expect(seqs(loaded)).toEqual([1, 2, 3, 4, 5]);
    // The first batch after the load overlaps it.
    expect(seqs(appendLog(loaded, [4, 5, 6].map(entry)))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps the newest entries up to the limit', () => {
    expect(seqs(withLoadedLog([6, 7].map(entry), [1, 2, 3, 4, 5].map(entry), 4))).toEqual([4, 5, 6, 7]);
  });
});

describe('mergeQuotes', () => {
  const held: Record<string, Quote> = {
    'STK:NVDA': { key: 'STK:NVDA', last: 236.59, close: 233.95, marketDataType: 1, updatedAt: 1 },
    'STK:AAPL': { key: 'STK:AAPL', last: 333.42, close: 333.69, open: 334, updatedAt: 1 },
  };

  it('merges changes into the quotes it holds and replaces those sent whole', () => {
    const { quotes, missing } = mergeQuotes(
      held,
      {
        'STK:NVDA': { key: 'STK:NVDA', last: 236.7, bid: undefined, updatedAt: 2 },
        'STK:AAPL': { key: 'STK:AAPL', last: 333.5, close: 333.69, updatedAt: 2 },
        'STK:MSFT': { key: 'STK:MSFT', last: 526.46, close: 517.53, updatedAt: 2 },
      },
      ['STK:AAPL', 'STK:MSFT'],
    );
    expect(missing).toEqual([]);
    expect(quotes['STK:NVDA']).toEqual({ key: 'STK:NVDA', last: 236.7, bid: undefined, close: 233.95, marketDataType: 1, updatedAt: 2 });
    expect(quotes['STK:AAPL']).toEqual({ key: 'STK:AAPL', last: 333.5, close: 333.69, updatedAt: 2 });
    expect(quotes['STK:MSFT'].close).toBe(517.53);
  });

  it('does not make a quote of changes alone, and reports it missing', () => {
    const { quotes, missing } = mergeQuotes(held, { 'STK:META': { key: 'STK:META', last: 745.7, bid: 745.69, updatedAt: 2 } });
    expect(quotes).toBe(held);
    expect(missing).toEqual(['STK:META']);
  });
});
