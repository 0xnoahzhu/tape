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
 * Local "HH:MM:SS", always 24-hour: for technical and exported times (API log, CSV). Times people
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
