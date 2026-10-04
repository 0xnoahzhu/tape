// Unusual option activity derived from the visible chain: today's volume against open
// interest and premium. IB does not stream individual option prints through this API, so
// rows are per contract (not per trade).

import { timeColumn, type Clock } from '@shared/timeFormat';
import type { ContractRef, OptionRight, Quote } from '@shared/types';
import { markOf } from './chain';

export type FlowTag = 'voi' | 'large' | 'elevated';
export type FlowSide = 'ask' | 'bid' | 'mid';

export interface FlowInput {
  contract: ContractRef;
  right: OptionRight;
  strike: number;
  expiry: string;
  multiplier: number;
  quote: Quote | undefined;
}

export interface FlowRow extends Omit<FlowInput, 'quote'> {
  volume: number;
  oi?: number;
  price?: number;
  premium?: number;
  /** Volume / open interest; Infinity when the open interest is 0, undefined while it is unknown. */
  voi?: number;
  /** Where the last trade printed relative to the current quote. */
  side?: FlowSide;
  /** Unix ms of the last trade, when IB reported it. */
  time?: number;
  tags: FlowTag[];
}

export const MIN_VOLUME = 50;
export const LARGE_PREMIUM = 1_000_000;

export function flowSide(q: Quote | undefined): FlowSide | undefined {
  if (!q || q.last == null || q.bid == null || q.ask == null || !(q.ask > 0)) return undefined;
  if (q.last >= q.ask) return 'ask';
  if (q.last <= q.bid) return 'bid';
  return 'mid';
}

/** Flagged contracts, most unusual (highest Vol/OI, then premium) first. */
export function unusualActivity(items: FlowInput[]): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const it of items) {
    const q = it.quote;
    const volume = q?.volume ?? 0;
    if (volume < MIN_VOLUME) continue;
    const oi = q?.openInterest;
    const price = q?.last != null && q.last > 0 ? q.last : markOf(q);
    const premium = price != null ? volume * price * it.multiplier : undefined;
    // Open interest that has not arrived yet says nothing about Vol/OI (it is not zero).
    const voi = oi == null ? undefined : oi > 0 ? volume / oi : Infinity;
    const tags: FlowTag[] = [];
    if (voi != null && voi >= 1) tags.push('voi');
    else if (voi != null && voi >= 0.5) tags.push('elevated');
    if (premium != null && premium >= LARGE_PREMIUM) tags.push('large');
    if (!tags.length) continue;
    const { quote: _q, ...rest } = it;
    rows.push({ ...rest, volume, oi, price, premium, voi, side: flowSide(q), time: q?.lastTime, tags });
  }
  return rows.sort((a, b) => (b.voi ?? -1) - (a.voi ?? -1) || (b.premium ?? 0) - (a.premium ?? 0));
}

/** Volume and open interest totals by right. */
export function chainTotals(items: Array<Pick<FlowInput, 'right' | 'quote'>>): { callVol: number; putVol: number; callOi: number; putOi: number; quoted: number } {
  const t = { callVol: 0, putVol: 0, callOi: 0, putOi: 0, quoted: 0 };
  for (const it of items) {
    const q = it.quote;
    if (!q) continue;
    if (q.volume != null || q.openInterest != null) t.quoted++;
    if (it.right === 'C') {
      t.callVol += q.volume ?? 0;
      t.callOi += q.openInterest ?? 0;
    } else {
      t.putVol += q.volume ?? 0;
      t.putOi += q.openInterest ?? 0;
    }
  }
  return t;
}

/** Grid columns of the flow list; the time column is sized for the clock format. */
export function flowColumns(clock: Pick<Clock, 'format'>): string {
  return `${timeColumn(clock)} minmax(0,2.2fr) repeat(5,minmax(0,1fr)) 70px`;
}
