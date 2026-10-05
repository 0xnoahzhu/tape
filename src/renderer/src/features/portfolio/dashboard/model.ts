// Pure computations behind the dashboard widgets (margin cushion, portfolio greeks,
// concentration, today's P&L contributions, option expirations, today's fills, upcoming
// corporate events and the benchmark comparison). No React and no store access; every value
// comes from the account summary, the position rows (valued by the one-price rule, calc.ts),
// quotes, executions and IB's corporate events.

import { contractKey, daysToExpiry, multiplierOf } from '@shared/contract';
import type { Bar, ContractRef, CorporateEarnings, Execution, NavPoint, Quote, QuoteDividends } from '@shared/types';
import { newestExecutions } from '../../orders/model';
import { underlyingOf, type PositionRow } from '../calc';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isOption = (r: PositionRow) => r.position.contract.secType === 'OPT' || r.position.contract.secType === 'FOP';

/** Best last price of a quote: last trade, else mid, else mark, else the previous close. */
export function quotePrice(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (finite(q.last) && q.last > 0) return q.last;
  if (finite(q.bid) && finite(q.ask) && q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  if (finite(q.mark) && q.mark > 0) return q.mark;
  return finite(q.close) && q.close > 0 ? q.close : undefined;
}

/** Contract key of a position's underlying (the stock itself for stocks). */
export const underlyingKey = (c: ContractRef): string => contractKey(underlyingOf(c));

/**
 * Price of a position's underlying: the option's own model underlying price, else the
 * underlying's quote, else a stock row of it.
 */
export function underlyingPrice(row: PositionRow, quotes: Readonly<Record<string, Quote>>, rows: readonly PositionRow[]): number | undefined {
  const c = row.position.contract;
  if (c.secType === 'STK') return row.last;
  const own = quotes[contractKey(c)]?.undPrice;
  if (finite(own) && own > 0) return own;
  const key = underlyingKey(c);
  const quoted = quotePrice(quotes[key]);
  if (quoted !== undefined) return quoted;
  const held = rows.find((r) => r.position.contract.secType === 'STK' && contractKey(r.position.contract) === key);
  return held?.last;
}

/**
 * The holdings' underlyings by contract key: a stock position's own contract (it carries the
 * conId), the underlying stock or index of an option.
 */
export function holdingUnderlyings(rows: readonly PositionRow[]): Map<string, ContractRef> {
  const out = new Map<string, ContractRef>();
  for (const r of rows) {
    const c = r.position.contract;
    if (c.secType === 'STK') out.set(contractKey(c), { ...c, exchange: 'SMART' });
    else if (isOption(r)) {
      const und = underlyingOf(c);
      const k = contractKey(und);
      if (!out.has(k)) out.set(k, und);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Margin cushion

/** Cushion (excess liquidity / net liquidation) below which a margin call is near. */
export const MARGIN_CALL_CUSHION = 10;

export interface MarginCushion {
  /** Excess liquidity in percent of net liquidation. */
  pct: number;
  /** Bar fill in percent (0–100). */
  fill: number;
  /** Below MARGIN_CALL_CUSHION. */
  warn: boolean;
}

/** IB's "Cushion" tag arrives rounded ("1"), so it is computed from excess liquidity and net liquidation. */
export function marginCushion(excessLiquidity: number | undefined, netLiq: number | undefined): MarginCushion | null {
  if (!finite(excessLiquidity) || !finite(netLiq) || netLiq <= 0) return null;
  const pct = (excessLiquidity / netLiq) * 100;
  return { pct, fill: Math.min(100, Math.max(0, pct)), warn: pct < MARGIN_CALL_CUSHION };
}

// ---------------------------------------------------------------------------
// Portfolio greeks

export interface PortfolioGreeks {
  /** Share-equivalent delta (stocks count their shares). */
  delta?: number;
  /** Delta × underlying price, in the account currency. */
  dollarDelta?: number;
  /** Change of the share-equivalent delta per $1 move of the underlyings. */
  gamma?: number;
  /** Time decay per day, in the account currency. */
  theta?: number;
  /** P&L per 1 point of implied volatility, in the account currency. */
  vega?: number;
  /** Option positions whose model greeks IB has not sent yet (the totals are then unknown). */
  pending: number;
  options: number;
}

/**
 * Greeks over all stock and option positions. IB's model greeks (tick 13) are per share, so an
 * option adds greek × quantity × multiplier; a stock adds its quantity to delta. Totals that
 * would leave out an option still waiting for its greeks are undefined, never a partial sum;
 * the dollar delta also needs every underlying price.
 */
export function portfolioGreeks(rows: readonly PositionRow[], quotes: Readonly<Record<string, Quote>>): PortfolioGreeks {
  let delta = 0;
  let dollar = 0;
  let dollarKnown = true;
  let gamma = 0;
  let theta = 0;
  let vega = 0;
  let pending = 0;
  let options = 0;
  for (const r of rows) {
    const c = r.position.contract;
    const qty = r.position.quantity;
    if (c.secType === 'STK') {
      delta += qty;
      if (finite(r.last)) dollar += qty * r.last;
      else dollarKnown = false;
      continue;
    }
    if (!isOption(r)) continue;
    options++;
    const q = quotes[contractKey(c)];
    if (!q || !finite(q.delta) || !finite(q.gamma) || !finite(q.theta) || !finite(q.vega)) {
      pending++;
      continue;
    }
    const size = qty * (r.position.multiplier || multiplierOf(c));
    delta += q.delta * size;
    gamma += q.gamma * size;
    theta += q.theta * size;
    vega += q.vega * size;
    const S = underlyingPrice(r, quotes, rows);
    if (finite(S)) dollar += q.delta * size * S;
    else dollarKnown = false;
  }
  if (pending) return { pending, options };
  return { delta, dollarDelta: dollarKnown ? dollar : undefined, gamma, theta, vega, pending, options };
}

// ---------------------------------------------------------------------------
// Concentration

/** Share of net liquidation from which an underlying is flagged. */
export const CONCENTRATION_FLAG = 20;

export interface ConcentrationItem {
  /** Underlying contract key. */
  key: string;
  underlying: ContractRef;
  /** Σ |market value| of its stock and options. */
  value: number;
  /** Percent of net liquidation. */
  pct: number;
  /** At or above CONCENTRATION_FLAG. */
  flagged: boolean;
}

export interface Concentration {
  /** Largest first, at most `limit`. */
  items: ConcentrationItem[];
  /** Sum of the three largest shares. */
  top3: number;
  /** Largest share (the bars' 100 %). */
  max: number;
}

/** Stock and options combined per underlying, as a share of net liquidation; null without net liquidation. */
export function concentration(rows: readonly PositionRow[], netLiq: number | undefined, limit = 5): Concentration | null {
  if (!finite(netLiq) || netLiq <= 0) return null;
  const by = new Map<string, { underlying: ContractRef; value: number }>();
  for (const r of rows) {
    if (!finite(r.value)) continue;
    const und = underlyingOf(r.position.contract);
    const key = contractKey(und);
    const e = by.get(key);
    if (e) e.value += Math.abs(r.value);
    else by.set(key, { underlying: und, value: Math.abs(r.value) });
  }
  const all = [...by]
    .map(([key, e]) => {
      const pct = (e.value / netLiq) * 100;
      return { key, underlying: e.underlying, value: e.value, pct, flagged: pct >= CONCENTRATION_FLAG };
    })
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  return { items: all.slice(0, limit), top3: all.slice(0, 3).reduce((s, i) => s + i.pct, 0), max: all[0]?.pct ?? 0 };
}

// ---------------------------------------------------------------------------
// Today's P&L by position

export interface Contribution {
  row: PositionRow;
  /** Today's P&L, re-marked to the row's price. */
  pnl: number;
  /** |pnl| / the largest |pnl| (bar length, 0–1). */
  frac: number;
}

/** The positions moving today's P&L most (largest |day P&L| first); rows without one are skipped. */
export function contributions(rows: readonly PositionRow[], limit = 6): Contribution[] {
  const list = rows
    .filter((r): r is PositionRow & { dayPnl: number } => finite(r.dayPnl))
    .sort((a, b) => Math.abs(b.dayPnl) - Math.abs(a.dayPnl) || a.key.localeCompare(b.key))
    .slice(0, limit);
  const max = list.reduce((m, r) => Math.max(m, Math.abs(r.dayPnl)), 0);
  return list.map((row) => ({ row, pnl: row.dayPnl, frac: max > 0 ? Math.abs(row.dayPnl) / max : 0 }));
}

// ---------------------------------------------------------------------------
// Option expirations

/** Days to expiry at or below which an expiration is highlighted. */
export const SOON_DAYS = 7;

export interface Expiration {
  row: PositionRow;
  /** Calendar days to expiry (local), never negative. */
  dte: number;
  soon: boolean;
  /** In / out of the money and the distance |S − K| / S in percent; undefined without the underlying price. */
  moneyness?: { itm: boolean; pct: number };
}

/** Option positions, soonest expiry first. */
export function expirations(rows: readonly PositionRow[], quotes: Readonly<Record<string, Quote>>, now: Date, limit = 6): Expiration[] {
  return rows
    .filter((r) => isOption(r) && /^\d{8}$/.test(r.position.contract.lastTradeDate ?? ''))
    .map((row) => {
      const c = row.position.contract;
      const dte = Math.max(0, daysToExpiry(c.lastTradeDate!, now));
      const S = underlyingPrice(row, quotes, rows);
      const K = c.strike;
      const moneyness =
        finite(S) && S > 0 && finite(K) ? { itm: c.right === 'P' ? S < K : S > K, pct: (Math.abs(S - K) / S) * 100 } : undefined;
      return { row, dte, soon: dte <= SOON_DAYS, moneyness };
    })
    .sort((a, b) => a.dte - b.dte || a.row.key.localeCompare(b.row.key))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Today's fills

/** The newest fills of today, and how many there were. */
export function recentFills(executions: readonly Execution[], limit = 5): { count: number; items: Execution[] } {
  return { count: executions.length, items: newestExecutions([...executions]).slice(0, limit) };
}

// ---------------------------------------------------------------------------
// Earnings and dividends

export interface CorporateEvent {
  /** Underlying contract key. */
  key: string;
  symbol: string;
  underlying: ContractRef;
  kind: 'earnings' | 'dividend';
  /** YYYYMMDD. */
  date: string;
  /** Calendar days from today (local). */
  days: number;
  soon: boolean;
  /** Earnings: before the open, after the close or during the session. */
  time?: 'bmo' | 'amc' | 'dmh';
  /** Dividend per share. */
  amount?: number;
}

/**
 * The holdings' upcoming earnings (Wall Street Horizon) and ex-dividend dates (IB's dividend
 * tick), today or later, soonest first. `underlyings` are the holdings' underlyings by key;
 * events of other instruments are ignored.
 */
export function upcomingEvents(
  underlyings: ReadonlyMap<string, ContractRef>,
  dividends: Readonly<Record<string, QuoteDividends | undefined>>,
  earnings: CorporateEarnings | undefined,
  now: Date,
  limit = 5,
): CorporateEvent[] {
  const out: CorporateEvent[] = [];
  const add = (key: string, kind: CorporateEvent['kind'], date: string, extra: Pick<CorporateEvent, 'time' | 'amount'>) => {
    const und = underlyings.get(key);
    if (!und || !/^\d{8}$/.test(date)) return;
    const days = daysToExpiry(date, now);
    if (days < 0) return;
    out.push({ key, symbol: und.symbol, underlying: und, kind, date, days, soon: days <= SOON_DAYS, ...extra });
  };
  if (earnings?.status === 'ok') for (const e of earnings.events) add(e.key, 'earnings', e.date, e.time ? { time: e.time } : {});
  for (const [key, d] of Object.entries(dividends)) {
    if (d?.nextDate) add(key, 'dividend', d.nextDate, finite(d.nextAmount) ? { amount: d.nextAmount } : {});
  }
  return out.sort((a, b) => a.days - b.days || a.symbol.localeCompare(b.symbol) || a.kind.localeCompare(b.kind)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Benchmark

/**
 * Daily bars are stamped with their day at 00:00 UTC; their close (16:00 New York) is counted at
 * 21:00 UTC, which is after it in summer and winter time.
 */
const CLOSE_AFTER_SEC = 21 * 3600;

/** The last daily close at or before `t` (unix ms); bars ascending. */
export function closeAtOrBefore(bars: readonly Bar[], t: number): number | undefined {
  const sec = t / 1000;
  let found: Bar | undefined;
  for (const b of bars) {
    if (b.time + CLOSE_AFTER_SEC <= sec) found = b;
    else break;
  }
  return found && finite(found.close) && found.close > 0 ? found.close : undefined;
}

/**
 * Return of a benchmark over the equity chart's range, in percent: the live price (else the
 * newest bar's close) against the daily close at or before the range's first NAV sample.
 * Undefined when the bars do not reach back that far.
 */
export function benchmarkReturn(bars: readonly Bar[], start: number | undefined, live: number | undefined): number | undefined {
  if (!finite(start) || !bars.length) return undefined;
  const base = closeAtOrBefore(bars, start);
  const last = finite(live) && live > 0 ? live : bars[bars.length - 1].close;
  return base !== undefined && finite(last) ? (last / base - 1) * 100 : undefined;
}

/** True when the daily bars (ascending) hold a close at or before `start`. */
export const barsCover = (bars: readonly Bar[], start: number): boolean => bars.length > 0 && (bars[0].time + CLOSE_AFTER_SEC) * 1000 <= start;

export interface BenchmarkRow {
  key: 'portfolio' | 'SPY' | 'QQQ';
  pct?: number;
  /** |pct| / the largest |pct| (bar length, 0–1). */
  frac: number;
}

/** The widget's three rows and the difference to SPY in percentage points (undefined without both). */
export function benchmarkRows(portfolio: number | undefined, spy: number | undefined, qqq: number | undefined): { rows: BenchmarkRow[]; vsSpy?: number } {
  const vals = [portfolio, spy, qqq];
  const max = vals.reduce<number>((m, v) => (finite(v) ? Math.max(m, Math.abs(v)) : m), 0);
  const row = (key: BenchmarkRow['key'], pct: number | undefined): BenchmarkRow => ({ key, pct, frac: finite(pct) && max > 0 ? Math.abs(pct) / max : 0 });
  return {
    rows: [row('portfolio', portfolio), row('SPY', spy), row('QQQ', qqq)],
    vsSpy: finite(portfolio) && finite(spy) ? portfolio - spy : undefined,
  };
}

/** Start of the comparison: the first NAV sample of the equity chart's range. */
export const rangeStartTime = (points: readonly NavPoint[]): number | undefined => points[0]?.t;
