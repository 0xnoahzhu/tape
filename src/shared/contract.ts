// Helpers for identifying and describing instruments.

import type { ContractRef, OptionRight } from './types';

/**
 * Version of the contract details Tape keeps (ContractInfo.v). 2 added the ISIN, market name,
 * contract month, real expiration, last trading time, the underlying and the bond details; older
 * persisted entries are used at once and fetched again in the background.
 */
export const CONTRACT_DETAILS_VERSION = 2;

/**
 * Stable key for an instrument, used for quote maps, selection and subscriptions.
 * Options and futures-options include expiry, strike and right; everything else is
 * keyed by type and symbol (plus currency when it is not USD).
 */
export function contractKey(c: Pick<ContractRef, 'symbol' | 'secType' | 'currency' | 'lastTradeDate' | 'strike' | 'right' | 'conId' | 'comboLegs'>): string {
  if (c.secType === 'OPT' || c.secType === 'FOP') {
    return `${c.secType}:${c.symbol}:${c.lastTradeDate ?? ''}:${c.strike ?? ''}:${c.right ?? ''}`;
  }
  if (c.secType === 'FUT') return `FUT:${c.symbol}:${c.lastTradeDate ?? ''}`;
  if (c.secType === 'BAG') {
    const legs = (c.comboLegs ?? []).map((l) => `${l.action[0]}${l.ratio}x${l.conId}`).join(',');
    return `BAG:${c.symbol}:${legs}`;
  }
  const ccy = c.currency && c.currency !== 'USD' ? `:${c.currency}` : '';
  return `${c.secType}:${c.symbol}${ccy}`;
}

export function stock(symbol: string, primaryExchange?: string): ContractRef {
  return { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD', ...(primaryExchange ? { primaryExchange } : {}) };
}

export function index(symbol: string, exchange: string): ContractRef {
  return { symbol, secType: 'IND', exchange, currency: 'USD' };
}

export function option(underlying: string, lastTradeDate: string, strike: number, right: OptionRight, opts: { tradingClass?: string; multiplier?: number; exchange?: string } = {}): ContractRef {
  return {
    symbol: underlying,
    secType: 'OPT',
    exchange: opts.exchange ?? 'SMART',
    currency: 'USD',
    lastTradeDate,
    strike,
    right,
    multiplier: opts.multiplier ?? 100,
    ...(opts.tradingClass ? { tradingClass: opts.tradingClass } : {}),
  };
}

/** "20261016" -> "10/16" */
export function shortExpiry(yyyymmdd: string | undefined): string {
  if (!yyyymmdd || yyyymmdd.length < 8) return yyyymmdd ?? '';
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

/** "20261016" -> Date at local midnight. */
export function expiryDate(yyyymmdd: string): Date {
  return new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)));
}

/** Calendar days from today (local) until expiry; 0 on expiry day. */
export function daysToExpiry(yyyymmdd: string, now: Date = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((expiryDate(yyyymmdd).getTime() - today.getTime()) / 86_400_000);
}

function trimStrike(strike: number | undefined): string {
  if (strike == null) return '';
  return Number.isInteger(strike) ? String(strike) : String(+strike.toFixed(3));
}

/**
 * Display label in the format used throughout the design:
 * "AAPL", "SPX", "AAPL 10/16 230 Call".
 */
export function contractLabel(c: ContractRef): string {
  switch (c.secType) {
    case 'OPT':
    case 'FOP':
      return `${c.symbol} ${shortExpiry(c.lastTradeDate)} ${trimStrike(c.strike)} ${c.right === 'P' ? 'Put' : 'Call'}`;
    case 'FUT':
      return c.localSymbol ?? `${c.symbol} ${shortExpiry(c.lastTradeDate)}`;
    case 'CASH':
      return `${c.symbol}.${c.currency}`;
    case 'BAG':
      return c.symbol;
    default:
      return c.symbol;
  }
}

/** Instruments that cannot be traded (indices). */
export function isTradable(c: ContractRef): boolean {
  return c.secType !== 'IND';
}

export function sameContract(a: ContractRef | null | undefined, b: ContractRef | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.conId && b.conId) return a.conId === b.conId;
  return contractKey(a) === contractKey(b);
}

export function multiplierOf(c: ContractRef): number {
  if (c.multiplier) return c.multiplier;
  return c.secType === 'OPT' ? 100 : 1;
}
