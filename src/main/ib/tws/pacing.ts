// IB's pacing rules for single request types. The send queue checks them when a frame is
// written, the moment IB counts it, so a caller's own pacing cannot be undone by the time a
// frame waits in the queue (behind higher lanes or the message rate limit):
//   reqMatchingSymbols  at most one per second (IB drops overlapping searches)
//   reqHistoricalData   no identical request within 15 s; at most 5 for the same contract,
//                       exchange and tick type within 2 s; at most 60 within 10 minutes;
//                       BID_ASK counts twice (IB "Historical Data Limitations")

import type { Token } from './encoder.ts';
import { OUT_MSG_ID } from './messageIds.ts';

/** At most `max` frames with this key in any `windowMs`; a frame counts `weight` times. */
export interface Pace {
  key: string;
  max: number;
  windowMs: number;
  weight: number;
}

const SYMBOL_SEARCH: Pace = { key: 'symbols', max: 1, windowMs: 1000, weight: 1 };

/** Token ranges of reqHistoricalData (encoder.ts): the contract (conId .. includeExpired), then
 *  endDateTime, barSize, duration, useRTH, whatToShow (the request fields IB compares). */
const HIST_CONTRACT = [2, 15] as const;
const HIST_QUERY_END = 20;
const HIST_WHAT_TO_SHOW = 19;

function historicalPaces(tokens: readonly Token[]): Pace[] {
  const contract = tokens.slice(...HIST_CONTRACT).join('\0');
  const whatToShow = String(tokens[HIST_WHAT_TO_SHOW] ?? '');
  const weight = whatToShow === 'BID_ASK' ? 2 : 1;
  return [
    { key: `hist=${tokens.slice(HIST_CONTRACT[0], HIST_QUERY_END).join('\0')}`, max: 1, windowMs: 15_000, weight: 1 },
    { key: `hist:${contract}\0${whatToShow}`, max: 5, windowMs: 2000, weight },
    { key: 'hist', max: 60, windowMs: 600_000, weight },
  ];
}

/** Pacing rules of an encoded frame (undefined: none beyond the message rate). */
export function pacesOf(tokens: readonly Token[]): readonly Pace[] | undefined {
  switch (Number(tokens[0])) {
    case OUT_MSG_ID.REQ_MATCHING_SYMBOLS:
      return [SYMBOL_SEARCH];
    case OUT_MSG_ID.REQ_HISTORICAL_DATA:
      return historicalPaces(tokens);
    default:
      return undefined;
  }
}

/** Write times per pacing key, kept while they are inside their window. */
export class PaceWindows {
  private readonly windows = new Map<string, { windowMs: number; stamps: number[] }>();

  /** Milliseconds until a frame with these rules may be written (0: now). */
  waitMs(paces: readonly Pace[], now: number): number {
    let until = now;
    for (const pace of paces) {
      const stamps = this.stamps(pace.key, now);
      const excess = stamps.length + pace.weight - pace.max;
      // the oldest `excess` writes must leave the window first
      if (excess > 0) until = Math.max(until, stamps[Math.min(excess, stamps.length) - 1] + pace.windowMs);
    }
    return until > now ? Math.max(1, Math.ceil(until - now)) : 0;
  }

  /** Counts a written frame, and forgets windows that are empty. */
  record(paces: readonly Pace[], now: number): void {
    for (const [key, w] of this.windows) {
      const last = w.stamps.at(-1);
      if (last === undefined || now - last >= w.windowMs) this.windows.delete(key);
    }
    for (const pace of paces) {
      let w = this.windows.get(pace.key);
      if (!w) this.windows.set(pace.key, (w = { windowMs: pace.windowMs, stamps: [] }));
      for (let i = 0; i < pace.weight; i++) w.stamps.push(now);
    }
  }

  /** Number of keys with writes inside their window (diagnostics, tests). */
  get size(): number {
    return this.windows.size;
  }

  private stamps(key: string, now: number): number[] {
    const w = this.windows.get(key);
    if (!w) return [];
    let expired = 0;
    while (expired < w.stamps.length && now - w.stamps[expired] >= w.windowMs) expired++;
    if (expired) w.stamps.splice(0, expired);
    return w.stamps;
  }
}
