// Strategy templates for the builder (design STRAT) and leg helpers.

import { stock } from '@shared/contract';
import type { ContractRef, OrderAction, OptionRight } from '@shared/types';
import { chainContract, nearestIndex, type ChainExpiry } from './chain';

export interface Leg {
  id: number;
  side: OrderAction;
  /** 'S' = stock, counted in 100-share lots. */
  right: OptionRight | 'S';
  /** 0 for stock legs. */
  strike: number;
  expiry: string;
  qty: number;
  tradingClass?: string;
  multiplier: number;
}

export type NewLeg = Omit<Leg, 'id'>;

export type StrategyKey =
  | 'single'
  | 'vertical'
  | 'covered'
  | 'collar'
  | 'straddle'
  | 'strangle'
  | 'calendar'
  | 'diagonal'
  | 'fly'
  | 'condor'
  | 'ironfly'
  | 'icondor'
  | 'custom';

/** Templates in design order with their 20×14 payoff icons. */
export const STRATEGIES: ReadonlyArray<{ key: StrategyKey; icon: string }> = [
  { key: 'single', icon: 'M2 11 L8 11 L17 2' },
  { key: 'vertical', icon: 'M2 11 L7 11 L12 3 L18 3' },
  { key: 'covered', icon: 'M2 13 L10 4 L18 4' },
  { key: 'collar', icon: 'M2 11 L6 11 L13 3 L18 3' },
  { key: 'straddle', icon: 'M2 2 L10 12 L18 2' },
  { key: 'strangle', icon: 'M2 2 L7 12 L13 12 L18 2' },
  { key: 'calendar', icon: 'M2 11 L10 3 L18 11' },
  { key: 'diagonal', icon: 'M2 6 L9 3 L18 11' },
  { key: 'fly', icon: 'M2 11 L7 11 L10 2 L13 11 L18 11' },
  { key: 'condor', icon: 'M2 11 L6 11 L8 3 L12 3 L14 11 L18 11' },
  { key: 'ironfly', icon: 'M2 10 L7 10 L10 3 L13 10 L18 10' },
  { key: 'icondor', icon: 'M2 10 L6 10 L8 3 L12 3 L14 10 L18 10' },
  { key: 'custom', icon: 'M3 4 L3 12 L15 12 L15 7 M8 9 L17 2' },
];

/** Icon shown when no template is selected. */
export const NO_STRATEGY_ICON = 'M2 7 L18 7';

interface LegSpec {
  side: OrderAction;
  right: OptionRight | 'S';
  /** Strike offset in strike steps from the center strike. */
  offset: number;
  /** Uses the next expiration (calendar / diagonal back month). */
  far?: boolean;
  qty?: number;
}

const L = (side: OrderAction, right: OptionRight | 'S', offset = 0, qty = 1, far = false): LegSpec => ({ side, right, offset, qty, far });

const SPECS: Record<StrategyKey, LegSpec[]> = {
  single: [L('BUY', 'C', 0)],
  vertical: [L('BUY', 'C', 0), L('SELL', 'C', 2)],
  covered: [L('BUY', 'S'), L('SELL', 'C', 2)],
  collar: [L('BUY', 'S'), L('BUY', 'P', -2), L('SELL', 'C', 2)],
  straddle: [L('BUY', 'C', 0), L('BUY', 'P', 0)],
  strangle: [L('BUY', 'C', 2), L('BUY', 'P', -2)],
  calendar: [L('SELL', 'C', 0), L('BUY', 'C', 0, 1, true)],
  diagonal: [L('SELL', 'C', 2), L('BUY', 'C', 0, 1, true)],
  fly: [L('BUY', 'C', -2), L('SELL', 'C', 0, 2), L('BUY', 'C', 2)],
  condor: [L('BUY', 'C', -3), L('SELL', 'C', -1), L('SELL', 'C', 1), L('BUY', 'C', 3)],
  ironfly: [L('BUY', 'P', -2), L('SELL', 'P', 0), L('SELL', 'C', 0), L('BUY', 'C', 2)],
  icondor: [L('SELL', 'P', -2), L('BUY', 'P', -4), L('SELL', 'C', 2), L('BUY', 'C', 4)],
  custom: [],
};

/** Templates with a stock leg (not available on an index). */
export function hasStockLeg(key: StrategyKey): boolean {
  return SPECS[key].some((s) => s.right === 'S');
}

/**
 * Legs of a template around `center` (a strike value, usually ATM) in the selected
 * expiration. Calendar and diagonal spreads sell the selected expiry and buy the next one
 * (or the previous / next pair when the last expiry is selected).
 */
export function buildStrategy(key: StrategyKey, expiries: ChainExpiry[], expiryIndex: number, center: number): NewLeg[] {
  if (!expiries.length) return [];
  const last = expiries.length - 1;
  const idx = Math.min(Math.max(0, expiryIndex), last);
  // Only spreads with a back month step back a month on the last expiry.
  const pair = idx === last && idx > 0 && SPECS[key].some((sp) => sp.far);
  const near = expiries[pair ? idx - 1 : idx];
  const far = expiries[pair ? idx : Math.min(idx + 1, last)];
  return SPECS[key].map((s) => {
    const e = s.far ? far : near;
    if (s.right === 'S') return { side: s.side, right: 'S', strike: 0, expiry: e.expiry, qty: s.qty ?? 1, multiplier: 100 };
    const base = nearestIndex(e.strikes, center);
    const k = e.strikes[Math.min(e.strikes.length - 1, Math.max(0, base + s.offset))];
    return { side: s.side, right: s.right, strike: k, expiry: e.expiry, qty: s.qty ?? 1, tradingClass: e.tradingClass, multiplier: e.multiplier };
  });
}

export function sameLeg(a: NewLeg, b: NewLeg): boolean {
  return a.side === b.side && a.right === b.right && a.strike === b.strike && a.expiry === b.expiry;
}

/** Adds a leg, or bumps the quantity of an identical one. */
export function addLeg(legs: Leg[], leg: NewLeg, id: number): Leg[] {
  const same = legs.find((l) => sameLeg(l, leg));
  if (same) return legs.map((l) => (l === same ? { ...l, qty: l.qty + leg.qty } : l));
  return [...legs, { ...leg, id }];
}

/** The tradable contract of a leg. */
export function legContract(leg: Leg | NewLeg, underlying: ContractRef): ContractRef {
  if (leg.right === 'S') return underlying.secType === 'STK' ? underlying : stock(underlying.symbol);
  return chainContract(underlying.symbol, { expiry: leg.expiry, tradingClass: leg.tradingClass ?? '', multiplier: leg.multiplier, exchange: 'SMART', strikes: [] }, leg.strike, leg.right);
}
