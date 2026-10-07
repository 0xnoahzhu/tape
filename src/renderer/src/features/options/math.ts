// Option math for the options desk: Black–Scholes prices and greeks, time to expiry,
// and strategy analysis (payoff, breakevens, max profit / loss, probability of profit).
// Pure functions only; no store or DOM access.

import type { OptionRight } from '@shared/types';

/** Risk-free rate used by the model (annual, continuously compounded). */
export const RISK_FREE_RATE = 0.045;

const YEAR_MS = 365 * 86_400_000;
const INV_SQRT_2PI = 0.3989422804014327;

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = INV_SQRT_2PI * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp((-x * x) / 2);
}

export function intrinsic(spot: number, strike: number, right: OptionRight): number {
  return right === 'C' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/** Model output per share. Theta is per calendar day, vega per one volatility point. */
export interface BsResult {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** Risk-neutral probability of expiring in the money, N(d2) / N(−d2). */
  itm: number;
}

/** Black–Scholes (European, no dividends). `t` in years, `sigma` as a fraction (0.25 = 25%). */
export function blackScholes(spot: number, strike: number, t: number, sigma: number, right: OptionRight, r = RISK_FREE_RATE): BsResult {
  if (t <= 1e-9 || !(sigma > 0) || !(spot > 0) || !(strike > 0)) {
    const i = intrinsic(spot, strike, right);
    const itm = i > 0 ? 1 : 0;
    return { price: i, delta: right === 'C' ? itm : -itm, gamma: 0, theta: 0, vega: 0, itm };
  }
  const sqrtT = Math.sqrt(t);
  const sT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + (r + (sigma * sigma) / 2) * t) / sT;
  const d2 = d1 - sT;
  const df = Math.exp(-r * t);
  const pdf1 = normPdf(d1);
  const gamma = pdf1 / (spot * sT);
  const vega = (spot * pdf1 * sqrtT) / 100;
  const decay = (-spot * pdf1 * sigma) / (2 * sqrtT);
  if (right === 'C') {
    return {
      price: spot * normCdf(d1) - strike * df * normCdf(d2),
      delta: normCdf(d1),
      gamma,
      vega,
      theta: (decay - r * strike * df * normCdf(d2)) / 365,
      itm: normCdf(d2),
    };
  }
  return {
    price: strike * df * normCdf(-d2) - spot * normCdf(-d1),
    delta: normCdf(d1) - 1,
    gamma,
    vega,
    theta: (decay + r * strike * df * normCdf(-d2)) / 365,
    itm: normCdf(-d2),
  };
}

/** Probability of touching the strike before expiry (reflection-principle approximation). */
export function touchProbability(itm: number): number {
  return Math.min(1, 2 * itm);
}

/** Unix ms of the 16:00 New York close on an expiry date (YYYYMMDD). */
export function expiryCloseMs(yyyymmdd: string): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  // 16:00 New York is 20:00 UTC in summer and 21:00 UTC in winter; correct the guess with Intl.
  const guess = Date.UTC(y, m, d, 20);
  const parts = nyHourFormatter.formatToParts(new Date(guess));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 16) % 24;
  return guess + (16 - hour) * 3_600_000;
}

const nyHourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });

/** Years from `now` until the expiry close (0 once expired). */
export function yearsToExpiry(yyyymmdd: string, now: number = Date.now()): number {
  return Math.max(0, expiryCloseMs(yyyymmdd) - now) / YEAR_MS;
}

/** One standard deviation move of the underlying until expiry. */
export function expectedMove(spot: number, iv: number, t: number): number {
  return spot * iv * Math.sqrt(Math.max(0, t));
}

/** Lognormal probability that the underlying ends below `x` after `t` years. */
export function probBelow(x: number, spot: number, sigma: number, t: number, r = RISK_FREE_RATE): number {
  if (x <= 0) return 0;
  if (!Number.isFinite(x)) return 1;
  if (t <= 0 || sigma <= 0) return x > spot ? 1 : 0;
  const z = (Math.log(x / spot) - (r - (sigma * sigma) / 2) * t) / (sigma * Math.sqrt(t));
  return normCdf(z);
}

// ---------------------------------------------------------------------------
// Strategies

export interface PayoffLeg {
  kind: OptionRight | 'S';
  /** 0 for stock legs. */
  strike: number;
  sign: 1 | -1;
  qty: number;
  /** Shares per unit of qty (100 for options; stock legs are counted in 100-share lots). */
  multiplier: number;
  /** Entry price per share. */
  price: number;
  /** Implied volatility; needed to value the leg before its expiry. */
  iv?: number;
  /** Years until this leg's expiry (0 for stock). */
  t: number;
}

/** Per-share value of a leg at underlying price `x` after `elapsed` years (NaN when it cannot be priced). */
export function legValue(leg: PayoffLeg, x: number, elapsed: number, r = RISK_FREE_RATE): number {
  if (leg.kind === 'S') return x;
  const rem = leg.t - elapsed;
  if (rem <= 1e-9) return intrinsic(x, leg.strike, leg.kind);
  if (leg.iv == null || !(leg.iv > 0)) return NaN;
  return blackScholes(x, leg.strike, rem, leg.iv, leg.kind, r).price;
}

/** Strategy P/L in dollars at underlying price `x`, `elapsed` years from now. */
export function strategyPnl(legs: PayoffLeg[], x: number, elapsed: number, r = RISK_FREE_RATE): number {
  let sum = 0;
  for (const l of legs) sum += l.sign * l.qty * l.multiplier * (legValue(l, x, elapsed, r) - l.price);
  return sum;
}

/** Net premium in dollars: positive = debit (paid), negative = credit (received). */
export function netCost(legs: PayoffLeg[]): number {
  return legs.reduce((a, l) => a + l.sign * l.qty * l.multiplier * l.price, 0);
}

/** Time of the first option expiry, in years (the "at expiry" horizon). */
export function nearestExpiry(legs: PayoffLeg[]): number {
  const ts = legs.filter((l) => l.kind !== 'S').map((l) => l.t);
  return ts.length ? Math.min(...ts) : 0;
}

/** P/L slope in $ per $1 as the underlying goes to infinity (calls and stock behave like stock). */
export function asymptoticSlope(legs: PayoffLeg[]): number {
  return legs.reduce((a, l) => a + (l.kind === 'P' ? 0 : l.sign * l.qty * l.multiplier), 0);
}

export interface StrategyAnalysis {
  /** Net premium: positive = debit, negative = credit. */
  cost: number;
  /** Largest P/L at the first expiry (bounded part of the curve). */
  maxProfit: number;
  /** Smallest P/L at the first expiry (negative = loss). */
  maxLoss: number;
  profitUnlimited: boolean;
  lossUnlimited: boolean;
  breakevens: number[];
  /** Probability of a positive P/L at the first expiry; null without a volatility. */
  pop: number | null;
  /** Horizon of the analysis in years. */
  horizon: number;
}

/**
 * Analyzes a strategy at the first expiry. Returns null when a leg cannot be priced
 * (missing entry price, or a later-expiry leg without implied volatility).
 * `sigma` is the volatility used for the probability of profit.
 */
export function analyzeStrategy(legs: PayoffLeg[], spot: number, sigma: number | undefined, r = RISK_FREE_RATE): StrategyAnalysis | null {
  if (!legs.length || !(spot > 0)) return null;
  if (legs.some((l) => !Number.isFinite(l.price))) return null;
  const horizon = nearestExpiry(legs);
  const pl = (x: number) => strategyPnl(legs, x, horizon, r);
  if (!Number.isFinite(pl(spot))) return null;

  const strikes = legs.filter((l) => l.kind !== 'S').map((l) => l.strike);
  const xMax = Math.max(3 * spot, ...strikes.map((k) => 2 * k));
  const grid = new Set<number>([0]);
  const N = 1500;
  for (let i = 1; i <= N; i++) grid.add((xMax * i) / N);
  for (const k of strikes) grid.add(k);
  grid.add(spot);
  const xs = [...grid].sort((a, b) => a - b);
  const ys = xs.map(pl);

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const y of ys) {
    if (y > maxProfit) maxProfit = y;
    if (y < maxLoss) maxLoss = y;
  }
  const slope = asymptoticSlope(legs);
  const profitUnlimited = slope > 1e-9;
  const lossUnlimited = slope < -1e-9;

  const breakevens: number[] = [];
  const tol = spot * 1e-6;
  for (let i = 1; i < xs.length; i++) {
    const y0 = ys[i - 1];
    const y1 = ys[i];
    if ((y0 < 0 && y1 >= 0) || (y0 > 0 && y1 <= 0)) {
      const x = y1 === y0 ? xs[i] : xs[i - 1] + ((xs[i] - xs[i - 1]) * -y0) / (y1 - y0);
      if (!breakevens.length || Math.abs(x - breakevens[breakevens.length - 1]) > tol) breakevens.push(x);
    }
  }

  let pop: number | null = null;
  if (sigma != null && sigma > 0) {
    const bounds = [0, ...breakevens, Infinity];
    pop = 0;
    for (let i = 1; i < bounds.length; i++) {
      const a = bounds[i - 1];
      const b = bounds[i];
      const probe = b === Infinity ? Math.max(a * 1.25, xMax) : a === 0 ? b / 2 : (a + b) / 2;
      if (pl(probe) > 0) pop += probBelow(b, spot, sigma, horizon, r) - probBelow(a, spot, sigma, horizon, r);
    }
    pop = Math.min(1, Math.max(0, pop));
  }

  return { cost: netCost(legs), maxProfit, maxLoss, profitUnlimited, lossUnlimited, breakevens, pop, horizon };
}

/** Sampled P/L curve between `lo` and `hi` (inclusive), `n` intervals. */
export function payoffCurve(legs: PayoffLeg[], lo: number, hi: number, n: number, elapsed: number, r = RISK_FREE_RATE): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    out.push({ x, y: strategyPnl(legs, x, elapsed, r) });
  }
  return out;
}

export interface Greeks4 {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** Position greeks: per-share greeks × sign × qty × multiplier, summed. Null if any leg lacks greeks. */
export function netGreeks(legs: Array<{ sign: 1 | -1; qty: number; multiplier: number; greeks: Greeks4 | null }>): Greeks4 | null {
  const out: Greeks4 = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of legs) {
    if (!l.greeks) return null;
    const k = l.sign * l.qty * l.multiplier;
    out.delta += k * l.greeks.delta;
    out.gamma += k * l.greeks.gamma;
    out.theta += k * l.greeks.theta;
    out.vega += k * l.greeks.vega;
  }
  return out;
}

/** IV rank and percentile of `current` within a history of implied volatilities. */
export function ivRank(history: number[], current: number): { rank: number; percentile: number; min: number; max: number } | null {
  const h = history.filter((v) => Number.isFinite(v) && v > 0);
  if (h.length < 2 || !(current > 0)) return null;
  const min = Math.min(...h);
  const max = Math.max(...h);
  const rank = max > min ? Math.min(1, Math.max(0, (current - min) / (max - min))) : 0.5;
  const percentile = h.filter((v) => v < current).length / h.length;
  return { rank, percentile, min, max };
}
