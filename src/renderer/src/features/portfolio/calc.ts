// Pure portfolio helpers: sectors, position rows (IB's own figures, the real-time source first), the
// header's figures and whether they are live. No React and no store access, so everything is unit
// tested.

import { index, stock } from '@shared/contract';
import { DASH, f0, f2 } from '@shared/format';
import type { Clock } from '@shared/timeFormat';
import type { AccountSummary, ConnectionStatus, ContractRef, Position, Quote, SecType } from '@shared/types';

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

/**
 * Where a click on a position row leads (Portfolio › Positions, the panel under the chart): the
 * position's own chart, an option's too (SMART-routed as its quotes are), a stock's as the stock.
 */
export function positionTarget(c: ContractRef): { contract: ContractRef; view: 'chart' } {
  return { contract: c.secType === 'OPT' ? quoteContract(c) : underlyingOf(c), view: 'chart' };
}

/** An option position's underlying in the option chain (the row's context menu). */
export function chainTarget(c: ContractRef): { contract: ContractRef; view: 'opt' } {
  return { contract: underlyingOf(c), view: 'opt' };
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

// ---------------------------------------------------------------------------
// Positions

/**
 * Where a row's figure comes from: 'mark' IB's mark price on the position's own quote line (tick 37,
 * real time), 'pnl' IB's P&L engine (reqPnLSingle, real time), 'portfolio' IB's portfolio update
 * (updatePortfolio, pushed when the position changes, else every 3 minutes).
 */
export type FigureSource = 'mark' | 'pnl' | 'portfolio';

/**
 * A position with IB's own figures, one per datum: the real-time source when IB sends it, else
 * the portfolio update. Nothing here is computed by Tape.
 */
export interface PositionRow {
  key: string;
  position: Position;
  /** Sector key (see sectorOf). */
  sector: string;
  /** IB's mark price (tick 37), else the portfolio update's marketPrice. */
  price?: number;
  priceSource?: FigureSource;
  /** reqPnLSingle's value, else the portfolio update's marketValue. */
  value?: number;
  valueSource?: FigureSource;
  /** reqPnLSingle's unrealized P&L, else the portfolio update's unrealizedPNL. */
  unrealized?: number;
  unrealizedSource?: FigureSource;
  /** reqPnLSingle's realized P&L, else the portfolio update's realizedPNL. */
  realized?: number;
  realizedSource?: FigureSource;
  /** reqPnLSingle's daily P&L (IB sends it nowhere else). */
  dayPnl?: number;
  /**
   * Units of the account currency per unit of the position's currency (IB's ExchangeRate; 1 for the
   * account currency); undefined while IB has not sent the rate.
   */
  fx?: number;
}

/** IB's real-time figure when it sent one, else its periodic one, with where it came from. */
function firstOf(live: number | undefined, liveSource: FigureSource, periodic: number | undefined): { v?: number; src?: FigureSource } {
  if (finite(live)) return { v: live, src: liveSource };
  return finite(periodic) ? { v: periodic, src: 'portfolio' } : {};
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

/**
 * The mark of a position's quote line while the line sends data. A line that no longer does (a final
 * error: its slot went to a visible view at the line limit, or IB ended it) keeps its last mark,
 * which is not real time any more: none then, so the row shows the portfolio update's price.
 */
export function liveMark(q: Pick<Quote, 'mark' | 'error'> | undefined): number | undefined {
  return q?.error?.final ? undefined : q?.mark;
}

/**
 * A position's row. `mark`: IB's mark price (tick 37) from the position's own quote line (liveMark),
 * which the Portfolio page asks for on its positions' lines (not bonds, CFDs or warrants:
 * usePositionRows); `fx`: see fxRate (null = unknown).
 */
export function positionRow(p: Position, mark: number | undefined, sector: string, fx: number | null = 1): PositionRow {
  // A mark that is not positive counts as none (IB marks a missing price -1): the portfolio update's
  // price shows instead, which says 0 for an option worth nothing.
  const price = firstOf(finite(mark) && mark > 0 ? mark : undefined, 'mark', p.marketPrice);
  const value = firstOf(p.pnlValue, 'pnl', p.marketValue);
  const unrealized = firstOf(p.pnlUnrealized, 'pnl', p.unrealizedPnL);
  const realized = firstOf(p.pnlRealized, 'pnl', p.realizedPnL);
  return {
    key: p.key,
    position: p,
    sector,
    price: price.v,
    priceSource: price.src,
    value: value.v,
    valueSource: value.src,
    unrealized: unrealized.v,
    unrealizedSource: unrealized.src,
    realized: realized.v,
    realizedSource: realized.src,
    dayPnl: finite(p.dailyPnL) ? p.dailyPnL : undefined,
    fx: fx ?? undefined,
  };
}

/** Position quantity: "1,200" / "−5" like the design; fractional sizes keep up to 4 decimals ("0.0153"). */
export function qtyLabel(n: number | undefined): string {
  return finite(n) && !Number.isInteger(n) ? f2(n, 4).replace(/\.?0+$/, '') : f0(n);
}

/**
 * How large a row is, for the default order only (never shown): |Value| in the account currency at
 * IB's exchange rate, so a HKD position does not outrank a larger USD one (the value as it is while
 * the rate is unknown); -1 without a value.
 */
export function rowSize(r: PositionRow): number {
  return finite(r.value) ? Math.abs(r.value * (r.fx ?? 1)) : -1;
}

/** Rows with the largest absolute market value first (rowSize); unknown values last. */
export function sortRows(rows: PositionRow[]): PositionRow[] {
  return rows.slice().sort((a, b) => rowSize(b) - rowSize(a) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Header

/** The header's figures: IB's own, as sent (nothing summed or derived by Tape). */
export interface HeaderFigures {
  /** reqPnL's daily, unrealized and realized P&L. */
  dayPnl?: number;
  unrealized?: number;
  realized?: number;
  /** IB's StockMarketValue / OptionMarketValue (account updates). */
  stockValue?: number;
  optionValue?: number;
  /** IB's leverage of the securities segment (gross position value / net liquidation). */
  leverage?: number;
  /** IB's Leverage-C, only while the commodities segment holds anything (futures). */
  leverageC?: number;
  /** IB's Cushion tag in percent (excess liquidity / net liquidation; IB sends a fraction). */
  cushionPct?: number;
}

export function headerFigures(a: AccountSummary | null): HeaderFigures {
  if (!a) return {};
  return {
    dayPnl: a.dailyPnL,
    unrealized: a.unrealizedPnL,
    realized: a.realizedPnL,
    stockValue: a.stockMarketValue,
    optionValue: a.optionMarketValue,
    leverage: a.leverage,
    ...(finite(a.grossPositionValueC) && a.grossPositionValueC !== 0 && finite(a.leverageC) ? { leverageC: a.leverageC } : {}),
    cushionPct: finite(a.cushion) ? a.cushion * 100 : undefined,
  };
}

/** "1.38×"; "—" when unknown. With the commodities segment's: "0.89× · C 2.10×". */
export function leverageLabel(lev: number | undefined, levC?: number): string {
  const s = finite(lev) ? `${f2(lev)}×` : DASH;
  return finite(levC) ? `${s} · C ${f2(levC)}×` : s;
}

/** "18.4%", "−1.0%"; "—" when unknown. */
export function pctLabel(p: number | undefined): string {
  return finite(p) ? `${f2(p, 1)}%` : DASH;
}

/** Cushion below which a margin call is near (percent of net liquidation). */
export const MARGIN_CALL_CUSHION = 10;

export interface CushionBar {
  /** Bar fill in percent (0–100). */
  fill: number;
  /** Below MARGIN_CALL_CUSHION. */
  warn: boolean;
}

/** The bar under Excess Liquidity for IB's cushion in percent; null while IB has not sent it. */
export function cushionBar(pct: number | undefined): CushionBar | null {
  if (!finite(pct)) return null;
  return { fill: Math.min(100, Math.max(0, pct)), warn: pct < MARGIN_CALL_CUSHION };
}

// ---------------------------------------------------------------------------
// Staleness

/**
 * Why the header's figures are not live: Tape is not connected, is connecting or reconnecting, or the
 * summary is another account's than the connected one. They are then the last IB sent, and the header
 * dims them with the time (AccountSummary.updatedAt).
 */
export type HeaderStale = 'disconnected' | 'connecting' | 'otherAccount';

/** Why the header's figures are not live, or null while they are (or there are none). */
export function headerStale(status: ConnectionStatus, summary: Pick<AccountSummary, 'account'> | null, connectedAccount: string | undefined): HeaderStale | null {
  if (!summary) return null;
  if (status === 'connecting' || status === 'reconnecting') return 'connecting';
  if (status !== 'connected') return 'disconnected';
  return connectedAccount && summary.account && summary.account !== connectedAccount ? 'otherAccount' : null;
}

/** When figures were last updated: "09:41 AM", with the date when not today ("10/13 04:00 PM"). */
export function asOfText(t: number, now: number, clock: Clock): string {
  const a = new Date(t);
  const b = new Date(now);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return clock.time(t, sameDay ? {} : { date: 'md' });
}
