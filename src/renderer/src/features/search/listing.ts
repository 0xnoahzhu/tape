// Search results as listings (pure, unit-tested): which ones are US listings, how they rank and
// the short tag that tells listings of one name apart ("NASDAQ", "MEXI · MXN", "Index").
//
// IB's symbol search returns every listing of a symbol with the same description: AAPL on NASDAQ
// in USD, on MEXI in MXN, on EBS in CHF, a Canadian depositary receipt on TSE in CAD … Tape is
// used mostly for US instruments, so US listings come first and foreign ones are capped.

import { contractKey } from '@shared/contract';
import type { ContractRef, SymbolMatch } from '@shared/types';

/**
 * US stock exchanges and the US exchanges indices are listed on, as IB names them (DOLLR4LOT is
 * an OTC market; RUSSELL lists the Russell indices, NYBOT the US Dollar Index).
 */
const US_EXCHANGES = new Set([
  'NASDAQ',
  'NYSE',
  'ARCA',
  'AMEX',
  'BATS',
  'IEX',
  'NYSENAT',
  'MEMX',
  'LTSE',
  'PINK',
  'DOLLR4LOT',
  'BYX',
  'EDGX',
  'EDGEA',
  'CHX',
  'PHLX',
  'PSX',
  'BEX',
  'ISE',
  'CBOE',
  'CBOE2',
  'CFE',
  'PSE',
  'RUSSELL',
  'CME',
  'CBOT',
  'NYMEX',
  'COMEX',
  'NYBOT',
]);

/** Temporary corporate-action lines ("BABA.TEN") and delisted instruments IB keeps under VALUE. */
const DEFUNCT_EXCHANGES = new Set(['CORPACT', 'VALUE']);

/** Foreign listings shown at most when the results also hold US listings. */
export const MAX_FOREIGN = 2;

/** Where the instrument is listed: a stock's primary exchange, else its exchange unless SMART. */
export function listingExchange(c: ContractRef): string {
  return c.primaryExchange || (c.exchange && c.exchange !== 'SMART' ? c.exchange : '');
}

/**
 * A USD instrument listed on a US exchange. A USD instrument without a known exchange (a typed
 * ticker, a watchlist entry) is taken as US; crypto is quoted on IB's US venues (PAXOS, ZEROHASH).
 */
export function isUsListing(c: ContractRef): boolean {
  if ((c.currency || 'USD') !== 'USD') return false;
  if (c.secType === 'CRYPTO') return true;
  const exchange = listingExchange(c);
  return !exchange || US_EXCHANGES.has(exchange);
}

export function isDefunct(c: ContractRef): boolean {
  return DEFUNCT_EXCHANGES.has(c.primaryExchange ?? '') || DEFUNCT_EXCHANGES.has(c.exchange);
}

const normSymbol = (s: string) => s.trim().toUpperCase().replace(/[./]/g, ' ');

/** The searched symbol itself, or a share class of it ("BRK B" or "BRK.B" for "BRK"). */
export function isExactSymbol(c: ContractRef, term: string): boolean {
  const s = normSymbol(c.symbol);
  const t = normSymbol(term);
  if (!t) return false;
  return s === t || (c.secType === 'STK' && s.startsWith(t + ' ') && /^[A-Z]{1,2}$/.test(s.slice(t.length + 1)));
}

/**
 * 0 exact US listing · 1 US listing whose symbol starts with the term · 2 other US listing ·
 * 3 exact foreign listing · 4 other foreign listing. Indices are ranked like any listing: an
 * index named as searched leads only when it is a US index (SPX); a foreign one (DAX on EUREX,
 * the EUR/JPY "RY" on CME) is an exact foreign listing.
 */
export function matchTier(c: ContractRef, term: string): number {
  const t = term.trim().toUpperCase();
  const exact = isExactSymbol(c, t);
  if (isUsListing(c)) return exact ? 0 : c.symbol.toUpperCase().startsWith(t) ? 1 : 2;
  return exact ? 3 : 4;
}

/**
 * Orders search results by tier (the order received within a tier), drops defunct lines and duplicates
 * (same conId; same symbol, type, currency and exchange; or the same contractKey, since quotes,
 * watchlists and the open instrument are keyed by it, so only the better ranked one could be
 * told apart), and keeps at most `MAX_FOREIGN` foreign listings when US listings exist. When the
 * list is cut to `limit`, the exact foreign listings keep their rows at the end and the US rows
 * after the exact ones give way.
 */
export function rankMatches(matches: SymbolMatch[], term: string, limit = Infinity): SymbolMatch[] {
  const sorted = matches
    .filter((m) => m.contract.symbol && !isDefunct(m.contract))
    .map((m, i) => ({ m, i, t: matchTier(m.contract, term) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);

  const seen = new Set<string>();
  const unique: typeof sorted = [];
  for (const x of sorted) {
    const c = x.m.contract;
    const keys = [`id:${c.symbol.toUpperCase()}|${c.secType}|${c.currency || 'USD'}|${listingExchange(c)}`, `key:${contractKey(c)}`];
    if (c.conId && c.conId > 0) keys.push(`conId:${c.conId}`);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    unique.push(x);
  }

  const head = unique.filter((x) => x.t <= 2);
  let foreign = unique.filter((x) => x.t >= 3);
  if (unique.some((x) => isUsListing(x.m.contract))) foreign = foreign.slice(0, MAX_FOREIGN);
  const reserved = Math.min(
    foreign.filter((x) => x.t === 3).length,
    Math.max(0, limit - head.filter((x) => x.t === 0).length),
  );
  const headRows = Math.min(head.length, limit - reserved);
  return [...head.slice(0, headRows), ...foreign.slice(0, Math.max(0, limit - headRows))].map((x) => x.m);
}

/**
 * The tag shown next to a result's name: the exchange of a US listing ("NASDAQ"), exchange and
 * currency of any other ("MEXI · MXN", "EBS · USD"), `indexLabel` for indices (with the currency
 * when it is not USD). Empty when nothing is known about the listing.
 */
export function listingTag(c: ContractRef, indexLabel: string): string {
  const currency = c.currency || 'USD';
  if (c.secType === 'IND') return currency === 'USD' ? indexLabel : `${indexLabel} · ${currency}`;
  const exchange = listingExchange(c);
  if (isUsListing(c)) return exchange;
  return exchange ? `${exchange} · ${currency}` : currency;
}

/**
 * Depositary receipt suffixes of IB descriptions: "-CDR", " - CDR", "-SP ADR", "-SPONS ADR",
 * "-UNS ADR", "-SDR", "-ADS" …
 */
const RECEIPT_RE = /^(.*?\S)(\s*-\s*(?:(?:SP|SPON|SPONS|SPONSORED|UNS|UNSP|UNSPON|UNSPONSORED)\s+)?(?:ADR|ADS|CDR|GDR|EDR|IDR|SDR)S?)$/i;

/**
 * Splits a depositary receipt suffix off a description ("APPLE INC-CDR" → "APPLE INC" + "-CDR"),
 * so a long name can be shortened while the suffix, which tells the receipt from the share,
 * stays visible.
 */
export function splitReceipt(description: string): { base: string; suffix: string } {
  const m = RECEIPT_RE.exec(description.trim());
  return m ? { base: m[1], suffix: m[2] } : { base: description.trim(), suffix: '' };
}

/** The minor units IB quotes some markets in (contract details' priceMagnifier 100). */
const MINOR_UNITS: Record<string, string> = { GBP: 'GBp', ZAR: 'ZAc', ILS: 'ILA' };
/**
 * Exchanges whose stocks IB quotes in pence, cents or agorot. On LSEETF it depends on the fund
 * (most GBP lines in pence, some in pounds), so only the contract details tell.
 */
const MINOR_UNIT_EXCHANGES = new Set(['LSE', 'JSE', 'TASE']);

/**
 * The unit shown after a result's price: none for USD and for index points, else the currency,
 * or the minor unit when IB quotes the instrument in it ("1,490.00 GBp" is £14.90).
 * `priceMagnifier` comes from the contract details (100 = minor unit); until it is known the
 * unit follows the exchange, and is left out where it could be either.
 */
export function priceUnit(c: ContractRef, priceMagnifier?: number): string | undefined {
  const currency = c.currency || 'USD';
  if (currency === 'USD' || c.secType === 'IND') return undefined;
  if (priceMagnifier) return priceMagnifier === 1 ? currency : MINOR_UNITS[currency];
  const minor = MINOR_UNITS[currency];
  if (!minor) return currency;
  return MINOR_UNIT_EXCHANGES.has(listingExchange(c)) ? minor : undefined;
}
