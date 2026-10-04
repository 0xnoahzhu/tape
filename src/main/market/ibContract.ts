// Conversions between Tape's ContractRef and the TWS client's structures (pure, unit-tested).

import type { Contract, ContractDescription, ContractDetails } from '../ib/tws';
import type { ContractInfo, ContractRef, SecType, SymbolMatch } from '@shared/types';

type IbSecType = NonNullable<Contract['secType']>;
type IbRight = NonNullable<Contract['right']>;
type IbComboLeg = NonNullable<Contract['comboLegs']>[number];

const WITH_EXPIRY = new Set<SecType>(['OPT', 'FOP', 'FUT', 'WAR']);
const WITH_STRIKE = new Set<SecType>(['OPT', 'FOP', 'WAR']);

/** Default routing when a contract carries no exchange: SMART, except for indices. */
function defaultExchange(secType: SecType): string {
  return secType === 'IND' ? '' : 'SMART';
}

/** The IB contract used for requests. A known conId identifies the contract on its own. */
export function toIbContract(c: ContractRef): Contract {
  const exchange = c.exchange || defaultExchange(c.secType);
  if (c.conId && c.secType !== 'BAG') {
    return { conId: c.conId, exchange, secType: c.secType as IbSecType, currency: c.currency || 'USD' };
  }
  const out: Contract = { symbol: c.symbol, secType: c.secType as IbSecType, exchange, currency: c.currency || 'USD' };
  if (c.primaryExchange && c.secType === 'STK') out.primaryExch = c.primaryExchange;
  if (WITH_EXPIRY.has(c.secType) && c.lastTradeDate) out.lastTradeDateOrContractMonth = c.lastTradeDate;
  if (WITH_STRIKE.has(c.secType) && c.strike != null) out.strike = c.strike;
  if (WITH_STRIKE.has(c.secType) && c.right) out.right = c.right as IbRight;
  if (WITH_EXPIRY.has(c.secType) && c.multiplier) out.multiplier = c.multiplier;
  if (c.localSymbol) out.localSymbol = c.localSymbol;
  if (c.tradingClass) out.tradingClass = c.tradingClass;
  if (c.secType === 'BAG' && c.comboLegs) {
    out.comboLegs = c.comboLegs.map(
      (l) => ({ conId: l.conId, ratio: l.ratio, action: l.action, exchange: l.exchange }) as IbComboLeg,
    );
  }
  return out;
}

/** Builds a ContractRef from an IB contract, keeping the requested fields IB left empty. */
export function fromIbContract(ib: Contract, requested?: ContractRef): ContractRef {
  const secType = (ib.secType || requested?.secType || 'STK') as SecType;
  const ref: ContractRef = {
    symbol: ib.symbol || requested?.symbol || '',
    secType,
    exchange: ib.exchange || requested?.exchange || defaultExchange(secType),
    currency: ib.currency || requested?.currency || 'USD',
  };
  if (ib.conId) ref.conId = ib.conId;
  if (ib.primaryExch) ref.primaryExchange = ib.primaryExch;
  if (WITH_EXPIRY.has(secType)) {
    const ltd = ib.lastTradeDate || ib.lastTradeDateOrContractMonth?.slice(0, 8) || requested?.lastTradeDate;
    if (ltd) ref.lastTradeDate = ltd;
  }
  if (WITH_STRIKE.has(secType)) {
    const strike = ib.strike || requested?.strike;
    if (strike) ref.strike = strike;
    const right = String(ib.right ?? requested?.right ?? '').toUpperCase();
    if (right) ref.right = right.startsWith('P') ? 'P' : 'C';
  }
  const mult = Number(ib.multiplier);
  if (mult > 0) ref.multiplier = mult;
  if (ib.localSymbol) ref.localSymbol = ib.localSymbol;
  if (ib.tradingClass) ref.tradingClass = ib.tradingClass;
  if (secType === 'BAG' && requested?.comboLegs) ref.comboLegs = requested.comboLegs;
  return ref;
}

/**
 * Picks the contract details entry that matches the request best. Stocks prefer the SMART
 * listing in the requested currency (USD by default).
 */
export function pickDetails(list: ContractDetails[], requested: ContractRef): ContractDetails | null {
  if (!list.length) return null;
  const ccy = requested.currency || 'USD';
  const exch = requested.exchange || defaultExchange(requested.secType);
  const score = (d: ContractDetails): number => {
    const c = d.contract;
    let s = 0;
    if (c.currency === ccy) s += 4;
    if (requested.secType === 'STK' ? c.exchange === 'SMART' : c.exchange === exch) s += 2;
    if (requested.primaryExchange && c.primaryExch === requested.primaryExchange) s += 1;
    return s;
  };
  let best = list[0];
  let bestScore = score(best);
  for (const d of list.slice(1)) {
    const s = score(d);
    if (s > bestScore) {
      best = d;
      bestScore = s;
    }
  }
  return best;
}

const splitList = (s: string | undefined): string[] | undefined => {
  const parts = (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
};

export function toContractInfo(d: ContractDetails, requested: ContractRef): ContractInfo {
  const info: ContractInfo = {
    contract: fromIbContract(d.contract, requested),
    longName: d.longName || d.contract.description || requested.symbol,
    minTick: d.minTick && d.minTick > 0 ? d.minTick : 0.01,
  };
  if (d.industry) info.industry = d.industry;
  if (d.category) info.category = d.category;
  if (d.subcategory && d.subcategory !== '*') info.subcategory = d.subcategory;
  if (d.timeZoneId) info.timeZoneId = d.timeZoneId;
  if (d.tradingHours) info.tradingHours = d.tradingHours;
  if (d.liquidHours) info.liquidHours = d.liquidHours;
  const validExchanges = splitList(d.validExchanges);
  if (validExchanges) info.validExchanges = validExchanges;
  const orderTypes = splitList(d.orderTypes);
  if (orderTypes) info.orderTypes = orderTypes;
  const stockType = d.stockType?.trim();
  if (stockType) info.stockType = stockType.toUpperCase();
  return info;
}

/** Instrument types a symbol search can return that Tape can quote and chart directly. */
const SEARCHABLE = new Set<string>(['STK', 'IND', 'CRYPTO']);

export function toSymbolMatch(d: ContractDescription): SymbolMatch | null {
  const c = d.contract;
  if (!c?.symbol || !c.secType || !SEARCHABLE.has(c.secType)) return null;
  const secType = c.secType as SecType;
  const contract: ContractRef = {
    symbol: c.symbol,
    secType,
    exchange: secType === 'STK' ? 'SMART' : c.primaryExch || '',
    currency: c.currency || 'USD',
  };
  if (c.conId) contract.conId = c.conId;
  if (c.primaryExch && secType === 'STK') contract.primaryExchange = c.primaryExch;
  return { contract, description: c.description ?? '', derivativeSecTypes: (d.derivativeSecTypes ?? []).map(String) };
}

/**
 * Orders search results: USD stocks / ETFs / indices first, then other currencies, then other
 * instrument types; an exact symbol match leads its group. Otherwise IB's order is kept.
 */
export function sortMatches(matches: SymbolMatch[], pattern: string): SymbolMatch[] {
  const p = pattern.trim().toUpperCase();
  const tier = (m: SymbolMatch): number => {
    const equity = m.contract.secType === 'STK' || m.contract.secType === 'IND';
    const usd = m.contract.currency === 'USD';
    const base = equity ? (usd ? 0 : 2) : usd ? 4 : 6;
    return base + (m.contract.symbol.toUpperCase() === p ? 0 : 1);
  };
  return matches
    .map((m, i) => ({ m, i, t: tier(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}
