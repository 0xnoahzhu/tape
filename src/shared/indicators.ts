// Technical indicators over a bar series (pure). Shared by the chart (its moving averages) and the
// indicator alerts in the main process, so both compute the same values from the same bars. Every
// series is aligned with its input: out[i] belongs to value or bar i, and is undefined where it is
// not defined yet.

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
