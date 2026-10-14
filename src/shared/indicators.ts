// Technical indicators over a bar series (pure). Shared by the chart (its moving averages) and the
// indicator alerts in the main process (main/market/alertEval.ts), so both compute the same values
// from the same bars. Every series is aligned with its input: out[i] belongs to value or bar i, and
// is undefined where it is not defined yet.
//
// Formulas follow the Futu / TDX conventions moomoo shows, which differ from some Western ones:
//   MA    arithmetic mean of the last n closes
//   EMA   α = 2 / (n + 1), seeded with the first value (TDX's EMA, defined from the first bar; an
//         SMA seed would change only the early values)
//   MACD  DIF = EMA(fast) − EMA(slow), DEA = EMA(DIF, signal), MACD = 2 × (DIF − DEA)  (the ×2 bars)
//   KDJ   RSV = (C − LLV(L, n)) / (HHV(H, n) − LLV(L, n)) × 100 over the bars there are (fewer than n
//         at the start), K = ((m1 − 1) × K' + RSV) / m1, D = ((m2 − 1) × D' + K) / m2, both starting
//         at 50, J = 3K − 2D. A bar whose n-bar range is zero (a run of IB's flat bars without trades)
//         leaves K and D as they were, so quiet periods do not read as a cross.
//   RSI   Wilder smoothing as TDX writes it: SMA(max(Δ, 0), n, 1) / SMA(|Δ|, n, 1) × 100, where
//         SMA(X, n, 1) = (X + (n − 1) × Y') / n seeded with the first Δ (defined from the second
//         close); while the closes have not moved it keeps its last value
//   BOLL  MID = MA(n), UPPER / LOWER = MID ± k × σ with the population σ (Bollinger's original; TDX
//         uses the sample σ, so its bands are slightly wider)

/** One value per input, undefined where the indicator is not defined (yet). */
export type Series = Array<number | undefined>;

const empty = (n: number): Series => new Array<number | undefined>(n).fill(undefined);
const validPeriod = (n: number) => Number.isInteger(n) && n >= 1;

/** Simple moving average of `values`; undefined until `period` values are available. */
export function sma(values: ArrayLike<number>, period: number): Series {
  const n = values.length;
  const out = empty(n);
  if (!validPeriod(period)) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, α = 2 / (period + 1), seeded with the first defined value; leading
 * undefined values (another indicator's warm-up) stay undefined.
 */
export function ema(values: ArrayLike<number | undefined>, period: number): Series {
  const n = values.length;
  const out = empty(n);
  if (!validPeriod(period)) return out;
  const alpha = 2 / (period + 1);
  let prev: number | undefined;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === undefined) {
      out[i] = prev;
      continue;
    }
    prev = prev === undefined ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export interface Macd {
  dif: Series;
  dea: Series;
  /** 2 × (DIF − DEA), the Chinese convention for the histogram. */
  bar: Series;
}

export function macd(closes: ArrayLike<number>, fast: number, slow: number, signal: number): Macd {
  const a = ema(closes, fast);
  const b = ema(closes, slow);
  const dif: Series = a.map((x, i) => (x === undefined || b[i] === undefined ? undefined : x - b[i]!));
  const dea = ema(dif, signal);
  const bar: Series = dif.map((x, i) => (x === undefined || dea[i] === undefined ? undefined : 2 * (x - dea[i]!)));
  return { dif, dea, bar };
}

export interface Kdj {
  k: Series;
  d: Series;
  j: Series;
}

export interface Hlc {
  high: number;
  low: number;
  close: number;
}

export function kdj(bars: readonly Hlc[], n: number, m1: number, m2: number): Kdj {
  const len = bars.length;
  const k = empty(len);
  const d = empty(len);
  const j = empty(len);
  if (!validPeriod(n) || !validPeriod(m1) || !validPeriod(m2)) return { k, d, j };
  let kPrev = 50;
  let dPrev = 50;
  for (let i = 0; i < len; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let t = Math.max(0, i - n + 1); t <= i; t++) {
      hi = Math.max(hi, bars[t].high);
      lo = Math.min(lo, bars[t].low);
    }
    if (hi > lo) {
      const rsv = ((bars[i].close - lo) / (hi - lo)) * 100;
      kPrev = ((m1 - 1) * kPrev + rsv) / m1;
      dPrev = ((m2 - 1) * dPrev + kPrev) / m2;
    }
    k[i] = kPrev;
    d[i] = dPrev;
    j[i] = 3 * kPrev - 2 * dPrev;
  }
  return { k, d, j };
}

export function rsi(closes: ArrayLike<number>, period: number): Series {
  const n = closes.length;
  const out = empty(n);
  if (!validPeriod(period)) return out;
  let up: number | undefined;
  let all: number | undefined;
  let last: number | undefined;
  for (let i = 1; i < n; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = Math.max(delta, 0);
    const move = Math.abs(delta);
    up = up === undefined ? gain : (gain + (period - 1) * up) / period;
    all = all === undefined ? move : (move + (period - 1) * all) / period;
    if (all > 0) last = (up / all) * 100;
    out[i] = last;
  }
  return out;
}

export interface Boll {
  mid: Series;
  upper: Series;
  lower: Series;
}

export function boll(closes: ArrayLike<number>, period: number, k: number): Boll {
  const n = closes.length;
  const mid = sma(closes, period);
  const upper = empty(n);
  const lower = empty(n);
  for (let i = period - 1; i < n; i++) {
    const m = mid[i];
    if (m === undefined) continue;
    let sq = 0;
    for (let t = i - period + 1; t <= i; t++) sq += (closes[t] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

/**
 * Whether line a crossed line b between two points, given a − b before (`prev`) and now (`cur`):
 * up = at or below before and above now, down = at or above before and below now.
 */
export function crossed(dir: 'up' | 'down', prev: number, cur: number): boolean {
  return dir === 'up' ? prev <= 0 && cur > 0 : prev >= 0 && cur < 0;
}
