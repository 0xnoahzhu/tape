import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { option, stock } from '@shared/contract';
import type { ContractRef, PositioningSnapshot } from '@shared/types';
import type { TapeEvent } from '@shared/ipc';
import type { MainContext, ProbeEvent } from '../context';
import { createMemoryDatabase } from '../db/memory';
import { createPositioningService, demoHistory, MAX_SCAN_OPTIONS, medianOf, mergeRows, rowOf, SCAN_LINES } from './positioning';
import { TICK } from './tickMap';

type Listener = (e: ProbeEvent) => void;

function setup(opts: { connected?: boolean; freeLines?: number } = {}) {
  const events: TapeEvent[] = [];
  const open = new Map<string, Listener>();
  const opened: ContractRef[] = [];
  let free = opts.freeLines ?? SCAN_LINES;
  const db = createMemoryDatabase();
  const ctx = {
    demo: false,
    emit: (e: TapeEvent) => events.push(e),
    db,
    ib: { api: {}, isConnected: () => opts.connected ?? true },
    quotes: {
      probe(c: ContractRef, _ticks: string, listener: Listener) {
        if (free <= 0) return null;
        free--;
        opened.push(c);
        const key = `${c.lastTradeDate}|${c.strike}|${c.right}`;
        open.set(key, listener);
        return {
          close() {
            if (open.delete(key)) free++;
          },
        };
      },
    },
  } as unknown as MainContext;
  return { ctx, events, open, opened, db };
}

/** Sends an option line its open interest, volume and model. */
function answer(l: Listener, right: 'C' | 'P', oi: number, vol: number, gamma: number, und = 100) {
  l({ kind: 'tick', tick: { kind: 'size', field: right === 'C' ? TICK.OPTION_CALL_OPEN_INTEREST : TICK.OPTION_PUT_OPEN_INTEREST, value: oi } });
  l({ kind: 'tick', tick: { kind: 'size', field: right === 'C' ? TICK.OPTION_PUT_OPEN_INTEREST : TICK.OPTION_CALL_OPEN_INTEREST, value: 0 } });
  l({ kind: 'tick', tick: { kind: 'option', field: TICK.MODEL_OPTION, iv: 0.3, delta: right === 'C' ? 0.5 : -0.5, gamma, undPrice: und } });
  l({ kind: 'tick', tick: { kind: 'size', field: TICK.VOLUME, value: vol } });
}

const opt = (k: number, right: 'C' | 'P', expiry = '20991218') => option('X', expiry, k, right);

describe('positioning helpers', () => {
  it('builds rows from what a line sent and merges scans of a day', () => {
    const c = opt(100, 'P');
    expect(rowOf(c, { key: '', updatedAt: 0 })).toBeNull();
    expect(rowOf({ ...c, multiplier: 10 }, { key: '', updatedAt: 0, openInterest: 5, iv: 0.2 })).toEqual({ expiry: '20991218', strike: 100, right: 'P', multiplier: 10, oi: 5, iv: 0.2 });
    const a = { expiry: '20991218', strike: 100, right: 'C' as const, multiplier: 100, oi: 1 };
    const b = { expiry: '20991218', strike: 95, right: 'C' as const, multiplier: 100, oi: 2 };
    expect(mergeRows([a, b], [{ ...a, oi: 3 }])).toEqual([b, { ...a, oi: 3 }]);
    expect(medianOf([3, 1, 2, NaN])).toBe(2);
    expect(medianOf([])).toBeUndefined();
  });

  it('makes up earlier weekdays for demo mode, oldest first', () => {
    const today: PositioningSnapshot = { underlying: 'STK:X', day: '20991202', updatedAt: 0, spot: 100, rows: [{ expiry: '20991218', strike: 100, right: 'C', multiplier: 100, oi: 1000 }] };
    const h = demoHistory(today, 4);
    expect(h.map((s) => s.day)).toEqual(['20991127', '20991130', '20991201', '20991202']);
    expect(h[3]).toBe(today);
  });
});

describe('positioning scans', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads each option on a probe line, stores the day and reports progress', async () => {
    const { ctx, events, open } = setup();
    const svc = createPositioningService(ctx);
    const scan = svc.scan(stock('X'), [opt(100, 'C'), opt(100, 'P'), opt(105, 'C')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(open.size).toBe(3);
    answer(open.get('20991218|100|C')!, 'C', 1200, 30, 0.04, 101);
    answer(open.get('20991218|100|P')!, 'P', 800, 10, 0.04, 99);
    // An option IB does not list.
    open.get('20991218|105|C')!({ kind: 'error', code: 200, message: 'No security definition' });
    await vi.advanceTimersByTimeAsync(10);
    const snap = await scan;
    expect(open.size).toBe(0);
    expect(snap.underlying).toBe('STK:X');
    expect(snap.spot).toBe(100);
    expect(snap.rows).toEqual([
      { expiry: '20991218', strike: 100, right: 'C', multiplier: 100, oi: 1200, volume: 30, iv: 0.3, delta: 0.5, gamma: 0.04 },
      { expiry: '20991218', strike: 100, right: 'P', multiplier: 100, oi: 800, volume: 10, iv: 0.3, delta: -0.5, gamma: 0.04 },
    ]);
    const last = events.filter((e) => e.type === 'positioningScan').pop();
    expect(last).toEqual({ type: 'positioningScan', progress: { underlying: 'STK:X', done: 3, total: 3, running: false } });
    expect(await svc.get(stock('X'), 5)).toEqual([snap]);
  });

  it('closes a silent line after the timeout, keeping what it sent', async () => {
    const { ctx, open } = setup();
    const svc = createPositioningService(ctx);
    const scan = svc.scan(stock('X'), [opt(100, 'C')]);
    await vi.advanceTimersByTimeAsync(10);
    open.get('20991218|100|C')!({ kind: 'tick', tick: { kind: 'size', field: TICK.OPTION_CALL_OPEN_INTEREST, value: 50 } });
    await vi.advanceTimersByTimeAsync(6_100);
    const snap = await scan;
    expect(snap.rows).toEqual([{ expiry: '20991218', strike: 100, right: 'C', multiplier: 100, oi: 50 }]);
  });

  it('waits for a free line, and gives up when none frees up', async () => {
    const { ctx, opened } = setup({ freeLines: 0 });
    const svc = createPositioningService(ctx);
    const scan = svc.scan(stock('X'), [opt(100, 'C')]);
    const err = scan.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await err).toBe('No free market data line for the scan');
    expect(opened).toEqual([]);
  });

  it('ends the running scan when cancelled or replaced, closing its lines', async () => {
    const { ctx, open, events } = setup();
    const svc = createPositioningService(ctx);
    const first = svc.scan(stock('X'), [opt(100, 'C'), opt(100, 'P')]);
    await vi.advanceTimersByTimeAsync(50);
    expect(open.size).toBe(2);
    svc.cancel();
    await vi.advanceTimersByTimeAsync(10);
    expect(open.size).toBe(0);
    const snap = await first;
    expect(snap.rows).toEqual([]);
    expect(events.filter((e) => e.type === 'positioningScan').pop()).toMatchObject({ progress: { running: false, error: 'Cancelled' } });
  });

  it('refuses without a session and caps the list', async () => {
    const off = createPositioningService(setup({ connected: false }).ctx);
    await expect(off.scan(stock('X'), [opt(100, 'C')])).rejects.toThrow(/Not connected/);
    const { ctx, opened } = setup();
    const svc = createPositioningService(ctx);
    void svc.scan(
      stock('X'),
      Array.from({ length: MAX_SCAN_OPTIONS + 10 }, (_, i) => opt(1 + i, 'C')),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opened.length).toBe(SCAN_LINES);
    svc.cancel();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('keeps the days stored, oldest first', async () => {
    const { ctx, db } = setup();
    const svc = createPositioningService(ctx);
    const snap = (day: string): PositioningSnapshot => ({ underlying: 'STK:X', day, updatedAt: 0, rows: [] });
    await db.kv.set('positioning', 'STK:X|20991201', snap('20991201'));
    await db.kv.set('positioning', 'STK:X|20991202', snap('20991202'));
    await db.kv.set('positioning', 'STK:X|days', ['20991201', '20991202', '20991130']);
    expect((await svc.get(stock('X'), 2)).map((s) => s.day)).toEqual(['20991201', '20991202']);
    expect((await svc.get(stock('X'), 10)).map((s) => s.day)).toEqual(['20991201', '20991202']);
  });
});
