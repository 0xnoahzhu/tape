// Order requests for the strategy builder: single legs and BAG combos.

import type { ComboLeg, ContractRef, OrderAction, OrderRequest, PriceConditionSpec } from '@shared/types';

export function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

export interface ComboInput {
  side: OrderAction;
  /** Leg ratio before reduction: option contracts, or shares for a stock leg. */
  ratio: number;
  /** Price per share of the leg (the mark). */
  price: number;
}

export interface ComboTerms {
  action: OrderAction;
  /** Number of combo units. */
  quantity: number;
  /** Reduced leg ratios. */
  ratios: number[];
  /** Leg actions as sent: flipped when the combo is sold. */
  legActions: OrderAction[];
  /** Positive limit price per combo unit. */
  limitPrice: number;
}

const flip = (a: OrderAction): OrderAction => (a === 'BUY' ? 'SELL' : 'BUY');

/**
 * Splits the legs into ratio × quantity and prices one combo unit as Σ ±ratio × price.
 * A net debit is sent as BUY; a net credit is sent as SELL with a positive price, which
 * means the leg actions are reversed (IB applies the combo action to every leg).
 */
export function comboTerms(legs: ComboInput[], tick = 0.01): ComboTerms {
  const g = legs.reduce((a, l) => gcd(a, l.ratio), 0) || 1;
  const ratios = legs.map((l) => Math.round(l.ratio / g));
  const net = legs.reduce((a, l, i) => a + (l.side === 'BUY' ? 1 : -1) * ratios[i] * l.price, 0);
  const debit = net >= 0;
  return {
    action: debit ? 'BUY' : 'SELL',
    quantity: g,
    ratios,
    legActions: legs.map((l) => (debit ? l.side : flip(l.side))),
    limitPrice: Math.max(tick, Number((Math.round(Math.abs(net) / tick) * tick).toFixed(4))),
  };
}

/** The BAG contract for a combo on `underlying`. */
export function comboContract(symbol: string, legs: Array<{ conId: number; ratio: number; action: OrderAction }>): ContractRef {
  const comboLegs: ComboLeg[] = legs.map((l) => ({ conId: l.conId, ratio: l.ratio, action: l.action, exchange: 'SMART' }));
  return { symbol, secType: 'BAG', exchange: 'SMART', currency: 'USD', comboLegs };
}

export function limitOrder(contract: ContractRef, action: OrderAction, quantity: number, limitPrice: number, condition?: PriceConditionSpec): OrderRequest {
  return { contract, action, orderType: 'LMT', quantity, limitPrice, tif: 'DAY', outsideRth: false, ...(condition ? { condition } : {}) };
}

/** How the strategy builder sends its legs. */
export interface StrategyOrderOptions {
  type: 'LMT' | 'MKT';
  tif: 'DAY' | 'GTC';
  /** Combos only: SMART may fill the legs separately (IB's NonGuaranteed routing). */
  nonGuaranteed?: boolean;
  condition?: PriceConditionSpec;
}

/** A strategy order: limit at the net price or market, DAY or GTC; combos optionally non-guaranteed. */
export function strategyOrder(contract: ContractRef, action: OrderAction, quantity: number, limitPrice: number, o: StrategyOrderOptions): OrderRequest {
  const req = limitOrder(contract, action, quantity, limitPrice, o.condition);
  if (o.type === 'MKT') {
    req.orderType = 'MKT';
    delete req.limitPrice;
  }
  req.tif = o.tif;
  if (o.nonGuaranteed && contract.secType === 'BAG') req.nonGuaranteed = true;
  return req;
}

/** Default trigger level: 3% above (≥) or below (≤) the underlying. */
export function defaultTrigger(spot: number, op: '>=' | '<='): string {
  return (spot * (op === '>=' ? 1.03 : 0.97)).toFixed(2);
}
