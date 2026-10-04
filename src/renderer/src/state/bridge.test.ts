import { describe, expect, it } from 'vitest';
import type { ApiLogEntry } from '@shared/types';
import { appendLog, withLoadedLog } from './bridge';

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
