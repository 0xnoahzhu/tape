import { describe, expect, it } from 'vitest';
import { blackScholes } from './math';
import {
  atDelta,
  barDate,
  dailyMove,
  delta25Strikes,
  eventMove,
  findEvent,
  finishedBars,
  firstExpiryAfter,
  forwardVariance,
  forwardVol,
  hvOnDates,
  ivAt,
  ivChange,
  ivHvRatios,
  ivRanks,
  percentileOf,
  realizedVol,
  rollingVol,
  skew25,
  skewPoints,
  smileIv,
  termShape,
  UNDATED_EVENT_HORIZON,
  upcomingEarnings,
  wingStrikes,
  type TermVol,
} from './vol';

/** Daily bar time (00:00 UTC) of a YYYYMMDD date. */
const day = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 1000;
/** Closes from 100 with the given daily log returns. */
const closesOf = (returns: number[]) => returns.reduce((cs, r) => [...cs, cs[cs.length - 1] * Math.exp(r)], [100]);

describe('realized volatility', () => {
  it('reads a daily bar’s date and leaves out today’s bar until the close', () => {
    expect(barDate(day('20261023'))).toBe('20261023');
    const bars = [{ time: day('20261022') }, { time: day('20261023') }];
    // Fri 2026-10-23 10:00 and 16:30 in New York (EDT, UTC−4).
    expect(finishedBars(bars, new Date(Date.UTC(2026, 9, 23, 14)))).toEqual([bars[0]]);
    expect(finishedBars(bars, new Date(Date.UTC(2026, 9, 23, 20, 30)))).toEqual(bars);
    // Saturday: Friday's bar is finished.
    expect(finishedBars(bars, new Date(Date.UTC(2026, 9, 24, 14)))).toEqual(bars);
  });

  it('annualizes the sample deviation of the last n daily log returns', () => {
    // Returns of ±1%: mean 0, sample deviation 0.01 × √(n / (n − 1)).
    const closes = closesOf([0.05, ...Array.from({ length: 20 }, (_, i) => (i % 2 ? -0.01 : 0.01))]);
    expect(realizedVol(closes, 20)).toBeCloseTo(0.01 * Math.sqrt(20 / 19) * Math.sqrt(252), 10);
    // The older 5% day is outside a 20-day window but inside a 21-day one.
    expect(realizedVol(closes, 21)!).toBeGreaterThan(realizedVol(closes, 20)!);
    expect(realizedVol(closes.slice(0, 20), 20)).toBeUndefined();
    expect(realizedVol([100, 0, 101, 102], 3)).toBeUndefined();
  });

  it('rolls the window over the closes and puts it on the IV bars’ dates', () => {
    const closes = closesOf([0.01, -0.02, 0.015, -0.01, 0.02]);
    const rolled = rollingVol(closes, 3);
    expect(rolled.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(rolled[5]).toBeCloseTo(realizedVol(closes, 3)!, 12);
    const times = ['20261016', '20261019', '20261020', '20261021', '20261022', '20261023'].map(day);
    // The IV bars lack a date the closes have, and have one they lack.
    const hv = hvOnDates([day('20261021'), day('20261023'), day('20261024')], times, closes, 3);
    expect(hv).toEqual([rolled[3], rolled[5], undefined]);
  });

  it('gives the 1σ daily move and IV / HV against its year', () => {
    expect(dailyMove(200, 0.252)).toBeCloseTo((200 * 0.252) / Math.sqrt(252), 12);
    expect(ivHvRatios([0.4, 0.2, 0.25], [0.2, undefined, 0.25])).toEqual([2, 1]);
    expect(percentileOf([1, 1.2, 1.4, 1.6], 1.5)).toBe(0.75);
    expect(percentileOf([], 1)).toBeUndefined();
  });
});

describe('IV rank and change', () => {
  it('ranks the current IV over 13, 26 and 52 weeks of closes', () => {
    // 260 closes: 0.20 for the first 195, then 0.30 … 0.494 rising over the last 65 (13 weeks).
    const closes = [...Array.from({ length: 195 }, () => 0.2), ...Array.from({ length: 65 }, (_, i) => 0.3 + i * 0.003)];
    const [w13, w26, w52] = ivRanks(closes, 0.4);
    expect(w13.weeks).toBe(13);
    expect(w13.stats!.min).toBeCloseTo(0.3, 12);
    expect(w26.stats!.min).toBe(0.2);
    expect(w52.stats!.rank).toBeCloseTo((0.4 - 0.2) / (0.492 - 0.2), 6);
    expect(ivRanks(closes, undefined).every((r) => r.stats == null)).toBe(true);
  });

  it('passes over a report already out today', () => {
    const events = [
      { date: '20261023', time: 'bmo' as const },
      { date: '20261029', time: 'amc' as const },
    ];
    // Fri 2026-10-23 in New York: 09:00 and 11:00 (EDT, UTC−4).
    expect(upcomingEarnings(events, new Date(Date.UTC(2026, 9, 23, 13)))).toBe(events[0]);
    expect(upcomingEarnings(events, new Date(Date.UTC(2026, 9, 23, 15)))).toBe(events[1]);
    const amc = [{ date: '20261023', time: 'amc' as const }];
    expect(upcomingEarnings(amc, new Date(Date.UTC(2026, 9, 23, 19, 59)))).toBe(amc[0]);
    expect(upcomingEarnings(amc, new Date(Date.UTC(2026, 9, 23, 20)))).toBeUndefined();
  });

  it('measures the change since the last close before today', () => {
    const times = ['20261021', '20261022', '20261023'].map(day);
    expect(ivChange(times, [0.25, 0.27, 0.29], 0.3, '20261023')).toBeCloseTo(0.03, 12);
    expect(ivChange(times, [0.25, 0.27, 0.29], 0.3, '20261024')).toBeCloseTo(0.01, 12);
    expect(ivChange(times, [0.25, 0.27, 0.29], undefined, '20261024')).toBeUndefined();
    expect(ivChange(times, [0.25, 0.27, 0.29], 0.3, '20261021')).toBeUndefined();
  });
});

describe('25Δ skew', () => {
  const spot = 100;
  const t = 30 / 365;
  // A smile with skew: the IV rises 0.4 points a strike below the price, 0.1 above.
  const ivOf = (k: number) => 0.25 + (k < spot ? (spot - k) * 0.004 : (k - spot) * 0.001);
  const quotes = Array.from({ length: 31 }, (_, i) => 85 + i).flatMap((k) =>
    (['C', 'P'] as const).map((right) => ({ strike: k, right, iv: ivOf(k), delta: blackScholes(spot, k, t, ivOf(k), right).delta, bid: 1 })),
  );

  it('keeps the out-of-the-money options with an IV, a delta and a bid', () => {
    const { puts, calls } = skewPoints([...quotes, { strike: 70, right: 'P', iv: 0.5, delta: -0.02, bid: 0 }], spot);
    expect(puts.every((p) => p.strike <= spot && p.delta < 0)).toBe(true);
    expect(calls.every((p) => p.strike >= spot && p.delta > 0)).toBe(true);
    expect(puts.some((p) => p.strike === 70)).toBe(false);
    expect(puts).toHaveLength(16);
  });

  it('interpolates the IV and strike at 25Δ in delta, and nothing beyond the strikes quoted', () => {
    const pts = [
      { strike: 90, delta: -0.2, iv: 0.3 },
      { strike: 95, delta: -0.3, iv: 0.28 },
    ];
    const at = atDelta(pts, -0.25)!;
    expect(at.iv).toBeCloseTo(0.29, 12);
    expect(at.strike).toBeCloseTo(92.5, 12);
    expect(atDelta(pts, -0.1)).toBeUndefined();
  });

  it('reads the risk reversal and butterfly', () => {
    const { puts, calls } = skewPoints(quotes, spot);
    const s = skew25(puts, calls, 0.25)!;
    expect(s.putStrike).toBeLessThan(spot);
    expect(s.callStrike).toBeGreaterThan(spot);
    expect(s.put).toBeGreaterThan(s.call);
    expect(s.skew).toBeCloseTo(s.put - s.call, 12);
    expect(s.fly).toBeCloseTo((s.put + s.call) / 2 - 0.25, 12);
    // A narrow window around the price does not reach 25Δ.
    const near = skewPoints(
      quotes.filter((q) => Math.abs(q.strike - spot) <= 2),
      spot,
    );
    expect(skew25(near.puts, near.calls, 0.25)).toBeUndefined();
  });

  it('finds the Black–Scholes 25Δ strikes, and reads a smile between and beyond its points', () => {
    const k = delta25Strikes(spot, 0.3, t);
    expect(blackScholes(spot, k.put, t, 0.3, 'P').delta).toBeCloseTo(-0.25, 4);
    expect(blackScholes(spot, k.call, t, 0.3, 'C').delta).toBeCloseTo(0.25, 4);
    const pts = [
      { strike: 90, iv: 0.3 },
      { strike: 95, iv: 0.28 },
    ];
    expect(smileIv(pts, 92)).toBeCloseTo(0.292, 12);
    expect(smileIv(pts, 80)).toBe(0.3);
    expect(smileIv(pts, 99)).toBe(0.28);
    expect(smileIv([], 99)).toBeUndefined();
  });

  it('moves the wings to where 25Δ is on a skewed index smile', () => {
    // SPX-like: 5-point strikes, 30 days, IV 15% ATM rising 1.2 points per 1% lower (a 7-point
    // risk reversal); the chain quotes ±12 strikes around the price.
    const S = 5800;
    const iv = (k: number) => 0.15 - 1.2 * Math.log(k / S);
    const strikes = Array.from({ length: 301 }, (_, i) => 5000 + i * 5);
    const quoted = new Set(strikes.filter((k) => Math.abs(k - S) <= 60));
    const point = (k: number) => ({ strike: k, iv: iv(k) });
    const otm = { puts: [...quoted].filter((k) => k <= S).map(point), calls: [...quoted].filter((k) => k >= S).map(point) };
    // Each round quotes the strikes asked for; their IVs come in for the next.
    let wings = { puts: [] as number[], calls: [] as number[] };
    for (let round = 0; round < 6; round++) {
      wings = wingStrikes(strikes, quoted, { puts: [...otm.puts, ...wings.puts.map(point)], calls: [...otm.calls, ...wings.calls.map(point)] }, S, iv(S), t);
    }
    expect(wings.puts).toHaveLength(3);
    expect(wings.calls).toHaveLength(3);
    // The quotes the skew reads bracket 25Δ on both sides.
    const delta = (k: number, right: 'C' | 'P') => ({ strike: k, delta: blackScholes(S, k, t, iv(k), right).delta, iv: iv(k) });
    const puts = [...otm.puts.map((p) => p.strike), ...wings.puts].map((k) => delta(k, 'P'));
    const calls = [...otm.calls.map((p) => p.strike), ...wings.calls].map((k) => delta(k, 'C'));
    const s = skew25(puts, calls, iv(S))!;
    expect(s).toBeDefined();
    expect(blackScholes(S, s.putStrike, t, iv(s.putStrike), 'P').delta).toBeCloseTo(-0.25, 2);
    expect(s.skew).toBeGreaterThan(0.05);
    // At the ATM IV alone (the first round) the put wing would sit too near the price.
    const first = wingStrikes(strikes, quoted, { puts: [], calls: [] }, S, iv(S), t);
    expect(Math.max(...first.puts)).toBeGreaterThan(Math.max(...wings.puts));
  });
});

describe('term structure', () => {
  const D = 1 / 365;
  /** Term points at `days` with a base vol, plus an event's variance in the expiries after `eventDay`. */
  const curve = (days: number[], base: (d: number) => number, eventDay?: number, m = 0.05): TermVol[] =>
    days.map((d) => ({ t: d * D, iv: Math.sqrt(base(d) ** 2 + (eventDay != null && d > eventDay ? (m * m) / (d * D) : 0)) }));

  it('reads forward vols and constant-maturity IV in total variance', () => {
    const a = { t: 30 * D, iv: 0.2 };
    const b = { t: 60 * D, iv: 0.25 };
    expect(forwardVariance(a, b)).toBeCloseTo((0.0625 * 60 - 0.04 * 30) / 30, 12);
    expect(forwardVol(a, b)).toBeCloseTo(Math.sqrt(0.085), 12);
    // Inverted variances: no forward vol.
    expect(forwardVol({ t: 30 * D, iv: 0.4 }, { t: 37 * D, iv: 0.3 })).toBeUndefined();
    expect(forwardVariance(b, a)).toBeUndefined();
    expect(ivAt([a, b], 45 * D)).toBeCloseTo(Math.sqrt((0.04 * 30 + 0.085 * 15) / 45), 12);
    expect(ivAt([a, b], 10 * D)).toBe(0.2);
    expect(ivAt([a, b], 90 * D)).toBe(0.25);
    expect(ivAt([], 30 * D)).toBeUndefined();
    expect(termShape(0.2, 0.25)).toBe('contango');
    expect(termShape(0.25, 0.2)).toBe('backwardation');
    expect(termShape(0.2, 0.202)).toBe('flat');
  });

  it('finds the move an event adds between two expiries', () => {
    const days = [3, 10, 17, 31, 59, 94, 122];
    // Earnings between the 31- and 59-day expiries, ±5%.
    const pts = curve(days, () => 0.3, 50);
    expect(findEvent(pts, 90 * D)).toBe(4);
    expect(eventMove(pts, 4)).toBeCloseTo(0.05, 10);
    // In the first week: in the first expiry already.
    const first = curve(days, () => 0.3, 1);
    expect(findEvent(first, 90 * D)).toBe(0);
    expect(eventMove(first, 0)).toBeCloseTo(0.05, 10);
    // Between the first and second.
    expect(findEvent(curve(days, () => 0.3, 5), 90 * D)).toBe(1);
    // Beyond the horizon, the event is not looked for: without a date, only the near weeks.
    expect(findEvent(pts, 40 * D)).toBeUndefined();
    expect(findEvent(pts, UNDATED_EVENT_HORIZON)).toBeUndefined();
    expect(findEvent(curve(days, () => 0.3, 22), UNDATED_EVENT_HORIZON)).toBe(3);
  });

  it('reads an event the same in a rising term structure', () => {
    const days = [3, 10, 17, 31, 59, 94, 122];
    // Base vol rising from 25% (3 days) to 31% (122 days), ±4% earnings at day 50.
    const pts = curve(days, (d) => 0.25 + d * 0.0005, 50, 0.04);
    expect(findEvent(pts, 90 * D)).toBe(4);
    expect(eventMove(pts, 4)).toBeCloseTo(0.04, 2);
    // Read against the forward vol after it alone, the rising base would hide most of it.
    expect(eventMove(pts, 4)!).toBeGreaterThan(0.035);
  });

  it('measures an event before the last expiry against the interval before it', () => {
    const days = [20, 48, 83, 174];
    const pts = curve(days, () => 0.3, 100, 0.06);
    expect(eventMove(pts, 3)).toBeCloseTo(0.06, 10);
    // Nothing on either side to read a base from.
    expect(eventMove(pts.slice(0, 1), 0)).toBeUndefined();
  });

  it('tells no event in a plain upward or backwardated curve', () => {
    const days = [7, 14, 21, 28, 56];
    expect(findEvent(curve(days, (d) => 0.24 + d * 0.001), 90 * D)).toBeUndefined();
    const backwardated = [0.45, 0.4, 0.36, 0.33, 0.3].map((iv, i) => ({ t: days[i] * D, iv }));
    expect(findEvent(backwardated, 90 * D)).toBeUndefined();
    // A small bump (less than two days of variance) is noise.
    expect(findEvent(curve(days, () => 0.3, 10, 0.01), 90 * D)).toBeUndefined();
    expect(eventMove(curve(days, () => 0.3), 2)).toBeUndefined();
    expect(eventMove(curve(days, () => 0.3, 10), 4)).toBeUndefined();
  });

  it('places a dated event before the expiries after it', () => {
    const exps = ['20261023', '20261030', '20261106', '20261120'];
    expect(firstExpiryAfter(exps, '20261028', 'amc')).toBe(1);
    // Reported on an expiry's day: before its close only before the open or during hours.
    expect(firstExpiryAfter(exps, '20261030', 'amc')).toBe(2);
    expect(firstExpiryAfter(exps, '20261030', 'bmo')).toBe(1);
    expect(firstExpiryAfter(exps, '20261030')).toBe(2);
    expect(firstExpiryAfter(exps, '20261201', 'bmo')).toBe(-1);
  });
});
