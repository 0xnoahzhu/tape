// Option chain structure and per-contract derived values for the options desk.
// Pure functions only.

import { daysToExpiry, expiryDate, option } from '@shared/contract';
import { DASH, f0, f2, sg } from '@shared/format';
import type { ContractRef, Lang, OptionChainParams, OptionRight, Quote } from '@shared/types';
import { blackScholes, intrinsic, touchProbability } from './math';

/** One expiration of the chain with the trading class that lists it. */
export interface ChainExpiry {
  expiry: string;
  tradingClass: string;
  multiplier: number;
  exchange: string;
  /**
   * Ascending. Union over the trading class (not every strike trades in every expiry); the desk
   * drops the strikes IB reports as unlisted in this expiry (see listing.ts).
   */
  strikes: number[];
}

/**
 * Merges reqSecDefOptParams results into one list of expirations. Prefers the SMART
 * exchange (else the exchange with the most expirations); when several trading classes
 * list the same expiry (SPX / SPXW), the class named like the underlying wins.
 */
export function buildChain(params: OptionChainParams[], symbol: string, now: Date = new Date()): ChainExpiry[] {
  if (!params.length) return [];
  const byExchange = new Map<string, OptionChainParams[]>();
  for (const p of params) byExchange.set(p.exchange, [...(byExchange.get(p.exchange) ?? []), p]);
  let chosen = byExchange.get('SMART');
  if (!chosen) {
    const count = (ps: OptionChainParams[]) => ps.reduce((a, p) => a + p.expirations.length, 0);
    chosen = [...byExchange.values()].sort((a, b) => count(b) - count(a))[0];
  }
  const ranked = [...chosen].sort((a, b) => Number(b.tradingClass === symbol) - Number(a.tradingClass === symbol));
  const out = new Map<string, ChainExpiry>();
  for (const p of ranked) {
    const strikes = [...new Set(p.strikes)].filter((k) => k > 0).sort((a, b) => a - b);
    if (!strikes.length) continue;
    for (const e of p.expirations) {
      if (out.has(e) || !/^\d{8}$/.test(e) || daysToExpiry(e, now) < 0) continue;
      out.set(e, { expiry: e, tradingClass: p.tradingClass, multiplier: p.multiplier || 100, exchange: p.exchange, strikes });
    }
  }
  return [...out.values()].sort((a, b) => a.expiry.localeCompare(b.expiry));
}

export type ExpiryKind = 'W' | 'M' | 'Q' | 'L';

function isThirdFriday(d: Date): boolean {
  return d.getDay() === 5 && d.getDate() >= 15 && d.getDate() <= 21;
}

/** Last weekday of the month. */
function isLastWeekday(d: Date): boolean {
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const skip = next.getDay() === 6 ? 2 : next.getDay() === 0 ? 1 : 0;
  const nextWeekday = new Date(next.getFullYear(), next.getMonth(), next.getDate() + skip);
  return nextWeekday.getMonth() !== d.getMonth();
}

/**
 * W = weekly, M = monthly (third Friday, or the Thursday before when Friday is a holiday),
 * Q = quarterly (monthly in Mar/Jun/Sep/Dec, or the quarter's last business day),
 * L = LEAPS (more than a year out).
 */
export function expiryKind(yyyymmdd: string, now: Date = new Date()): ExpiryKind {
  if (daysToExpiry(yyyymmdd, now) > 365) return 'L';
  const d = expiryDate(yyyymmdd);
  const friday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const monthly = isThirdFriday(d) || (d.getDay() === 4 && isThirdFriday(friday));
  const quarterMonth = d.getMonth() % 3 === 2;
  if (quarterMonth && (monthly || isLastWeekday(d))) return 'Q';
  return monthly ? 'M' : 'W';
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MONTH_LABEL = {
  en: (y: string, m: number) => `${MONTHS_EN[m - 1]} ${y}`,
  zh: (y: string, m: number) => `${y}年${m}月`,
};

/** "Oct 2026" / "2026年10月". */
export function monthLabel(yyyymmdd: string, lang: Lang): string {
  const y = yyyymmdd.slice(0, 4);
  const m = Number(yyyymmdd.slice(4, 6));
  return MONTH_LABEL[lang](y, m);
}

/** Expirations grouped by calendar month, in order. */
export function groupByMonth<T extends { expiry: string }>(items: T[], lang: Lang): Array<{ name: string; rows: T[] }> {
  const groups: Array<{ name: string; rows: T[] }> = [];
  for (const it of items) {
    const name = monthLabel(it.expiry, lang);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.rows.push(it);
    else groups.push({ name, rows: [it] });
  }
  return groups;
}

/**
 * The expirations shown as chips: the first `n` plus the selected one, at most `max` chips
 * (the room in the tab bar). The selected expiry always keeps its chip while `max` ≥ 1.
 */
export function visibleExpiries(expiries: string[], selected: string | undefined, n = 6, max = n + 1): string[] {
  const sel = selected ? expiries.indexOf(selected) : -1;
  const head = Math.max(0, Math.min(n, sel >= Math.min(n, max) ? max - 1 : max));
  const set = new Set(expiries.slice(0, head));
  if (sel >= 0 && set.size < max) set.add(selected!);
  return expiries.filter((e) => set.has(e));
}

/**
 * Expirations sampled for the ATM term structure (design TERM): one per monthly cycle. When a
 * month lists several non-weekly dates (the AM-settled SPX Thursday next to the SPXW third
 * Friday, a quarter-end date) the third Friday wins. Falls back to every expiration when fewer
 * than four monthly cycles are listed.
 */
export function termExpiries<T extends { expiry: string }>(expiries: T[], n: number, now: Date = new Date()): T[] {
  const byMonth = new Map<string, T>();
  for (const e of expiries) {
    if (expiryKind(e.expiry, now) === 'W') continue;
    const month = e.expiry.slice(0, 6);
    const kept = byMonth.get(month);
    if (!kept || (!isThirdFriday(expiryDate(kept.expiry)) && isThirdFriday(expiryDate(e.expiry)))) byMonth.set(month, e);
  }
  const cycles = [...byMonth.values()];
  return (cycles.length >= 4 ? cycles : expiries).slice(0, n);
}

/** Index of the value closest to `x` (first on ties); -1 for an empty list. */
export function nearestIndex(values: number[], x: number): number {
  let best = -1;
  let dist = Infinity;
  values.forEach((v, i) => {
    const d = Math.abs(v - x);
    if (d < dist - 1e-9) {
      dist = d;
      best = i;
    }
  });
  return best;
}

/** Strike rows for a ±range window around `center` (index), clamped to the list. */
export function strikeWindow(strikes: number[], center: number, range: number | 'all'): { from: number; to: number } {
  if (range === 'all' || !strikes.length) return { from: 0, to: strikes.length };
  const from = Math.max(0, center - range);
  const to = Math.min(strikes.length, center + range + 1);
  return { from, to };
}

/** Builds the option contract for one chain cell. */
export function chainContract(symbol: string, e: ChainExpiry, strike: number, right: OptionRight): ContractRef {
  return option(symbol, e.expiry, strike, right, { tradingClass: e.tradingClass, multiplier: e.multiplier });
}

// ---------------------------------------------------------------------------
// Per-contract values

/** Quote plus model-derived values for one option. Undefined fields render as "—". */
export interface OptionData {
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  bidSize?: number;
  askSize?: number;
  volume?: number;
  oi?: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  /** Percent change of the last trade against the previous close. */
  chg?: number;
  /** Bid/ask spread as a percent of the mark. */
  sprd?: number;
  intr?: number;
  tv?: number;
  itm?: number;
  touch?: number;
}

const pos = (n: number | undefined): number | undefined => (n != null && Number.isFinite(n) && n > 0 ? n : undefined);
const num = (n: number | undefined): number | undefined => (n != null && Number.isFinite(n) ? n : undefined);

/** Mark price: IB's mark, else the bid/ask midpoint. */
export function markOf(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (pos(q.mark)) return q.mark;
  if (pos(q.ask) && q.bid != null && q.bid >= 0) return (q.bid + q.ask!) / 2;
  return undefined;
}

/**
 * Combines IB's quote and model greeks with Black–Scholes values derived from IB's
 * implied volatility (ITM / touch probability, missing greeks). `spot` and `t` (years)
 * may be unknown.
 */
export function optionData(q: Quote | undefined, strike: number, right: OptionRight, spot: number | undefined, t: number): OptionData {
  const d: OptionData = {};
  if (q) {
    d.bid = num(q.bid) != null && q.bid! >= 0 ? q.bid : undefined;
    d.ask = pos(q.ask);
    d.last = pos(q.last);
    d.mark = markOf(q);
    d.bidSize = num(q.bidSize);
    d.askSize = num(q.askSize);
    d.volume = num(q.volume);
    d.oi = num(q.openInterest);
    d.iv = pos(q.iv);
    d.delta = num(q.delta);
    d.gamma = num(q.gamma);
    d.theta = num(q.theta);
    d.vega = num(q.vega);
    if (d.last != null && pos(q.close)) d.chg = (d.last / q.close! - 1) * 100;
    if (d.bid != null && d.ask != null && d.mark) d.sprd = ((d.ask - d.bid) / d.mark) * 100;
  }
  const s = spot ?? pos(q?.undPrice);
  if (s != null) {
    d.intr = intrinsic(s, strike, right);
    if (d.mark != null) d.tv = Math.max(0, d.mark - d.intr);
    if (d.iv != null) {
      const bs = blackScholes(s, strike, t, d.iv, right);
      d.itm = bs.itm;
      d.touch = touchProbability(bs.itm);
      d.delta ??= bs.delta;
      d.gamma ??= bs.gamma;
      d.theta ??= bs.theta;
      d.vega ??= bs.vega;
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Columns (design COLS / FMT)

export type ColumnKey = 'bid' | 'ask' | 'last' | 'mark' | 'size' | 'chg' | 'sprd' | 'iv' | 'd' | 'g' | 'th' | 'vg' | 'intr' | 'tv' | 'itm' | 'touch' | 'vol' | 'oi';
export type ColumnPreset = 'key' | 'quotes' | 'greeks' | 'value';

export const COLUMN_PRESETS: Record<ColumnPreset, ColumnKey[]> = {
  key: ['oi', 'vol', 'iv', 'd', 'bid', 'ask'],
  quotes: ['bid', 'ask', 'last', 'mark', 'size', 'chg', 'sprd'],
  greeks: ['iv', 'd', 'g', 'th', 'vg', 'mark'],
  value: ['intr', 'tv', 'itm', 'touch', 'vol', 'oi'],
};

/** Fixed decimals with a true minus; values that round to zero lose their sign. */
export function fixed(n: number | undefined, digits: number): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const s = n.toFixed(digits);
  return /^-0?\.?0*$/.test(s) ? s.slice(1) : s.replace('-', '−');
}
const fx = fixed;
const pctOf = (n: number | undefined, digits: number) => (n == null ? DASH : (n * 100).toFixed(digits) + '%');

export function formatCell(key: ColumnKey, d: OptionData): string {
  switch (key) {
    case 'sprd':
      return d.sprd == null ? DASH : d.sprd.toFixed(1) + '%';
    case 'bid':
      return f2(d.bid);
    case 'ask':
      return f2(d.ask);
    case 'last':
      return f2(d.last);
    case 'mark':
      return f2(d.mark);
    case 'size':
      return d.bidSize == null && d.askSize == null ? DASH : `${d.bidSize ?? DASH}×${d.askSize ?? DASH}`;
    case 'chg':
      return d.chg == null ? DASH : sg(d.chg) + '%';
    case 'iv':
      return pctOf(d.iv, 1);
    case 'd':
      return fx(d.delta, 2);
    case 'g':
      return fx(d.gamma, 3);
    case 'th':
      return fx(d.theta, 3);
    case 'vg':
      return fx(d.vega, 3);
    case 'intr':
      return f2(d.intr);
    case 'tv':
      return f2(d.tv);
    case 'itm':
      return pctOf(d.itm, 0);
    case 'touch':
      return pctOf(d.touch, 0);
    case 'vol':
      return f0(d.volume);
    case 'oi':
      return f0(d.oi);
  }
}

/** Thresholds the design flags in red. */
export const WIDE_SPREAD_PCT = 10;
export const THIN_OPEN_INTEREST = 200;

/** Cell text color as in the design (bid = down color, ask = up color, flags in red). */
export function cellColor(key: ColumnKey, d: OptionData): string {
  if (key === 'sprd' && d.sprd != null && d.sprd > WIDE_SPREAD_PCT) return 'var(--r)';
  if (key === 'oi' && d.oi != null && d.oi < THIN_OPEN_INTEREST) return 'var(--r)';
  if (key === 'bid') return 'var(--dn)';
  if (key === 'ask') return 'var(--up)';
  if (key === 'chg') return d.chg == null || d.chg === 0 ? 'var(--mu)' : d.chg > 0 ? 'var(--up)' : 'var(--dn)';
  if (key === 'mark' || key === 'last') return 'var(--tx)';
  return 'var(--mu)';
}

/** ATM implied volatility: mean of the available call / put IVs. */
export function atmIv(call: Quote | undefined, put: Quote | undefined): number | undefined {
  const ivs = [call?.iv, put?.iv].filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : undefined;
}
