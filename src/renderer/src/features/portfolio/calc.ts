// Pure portfolio computations: sectors, position rows, account totals and the margin cushion. No
// React and no store access, so everything is unit tested.

import { index, multiplierOf, stock } from '@shared/contract';
import { DASH, f0, f2 } from '@shared/format';
import type { AccountSummary, ContractRef, Execution, Position, Quote, SecType } from '@shared/types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ---------------------------------------------------------------------------
// Sectors

export const ETF_SECTOR = '@etf';
export const OTHER_SECTOR = '@other';

export interface Classification {
  industry?: string;
  category?: string;
  longName?: string;
  /** IB's stock type from contract details ('COMMON', 'ETF', 'ADR', …). */
  stockType?: string;
}

/** IB stock types of exchange-traded products, which go to the ETF bucket. */
const EXCHANGE_TRADED = new Set(['ETF', 'ETN', 'ETC', 'ETP']);

/** Whether IB's stock type is an exchange-traded product (ETF, ETN, ETC, ETP). */
export function isExchangeTraded(stockType: string | undefined): boolean {
  return !!stockType && EXCHANGE_TRADED.has(stockType.trim().toUpperCase());
}

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

/**
 * The instrument a position belongs to: the underlying for options (a stock in the option's
 * currency, so an option on 0700 in HKD goes with the HKD stock), the stock itself otherwise.
 */
export function underlyingOf(c: ContractRef): ContractRef {
  if (c.secType === 'OPT') {
    const ex = INDEX_EXCHANGES[c.symbol];
    return ex ? index(c.symbol, ex) : { ...stock(c.symbol), currency: c.currency || 'USD' };
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
  /**
   * Units of the account currency per unit of the position's currency (IB's ExchangeRate; 1 for the
   * account currency); undefined while IB has not sent the rate.
   */
  fx?: number;
  /** `value` in the account currency (value × fx). */
  valueBase?: number;
  /** Signed percent of net liquidation (from the value in the account currency). */
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

/**
 * The exchange rate of a position's currency (see PositionRow.fx): 1 for the account currency,
 * IB's rate for another one, null while the account or the rate is unknown.
 */
export function fxRate(currency: string | undefined, account: Pick<AccountSummary, 'currency' | 'exchangeRates'> | null | undefined): number | null {
  if (!account) return null;
  if (!currency || currency === account.currency) return 1;
  const rate = account.exchangeRates?.[currency];
  return finite(rate) && rate > 0 ? rate : null;
}

/** `fx`: see fxRate (null = unknown, so the base-currency value and the weight are too). */
export function positionRow(p: Position, livePx: number | undefined, netLiq: number | undefined, sector: string, fx: number | null = 1): PositionRow {
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
  const valueBase = finite(value) && fx != null ? value * fx : undefined;
  return {
    key: p.key,
    position: p,
    sector,
    last,
    value,
    unrealized,
    unrealizedPct: finite(unrealized) && cost !== 0 ? (unrealized / Math.abs(cost)) * 100 : undefined,
    dayPnl: finite(p.dailyPnL) ? p.dailyPnL + remark(p, value) : undefined,
    fx: fx ?? undefined,
    valueBase,
    weight: finite(valueBase) && finite(netLiq) && netLiq !== 0 ? (valueBase / netLiq) * 100 : undefined,
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
export function sumRows(rows: readonly PositionRow[], field: 'value' | 'valueBase' | 'unrealized' | 'dayPnl', filter?: (r: PositionRow) => boolean): number | undefined {
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
  /**
   * Stocks and options, shorts negative (the header's Stocks / Options): the rows' values in the
   * account currency, so they move with the same prices as the positions table; IB's
   * StockMarketValue / OptionMarketValue when a row has none.
   */
  stockValue?: number;
  optionValue?: number;
  gross?: number;
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
  return {
    // Positions closed today only show up in the account figure, so there is no fallback without positions.
    dayPnl: finite(a.dailyPnL) ? a.dailyPnL + adjust : rows.length ? sumRows(rows, 'dayPnl') : undefined,
    unrealized: finite(a.unrealizedPnL) ? a.unrealizedPnL + adjust : sumRows(rows, 'unrealized'),
    stockValue: sumRows(rows, 'valueBase', ofType('STK')) ?? a.stockMarketValue,
    optionValue: sumRows(rows, 'valueBase', ofType('OPT')) ?? a.optionMarketValue,
    gross: a.grossPositionValue ?? grossValue(rows),
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

// ---------------------------------------------------------------------------
// Margin

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

/**
 * Excess liquidity / net liquidation: the same fraction as IB's "Cushion" (an account-updates
 * value), computed from the summary values the header already has.
 */
export function marginCushion(excessLiquidity: number | undefined, netLiq: number | undefined): MarginCushion | null {
  if (!finite(excessLiquidity) || !finite(netLiq) || netLiq <= 0) return null;
  const pct = (excessLiquidity / netLiq) * 100;
  return { pct, fill: Math.min(100, Math.max(0, pct)), warn: pct < MARGIN_CALL_CUSHION };
}
