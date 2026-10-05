// Pure portfolio computations: NAV history slicing, returns, drawdown, equity chart geometry,
// sector allocation and position rows. No React and no store access, so everything is unit tested.

import { index, multiplierOf, stock } from '@shared/contract';
import { DASH, f0, f2, MINUS, pct } from '@shared/format';
import type { Clock } from '@shared/timeFormat';
import type { AccountSummary, ContractRef, Execution, NavPoint, Position, Quote, SecType } from '@shared/types';

export type RangeKey = '7D' | 'MTD' | 'YTD' | '1Y' | 'ALL';
export const RANGES: readonly RangeKey[] = ['7D', 'MTD', 'YTD', '1Y', 'ALL'];
export type EquityMode = 'value' | 'perf';

const DAY = 86_400_000;

/**
 * A range counts as covered when a NAV sample exists at most this long before its start.
 * Allows for weekends, holidays and days the app was not running.
 */
export const MAX_BASE_GAP = 5 * DAY;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ---------------------------------------------------------------------------
// NAV history

/**
 * Valid NAV samples in time order, with the live net liquidation appended as the newest point.
 * Non-positive values carry no return information and are dropped.
 */
export function navSeries(nav: readonly NavPoint[], live?: { netLiq: number | undefined; t: number }): NavPoint[] {
  const pts = nav.filter((p) => finite(p.t) && finite(p.netLiq) && p.netLiq > 0);
  let sorted = true;
  for (let i = 1; i < pts.length && sorted; i++) sorted = pts[i - 1].t <= pts[i].t;
  if (!sorted) pts.sort((a, b) => a.t - b.t);
  const out: NavPoint[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1].t === p.t) out[out.length - 1] = p;
    else out.push(p);
  }
  if (live && finite(live.netLiq) && live.netLiq > 0 && finite(live.t)) {
    const last = out[out.length - 1];
    if (!last || live.t > last.t) out.push({ t: live.t, netLiq: live.netLiq });
    else if (live.t === last.t) out[out.length - 1] = { t: live.t, netLiq: live.netLiq };
  }
  return out;
}

/** Start of a range in unix ms (local calendar for MTD / YTD); -Infinity for ALL. */
export function rangeStart(range: RangeKey, now: number): number {
  const d = new Date(now);
  switch (range) {
    case '7D':
      return now - 7 * DAY;
    case 'MTD':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case 'YTD':
      return new Date(d.getFullYear(), 0, 1).getTime();
    case '1Y': {
      const y = new Date(now);
      y.setFullYear(d.getFullYear() - 1);
      return y.getTime();
    }
    case 'ALL':
      return -Infinity;
  }
}

export interface RangeSlice {
  /** Samples in the range, starting with the last sample at or before the range start when it is recent enough. */
  points: NavPoint[];
  /** The history reaches back to the start of the range (ALL: at least two samples). */
  covered: boolean;
}

export function sliceRange(series: readonly NavPoint[], range: RangeKey, now: number): RangeSlice {
  if (range === 'ALL') return { points: series.slice(), covered: series.length >= 2 };
  const start = rangeStart(range, now);
  let i = series.findIndex((p) => p.t > start);
  if (i < 0) i = series.length;
  const base = i > 0 ? series[i - 1] : undefined;
  const useBase = !!base && start - base.t <= MAX_BASE_GAP;
  const points = series.slice(useBase ? i - 1 : i);
  return { points, covered: useBase && points.length >= 2 };
}

export interface RangeReturn {
  change: number;
  /** Percent. */
  pct: number;
  /** Percent, <= 0. */
  maxDrawdown: number;
}

export function rangeReturn(points: readonly NavPoint[]): RangeReturn | null {
  if (points.length < 2) return null;
  const first = points[0].netLiq;
  const last = points[points.length - 1].netLiq;
  return { change: last - first, pct: (last / first - 1) * 100, maxDrawdown: maxDrawdown(points.map((p) => p.netLiq)) };
}

/** Largest peak-to-trough decline in percent (0 or negative). */
export function maxDrawdown(values: readonly number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.min(dd, v / peak - 1);
  }
  return dd * 100;
}

/**
 * Reduces a long series for drawing: per time bucket keeps the first, lowest, highest and last
 * sample, so peaks and troughs survive. The first and last samples are always kept.
 */
export function downsample(points: readonly NavPoint[], buckets: number): NavPoint[] {
  if (points.length <= buckets * 4) return points.slice();
  const t0 = points[0].t;
  const span = points[points.length - 1].t - t0 || 1;
  const out: NavPoint[] = [];
  let bucket = -1;
  let group: NavPoint[] = [];
  const flush = () => {
    if (!group.length) return;
    let lo = group[0];
    let hi = group[0];
    for (const p of group) {
      if (p.netLiq < lo.netLiq) lo = p;
      if (p.netLiq > hi.netLiq) hi = p;
    }
    const keep = [...new Set([group[0], lo, hi, group[group.length - 1]])].sort((a, b) => a.t - b.t);
    out.push(...keep);
    group = [];
  };
  for (const p of points) {
    const k = Math.min(buckets - 1, Math.floor(((p.t - t0) / span) * buckets));
    if (k !== bucket) {
      flush();
      bucket = k;
    }
    group.push(p);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Equity chart

export const CHART_W = 800;
export const CHART_H = 300;
/** Fractions of the plot height where the right-axis labels sit. */
const AXIS_FRACS = [0.2, 0.5, 0.8];
/** Fractions of the time span for the four x labels. */
const TICK_FRACS = [0, 0.33, 0.66, 1];

/**
 * Samples spanning less than this are not yet a curve (the minutes after the first connect):
 * the chart draws the line without its area and explains that history is still being recorded.
 */
export const MIN_CURVE_SPAN = 60 * 60_000;

/** Fewer than two samples, or samples less than MIN_CURVE_SPAN apart. */
export function shortHistory(points: readonly NavPoint[]): boolean {
  return points.length < 2 || points[points.length - 1].t - points[0].t < MIN_CURVE_SPAN;
}

export interface EquityChart {
  /** Polyline points in the 800×300 viewBox; empty with fewer than two samples. */
  line: string;
  /** Filled area under the line; empty with fewer than two samples or a flat series. */
  area: string;
  /** Dashed baseline at the first value. */
  baseY: number;
  /** Newest value (end marker). */
  endY: number;
  axis: Array<{ frac: number; value: number }>;
  /** Unix ms for the x labels. */
  ticks: number[];
}

/** Values plotted for a mode: net liquidation, or percent change from the first sample. */
export function modeValues(points: readonly NavPoint[], mode: EquityMode): number[] {
  if (mode === 'value' || !points.length) return points.map((p) => p.netLiq);
  const base = points[0].netLiq;
  return points.map((p) => (p.netLiq / base - 1) * 100);
}

export function equityChart(series: readonly NavPoint[], mode: EquityMode): EquityChart | null {
  if (!series.length) return null;
  const points = downsample(series, 200);
  const vals = modeValues(points, mode);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // A flat series has no shape: it gets the line only, no filled area.
  const flat = hi === lo;
  // 8% headroom; a flat series gets a small band around its value.
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.001 || 1;
  lo -= pad;
  hi += pad;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * CHART_W : CHART_W);
  const y = (v: number) => ((hi - v) / (hi - lo)) * CHART_H;
  const line = points.length >= 2 ? points.map((p, i) => `${x(p.t).toFixed(1)},${y(vals[i]).toFixed(1)}`).join(' ') : '';
  return {
    line,
    area: line && !flat ? `0,${CHART_H} ${line} ${CHART_W},${CHART_H}` : '',
    baseY: y(vals[0]),
    endY: y(vals[vals.length - 1]),
    axis: AXIS_FRACS.map((frac) => ({ frac, value: hi - (hi - lo) * frac })),
    ticks: points.length >= 2 ? TICK_FRACS.map((f) => t0 + (t1 - t0) * f) : [],
  };
}

/** Decimals that resolve `step`: values at least `step` apart never round to the same label. */
function decimalsFor(step: number): number {
  return finite(step) && step > 0 ? Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)) : 0;
}

/** Units of the value axis, largest first, with the decimals the design shows ("$1.284M", "$254.3K"). */
const MONEY_UNITS = [
  { size: 1e6, suffix: 'M', decimals: 3, from: 1e6 },
  { size: 1e3, suffix: 'K', decimals: 1, from: 1e4 },
] as const;

/**
 * Right-axis labels for evenly spaced values: "$1.284M" / "$254.3K" / "$5,400", or a signed
 * percent. When the labels are close together (a flat or quiet range) they switch to a smaller
 * unit or more decimals, so neighbouring labels never repeat.
 */
export function axisLabels(values: readonly number[], mode: EquityMode, symbol = '$'): string[] {
  const step = values.length > 1 ? Math.abs(values[1] - values[0]) : 0;
  if (mode === 'perf') {
    const d = Math.min(4, Math.max(2, decimalsFor(step)));
    return values.map((v) => pct(v, d));
  }
  const top = Math.max(...values.map(Math.abs));
  const unit = MONEY_UNITS.find((u) => top >= u.from && decimalsFor(step / u.size) <= u.decimals);
  const d = unit ? unit.decimals : Math.min(2, decimalsFor(step));
  return values.map((v) => `${v < 0 ? MINUS : ''}${symbol}${f2(Math.abs(v) / (unit?.size ?? 1), d)}${unit?.suffix ?? ''}`);
}

/** Short money for the donut center: "$1.28M", "$52.4K". */
export function moneyShort(v: number | undefined, symbol = '$'): string {
  if (!finite(v)) return DASH;
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}${symbol}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}${symbol}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${symbol}${f0(a)}`;
}

/**
 * X labels: the clock time within two days ("9:41 AM" / "09:41" as the user reads clocks, with
 * seconds when the ticks are less than a minute apart), "YYYY/M" for long ALL spans, otherwise
 * "M/D". A label equal to the one before it is left blank, so a short span never prints the same
 * time four times.
 */
export function tickLabels(ticks: readonly number[], range: RangeKey, clock: Clock): string[] {
  const span = ticks.length > 1 ? ticks[ticks.length - 1] - ticks[0] : 0;
  const label = (t: number) => {
    const d = new Date(t);
    if (span < 2 * DAY) return clock.time(d, { seconds: span < 3 * 60_000 });
    if (range === 'ALL' && span > 90 * DAY) return `${d.getFullYear()}/${d.getMonth() + 1}`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  let prev = '';
  return ticks.map((t) => {
    const l = label(t);
    if (l === prev) return '';
    prev = l;
    return l;
  });
}

// ---------------------------------------------------------------------------
// Sectors and allocation

export const ETF_SECTOR = '@etf';
export const OTHER_SECTOR = '@other';
export const CASH_KEY = '@cash';

export interface Classification {
  industry?: string;
  category?: string;
  longName?: string;
  /** IB's stock type from contract details ('COMMON', 'ETF', 'ADR', …). */
  stockType?: string;
}

/** IB stock types of exchange-traded products, which go to the ETF bucket. */
const EXCHANGE_TRADED = new Set(['ETF', 'ETN', 'ETC', 'ETP']);

/** Index options and their underlyings; everything else is treated as a stock underlying. */
const INDEX_EXCHANGES: Record<string, string> = {
  SPX: 'CBOE',
  XSP: 'CBOE',
  VIX: 'CBOE',
  OEX: 'CBOE',
  DJX: 'CBOE',
  NDX: 'NASDAQ',
  RUT: 'RUSSELL',
};

/** The instrument a position belongs to: the underlying for options, the stock itself otherwise. */
export function underlyingOf(c: ContractRef): ContractRef {
  if (c.secType === 'OPT') {
    const ex = INDEX_EXCHANGES[c.symbol];
    return ex ? index(c.symbol, ex) : stock(c.symbol);
  }
  if (c.secType === 'STK') return { ...stock(c.symbol, c.primaryExchange), currency: c.currency || 'USD' };
  return c;
}

/**
 * Contract used for a position's quote subscription. IB reports positions with the listing
 * exchange (or none); quotes for stocks and options are requested SMART-routed. The contract
 * key does not depend on the exchange, so quotes still match the position.
 */
export function quoteContract(c: ContractRef): ContractRef {
  if ((c.secType !== 'STK' && c.secType !== 'OPT') || c.exchange === 'SMART') return c;
  const primary = c.secType === 'STK' && c.exchange && !c.primaryExchange ? { primaryExchange: c.exchange } : {};
  return { ...c, ...primary, exchange: 'SMART' };
}

/** Where a click on a position row leads: the underlying's option chain or chart. */
export function positionTarget(c: ContractRef): { contract: ContractRef; view: 'opt' | 'chart' } {
  return { contract: underlyingOf(c), view: c.secType === 'OPT' ? 'opt' : 'chart' };
}

/**
 * Sector bucket: the IB industry ("Technology", "Consumer, Cyclical" …), ETF / Index for
 * exchange-traded products and indices, or Other when the instrument is not classified. IB's
 * stock type ('ETF', 'COMMON', …) decides when it is known. Without it a heuristic applies: IB
 * gives every operating company an industry, so a stock whose contract details have neither
 * industry nor category is a fund (QQQ, GLD and TLT come without either), and fund industries,
 * categories or names count as ETFs.
 */
export function sectorOf(underlyingSecType: SecType, info: Classification | undefined): string {
  if (underlyingSecType === 'IND') return ETF_SECTOR;
  if (!info) return OTHER_SECTOR;
  const industry = info.industry?.trim() ?? '';
  const category = info.category?.trim() ?? '';
  const stockType = info.stockType?.trim().toUpperCase();
  if (stockType) return EXCHANGE_TRADED.has(stockType) ? ETF_SECTOR : industry || OTHER_SECTOR;
  if (underlyingSecType === 'STK' && !industry && !category) return ETF_SECTOR;
  if (/^funds?$/i.test(industry) || /\b(etf|etn|funds?)\b/i.test(category) || /\b(ETF|ETN)\b/.test(info.longName ?? '')) return ETF_SECTOR;
  return industry || OTHER_SECTOR;
}

export interface AllocSlice {
  /** Sector key or CASH_KEY. */
  key: string;
  /** Signed market value. */
  value: number;
  /** Signed share of net liquidation in percent; undefined without net liquidation. */
  pctOfNetLiq?: number;
  /** Arc length in percent of the circle (positive slices only; 0 for a short sector or a margin loan). */
  len: number;
  /** stroke-dashoffset (negative cumulative length). */
  offset: number;
  opacity: number;
}

/**
 * Donut slices: sectors by absolute market value (shades of the accent with decreasing opacity),
 * then cash. Sectors beyond `maxSectors` are merged into Other. The arcs divide the circle among
 * the positive slices; negative ones (net-short sectors, borrowed cash) get no arc.
 */
export function allocation(
  items: ReadonlyArray<{ sector: string; value: number | undefined }>,
  cash: number | undefined,
  netLiq: number | undefined,
  maxSectors = 6,
): AllocSlice[] {
  const agg = new Map<string, number>();
  for (const it of items) if (finite(it.value)) agg.set(it.sector, (agg.get(it.sector) ?? 0) + it.value);
  let sectors = [...agg].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (sectors.length > maxSectors) {
    const top = sectors.filter(([k]) => k !== OTHER_SECTOR).slice(0, maxSectors - 1);
    const kept = new Set(top.map(([k]) => k));
    const rest = sectors.filter(([k]) => !kept.has(k)).reduce((a, [, v]) => a + v, 0);
    sectors = [...top, [OTHER_SECTOR, rest]];
  }
  // Design: 1, .75, .5 … ; with many sectors the step shrinks so the last one stays visible (>= .3).
  const step = sectors.length > 1 ? Math.min(0.25, 0.7 / (sectors.length - 1)) : 0;
  const src = sectors.map(([key, value], i) => ({ key, value, opacity: +(1 - i * step).toFixed(3) }));
  if (finite(cash) && cash !== 0) src.push({ key: CASH_KEY, value: cash, opacity: 0.55 });
  // The ring shows what is held: a net-short sector or a margin loan (negative cash) has no arc
  // (it would read as a holding); the legend still lists it with its signed share.
  const posSum = src.reduce((a, s) => a + Math.max(0, s.value), 0);
  let cum = 0;
  return src.map((s) => {
    const len = posSum && s.value > 0 ? (s.value / posSum) * 100 : 0;
    const slice: AllocSlice = {
      ...s,
      len,
      offset: cum ? -cum : 0,
      pctOfNetLiq: finite(netLiq) && netLiq !== 0 ? (s.value / netLiq) * 100 : undefined,
    };
    cum += len;
    return slice;
  });
}

/** "12.9%", "−1.0%"; "—" when unknown. */
export function weightLabel(p: number | undefined): string {
  return finite(p) ? `${f2(p, 1)}%` : DASH;
}

// ---------------------------------------------------------------------------
// Positions

export interface PositionRow {
  key: string;
  position: Position;
  /** Sector key (see sectorOf). */
  sector: string;
  /** Price the row is valued at: the live price (see livePrice), else IB's mark from the portfolio update. */
  last?: number;
  value?: number;
  unrealized?: number;
  /** Percent of cost basis, sign-adjusted for shorts. */
  unrealizedPct?: number;
  dayPnl?: number;
  /** Signed percent of net liquidation. */
  weight?: number;
}

const pos = (n: number | undefined): n is number => finite(n) && n > 0;

/**
 * Live price a position is valued at. Options use the mark (IB's mark, else the bid/ask
 * midpoint): their last trade is often hours old. Other instruments use `last`, the quote's
 * best last price. Undefined when there is none, so the row keeps IB's portfolio values.
 */
export function livePrice(secType: SecType, q: Quote | undefined, last: number | undefined): number | undefined {
  if (secType !== 'OPT' && secType !== 'FOP') return last;
  if (!q) return undefined;
  if (pos(q.mark)) return q.mark;
  if (pos(q.ask) && finite(q.bid) && q.bid >= 0) return (q.bid + q.ask) / 2;
  return undefined;
}

/**
 * Difference between the value a row shows and the value IB's P&L engine used for its daily P&L
 * (reqPnLSingle marks at its own price, which outside regular hours differs from the last price and
 * from the portfolio update). Adding it to IB's daily or unrealized P&L re-marks them to the row.
 */
export function remark(p: Position, value: number | undefined): number {
  return finite(value) && finite(p.pnlValue) ? value - p.pnlValue : 0;
}

export function positionRow(p: Position, livePx: number | undefined, netLiq: number | undefined, sector: string): PositionRow {
  const mult = p.multiplier || multiplierOf(p.contract);
  const live = pos(livePx);
  const last = live ? livePx : finite(p.marketPrice) ? p.marketPrice : undefined;
  const cost = p.quantity * p.avgPrice * mult;
  let value: number | undefined;
  let unrealized: number | undefined;
  if (live) {
    value = p.quantity * livePx * mult;
    unrealized = value - cost;
  } else {
    value = finite(p.marketValue) ? p.marketValue : finite(last) ? p.quantity * last * mult : undefined;
    unrealized = finite(p.unrealizedPnL) ? p.unrealizedPnL : finite(value) ? value - cost : undefined;
  }
  return {
    key: p.key,
    position: p,
    sector,
    last,
    value,
    unrealized,
    unrealizedPct: finite(unrealized) && cost !== 0 ? (unrealized / Math.abs(cost)) * 100 : undefined,
    dayPnl: finite(p.dailyPnL) ? p.dailyPnL + remark(p, value) : undefined,
    weight: finite(value) && finite(netLiq) && netLiq !== 0 ? (value / netLiq) * 100 : undefined,
  };
}

/** Position quantity: "1,200" / "−5" like the design; fractional sizes keep up to 4 decimals ("0.0153"). */
export function qtyLabel(n: number | undefined): string {
  return finite(n) && !Number.isInteger(n) ? f2(n, 4).replace(/\.?0+$/, '') : f0(n);
}

/** Rows with the largest absolute market value first; unknown values last. */
export function sortRows(rows: PositionRow[]): PositionRow[] {
  const size = (r: PositionRow) => (finite(r.value) ? Math.abs(r.value) : -1);
  return rows.slice().sort((a, b) => size(b) - size(a) || a.key.localeCompare(b.key));
}

/** Sum of a field over rows; undefined when any contributing row lacks it. 0 for no rows. */
export function sumRows(rows: readonly PositionRow[], field: 'value' | 'unrealized' | 'dayPnl', filter?: (r: PositionRow) => boolean): number | undefined {
  let sum = 0;
  for (const r of rows) {
    if (filter && !filter(r)) continue;
    const v = r[field];
    if (!finite(v)) return undefined;
    sum += v;
  }
  return sum;
}

/** Sum of absolute market values; undefined when any row has no value. */
export function grossValue(rows: readonly PositionRow[]): number | undefined {
  let sum = 0;
  for (const r of rows) {
    if (!finite(r.value)) return undefined;
    sum += Math.abs(r.value);
  }
  return sum;
}

export interface AccountTotals {
  dayPnl?: number;
  unrealized?: number;
  stockValue?: number;
  optionValue?: number;
  gross?: number;
  /**
   * Stocks + options, shorts negative (the header's Market Value): the rows' values, so it moves
   * with the same prices as the positions table; IB's stock + option market values when a row
   * has no value.
   */
  marketValue?: number;
  /** P&L of positions closed today (the header's Realized Today). */
  realized?: number;
}

/**
 * Account figures, falling back to sums over the positions when IB did not report them.
 * `executions` (today's) are the fallback of the realized P&L before reqPnL has answered.
 */
export function accountTotals(a: AccountSummary | null, rows: readonly PositionRow[], executions?: readonly Execution[]): AccountTotals {
  if (!a) return {};
  const ofType = (t: SecType) => (r: PositionRow) => r.position.contract.secType === t;
  // IB's account P&L is computed at the P&L engine's marks; re-mark it to the prices the rows show.
  const adjust = rows.reduce((sum, r) => sum + remark(r.position, r.value), 0);
  const ibMarketValue = finite(a.stockMarketValue) || finite(a.optionMarketValue) ? (a.stockMarketValue ?? 0) + (a.optionMarketValue ?? 0) : undefined;
  return {
    // Positions closed today only show up in the account figure, so there is no fallback without positions.
    dayPnl: finite(a.dailyPnL) ? a.dailyPnL + adjust : rows.length ? sumRows(rows, 'dayPnl') : undefined,
    unrealized: finite(a.unrealizedPnL) ? a.unrealizedPnL + adjust : sumRows(rows, 'unrealized'),
    stockValue: a.stockMarketValue ?? sumRows(rows, 'value', ofType('STK')),
    optionValue: a.optionMarketValue ?? sumRows(rows, 'value', ofType('OPT')),
    gross: a.grossPositionValue ?? grossValue(rows),
    marketValue: sumRows(rows, 'value', (r) => r.position.contract.secType === 'STK' || r.position.contract.secType === 'OPT') ?? ibMarketValue,
    realized: finite(a.realizedPnL) ? a.realizedPnL : executions ? realizedFromExecutions(executions) : undefined,
  };
}

/**
 * Executions of the current New York day (`dayStart`, `nyDayStart`). The main process keeps
 * every fill of the session, so after New York midnight the list still holds yesterday's.
 */
export function todaysExecutions(executions: readonly Execution[], dayStart: number): Execution[] {
  return executions.filter((e) => e.time >= dayStart);
}

/** Realized P&L of executions (IB's commission reports; opening fills carry none). */
export function realizedFromExecutions(executions: readonly Execution[]): number {
  return executions.reduce((sum, e) => sum + (finite(e.realizedPnL) ? e.realizedPnL : 0), 0);
}

/** Gross position value / net liquidation. */
export function leverage(gross: number | undefined, netLiq: number | undefined): number | undefined {
  return finite(gross) && finite(netLiq) && netLiq > 0 ? gross / netLiq : undefined;
}

/** "1.38×"; "—" when unknown. */
export function leverageLabel(lev: number | undefined): string {
  return finite(lev) ? `${f2(lev)}×` : DASH;
}
