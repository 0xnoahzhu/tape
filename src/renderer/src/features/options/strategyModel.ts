// Strategy builder view-model: per-leg market data, payoff analysis and the order price.
// Pure: everything comes in as arguments.

import { contractKey, daysToExpiry, shortExpiry } from '@shared/contract';
import { f2 } from '@shared/format';
import type { ContractRef, Quote } from '@shared/types';
import { markOf, optionData } from './chain';
import { analyzeStrategy, nearestExpiry, netGreeks, yearsToExpiry, type Greeks4, type PayoffLeg, type StrategyAnalysis } from './math';
import { comboTerms, type ComboTerms } from './orders';
import { legContract, type Leg } from './strategies';

export interface LegView {
  leg: Leg;
  contract: ContractRef;
  /** "10/16 230.00 Call" or "100 AAPL". */
  desc: string;
  mark?: number;
  bid?: number;
  ask?: number;
  iv?: number;
  greeks: Greeks4 | null;
  t: number;
  dte: number;
}

export interface StrategyView {
  legs: LegView[];
  /** Null until every leg has a price. */
  payoff: PayoffLeg[] | null;
  analysis: StrategyAnalysis | null;
  greeks: Greeks4 | null;
  minDte: number;
  /** Price of the order that "Send" places (null when a needed bid / ask / mark is missing). */
  order: { single: true; price: number } | { single: false; terms: ComboTerms } | null;
  /** Dollar amount of the order at that price (positive = debit). */
  orderCost?: number;
}

const stockGreeks: Greeks4 = { delta: 1, gamma: 0, theta: 0, vega: 0 };

export function legDesc(leg: Leg, symbol: string): string {
  if (leg.right === 'S') return `${leg.qty * 100} ${symbol}`;
  return `${shortExpiry(leg.expiry)} ${f2(leg.strike)} ${leg.right === 'C' ? 'Call' : 'Put'}`;
}

export function strategyView(
  legs: Leg[],
  underlying: ContractRef,
  spot: number | undefined,
  underlyingQuote: Quote | undefined,
  quotes: Record<string, Quote>,
  /** Volatility for the probability of profit when the legs have none. */
  fallbackIv: number | undefined,
  now: number = Date.now(),
): StrategyView {
  const views: LegView[] = legs.map((leg) => {
    const contract = legContract(leg, underlying);
    if (leg.right === 'S') {
      const q = underlyingQuote;
      return { leg, contract, desc: legDesc(leg, underlying.symbol), mark: spot, bid: q?.bid, ask: q?.ask, greeks: stockGreeks, t: 0, dte: 0 };
    }
    const t = yearsToExpiry(leg.expiry, now);
    const q = quotes[contractKey(contract)];
    const d = optionData(q, leg.strike, leg.right, spot, t);
    const greeks = d.delta != null && d.gamma != null && d.theta != null && d.vega != null ? { delta: d.delta, gamma: d.gamma, theta: d.theta, vega: d.vega } : null;
    return { leg, contract, desc: legDesc(leg, underlying.symbol), mark: markOf(q), bid: d.bid, ask: d.ask, iv: d.iv, greeks, t, dte: daysToExpiry(leg.expiry, new Date(now)) };
  });

  const priced = views.every((v) => v.mark != null);
  const payoff: PayoffLeg[] | null = priced
    ? views.map((v) => ({
        kind: v.leg.right,
        strike: v.leg.strike,
        sign: v.leg.side === 'BUY' ? 1 : -1,
        qty: v.leg.qty,
        multiplier: v.leg.multiplier,
        price: v.mark!,
        iv: v.iv,
        t: v.t,
      }))
    : null;

  const horizon = payoff ? nearestExpiry(payoff) : 0;
  const frontIvs = views.filter((v) => v.leg.right !== 'S' && Math.abs(v.t - horizon) < 1e-9 && v.iv != null).map((v) => v.iv!);
  const sigma = frontIvs.length ? frontIvs.reduce((a, b) => a + b, 0) / frontIvs.length : fallbackIv;
  const analysis = payoff && spot != null ? analyzeStrategy(payoff, spot, sigma) : null;
  const greeks = views.length ? netGreeks(views.map((v) => ({ sign: v.leg.side === 'BUY' ? 1 : -1, qty: v.leg.qty, multiplier: v.leg.multiplier, greeks: v.greeks }))) : null;
  const options = views.filter((v) => v.leg.right !== 'S');
  const minDte = options.length ? Math.min(...options.map((v) => v.dte)) : 0;

  let order: StrategyView['order'] = null;
  let orderCost: number | undefined;
  if (views.length === 1) {
    const v = views[0];
    const price = v.leg.side === 'BUY' ? v.ask : v.bid;
    if (price != null && price > 0) {
      order = { single: true, price };
      orderCost = (v.leg.side === 'BUY' ? 1 : -1) * price * v.leg.qty * v.leg.multiplier;
    }
  } else if (views.length > 1 && priced) {
    // Combo prices are per option share. A stock leg's ratio counts shares, so its price is
    // scaled by 1 / multiplier (a covered call prices as stock − call).
    const mult = options[0]?.leg.multiplier ?? 100;
    const terms = comboTerms(
      views.map((v) => (v.leg.right === 'S' ? { side: v.leg.side, ratio: v.leg.qty * 100, price: v.mark! / mult } : { side: v.leg.side, ratio: v.leg.qty, price: v.mark! })),
    );
    order = { single: false, terms };
    orderCost = (terms.action === 'BUY' ? 1 : -1) * terms.limitPrice * terms.quantity * mult;
  }

  return { legs: views, payoff, analysis, greeks, minDte, order, orderCost };
}
