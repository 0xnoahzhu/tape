import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractKey, stock } from '@shared/contract';
import type { Position } from '@shared/types';
import { positionRow } from './calc';
import { addOnSubscriptions, COLUMNS, type ColumnDef } from './columns';
import { ADD_ON_DEBOUNCE_MS, latestAfter, profileColumns, reaskDelay } from './usePositionColumnData';

describe('latestAfter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes the first value at once, then the latest after a quiet wait', () => {
    const out: string[] = [];
    const d = latestAfter<string>(ADD_ON_DEBOUNCE_MS, (v) => out.push(v));
    d.push('a');
    expect(out).toEqual(['a']);
    // A run of column toggles: one change, the last one, 500 ms after it.
    d.push('b');
    vi.advanceTimersByTime(300);
    d.push('c');
    vi.advanceTimersByTime(ADD_ON_DEBOUNCE_MS - 1);
    expect(out).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(out).toEqual(['a', 'c']);
    // Later changes wait too.
    d.push('d');
    expect(out).toEqual(['a', 'c']);
    vi.advanceTimersByTime(ADD_ON_DEBOUNCE_MS);
    expect(out).toEqual(['a', 'c', 'd']);
  });

  it('drops a pending value when cancelled', () => {
    const out: number[] = [];
    const d = latestAfter<number>(ADD_ON_DEBOUNCE_MS, (v) => out.push(v));
    d.push(1);
    d.push(2);
    d.cancel();
    vi.advanceTimersByTime(ADD_ON_DEBOUNCE_MS * 2);
    expect(out).toEqual([1]);
  });
});

describe('the extra ticks of the Positions table', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const row = (symbol: string) => {
    const p: Position = { account: 'DU1', key: symbol, contract: stock(symbol), quantity: 10, avgPrice: 100, multiplier: 1, updatedAt: 0 };
    return positionRow(p, 101, 1_000_000, 'Technology', 1);
  };
  const keys = (subs: ReturnType<typeof addOnSubscriptions>) => subs.map((s) => `${contractKey(s.contract)}|${s.profile}`);

  it('waits only for column changes: a new position gets its extra ticks at once, with its portfolio line', () => {
    // As the hook: the profile columns through latestAfter, the rows straight through.
    let shown: readonly ColumnDef[] = [];
    const columns = latestAfter<readonly ColumnDef[]>(ADD_ON_DEBOUNCE_MS, (defs) => (shown = defs));
    const shownCols = [COLUMNS.symbol, COLUMNS.quantity, COLUMNS.high52w];
    const first = profileColumns(shownCols);
    expect(first.defs).toEqual([COLUMNS.high52w]);
    columns.push(first.defs);
    expect(keys(addOnSubscriptions([row('AAPL')], shown))).toEqual(['STK:AAPL|range']);
    // A fill opens MSFT: the rows change, the profile columns do not (same signature, nothing to push),
    // so the new list is there in the same render as the 'portfolio' owner's, without a wait.
    expect(profileColumns([...shownCols]).sig).toBe(first.sig);
    expect(keys(addOnSubscriptions([row('AAPL'), row('MSFT')], shown))).toEqual(['STK:AAPL|range', 'STK:MSFT|range']);
    // A column toggle waits.
    columns.push(profileColumns([...shownCols, COLUMNS.vwap]).defs);
    expect(keys(addOnSubscriptions([row('AAPL'), row('MSFT')], shown))).toEqual(['STK:AAPL|range', 'STK:MSFT|range']);
    vi.advanceTimersByTime(ADD_ON_DEBOUNCE_MS);
    expect(keys(addOnSubscriptions([row('AAPL'), row('MSFT')], shown))).toEqual(['STK:AAPL|range', 'STK:AAPL|vwap', 'STK:MSFT|range', 'STK:MSFT|vwap']);
  });

  it('signs only the columns with a profile', () => {
    expect(profileColumns([COLUMNS.symbol, COLUMNS.price, COLUMNS.nextEarnings])).toEqual({ defs: [], sig: '' });
    expect(profileColumns([COLUMNS.vwap, COLUMNS.symbol, COLUMNS.mark]).sig).toBe('vwap,mark');
  });
});

describe('reaskDelay', () => {
  it('asks again after 5 s, 15 s, 45 s, 2 min and 5 min, then no more', () => {
    expect([0, 1, 2, 3, 4].map(reaskDelay)).toEqual([5_000, 15_000, 45_000, 120_000, 300_000]);
    expect(reaskDelay(5)).toBeUndefined();
  });
});
