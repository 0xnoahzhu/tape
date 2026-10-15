// One underlying's option exposure (pure), for the Trade page's activity panel under the options
// desk: the greeks of the symbol's stock and options together (Δ, $Δ, Γ, Θ, Vega), each row's share
// of the delta and its days to expiry. These add up IB's per-share model greeks (tick 13) of the
// options' own lines; the Positions page shows none of them (it shows IB's figures only). No React
// and no store access; every value comes from the position rows and quotes: the options' own lines
// and the underlying's.

import { contractKey, multiplierOf } from '@shared/contract';
import { nyDaysUntil } from '@shared/orderTiming';
import type { ContractRef, Quote } from '@shared/types';
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
 * Price of a position's underlying: a stock's own quote, else its row's price (IB's mark or
 * portfolio price); an option's model underlying price, else the underlying's quote, else a stock
 * row of it. A futures option is not tied to its future (underlyingOf returns the option itself),
 * so only its model underlying price counts: its own quote is the premium.
 */
export function underlyingPrice(row: PositionRow, quotes: Readonly<Record<string, Quote>>, rows: readonly PositionRow[]): number | undefined {
  const c = row.position.contract;
  if (c.secType === 'STK') return lastQuotePrice(quotes[contractKey(c)]) ?? row.price;
  const self = contractKey(c);
  const own = quotes[self]?.undPrice;
  if (finite(own) && own > 0) return own;
  const key = underlyingKey(c);
  if (key === self) return undefined;
  const quoted = lastQuotePrice(quotes[key]);
  if (quoted !== undefined) return quoted;
  const held = rows.find((r) => r.position.contract.secType === 'STK' && contractKey(r.position.contract) === key);
  return held && underlyingPrice(held, quotes, rows);
}

// ---------------------------------------------------------------------------
// Greeks

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
 * Greeks over the rows' stocks and options (the activity panel passes one underlying's). IB's model
 * greeks (tick 13) are per share, so an option adds greek × quantity × multiplier; a stock adds its
 * quantity to delta. Totals that
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
      const S = underlyingPrice(r, quotes, rows);
      if (finite(S)) dollar += qty * S;
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
// Days to expiry

/** Days to expiry at or below which an option's DTE is highlighted. */
export const SOON_DAYS = 7;

/**
 * An option or futures option row's calendar days to expiry on New York's calendar (never negative)
 * and whether that is SOON_DAYS or fewer; undefined for other instruments and without an expiry date.
 */
export function optionDte(row: PositionRow, now: Date): { days: number; soon: boolean } | undefined {
  const c = row.position.contract;
  if (!isOption(row) || !/^\d{8}$/.test(c.lastTradeDate ?? '')) return undefined;
  const days = Math.max(0, nyDaysUntil(c.lastTradeDate!, now));
  return { days, soon: days <= SOON_DAYS };
}
