// Maps IB market data callbacks (tickPrice, tickSize, tickGeneric, tickString,
// tickOptionComputation) onto Tape's Quote. Pure and unit-tested.

import type { Quote, QuoteDividends } from '@shared/types';

/** IB tick type ids (see TickType in ib/tws) used by the mapping. */
export const TICK = {
  BID_SIZE: 0,
  BID: 1,
  ASK: 2,
  ASK_SIZE: 3,
  LAST: 4,
  LAST_SIZE: 5,
  HIGH: 6,
  LOW: 7,
  VOLUME: 8,
  CLOSE: 9,
  MODEL_OPTION: 13,
  OPEN: 14,
  LOW_52_WEEK: 19,
  HIGH_52_WEEK: 20,
  AVG_VOLUME: 21,
  OPTION_HISTORICAL_VOL: 23,
  OPTION_IMPLIED_VOL: 24,
  OPTION_CALL_OPEN_INTEREST: 27,
  OPTION_PUT_OPEN_INTEREST: 28,
  OPTION_CALL_VOLUME: 29,
  OPTION_PUT_VOLUME: 30,
  MARK_PRICE: 37,
  LAST_TIMESTAMP: 45,
  RT_VOLUME: 48,
  HALTED: 49,
  LAST_RTH_TRADE: 57,
  IB_DIVIDENDS: 59,
  DELAYED_BID: 66,
  DELAYED_ASK: 67,
  DELAYED_LAST: 68,
  DELAYED_BID_SIZE: 69,
  DELAYED_ASK_SIZE: 70,
  DELAYED_LAST_SIZE: 71,
  DELAYED_HIGH: 72,
  DELAYED_LOW: 73,
  DELAYED_VOLUME: 74,
  DELAYED_CLOSE: 75,
  DELAYED_OPEN: 76,
  DELAYED_MODEL_OPTION: 83,
  DELAYED_LAST_TIMESTAMP: 88,
  DELAYED_HALTED: 90,
} as const;

type NumericField = {
  [K in keyof Quote]-?: Quote[K] extends number | undefined ? (K extends 'updatedAt' | 'marketDataType' ? never : K) : never;
}[keyof Quote];

const PRICE_FIELDS: Partial<Record<number, NumericField>> = {
  [TICK.BID]: 'bid',
  [TICK.ASK]: 'ask',
  [TICK.LAST]: 'last',
  [TICK.HIGH]: 'high',
  [TICK.LOW]: 'low',
  [TICK.CLOSE]: 'close',
  [TICK.OPEN]: 'open',
  [TICK.LOW_52_WEEK]: 'week52Low',
  [TICK.HIGH_52_WEEK]: 'week52High',
  [TICK.MARK_PRICE]: 'mark',
  [TICK.LAST_RTH_TRADE]: 'lastRthTrade',
  [TICK.DELAYED_BID]: 'bid',
  [TICK.DELAYED_ASK]: 'ask',
  [TICK.DELAYED_LAST]: 'last',
  [TICK.DELAYED_HIGH]: 'high',
  [TICK.DELAYED_LOW]: 'low',
  [TICK.DELAYED_CLOSE]: 'close',
  [TICK.DELAYED_OPEN]: 'open',
};

const SIZE_FIELDS: Partial<Record<number, NumericField>> = {
  [TICK.BID_SIZE]: 'bidSize',
  [TICK.ASK_SIZE]: 'askSize',
  [TICK.LAST_SIZE]: 'lastSize',
  [TICK.VOLUME]: 'volume',
  [TICK.AVG_VOLUME]: 'avgVolume',
  [TICK.DELAYED_BID_SIZE]: 'bidSize',
  [TICK.DELAYED_ASK_SIZE]: 'askSize',
  [TICK.DELAYED_LAST_SIZE]: 'lastSize',
  [TICK.DELAYED_VOLUME]: 'volume',
};

/** Prices where 0 is a real quote (an option without bids still shows 0.00). */
const ZERO_OK_PRICES = new Set<NumericField>(['bid', 'ask']);

export type TickEvent =
  | { kind: 'price'; field: number; value: number | undefined }
  | { kind: 'size'; field: number; value: number | undefined }
  | { kind: 'generic'; field: number; value: number | undefined }
  | { kind: 'string'; field: number; value: string | undefined }
  | {
      kind: 'option';
      field: number;
      iv?: number;
      delta?: number;
      gamma?: number;
      vega?: number;
      theta?: number;
      undPrice?: number;
    };

export interface TickContext {
  /** The subscribed contract is an option (OPT / FOP). */
  isOption: boolean;
  /** Call or put, for option contracts. IB sends both open-interest ticks (27 and 28) to an option. */
  right?: 'C' | 'P';
  /** Combos can legitimately quote zero or negative prices. */
  isCombo?: boolean;
}

/** Rejects IB's "no value" markers: undefined, NaN, Double.MAX and other absurd magnitudes. */
const finite = (v: number | undefined | null): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e100;

function set<K extends keyof Quote>(q: Quote, key: K, value: Quote[K]): boolean {
  if (q[key] === value) return false;
  if (value === undefined && !(key in q)) return false;
  q[key] = value;
  return true;
}

function priceValue(field: NumericField, v: number | undefined, ctx: TickContext): number | undefined {
  if (!finite(v)) return undefined;
  if (ctx.isCombo) return v === -1 ? undefined : v;
  if (v < 0) return undefined; // -1 = no bid / ask / last
  if (v === 0 && !(ctx.isOption && ZERO_OK_PRICES.has(field))) return undefined;
  return v;
}

const sizeValue = (v: number | undefined): number | undefined => (finite(v) && v >= 0 ? v : undefined);

/** Parses an IB timestamp string (unix seconds, or ms) to unix ms. */
function timestampMs(s: string | undefined): number | undefined {
  const n = Number(s);
  if (!s || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
}

function applyPrice(q: Quote, field: number, value: number | undefined, ctx: TickContext): boolean {
  const key = PRICE_FIELDS[field];
  if (!key) return false;
  const v = priceValue(key, value, ctx);
  return key === 'close' ? applyClose(q, field, v) : set(q, key, v);
}

const isLive = (q: Quote): boolean => q.marketDataType === 1 || q.marketDataType === 2;

/**
 * The previous close, the reference of every change. IB sends it with a request's first ticks and
 * then only when it changes (a new session's close replaces it). Its "not available" markers (-1,
 * 0, Double.MAX) do not mean the instrument has no close, so they never erase a known one (IB does
 * not send it again). A delayed close (75) lags the live one, so it does not replace the close of a
 * quote that reports live data (type 1 / 2); a delayed quote takes it.
 */
function applyClose(q: Quote, field: number, v: number | undefined): boolean {
  if (v === undefined) return false;
  if (field === TICK.DELAYED_CLOSE && q.close !== undefined && isLive(q)) return false;
  return set(q, 'close', v);
}

function applySize(q: Quote, field: number, value: number | undefined, ctx: TickContext): boolean {
  const key = SIZE_FIELDS[field];
  if (key) return set(q, key, sizeValue(value));
  const v = sizeValue(value);
  switch (field) {
    case TICK.OPTION_CALL_OPEN_INTEREST:
    case TICK.OPTION_PUT_OPEN_INTEREST:
      if (ctx.isOption) {
        // Only the tick matching the option's right carries its open interest; the other is 0.
        const own = ctx.right === 'P' ? TICK.OPTION_PUT_OPEN_INTEREST : TICK.OPTION_CALL_OPEN_INTEREST;
        if (ctx.right ? field !== own : !v) return false;
        return set(q, 'openInterest', v);
      }
      return set(q, field === TICK.OPTION_CALL_OPEN_INTEREST ? 'callOpenInterest' : 'putOpenInterest', v);
    case TICK.OPTION_CALL_VOLUME:
    case TICK.OPTION_PUT_VOLUME:
      // On an option contract these repeat its own daily volume; tick 8 is authoritative.
      if (ctx.isOption) return q.volume === undefined && v !== undefined ? set(q, 'volume', v) : false;
      return set(q, field === TICK.OPTION_CALL_VOLUME ? 'callVolume' : 'putVolume', v);
    default:
      return false;
  }
}

function applyGeneric(q: Quote, field: number, value: number | undefined): boolean {
  switch (field) {
    case TICK.OPTION_HISTORICAL_VOL:
      return set(q, 'histVol', finite(value) && value > 0 ? value : undefined);
    case TICK.OPTION_IMPLIED_VOL:
      return set(q, 'impliedVol', finite(value) && value > 0 ? value : undefined);
    case TICK.HALTED:
    case TICK.DELAYED_HALTED:
      // -1 = not available, 0 = trading, 1 = general halt, 2 = volatility halt.
      return finite(value) && value >= 0 ? set(q, 'halted', value > 0) : false;
    default:
      return false;
  }
}

/**
 * IB's dividend summary (tick 59): "past12m,next12m,nextDate,nextAmount", e.g.
 * "3.64,3.92,20261119,0.98". IB sends ",,," for an instrument without dividends, which becomes
 * an empty object (known: none); a value that is not four fields is ignored (undefined).
 */
export function parseDividends(value: string | undefined): QuoteDividends | undefined {
  const parts = (value ?? '').split(',');
  if (parts.length !== 4) return undefined;
  const amount = (s: string) => {
    const n = Number(s.trim());
    return s.trim() !== '' && finite(n) && n >= 0 ? n : undefined;
  };
  const date = parts[2].trim();
  const out: QuoteDividends = {};
  const past12m = amount(parts[0]);
  const next12m = amount(parts[1]);
  const nextAmount = amount(parts[3]);
  if (past12m !== undefined) out.past12m = past12m;
  if (next12m !== undefined) out.next12m = next12m;
  if (/^\d{8}$/.test(date)) out.nextDate = date;
  if (nextAmount !== undefined) out.nextAmount = nextAmount;
  return out;
}

const sameDividends = (a: QuoteDividends | undefined, b: QuoteDividends | undefined): boolean =>
  a === b || (!!a && !!b && a.past12m === b.past12m && a.next12m === b.next12m && a.nextDate === b.nextDate && a.nextAmount === b.nextAmount);

function applyString(q: Quote, field: number, value: string | undefined): boolean {
  switch (field) {
    case TICK.LAST_TIMESTAMP:
    case TICK.DELAYED_LAST_TIMESTAMP: {
      const t = timestampMs(value);
      return t !== undefined ? set(q, 'lastTime', t) : false;
    }
    case TICK.RT_VOLUME: {
      // "price;size;time(ms);totalVolume;VWAP;singleTrade". Price is empty for unreported trades.
      const [price, size, time, total] = (value ?? '').split(';');
      let changed = false;
      const p = Number(price);
      if (price && finite(p) && p > 0) {
        changed = set(q, 'last', p) || changed;
        const s = Number(size);
        if (size && finite(s) && s >= 0) changed = set(q, 'lastSize', s) || changed;
        const t = timestampMs(time);
        if (t !== undefined) changed = set(q, 'lastTime', t) || changed;
      }
      const v = Number(total);
      if (total && finite(v) && v >= 0) changed = set(q, 'volume', v) || changed;
      return changed;
    }
    case TICK.IB_DIVIDENDS: {
      // A new object only when a value changed: the renderer patch compares fields by reference.
      const d = parseDividends(value);
      return d !== undefined && !sameDividends(q.dividends, d) ? set(q, 'dividends', d) : false;
    }
    default:
      return false;
  }
}

function applyOption(q: Quote, t: Extract<TickEvent, { kind: 'option' }>): boolean {
  if (t.field !== TICK.MODEL_OPTION && t.field !== TICK.DELAYED_MODEL_OPTION) return false;
  let changed = false;
  // -1 / -2 are IB's "not computed" markers; Double.MAX arrives as undefined.
  if (finite(t.iv) && t.iv > 0 && t.iv < 50) changed = set(q, 'iv', t.iv) || changed;
  if (finite(t.delta) && t.delta >= -1 && t.delta <= 1) changed = set(q, 'delta', t.delta) || changed;
  if (finite(t.gamma) && t.gamma !== -2 && t.gamma > -1e6) changed = set(q, 'gamma', t.gamma) || changed;
  if (finite(t.vega) && t.vega !== -2) changed = set(q, 'vega', t.vega) || changed;
  if (finite(t.theta) && t.theta !== -2) changed = set(q, 'theta', t.theta) || changed;
  if (finite(t.undPrice) && t.undPrice > 0) changed = set(q, 'undPrice', t.undPrice) || changed;
  return changed;
}

/** Applies one tick to the quote in place. Returns true when a field changed. */
export function applyTick(q: Quote, tick: TickEvent, ctx: TickContext): boolean {
  switch (tick.kind) {
    case 'price':
      return applyPrice(q, tick.field, tick.value, ctx);
    case 'size':
      return applySize(q, tick.field, tick.value, ctx);
    case 'generic':
      return applyGeneric(q, tick.field, tick.value);
    case 'string':
      return applyString(q, tick.field, tick.value);
    case 'option':
      return applyOption(q, tick);
  }
}

/** Mid price of a two-sided quote, or undefined. */
export function midPrice(q: Pick<Quote, 'bid' | 'ask'>): number | undefined {
  return q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : undefined;
}

/** Last trade price, falling back to the mid. Used for alert evaluation. */
export function lastOrMid(q: Pick<Quote, 'last' | 'bid' | 'ask'>): number | undefined {
  if (q.last != null && q.last > 0) return q.last;
  return midPrice(q);
}
