// Number and time formatting shared by every view. Matches the design's helpers
// (f2 / f0 / sg) and uses a true minus sign (U+2212) for negatives.

export const MINUS = '−';
export const DASH = '—';

const nf = new Map<string, Intl.NumberFormat>();
function fmt(min: number, max: number): Intl.NumberFormat {
  const k = `${min}:${max}`;
  let f = nf.get(k);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
    nf.set(k, f);
  }
  return f;
}

const valid = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** 1234.5 -> "1,234.50". Negative numbers use U+2212. */
export function f2(n: number | null | undefined, digits = 2): string {
  if (!valid(n)) return DASH;
  const s = fmt(digits, digits).format(Math.abs(n));
  return n < 0 && s !== fmt(digits, digits).format(0) ? MINUS + s : s;
}

/** 1234.5 -> "1,235". */
export function f0(n: number | null | undefined): string {
  if (!valid(n)) return DASH;
  const s = fmt(0, 0).format(Math.abs(n));
  return n < 0 && s !== '0' ? MINUS + s : s;
}

/** Signed: 12.3 -> "+12.30", -4 -> "−4.00". */
export function sg(n: number | null | undefined, format: (x: number) => string = f2): string {
  if (!valid(n)) return DASH;
  return (n >= 0 ? '+' : MINUS) + format(Math.abs(n));
}

/** Signed percent: 1.234 -> "+1.23%". */
export function pct(n: number | null | undefined, digits = 2): string {
  if (!valid(n)) return DASH;
  return sg(n, (x) => f2(x, digits)) + '%';
}

/** Price with tick-appropriate precision: < 1 uses 4 decimals, otherwise 2. */
export function px(n: number | null | undefined): string {
  if (!valid(n)) return DASH;
  return Math.abs(n) > 0 && Math.abs(n) < 1 ? f2(n, 4).replace(/0{1,2}$/, '') : f2(n);
}

/** 12_400_000 -> "12.4M", 12_400 -> "12.4K", 8_200 -> "8,200". A value that rounds up to 1000 of a unit moves to the next one. */
export function compact(n: number | null | undefined): string {
  if (!valid(n)) return DASH;
  const a = Math.abs(n);
  const k = (a / 1e3).toFixed(1);
  const m = (a / 1e6).toFixed(1);
  let s: string;
  if (a >= 1e9 || Number(m) >= 1000) s = (a / 1e9).toFixed(2) + 'B';
  else if (a >= 1e6 || Number(k) >= 1000) s = m + 'M';
  else if (a >= 1e4) s = k + 'K';
  else s = f0(a);
  return n < 0 && s !== '0' ? MINUS + s : s;
}

/**
 * Compact in myriads, as Chinese writes large numbers: 12_400_000 → "1240" + wan, 1_250_000_000 →
 * "12.5" + yi, 8_200 → "8200" (at most two decimals, trailing zeros dropped, no separators). The
 * unit words come from the caller's zh message table.
 */
export function compactMyriad(n: number | null | undefined, units: { wan: string; yi: string }): string {
  if (!valid(n)) return DASH;
  const a = Math.abs(n);
  const short = (x: number) => String(Number(x.toFixed(2)));
  let s: string;
  if (a >= 1e8 || Number((a / 1e4).toFixed(2)) >= 1e4) s = short(a / 1e8) + units.yi;
  else if (a >= 1e4 || Math.round(a) >= 1e4) s = short(a / 1e4) + units.wan;
  else s = String(Math.round(a));
  return n < 0 && s !== '0' ? MINUS + s : s;
}

/**
 * A threshold the user set (an alert's volume or turnover), written exactly: in compact's unit (K
 * from 10,000, M, B) or with `myriad` in 万 / 亿 when at most two decimals of it are exact
 * (1_250_000 → "1.25M" / "125万"), else in grouped digits (12_345_678 → "12,345,678"; below 10,000
 * in myriads without separators, as compactMyriad). Unlike compact, it never shows a rounded value.
 */
export function exactCompact(n: number | null | undefined, myriad?: { wan: string; yi: string }): string {
  if (!valid(n)) return DASH;
  const a = Math.abs(n);
  // [from, size, unit]: the largest unit the value reaches.
  const units: Array<[number, number, string]> = myriad ? [[1e8, 1e8, myriad.yi], [1e4, 1e4, myriad.wan]] : [[1e9, 1e9, 'B'], [1e6, 1e6, 'M'], [1e4, 1e3, 'K']];
  const unit = units.find(([from]) => a >= from);
  const v = unit ? a / unit[1] : 0;
  let s: string;
  if (unit && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6) s = `${Number(v.toFixed(2))}${unit[2]}`;
  else if (myriad && a < 1e4) s = String(Number(a.toFixed(2)));
  else s = fmt(0, 2).format(a);
  return n < 0 && s !== '0' ? MINUS + s : s;
}

/** Money with a dollar sign: 1284530.42 -> "$1,284,530.42". No sign when the value rounds to zero. */
export function usd(n: number | null | undefined, digits = 2): string {
  if (!valid(n)) return DASH;
  const s = f2(Math.abs(n), digits);
  return (n < 0 && s !== f2(0, digits) ? MINUS : '') + '$' + s;
}

/** Change and percent change between two prices, e.g. "+2.96 (+1.32%)". */
export function change(cur: number | null | undefined, ref: number | null | undefined): string {
  if (!valid(cur) || !valid(ref) || ref === 0) return DASH;
  return `${sg(cur - ref)} (${pct((cur / ref - 1) * 100)})`;
}

/** CSS color variable for a signed value: up/down follow the user's color convention. */
export function signColor(n: number | null | undefined): string {
  if (!valid(n) || n === 0) return 'var(--tx)';
  return n > 0 ? 'var(--up)' : 'var(--dn)';
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Local "HH:MM:SS", always 24-hour: for technical times (API log). Times people
 * read follow Settings › General › Time format through timeFormat.ts (createClock / useClock).
 */
export function hms(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local "HH:MM:SS.mmm". */
export function hmsMs(t: number): string {
  return `${hms(t)}.${pad(new Date(t).getMilliseconds(), 3)}`;
}

/** Local "YYYY-MM-DD". */
export function ymd(t: number | Date): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses a user-typed number, tolerating thousands separators. Returns NaN when invalid. */
export function parseNum(s: string): number {
  const t = s.replace(/,/g, '').replace(MINUS, '-').trim();
  if (!t) return NaN;
  return Number(t);
}

/** Multipliers of the unit letters parseQuantity takes: K / M / B and the Chinese 万 / 亿. */
const QUANTITY_UNITS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 亿: 1e8 };

/**
 * Parses a typed quantity or amount (an alert's volume or turnover): a number as parseNum takes it,
 * optionally followed by one unit, K / M / B (any case) or 万 / 亿, with or without a space:
 * "10M" → 10_000_000, "1.5B", "1000万", "2亿", "12,000". Returns NaN when invalid.
 */
export function parseQuantity(s: string): number {
  const t = s.replace(/,/g, '').replace(MINUS, '-').trim();
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))\s*([kKmMbB万亿])?$/.exec(t);
  if (!m) return NaN;
  const unit = m[2] ? QUANTITY_UNITS[m[2].toLowerCase()] : 1;
  // Rounded so "1.1M" is 1_100_000, not 1_100_000.0000000002.
  return Number((Number(m[1]) * unit).toPrecision(12));
}

/** Rounds a price to the instrument's minimum tick. */
export function roundToTick(price: number, minTick = 0.01): number {
  if (!minTick || minTick <= 0) return price;
  const r = Math.round(price / minTick) * minTick;
  return Number(r.toFixed(tickDecimals(minTick)));
}

/** Decimal places a tick needs: 0.25 → 2, 0.125 → 3, 5e-5 → 5. */
function tickDecimals(minTick: number): number {
  const s = String(minTick);
  const exp = /e-(\d+)$/.exec(s);
  if (exp) return Math.min(20, Number(exp[1]) + (s.split('e')[0].split('.')[1]?.length ?? 0));
  return Math.min(20, s.split('.')[1]?.length ?? 0);
}
