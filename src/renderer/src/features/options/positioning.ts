// Positioning math for the options desk's Positioning tab: dealer exposures by strike (gamma, delta,
// vanna, charm), the gamma profile over prices with its zero-gamma level, the call and put walls,
// max pain, open-interest change between two scans, unusual volume, and the daily levels over time.
// Pure functions only.
//
// Who holds what is not public: open interest counts contracts, not their owners. Like the usual
// GEX charts, the exposures assume dealers are long the calls (customers sell them) and short the
// puts (customers buy them); `callSign` -1 flips the calls (dealers short them, as where customers
// buy calls or covered calls are few). Units, per strike, all in the account's dollars of the
// underlying:
// - GEX: Γ × OI × multiplier × S² × 1%: the dollar delta dealers must trade for a 1% move;
// - DEX: Δ × OI × multiplier × S: the dealers' dollar delta;
// - vanna: ∂Δ/∂σ × OI × multiplier × S × 1 vol point: dollar delta for a 1-point rise in IV;
// - charm: the change in Δ over one calendar day × OI × multiplier × S.
// Greeks are Black–Scholes at each option's IV (an option without one takes its expiry's smile,
// interpolated in strike, vol.ts → smileIv); one with neither uses IB's gamma and delta, at the
// scan's price only.

import { daysToExpiry, option } from '@shared/contract';
import type { ContractRef, PositioningRow, PositioningSnapshot } from '@shared/types';
import type { ChainExpiry } from './chain';
import { blackScholes, expiryCloseMs, normPdf, RISK_FREE_RATE, yearsToExpiry } from './math';
import { smileIv } from './vol';

export type ExpiryScope = 'sel' | 7 | 30 | 90;
export const EXPIRY_SCOPES: readonly ExpiryScope[] = ['sel', 7, 30, 90];
/** Strikes within this share of the price on either side. */
export type StrikeSpan = 0.1 | 0.2 | 0.3;
export const STRIKE_SPANS: readonly StrikeSpan[] = [0.1, 0.2, 0.3];
/** What the by-strike chart shows. */
export type PosMetric = 'gex' | 'oi' | 'oiChg' | 'vol' | 'dex' | 'vanna' | 'charm';
export const POS_METRICS: readonly PosMetric[] = ['gex', 'oi', 'oiChg', 'vol', 'dex', 'vanna', 'charm'];
/** Options per scan, at most (main/market/positioning.ts allows 1500). */
export const SCAN_CAP = 1200;
/** Price points of the gamma profile. */
export const PROFILE_POINTS = 121;

const DAY_YEARS = 1 / 365;

/** The expiries a scope covers: the selected one, or every one within `scope` days (at least the first). */
export function scopeExpiries<T extends { expiry: string }>(all: readonly T[], scope: ExpiryScope, selected: string | undefined, now: Date = new Date()): T[] {
  if (scope === 'sel') return all.filter((e) => e.expiry === (selected ?? all[0]?.expiry));
  const within = all.filter((e) => daysToExpiry(e.expiry, now) <= scope);
  return within.length ? within : all.slice(0, 1);
}

/** The strike window [lo, hi] around `spot`. */
export const strikeBounds = (spot: number, span: StrikeSpan) => ({ lo: spot * (1 - span), hi: spot * (1 + span) });

/**
 * The calls and puts to scan: each expiry's strikes in [lo, hi], nearest expiry first, whole
 * expiries while they fit `cap` (`trimmed`: expiries left out). The first expiry always goes in,
 * its strikes nearest the price first when it alone is over the cap.
 */
export function scanContracts(symbol: string, expiries: readonly ChainExpiry[], spot: number, lo: number, hi: number, cap = SCAN_CAP): { contracts: ContractRef[]; trimmed: number } {
  const out: ContractRef[] = [];
  let trimmed = 0;
  for (const e of expiries) {
    let ks = e.strikes.filter((k) => k >= lo && k <= hi);
    if (out.length + ks.length * 2 > cap) {
      if (out.length) {
        trimmed++;
        continue;
      }
      ks = [...ks].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, Math.floor(cap / 2)).sort((a, b) => a - b);
    }
    for (const k of ks) for (const right of ['C', 'P'] as const) out.push(option(symbol, e.expiry, k, right, { tradingClass: e.tradingClass, multiplier: e.multiplier }));
  }
  return { contracts: out, trimmed };
}

/** A scanned option ready for the model: years to expiry and the IV used (its own, else its smile's). */
export interface Prepared extends PositioningRow {
  t: number;
  sigma?: number;
}

/** The rows of `expiries` with strikes in [lo, hi], each with its time to expiry and IV. */
export function prepare(rows: readonly PositioningRow[], now: number, filter?: { expiries: ReadonlySet<string>; lo: number; hi: number }): Prepared[] {
  const keep = filter ? rows.filter((r) => filter.expiries.has(r.expiry) && r.strike >= filter.lo && r.strike <= filter.hi) : [...rows];
  const smiles = new Map<string, Array<{ strike: number; iv: number }>>();
  for (const r of keep) {
    if (!(r.iv != null && r.iv > 0)) continue;
    const pts = smiles.get(r.expiry) ?? [];
    pts.push({ strike: r.strike, iv: r.iv });
    smiles.set(r.expiry, pts);
  }
  return keep.map((r) => {
    const sigma = r.iv != null && r.iv > 0 ? r.iv : (() => {
      const pts = smiles.get(r.expiry);
      return pts?.length ? smileIv(pts, r.strike) : undefined;
    })();
    return { ...r, t: yearsToExpiry(r.expiry, now), sigma };
  });
}

export interface Greeks {
  delta: number;
  gamma: number;
  /** ∂Δ/∂σ per 1.00 of volatility. */
  vanna: number;
  /** The change in Δ as one calendar day passes. */
  charm: number;
}

/**
 * Black–Scholes delta, gamma, vanna and charm at `s`; undefined without an IV or once expired. Charm
 * from ∂d1/∂τ = r / (σ√τ) − d2 / (2τ): Δ changes by −φ(d1) · ∂d1/∂τ per year as τ falls.
 */
export function greeksAt(s: number, k: number, t: number, sigma: number | undefined, right: 'C' | 'P', r = RISK_FREE_RATE): Greeks | undefined {
  if (!(sigma != null && sigma > 0) || !(t > 0) || !(s > 0) || !(k > 0)) return undefined;
  const bs = blackScholes(s, k, t, sigma, right, r);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + (sigma * sigma) / 2) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const pdf = normPdf(d1);
  const dd1 = r / (sigma * sqrtT) - d2 / (2 * t);
  return { delta: bs.delta, gamma: bs.gamma, vanna: (-pdf * d2) / sigma, charm: -pdf * dd1 * DAY_YEARS };
}

/** The dealers' assumed sign of an option: calls `callSign` (+1 long), puts short. */
export const dealerSign = (right: 'C' | 'P', callSign: 1 | -1) => (right === 'C' ? callSign : -1);

/** Per strike, summed over the expiries; exposures in dollars (see the header), signed for the dealers. */
export interface StrikeExposure {
  strike: number;
  callGex: number;
  putGex: number;
  gex: number;
  dex: number;
  vanna: number;
  charm: number;
  callOi: number;
  putOi: number;
  /** Open interest against the previous scan of the same options; undefined without one. */
  callOiChg?: number;
  putOiChg?: number;
  callVol: number;
  putVol: number;
}

const optKey = (r: Pick<PositioningRow, 'expiry' | 'strike' | 'right'>) => `${r.expiry}|${r.strike}|${r.right}`;

/** Open interest per option of a snapshot, for the change against it. */
export function oiMap(rows: readonly PositioningRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (r.oi != null) m.set(optKey(r), r.oi);
  return m;
}

export function exposureByStrike(rows: readonly Prepared[], spot: number, callSign: 1 | -1, prevOi?: ReadonlyMap<string, number>): StrikeExposure[] {
  const by = new Map<number, StrikeExposure>();
  for (const r of rows) {
    let e = by.get(r.strike);
    if (!e) {
      e = { strike: r.strike, callGex: 0, putGex: 0, gex: 0, dex: 0, vanna: 0, charm: 0, callOi: 0, putOi: 0, callVol: 0, putVol: 0 };
      by.set(r.strike, e);
    }
    const call = r.right === 'C';
    const oi = r.oi ?? 0;
    if (call) {
      e.callOi += oi;
      e.callVol += r.volume ?? 0;
    } else {
      e.putOi += oi;
      e.putVol += r.volume ?? 0;
    }
    const prev = prevOi?.get(optKey(r));
    if (prev != null && r.oi != null) {
      if (call) e.callOiChg = (e.callOiChg ?? 0) + r.oi - prev;
      else e.putOiChg = (e.putOiChg ?? 0) + r.oi - prev;
    }
    if (!oi) continue;
    const g = greeksAt(spot, r.strike, r.t, r.sigma, r.right);
    const gamma = g?.gamma ?? r.gamma ?? 0;
    const delta = g?.delta ?? r.delta ?? 0;
    const size = dealerSign(r.right, callSign) * oi * r.multiplier;
    const gex = size * gamma * spot * spot * 0.01;
    if (call) e.callGex += gex;
    else e.putGex += gex;
    e.gex += gex;
    e.dex += size * delta * spot;
    if (g) {
      e.vanna += size * g.vanna * spot * 0.01;
      e.charm += size * g.charm * spot;
    }
  }
  return [...by.values()].sort((a, b) => a.strike - b.strike);
}

/** Total GEX if the underlying were at each price in [lo, hi] (at the options' IVs, now). */
export function gexProfile(rows: readonly Prepared[], callSign: 1 | -1, lo: number, hi: number, n = PROFILE_POINTS): Array<{ x: number; gex: number }> {
  const live = rows.filter((r) => (r.oi ?? 0) > 0 && r.sigma != null && r.t > 0);
  const out: Array<{ x: number; gex: number }> = [];
  if (!(hi > lo) || n < 2) return out;
  for (let i = 0; i < n; i++) {
    const x = lo + ((hi - lo) * i) / (n - 1);
    let gex = 0;
    for (const r of live) {
      const g = greeksAt(x, r.strike, r.t, r.sigma, r.right);
      if (g) gex += dealerSign(r.right, callSign) * r.oi! * r.multiplier * g.gamma * x * x * 0.01;
    }
    out.push({ x, gex });
  }
  return out;
}

/** Where the profile changes sign, the crossing nearest `spot` (interpolated); undefined when it never does. */
export function zeroGamma(profile: ReadonlyArray<{ x: number; gex: number }>, spot: number): number | undefined {
  let best: number | undefined;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (a.gex === 0 && b.gex === 0) continue;
    if (Math.sign(a.gex) === Math.sign(b.gex) && a.gex !== 0) continue;
    const x = a.gex === b.gex ? a.x : a.x + ((b.x - a.x) * a.gex) / (a.gex - b.gex);
    if (best == null || Math.abs(x - spot) < Math.abs(best - spot)) best = x;
  }
  return best;
}

/** The strikes with the largest call GEX and the largest put GEX (in size); undefined where none is non-zero. */
export function walls(byStrike: readonly StrikeExposure[]): { call?: number; put?: number } {
  let call: StrikeExposure | undefined;
  let put: StrikeExposure | undefined;
  for (const e of byStrike) {
    if (Math.abs(e.callGex) > 0 && (!call || Math.abs(e.callGex) > Math.abs(call.callGex))) call = e;
    if (Math.abs(e.putGex) > 0 && (!put || Math.abs(e.putGex) > Math.abs(put.putGex))) put = e;
  }
  return { call: call?.strike, put: put?.strike };
}

/**
 * Max pain of one expiry's options: the strike where, settling there, the options' holders would
 * be paid the least (calls' and puts' intrinsic value times open interest). Only the strikes scanned
 * count, so a narrow window can move it.
 */
export function maxPain(rows: readonly PositioningRow[]): { strike: number; payout: number } | undefined {
  const withOi = rows.filter((r) => (r.oi ?? 0) > 0);
  if (!withOi.length) return undefined;
  const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
  let best: { strike: number; payout: number } | undefined;
  for (const p of strikes) {
    let payout = 0;
    for (const r of withOi) payout += r.oi! * r.multiplier * (r.right === 'C' ? Math.max(0, p - r.strike) : Math.max(0, r.strike - p));
    if (!best || payout < best.payout) best = { strike: p, payout };
  }
  return best;
}

export interface UnusualOption {
  expiry: string;
  strike: number;
  right: 'C' | 'P';
  volume: number;
  oi: number;
  /** Volume over open interest (Infinity when there was none). */
  ratio: number;
}

/** Options traded more than their open interest today (at least `minVolume`), highest ratio first. */
export function unusualVolume(rows: readonly PositioningRow[], n = 8, minVolume = 100): UnusualOption[] {
  return rows
    .filter((r) => (r.volume ?? 0) >= minVolume && (r.volume ?? 0) > (r.oi ?? 0))
    .map((r) => ({ expiry: r.expiry, strike: r.strike, right: r.right, volume: r.volume!, oi: r.oi ?? 0, ratio: r.oi ? r.volume! / r.oi : Infinity }))
    .sort((a, b) => b.ratio - a.ratio || b.volume - a.volume)
    .slice(0, n);
}

export interface Totals {
  gex: number;
  dex: number;
  vanna: number;
  charm: number;
  callOi: number;
  putOi: number;
  callVol: number;
  putVol: number;
  callOiChg?: number;
  putOiChg?: number;
}

export function totals(byStrike: readonly StrikeExposure[]): Totals {
  const t: Totals = { gex: 0, dex: 0, vanna: 0, charm: 0, callOi: 0, putOi: 0, callVol: 0, putVol: 0 };
  for (const e of byStrike) {
    t.gex += e.gex;
    t.dex += e.dex;
    t.vanna += e.vanna;
    t.charm += e.charm;
    t.callOi += e.callOi;
    t.putOi += e.putOi;
    t.callVol += e.callVol;
    t.putVol += e.putVol;
    if (e.callOiChg != null) t.callOiChg = (t.callOiChg ?? 0) + e.callOiChg;
    if (e.putOiChg != null) t.putOiChg = (t.putOiChg ?? 0) + e.putOiChg;
  }
  return t;
}

/** A day's levels, for the history chart. */
export interface DayLevels {
  day: string;
  spot?: number;
  gex: number;
  zeroGamma?: number;
  callWall?: number;
  putWall?: number;
  maxPain?: number;
}

/** The New York close of a trading day (YYYYMMDD), as the time its snapshot's levels are read at when it is past. */
const dayCloseMs = (day: string) => expiryCloseMs(day);

/**
 * A stored day's levels under the same rules as today's view: the expiries within `maxDays` of that
 * day (`'sel'`: the first one on or after it), the strikes within `span` of its price, at its price.
 */
export function dayLevels(snap: PositioningSnapshot, scope: ExpiryScope, span: StrikeSpan, callSign: 1 | -1, selected?: string): DayLevels {
  const spot = snap.spot;
  if (spot == null) return { day: snap.day, gex: 0 };
  const now = Math.min(snap.updatedAt, dayCloseMs(snap.day));
  const expiries = [...new Set(snap.rows.map((r) => r.expiry))].filter((e) => expiryCloseMs(e) > now).sort();
  const at = new Date(now);
  const pick =
    scope === 'sel'
      ? [selected && expiries.includes(selected) ? selected : expiries[0]].filter((e): e is string => !!e)
      : scopeExpiries(
          expiries.map((expiry) => ({ expiry })),
          scope,
          undefined,
          at,
        ).map((e) => e.expiry);
  const { lo, hi } = strikeBounds(spot, span);
  const rows = prepare(snap.rows, now, { expiries: new Set(pick), lo, hi });
  const by = exposureByStrike(rows, spot, callSign);
  const w = walls(by);
  const profile = gexProfile(rows, callSign, lo, hi, 41);
  const first = pick[0];
  return {
    day: snap.day,
    spot,
    gex: totals(by).gex,
    zeroGamma: zeroGamma(profile, spot),
    callWall: w.call,
    putWall: w.put,
    maxPain: first ? maxPain(rows.filter((r) => r.expiry === first))?.strike : undefined,
  };
}

/** Everything the Positioning tab shows of one snapshot, at `spot`. */
export interface PosView {
  lo: number;
  hi: number;
  by: StrikeExposure[];
  totals: Totals;
  walls: { call?: number; put?: number };
  profile: Array<{ x: number; gex: number }>;
  zero?: number;
  /** The nearest expiry with options in the window, and its max pain. */
  first?: string;
  maxPain?: number;
  perExpiry: Array<{ expiry: string; callOi: number; putOi: number; gex: number; maxPain?: number }>;
  unusual: UnusualOption[];
  /** An earlier snapshot was there to compare open interest with. */
  hasPrev: boolean;
}

/**
 * The view of `latest` (`prev`: the stored day before it, for the open interest change) for the
 * `expiries` (in order) and the strikes within `span` of `spot`.
 */
export function positioningView(latest: PositioningSnapshot, prev: PositioningSnapshot | undefined, spot: number, expiries: readonly string[], span: StrikeSpan, callSign: 1 | -1, now: number): PosView {
  const { lo, hi } = strikeBounds(spot, span);
  const rows = prepare(latest.rows, now, { expiries: new Set(expiries), lo, hi });
  const by = exposureByStrike(rows, spot, callSign, prev ? oiMap(prev.rows) : undefined);
  const profile = gexProfile(rows, callSign, lo, hi);
  const first = expiries.find((e) => rows.some((r) => r.expiry === e));
  const perExpiry = expiries.flatMap((e) => {
    const rs = rows.filter((r) => r.expiry === e);
    if (!rs.length) return [];
    const t = totals(exposureByStrike(rs, spot, callSign));
    return [{ expiry: e, callOi: t.callOi, putOi: t.putOi, gex: t.gex, maxPain: maxPain(rs)?.strike }];
  });
  return {
    lo,
    hi,
    by,
    totals: totals(by),
    walls: walls(by),
    profile,
    zero: zeroGamma(profile, spot),
    first,
    maxPain: first ? maxPain(rows.filter((r) => r.expiry === first))?.strike : undefined,
    perExpiry,
    unusual: unusualVolume(rows),
    hasPrev: !!prev,
  };
}
