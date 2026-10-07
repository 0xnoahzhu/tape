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
  LOW_13_WEEK: 15,
  HIGH_13_WEEK: 16,
  LOW_26_WEEK: 17,
  HIGH_26_WEEK: 18,
  LOW_52_WEEK: 19,
  HIGH_52_WEEK: 20,
  AVG_VOLUME: 21,
  OPTION_HISTORICAL_VOL: 23,
  OPTION_IMPLIED_VOL: 24,
  OPTION_CALL_OPEN_INTEREST: 27,
  OPTION_PUT_OPEN_INTEREST: 28,
  OPTION_CALL_VOLUME: 29,
  OPTION_PUT_VOLUME: 30,
  AUCTION_VOLUME: 34,
  AUCTION_PRICE: 35,
  AUCTION_IMBALANCE: 36,
  MARK_PRICE: 37,
  LAST_TIMESTAMP: 45,
  SHORTABLE: 46,
  RT_VOLUME: 48,
  HALTED: 49,
  BID_YIELD: 50,
  ASK_YIELD: 51,
  LAST_YIELD: 52,
  TRADE_COUNT: 54,
  TRADE_RATE: 55,
  VOLUME_RATE: 56,
  LAST_RTH_TRADE: 57,
  RT_HISTORICAL_VOL: 58,
  IB_DIVIDENDS: 59,
  BOND_FACTOR_MULTIPLIER: 60,
  REGULATORY_IMBALANCE: 61,
  SHORT_TERM_VOLUME_3_MIN: 63,
  SHORT_TERM_VOLUME_5_MIN: 64,
  SHORT_TERM_VOLUME_10_MIN: 65,
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
  FUTURES_OPEN_INTEREST: 86,
  AVG_OPT_VOLUME: 87,
  DELAYED_LAST_TIMESTAMP: 88,
  SHORTABLE_SHARES: 89,
  DELAYED_HALTED: 90,
  ETF_NAV_LAST: 96,
  ETF_NAV_FROZEN_LAST: 97,
  ETF_NAV_HIGH: 98,
  ETF_NAV_LOW: 99,
  DELAYED_YIELD_BID: 103,
  DELAYED_YIELD_ASK: 104,
  /** "SLB Rate - Fee" (generic tick 499; not in IB's TickType list). */
  SLB_FEE: 111,
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
  [TICK.LOW_13_WEEK]: 'week13Low',
  [TICK.HIGH_13_WEEK]: 'week13High',
  [TICK.LOW_26_WEEK]: 'week26Low',
  [TICK.HIGH_26_WEEK]: 'week26High',
  [TICK.LOW_52_WEEK]: 'week52Low',
  [TICK.HIGH_52_WEEK]: 'week52High',
  [TICK.AUCTION_PRICE]: 'auctionPrice',
  [TICK.MARK_PRICE]: 'mark',
  [TICK.BID_YIELD]: 'bidYield',
  [TICK.ASK_YIELD]: 'askYield',
  [TICK.LAST_YIELD]: 'lastYield',
  [TICK.LAST_RTH_TRADE]: 'lastRthTrade',
  [TICK.DELAYED_BID]: 'bid',
  [TICK.DELAYED_ASK]: 'ask',
  [TICK.DELAYED_LAST]: 'last',
  [TICK.DELAYED_HIGH]: 'high',
  [TICK.DELAYED_LOW]: 'low',
  [TICK.DELAYED_CLOSE]: 'close',
  [TICK.DELAYED_OPEN]: 'open',
  [TICK.ETF_NAV_LAST]: 'etfNav',
  [TICK.ETF_NAV_FROZEN_LAST]: 'etfNav',
  [TICK.ETF_NAV_HIGH]: 'etfNavHigh',
  [TICK.ETF_NAV_LOW]: 'etfNavLow',
  [TICK.DELAYED_YIELD_BID]: 'bidYield',
  [TICK.DELAYED_YIELD_ASK]: 'askYield',
  [TICK.SLB_FEE]: 'borrowFee',
};

const SIZE_FIELDS: Partial<Record<number, NumericField>> = {
  [TICK.BID_SIZE]: 'bidSize',
  [TICK.ASK_SIZE]: 'askSize',
  [TICK.LAST_SIZE]: 'lastSize',
  [TICK.VOLUME]: 'volume',
  [TICK.AVG_VOLUME]: 'avgVolume',
  [TICK.AUCTION_VOLUME]: 'auctionVolume',
  [TICK.AUCTION_IMBALANCE]: 'auctionImbalance',
  [TICK.REGULATORY_IMBALANCE]: 'regulatoryImbalance',
  [TICK.SHORT_TERM_VOLUME_3_MIN]: 'volume3m',
  [TICK.SHORT_TERM_VOLUME_5_MIN]: 'volume5m',
  [TICK.SHORT_TERM_VOLUME_10_MIN]: 'volume10m',
  [TICK.DELAYED_BID_SIZE]: 'bidSize',
  [TICK.DELAYED_ASK_SIZE]: 'askSize',
  [TICK.DELAYED_LAST_SIZE]: 'lastSize',
  [TICK.DELAYED_VOLUME]: 'volume',
  [TICK.FUTURES_OPEN_INTEREST]: 'futuresOpenInterest',
  [TICK.AVG_OPT_VOLUME]: 'avgOptionVolume',
  [TICK.SHORTABLE_SHARES]: 'shortableShares',
};

/** Prices where 0 is a real quote (an option without bids still shows 0.00). */
const ZERO_OK_PRICES = new Set<NumericField>(['bid', 'ask']);
/** Prices that may be 0 or negative: bond yields. */
const SIGNED_PRICES = new Set<NumericField>(['bidYield', 'askYield', 'lastYield']);
/** Sizes with a side: an auction imbalance is a buy or a sell excess. */
const SIGNED_SIZES = new Set<NumericField>(['auctionImbalance', 'regulatoryImbalance']);

/**
 * The Quote fields each generic tick id brings (the ticks it makes IB send). A line's generic
 * values never outlive it: clearGenericFields empties them for every new line, so a field IB does
 * not send on the new one (a delayed line gets no dividends) shows "—" instead of an older value.
 */
export const GENERIC_FIELDS: Readonly<Record<number, readonly (keyof Quote)[]>> = {
  100: ['callVolume', 'putVolume'],
  101: ['callOpenInterest', 'putOpenInterest', 'openInterest'],
  104: ['histVol'],
  105: ['avgOptionVolume'],
  106: ['impliedVol'],
  165: ['week13Low', 'week13High', 'week26Low', 'week26High', 'week52Low', 'week52High', 'avgVolume'],
  221: ['mark'],
  225: ['auctionVolume', 'auctionPrice', 'auctionImbalance', 'regulatoryImbalance'],
  233: ['vwap'],
  236: ['shortable', 'shortableShares'],
  293: ['tradeCount'],
  294: ['tradeRate'],
  295: ['volumeRate'],
  318: ['lastRthTrade'],
  411: ['rtHistVol'],
  456: ['dividends'],
  460: ['bondFactor'],
  499: ['borrowFee'],
  577: ['etfNav'],
  588: ['futuresOpenInterest'],
  595: ['volume3m', 'volume5m', 'volume10m'],
  614: ['etfNavHigh', 'etfNavLow'],
  623: ['etfNav'],
};

/**
 * Bond yields (ticks 50–52, delayed 103 / 104). They come with a bond line's prices, but the last
 * yield has no delayed tick: kept across lines, a line that turns delayed would show a live one for
 * good. So they go with the generic values, on every new line and every live ↔ delayed change.
 */
const LINE_YIELDS: readonly (keyof Quote)[] = ['bidYield', 'askYield', 'lastYield'];

/**
 * Generic values IB sends on delayed lines too (probe of the paper account, October 2026): the mark
 * (37), the 165 values (week ranges 15–20, seen on a delayed index, with the average volume 21),
 * implied volatility (24), open interest (27 / 28, futures 86) and the volume rate (56). IB sends some
 * of them only once a line, so a line that changes between live and delayed keeps them.
 */
export const DELAYED_TOO: ReadonlySet<keyof Quote> = new Set<keyof Quote>([
  'mark',
  ...GENERIC_FIELDS[165],
  'impliedVol',
  'callOpenInterest',
  'putOpenInterest',
  'openInterest',
  'futuresOpenInterest',
  'volumeRate',
]);

/**
 * Clears every field a generic tick brings, and the bond yields, for a new line requested with
 * `ticks` (a genericTicksFor list). Only the mark stays, when the new line asks for it too (221):
 * options are valued at it, and IB sends it on delayed lines as well. Returns true when a field changed.
 */
export function clearGenericFields(q: Quote, ticks: string): boolean {
  const keepMark = ticks.split(',').includes('221');
  let changed = false;
  for (const fields of Object.values(GENERIC_FIELDS)) {
    for (const f of fields) if (!(keepMark && f === 'mark')) changed = set(q, f, undefined) || changed;
  }
  for (const f of LINE_YIELDS) changed = set(q, f, undefined) || changed;
  return changed;
}

/**
 * Clears what a line whose data type changed between live (1, 2) and delayed (3, 4) may not get
 * again: the generic values IB is not known to send on delayed lines (dividends, the last RTH trade,
 * …) and the bond yields. Those of DELAYED_TOO stay: IB sends them on the new data type as well, some
 * only at the start of a line. Returns true when a field changed.
 */
export function clearLiveOnlyFields(q: Quote): boolean {
  let changed = false;
  for (const fields of Object.values(GENERIC_FIELDS)) {
    for (const f of fields) if (!DELAYED_TOO.has(f)) changed = set(q, f, undefined) || changed;
  }
  for (const f of LINE_YIELDS) changed = set(q, f, undefined) || changed;
  return changed;
}

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
      optPrice?: number;
      pvDividend?: number;
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
  /** Per-line state kept by applyTick: the line has sent a previous close (see applyClose). */
  hasClose?: boolean;
  /** Per-line state: the line has sent an ETF NAV (96), so the frozen one (97) no longer counts. */
  hasNav?: boolean;
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
  if (SIGNED_PRICES.has(field)) return v;
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
  if (key === 'close') return applyClose(q, v, ctx);
  // The frozen NAV (97) stands in until the line sends a live one (96).
  if (field === TICK.ETF_NAV_FROZEN_LAST && ctx.hasNav) return false;
  if (field === TICK.ETF_NAV_LAST && v !== undefined) ctx.hasNav = true;
  return set(q, key, v);
}

/**
 * The previous close (9, or 75 on a delayed line), the reference of every change. IB sends it with
 * a request's first ticks, often before the line's marketDataType, and then only when it changes (a
 * new session's close replaces it). A line's close is taken whether live or delayed: both are the
 * same number, and the quote's data type may still be the previous line's. IB's "not available"
 * markers (-1, 0, Double.MAX) never erase a close the same line has sent (IB does not send it
 * again); on a new line (a reconnect, maybe a new session) they do, so a close from an older line
 * is not kept as this one's reference.
 */
function applyClose(q: Quote, v: number | undefined, ctx: TickContext): boolean {
  if (v === undefined) return ctx.hasClose ? false : set(q, 'close', undefined);
  ctx.hasClose = true;
  return set(q, 'close', v);
}

function applySize(q: Quote, field: number, value: number | undefined, ctx: TickContext): boolean {
  const key = SIZE_FIELDS[field];
  if (key) return set(q, key, SIGNED_SIZES.has(key) ? (finite(value) ? value : undefined) : sizeValue(value));
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
    case TICK.RT_HISTORICAL_VOL:
      return set(q, 'rtHistVol', finite(value) && value > 0 ? value : undefined);
    case TICK.SHORTABLE:
      // IB's raw code: above 2.5 at least 1000 shares to borrow, above 1.5 on locate, else none.
      return set(q, 'shortable', finite(value) && value >= 0 ? value : undefined);
    case TICK.TRADE_COUNT:
      return set(q, 'tradeCount', sizeValue(value));
    case TICK.TRADE_RATE:
      return set(q, 'tradeRate', sizeValue(value));
    case TICK.VOLUME_RATE:
      return set(q, 'volumeRate', sizeValue(value));
    case TICK.BOND_FACTOR_MULTIPLIER:
      return set(q, 'bondFactor', finite(value) && value > 0 ? value : undefined);
    case TICK.HALTED:
    case TICK.DELAYED_HALTED: {
      // -1 = not available, 0 = trading, 1 = general halt, 2 = volatility halt.
      if (!finite(value) || value < 0) return false;
      const code = value === 1 || value === 2 ? value : 0;
      const changed = set(q, 'halted', value > 0);
      return set(q, 'haltCode', code) || changed;
    }
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

/** The VWAP of an RTVolume string (its fifth field), or undefined when it carries none. */
export function parseVwap(value: string | undefined): number | undefined {
  const field = (value ?? '').split(';')[4]?.trim();
  const v = Number(field);
  return field && finite(v) && v > 0 ? v : undefined;
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
      // "price;size;time(ms);totalVolume;VWAP;singleTrade". Only the VWAP is taken: the last trade
      // and the volume come from ticks 4, 5, 45 and 8 (RTVolume counts other trades, and a second
      // source would make them jump).
      const vwap = parseVwap(value);
      return vwap !== undefined ? set(q, 'vwap', vwap) : false;
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
  if (finite(t.optPrice) && t.optPrice >= 0) changed = set(q, 'optPrice', t.optPrice) || changed;
  if (finite(t.pvDividend) && t.pvDividend >= 0) changed = set(q, 'pvDividend', t.pvDividend) || changed;
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
