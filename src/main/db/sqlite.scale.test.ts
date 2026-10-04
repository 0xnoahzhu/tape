// Scale check: does SQLite slow down with lots of bars? 2,000,000 bars across 400 series, then
// timed 500-bar range reads straight from the store and through the worker protocol.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import type { Bar } from '@shared/types';
import { createSqliteClient } from './client';
import { serve } from './server';
import { openStore } from './sqlite';

const SERIES = 400;
const BARS_PER_SERIES = 5_000;
const SERIES_PER_TRANSACTION = 10;
const READ_BARS = 500;
const READS = 400;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

describe('SQLite at scale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tape-dbscale-'));
  const file = join(dir, 'tape.db');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it(`${SERIES * BARS_PER_SERIES} bars: batched inserts, 500-bar range reads well under 5 ms`, { timeout: 180_000 }, async () => {
    const store = openStore(file);
    // 1-minute bars of 400 instruments; times interleave across series as real data does.
    const t0 = 1_700_000_000;
    const series = (s: number) => `SYM${s}@SMART|1m|1|TRADES`;
    const bars: Bar[] = Array.from({ length: BARS_PER_SERIES }, (_, i) => ({
      time: t0 + i * 60,
      open: 100 + (i % 7),
      high: 101 + (i % 7),
      low: 99 + (i % 7),
      close: 100.5 + (i % 7),
      volume: 1000 + i,
    }));

    const insertStart = performance.now();
    for (let s = 0; s < SERIES; s += SERIES_PER_TRANSACTION) {
      store.transaction(() => {
        for (let k = s; k < s + SERIES_PER_TRANSACTION; k++) store.barsPut(series(k), bars, true);
      });
    }
    const insertMs = performance.now() - insertStart;
    store.checkpoint();
    const rows = SERIES * BARS_PER_SERIES;
    const size = statSync(file).size;

    // The newest 500 bars of a series (the chart's usual request), straight from the store:
    // the SQL work the worker does per request.
    const lastFrom = t0 + (BARS_PER_SERIES - READ_BARS) * 60;
    const direct: number[] = [];
    for (let r = 0; r < READS; r++) {
      const start = performance.now();
      const packed = store.barsGet(series((r * 37) % SERIES), lastFrom);
      direct.push(performance.now() - start);
      expect(packed.length / 6).toBe(READ_BARS);
    }
    store.close();

    // Through the protocol: client -> port -> server -> SQLite -> transferred Float64Array -> Bar[].
    const { port1, port2 } = new MessageChannel();
    serve(port2, { file, log: () => undefined });
    const db = createSqliteClient({
      post: (req, transfer) => (transfer ? port1.postMessage(req, transfer) : port1.postMessage(req)),
      listen: (onMessage) => void port1.on('message', onMessage),
      terminate: async () => port1.close(),
    });
    await db.ready;
    const rpc: number[] = [];
    for (let r = 0; r < READS; r++) {
      const start = performance.now();
      const got = await db.bars.get(series((r * 53) % SERIES), lastFrom);
      rpc.push(performance.now() - start);
      expect(got.length).toBe(READ_BARS);
    }
    const lastStart = performance.now();
    expect(await db.bars.last(series(SERIES - 1))).toBe(t0 + (BARS_PER_SERIES - 1) * 60);
    const lastMs = performance.now() - lastStart;
    await db.close();

    direct.sort((a, b) => a - b);
    rpc.sort((a, b) => a - b);
    console.log(
      [
        `[db scale] ${rows.toLocaleString('en-US')} bars in ${SERIES} series`,
        `insert ${(insertMs / 1000).toFixed(2)} s = ${Math.round(rows / (insertMs / 1000)).toLocaleString('en-US')} bars/s (${SERIES / SERIES_PER_TRANSACTION} transactions)`,
        `file ${mib(size)} MiB (${(size / rows).toFixed(1)} B/bar)`,
        `500-bar read, direct: median ${percentile(direct, 0.5).toFixed(3)} ms, p99 ${percentile(direct, 0.99).toFixed(3)} ms`,
        `500-bar read, via protocol: median ${percentile(rpc, 0.5).toFixed(3)} ms, p99 ${percentile(rpc, 0.99).toFixed(3)} ms`,
        `last(): ${lastMs.toFixed(3)} ms`,
      ].join('\n  '),
    );
    expect(percentile(direct, 0.5)).toBeLessThan(5);
    expect(percentile(rpc, 0.5)).toBeLessThan(5);
  });
});
