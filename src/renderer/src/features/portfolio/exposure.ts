// The holdings' option exposure (pure): the portfolio greeks on the Positions toolbar (and, for one
// underlying, in the Trade page's activity panel under the options desk, with each row's delta and
// days to expiry) and the line under an option row's symbol ("Call · 12 DTE · 3.2% ITM"). No React
// and no store access; every value comes from the position rows (valued by the one-price rule,
// calc.ts) and quotes: the options' own lines (IB's model greeks, tick 13) and their underlyings'
// (data.ts → useUnderlyingQuotes; the activity panel's own subscription).

import { contractKey, multiplierOf } from '@shared/contract';
import { nyDaysUntil } from '@shared/orderTiming';
import type { ContractRef, OptionRight, Quote } from '@shared/types';
import { underlyingOf, type PositionRow } from './calc';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isOption = (r: PositionRow) => r.position.contract.secType === 'OPT' || r.position.contract.secType === 'FOP';

/** Best last price of a quote: last trade, else mid, else mark, else the previous close. */
export function lastQuotePrice(q: Quote | undefined): number | undefined {
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
 * underlying's quote, else a stock row of it. A futures option is not tied to its future
 * (underlyingOf returns the option itself), so only its model underlying price counts: its own
 * quote is the premium.
 */
export function underlyingPrice(row: PositionRow, quotes: Readonly<Record<string, Quote>>, rows: readonly PositionRow[]): number | undefined {
  const c = row.position.contract;
  if (c.secType === 'STK') return row.last;
  const self = contractKey(c);
  const own = quotes[self]?.undPrice;
  if (finite(own) && own > 0) return own;
  const key = underlyingKey(c);
  if (key === self) return undefined;
  const quoted = lastQuotePrice(quotes[key]);
  if (quoted !== undefined) return quoted;
  const held = rows.find((r) => r.position.contract.secType === 'STK' && contractKey(r.position.contract) === key);
  return held?.last;
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

/**
 * One row's share of portfolioGreeks' delta: a stock its shares, an option IB's model delta ×
 * quantity × multiplier (undefined until IB sends it); undefined for any other instrument. The
 * Trade page's activity panel shows it per row under the options desk.
 */
export function positionDelta(row: PositionRow, quotes: Readonly<Record<string, Quote>>): number | undefined {
  const c = row.position.contract;
  if (c.secType === 'STK') return row.position.quantity;
  if (!isOption(row)) return undefined;
  const d = quotes[contractKey(c)]?.delta;
  return finite(d) ? d * row.position.quantity * (row.position.multiplier || multiplierOf(c)) : undefined;
}

// ---------------------------------------------------------------------------
// An option row's line

/** Days to expiry at or below which an option's DTE is highlighted. */
export const SOON_DAYS = 7;

/** What the line under an option row's symbol says: "Call · 12 DTE · 3.2% ITM". */
export interface OptionLine {
  right?: OptionRight;
  /** Calendar days to expiry (New York's calendar), never negative; undefined without an expiry date. */
  dte?: number;
  /** At most SOON_DAYS to expiry. */
  soon: boolean;
  /** In / out of the money and the distance |S − K| / S in percent; undefined without the underlying price. */
  moneyness?: { itm: boolean; pct: number };
}

/**
 * The line of an option or futures option row (undefined for other instruments). The underlying
 * price is underlyingPrice's: a futures option's only from IB's model, never its premium.
 */
export function optionLine(row: PositionRow, quotes: Readonly<Record<string, Quote>>, rows: readonly PositionRow[], now: Date): OptionLine | undefined {
  if (!isOption(row)) return undefined;
  const c = row.position.contract;
  const dte = /^\d{8}$/.test(c.lastTradeDate ?? '') ? Math.max(0, nyDaysUntil(c.lastTradeDate!, now)) : undefined;
  const S = underlyingPrice(row, quotes, rows);
  const K = c.strike;
  const moneyness = finite(S) && S > 0 && finite(K) ? { itm: c.right === 'P' ? S < K : S > K, pct: (Math.abs(S - K) / S) * 100 } : undefined;
  return { right: c.right, dte, soon: dte !== undefined && dte <= SOON_DAYS, moneyness };
}

/** Whether two lines read the same (the distance to a tenth of a percent, as written). */
export function sameOptionLine(a: OptionLine | undefined, b: OptionLine | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const pct = (l: OptionLine) => (l.moneyness ? Math.round(l.moneyness.pct * 10) : undefined);
  return a.right === b.right && a.dte === b.dte && a.soon === b.soon && a.moneyness?.itm === b.moneyness?.itm && pct(a) === pct(b);
}
