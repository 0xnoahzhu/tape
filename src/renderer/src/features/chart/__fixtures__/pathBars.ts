// Synthetic bars for the pattern tests (waves, reversals): straight legs through given prices.

import type { Bar } from '@shared/types';

/** Bars walking in straight legs through `prices`, `per` bars per leg, each bar 0.2 high. */
export function pathBars(prices: number[], per = 6): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < prices.length - 1; k++) {
    for (let j = 0; j < per; j++) {
      const p = prices[k] + ((prices[k + 1] - prices[k]) * j) / per;
      out.push({ time: out.length * 86_400, open: p, high: p + 0.1, low: p - 0.1, close: p, volume: 1 });
    }
  }
  const last = prices[prices.length - 1];
  out.push({ time: out.length * 86_400, open: last, high: last + 0.1, low: last - 0.1, close: last, volume: 1 });
  return out;
}
