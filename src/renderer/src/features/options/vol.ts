// Volatility analytics of the options desk's Volatility tab: realized volatility from daily closes,
// the 25Δ skew, the term structure's forward vols and constant-maturity IV, the move an event in
// the term structure prices, and IV rank over several look-backs. Pure functions only.

import { nyClock } from '@shared/session';
import { ivRank, RISK_FREE_RATE } from './math';

/** Trading days a year: realized volatility and daily moves are annualized with √252. */
export const TRADING_DAYS = 252;
/** Trading days in IV30's 30 calendar days: the window of HV 30. */
export const HV_DAYS = 21;
/** IV rank look-backs (weeks of daily IV closes, 5 a week). */
export const RANK_WEEKS = [13, 26, 52] as const;

const DAY = 1 / 365;

/** Calendar date (YYYYMMDD) of a daily bar: its time is 00:00 UTC of that date (unix seconds). */
export function barDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Daily bars of finished sessions: today's bar (New York) is left out before 16:00, while it can still change. */
export function finishedBars<T extends { time: number }>(bars: readonly T[], now: Date = new Date()): T[] {
  const { ymd, minutes } = nyClock(now);
  const last = bars[bars.length - 1];
  return last && barDate(last.time) === ymd && minutes < 16 * 60 ? bars.slice(0, -1) : [...bars];
}

/** Annualized sample standard deviation of daily log returns; undefined below two returns. */
function annualized(returns: readonly number[]): number | undefined {
  if (returns.length < 2) return undefined;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const v = returns.reduce((a, x) => a + (x - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(v * TRADING_DAYS);
}

/** Close-to-close volatility (annualized) of the last `n` daily returns; undefined with fewer, or a non-positive close among them. */
export function realizedVol(closes: readonly number[], n: number): number | undefined {
  if (n < 2 || closes.length < n + 1) return undefined;
  const last = closes.slice(-(n + 1));
  if (last.some((c) => !(c > 0))) return undefined;
  return annualized(last.slice(1).map((c, i) => Math.log(c / last[i])));
}

/** realizedVol of the `n` returns ending at each close (undefined for the first `n`). */
export function rollingVol(closes: readonly number[], n: number): Array<number | undefined> {
  return closes.map((_, i) => (i < n ? undefined : realizedVol(closes.slice(i - n, i + 1), n)));
}

/** One standard deviation of a day's move at an annualized volatility, in the price's units. */
export function dailyMove(price: number, vol: number): number {
  return (price * vol) / Math.sqrt(TRADING_DAYS);
}

/** HV over `n` days on each IV bar's date (from the daily closes); undefined where the closes lack that date. */
export function hvOnDates(ivTimes: readonly number[], barTimes: readonly number[], closes: readonly number[], n = HV_DAYS): Array<number | undefined> {
  const hv = rollingVol(closes, n);
  const byDate = new Map(barTimes.map((t, i) => [barDate(t), hv[i]]));
  return ivTimes.map((t) => byDate.get(barDate(t)));
}

/** IV / HV on the dates both exist. */
export function ivHvRatios(iv: readonly number[], hv: ReadonlyArray<number | undefined>): number[] {
  const out: number[] = [];
  iv.forEach((v, i) => {
    const h = hv[i];
    if (v > 0 && h != null && h > 0) out.push(v / h);
  });
  return out;
}

/** Share of `xs` below `x` (0–1); undefined for an empty list. */
export function percentileOf(xs: readonly number[], x: number): number | undefined {
  return xs.length ? xs.filter((v) => v < x).length / xs.length : undefined;
}

/** IV rank and percentile of `current` over the last 13, 26 and 52 weeks of daily IV closes. */
export function ivRanks(closes: readonly number[], current: number | undefined) {
  return RANK_WEEKS.map((weeks) => ({ weeks, stats: current != null ? ivRank(closes.slice(-weeks * 5), current) : null }));
}

/**
 * IV now against the last daily IV close dated before `todayYmd` (New York): the change since the
 * previous session. Undefined without both.
 */
export function ivChange(times: readonly number[], closes: readonly number[], current: number | undefined, todayYmd: string): number | undefined {
  if (current == null) return undefined;
  for (let i = Math.min(times.length, closes.length) - 1; i >= 0; i--) {
    if (barDate(times[i]) < todayYmd) return current - closes[i];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Skew

export interface DeltaPoint {
  strike: number;
  delta: number;
  iv: number;
}

/**
 * IV and strike at `target` delta (puts negative), interpolated linearly in delta between the two
 * points around it. Undefined when no two points bracket it: the 25Δ strike beyond the strikes quoted.
 */
export function atDelta(points: readonly DeltaPoint[], target: number): { iv: number; strike: number } | undefined {
  const ps = points.filter((p) => Number.isFinite(p.delta) && p.iv > 0).sort((a, b) => a.delta - b.delta);
  for (let i = 1; i < ps.length; i++) {
    const [a, b] = [ps[i - 1], ps[i]];
    if (a.delta > target || target > b.delta) continue;
    const f = b.delta === a.delta ? 0.5 : (target - a.delta) / (b.delta - a.delta);
    return { iv: a.iv + (b.iv - a.iv) * f, strike: a.strike + (b.strike - a.strike) * f };
  }
  return undefined;
}

/** One option of the smile, for the skew: its strike, right, IV, delta and bid. */
export interface SkewQuote {
  strike: number;
  right: 'C' | 'P';
  iv?: number;
  delta?: number;
  bid?: number;
}

/**
 * The out-of-the-money puts (strikes at or below `spot`) and calls (at or above) with an IV and a
 * delta, as delta points; an option bid at zero has no price to read an IV from and is left out.
 */
export function skewPoints(quotes: readonly SkewQuote[], spot: number): { puts: DeltaPoint[]; calls: DeltaPoint[] } {
  const ok = (q: SkewQuote) => q.iv != null && q.iv > 0 && q.delta != null && Number.isFinite(q.delta) && q.bid !== 0;
  const point = (q: SkewQuote) => ({ strike: q.strike, delta: q.delta!, iv: q.iv! });
  return {
    puts: quotes.filter((q) => q.right === 'P' && q.strike <= spot && ok(q)).map(point),
    calls: quotes.filter((q) => q.right === 'C' && q.strike >= spot && ok(q)).map(point),
  };
}

export interface Skew25 {
  /** IVs of the 25Δ put and call, and their (interpolated) strikes. */
  put: number;
  call: number;
  putStrike: number;
  callStrike: number;
  /** 25Δ put IV − 25Δ call IV: how much more the downside costs (vol points as a fraction). */
  skew: number;
  /** Butterfly: the 25Δ wings' mean IV over ATM; undefined without an ATM IV. */
  fly?: number;
}

/** The 25Δ skew of a smile's OTM puts and calls (skewPoints). */
export function skew25(puts: readonly DeltaPoint[], calls: readonly DeltaPoint[], atm: number | undefined): Skew25 | undefined {
  const put = atDelta(puts, -0.25);
  const call = atDelta(calls, 0.25);
  if (!put || !call) return undefined;
  return {
    put: put.iv,
    call: call.iv,
    putStrike: put.strike,
    callStrike: call.strike,
    skew: put.iv - call.iv,
    fly: atm != null && atm > 0 ? (put.iv + call.iv) / 2 - atm : undefined,
  };
}

/** N⁻¹(0.75): d1 of a 25Δ put (and −d1 of a 25Δ call). */
const Z25 = 0.6744897501960817;

/** Black–Scholes strikes of the 25Δ put and call at volatility `sigma`, `t` years out. */
export function delta25Strikes(spot: number, sigma: number, t: number, r = RISK_FREE_RATE): { put: number; call: number } {
  const sT = sigma * Math.sqrt(t);
  const drift = (r + (sigma * sigma) / 2) * t;
  return { put: spot * Math.exp(-Z25 * sT + drift), call: spot * Math.exp(Z25 * sT + drift) };
}

/** A smile's IV at strike `k`: linear in strike between the points around it, flat beyond the farthest. */
export function smileIv(points: ReadonlyArray<{ strike: number; iv: number }>, k: number): number | undefined {
  const ps = points.filter((p) => p.iv > 0).sort((a, b) => a.strike - b.strike);
  if (!ps.length) return undefined;
  if (k <= ps[0].strike) return ps[0].iv;
  for (let i = 1; i < ps.length; i++) {
    const [a, b] = [ps[i - 1], ps[i]];
    if (k <= b.strike) return a.iv + ((b.iv - a.iv) * (k - a.strike)) / (b.strike - a.strike);
  }
  return ps[ps.length - 1].iv;
}

/**
 * The listed strikes to quote for an expiry's 25Δ put and call beyond the `quoted` ones: on each
 * side the three nearest the Black–Scholes 25Δ strike, solved at the smile's own IV there
 * (smileIv over that side's OTM `points`, `atm` without any). OTM IVs are above ATM, which puts
 * 25Δ farther out than at the ATM IV; solving again as the farther options' IVs come in moves the
 * strikes to where 25Δ is.
 */
export function wingStrikes(
  strikes: readonly number[],
  quoted: ReadonlySet<number>,
  points: { puts: ReadonlyArray<{ strike: number; iv: number }>; calls: ReadonlyArray<{ strike: number; iv: number }> },
  spot: number,
  atm: number,
  t: number,
): { puts: number[]; calls: number[] } {
  const side = (pts: ReadonlyArray<{ strike: number; iv: number }>, pick: (k: { put: number; call: number }) => number) => {
    let k = pick(delta25Strikes(spot, atm, t));
    for (let i = 0; i < 4; i++) k = pick(delta25Strikes(spot, smileIv(pts, k) ?? atm, t));
    const at = strikes.findIndex((s) => s >= k);
    const i = at < 0 ? strikes.length - 1 : at > 0 && k - strikes[at - 1] < strikes[at] - k ? at - 1 : at;
    return strikes.slice(Math.max(0, i - 1), i + 2).filter((s) => !quoted.has(s));
  };
  return { puts: side(points.puts, (k) => k.put), calls: side(points.calls, (k) => k.call) };
}

// ---------------------------------------------------------------------------
// Term structure

/** A term structure point: years to its expiry and its ATM IV. */
export interface TermVol {
  t: number;
  iv: number;
}

/** Forward variance (annualized) between two term points: (σ₂²t₂ − σ₁²t₁) / (t₂ − t₁); undefined unless t₂ > t₁. */
export function forwardVariance(a: TermVol, b: TermVol): number | undefined {
  return b.t > a.t ? (b.iv * b.iv * b.t - a.iv * a.iv * a.t) / (b.t - a.t) : undefined;
}

/** The volatility priced between two expiries; undefined when their variances are inverted (negative forward variance). */
export function forwardVol(a: TermVol, b: TermVol): number | undefined {
  const v = forwardVariance(a, b);
  return v != null && v > 0 ? Math.sqrt(v) : undefined;
}

/** IV `t` years out, linear in total variance σ²t between the term points around it, flat beyond them. */
export function ivAt(points: readonly TermVol[], t: number): number | undefined {
  const ps = points.filter((p) => p.t > 0 && p.iv > 0).sort((a, b) => a.t - b.t);
  if (!ps.length || !(t > 0)) return undefined;
  if (t <= ps[0].t) return ps[0].iv;
  for (let i = 1; i < ps.length; i++) {
    const [a, b] = [ps[i - 1], ps[i]];
    if (t > b.t) continue;
    const w = a.iv * a.iv * a.t + ((b.iv * b.iv * b.t - a.iv * a.iv * a.t) * (t - a.t)) / (b.t - a.t);
    return w > 0 ? Math.sqrt(w / t) : undefined;
  }
  return ps[ps.length - 1].iv;
}

export type TermShape = 'contango' | 'backwardation' | 'flat';

/** Contango when IV90 is over 3% above IV30, backwardation when as much below. */
export function termShape(iv30: number, iv90: number): TermShape {
  return iv90 > iv30 * 1.03 ? 'contango' : iv90 < iv30 / 1.03 ? 'backwardation' : 'flat';
}

/** Normal days' worth of the base variance below which an event adds nothing worth showing. */
const EVENT_NONE_DAYS = 0.5;

/**
 * The variance m² (m: the 1σ move, a fraction of the price) an event between term points
 * `after − 1` (or now) and `after` adds, and the base variance it is read against: the forward
 * variance into `after` less the base's over the same days. The base is the mean of the forward
 * variances around that interval (the one after `after`, and the one before `after − 1` when there
 * is one), so a term structure that rises or falls around the event does not change its size; with
 * no expiry after `after`, the one before alone. Undefined when there is nothing to read the base
 * from: a negative m² means the event adds nothing.
 */
export function eventVariance(points: readonly TermVol[], after: number): { m2: number; base: number } | undefined {
  const [b, c] = [points[after], points[after + 1]];
  if (!b) return undefined;
  const a = after > 0 ? points[after - 1] : { t: 0, iv: 0 };
  const into = after > 0 ? forwardVariance(a, b) : b.iv * b.iv;
  const out = c ? forwardVariance(b, c) : undefined;
  const before = after > 1 ? forwardVariance(points[after - 2], a) : after === 1 ? a.iv * a.iv : undefined;
  const around = [before, out].filter((v): v is number => v != null && v > 0);
  if (into == null || !around.length || (out != null && !(out > 0))) return undefined;
  const base = around.reduce((x, y) => x + y, 0) / around.length;
  return { m2: (into - base) * (b.t - a.t), base };
}

/**
 * The 1σ move (a fraction of the price) of an event before term point `after` (the first expiry
 * after it): √m² of eventVariance. Undefined when that is, or when the event adds less than
 * EVENT_NONE_DAYS of the base variance.
 */
export function eventMove(points: readonly TermVol[], after: number): number | undefined {
  const v = eventVariance(points, after);
  return v && eventPriced(v) ? Math.sqrt(v.m2) : undefined;
}

/** Whether an event's variance (eventVariance) is worth showing: at least EVENT_NONE_DAYS of the base's. */
export function eventPriced(v: { m2: number; base: number }): boolean {
  return v.m2 > (EVENT_NONE_DAYS * v.base) / TRADING_DAYS;
}

/** How much the forward vol into an expiry must exceed the base around it for an event (in vol, so about 1.17× in variance). */
const EVENT_SPIKE = 1.08;
/**
 * Normal days' worth of the base variance an event must add: 3 days is past the noise of the
 * forward variance between weeklies (about 1 day for IVs off by 0.3 points), and an earnings
 * report usually prices 4 to 10.
 */
const EVENT_MIN_DAYS = 3;
/** Shortest gap to the next expiry the base vol is read over. */
const EVENT_BASE_GAP = 4 * DAY;
/**
 * How far out findEvent looks without the event's date: the near weeks. Monthly expiries farther
 * out are a month apart, and their forward variances too noisy: with ATM IVs 0.3 points off, a
 * flat curve shows an event 1 to 3 times in 100 when looking 60 to 90 days out, about never within
 * 35 days (where a 4% earnings move is still found 99 times in 100).
 */
export const UNDATED_EVENT_HORIZON = 35 * DAY;

/**
 * The first expiry after an event the term structure prices, without its date: the forward
 * variance into it is a peak, above the ones before and after it and EVENT_SPIKE times the base
 * around it (eventVariance), and the event adds at least EVENT_MIN_DAYS of the base variance. For
 * the first point (nothing before it) the curve after it must not keep falling: that is a
 * backwardated term structure, not an event. The largest such event among the points within
 * `maxT` years wins.
 */
export function findEvent(points: readonly TermVol[], maxT: number): number | undefined {
  const spike = EVENT_SPIKE * EVENT_SPIKE;
  let best: number | undefined;
  let bestDays = 0;
  for (let e = 0; e + 1 < points.length && points[e].t <= maxT; e++) {
    const p = points[e];
    const v = eventVariance(points, e);
    const out = forwardVariance(p, points[e + 1]);
    const into = e === 0 ? p.iv * p.iv : forwardVariance(points[e - 1], p);
    if (!v || out == null || into == null || points[e + 1].t - p.t < EVENT_BASE_GAP) continue;
    if (into < spike * v.base || into <= out) continue;
    if (e > 0) {
      const before = e === 1 ? points[0].iv * points[0].iv : forwardVariance(points[e - 2], points[e - 1]);
      if (before != null && into <= before) continue;
    } else {
      const next = points[2] ? forwardVariance(points[1], points[2]) : undefined;
      if (next != null && out > spike * next) continue;
    }
    const days = v.m2 / (v.base / TRADING_DAYS);
    if (days >= EVENT_MIN_DAYS && days > bestDays) [best, bestDays] = [e, days];
  }
  return best;
}

/**
 * The first of the earnings reports (soonest first, as WSH gives them) not yet out: one dated
 * today is out from 09:30 New York when before the open or during market hours, and from 16:00
 * after the close (`now` in New York).
 */
export function upcomingEarnings<T extends { date: string; time?: 'bmo' | 'amc' | 'dmh' }>(events: readonly T[], now: Date = new Date()): T | undefined {
  const { ymd, minutes } = nyClock(now);
  return events.find((e) => e.date > ymd || (e.date === ymd && minutes < (e.time === 'amc' ? 16 * 60 : 9 * 60 + 30)));
}

/**
 * Index of the first expiry a dated event (earnings) falls before: one after its date, or on it
 * when reported before the close (before the open or during market hours). -1 when none is.
 */
export function firstExpiryAfter(expiries: readonly string[], date: string, time?: 'bmo' | 'amc' | 'dmh'): number {
  return expiries.findIndex((e) => e > date || (e === date && (time === 'bmo' || time === 'dmh')));
}
