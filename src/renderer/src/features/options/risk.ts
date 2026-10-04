// Option risk alerts computed from positions and live quotes (bell panel › Alerts).

import { contractKey, daysToExpiry, stock } from '@shared/contract';
import type { ContractRef, Position, Quote, Watchlist } from '@shared/types';
import { markOf } from './chain';

/** IB position contracts may lack an exchange; market data requests need one. */
export function quotableContract(c: ContractRef): ContractRef {
  return { ...c, exchange: c.exchange || 'SMART', currency: c.currency || 'USD' };
}

export function isOptionPosition(p: Position): boolean {
  return (p.contract.secType === 'OPT' || p.contract.secType === 'FOP') && p.quantity !== 0;
}

/** The underlying of an option symbol: an index when a watchlist lists one, else the US stock. */
export function underlyingFor(symbol: string, watchlists: Watchlist[]): ContractRef {
  for (const w of watchlists) {
    for (const g of w.groups) {
      for (const it of g.items) if (it.contract.symbol === symbol && it.contract.secType === 'IND') return it.contract;
    }
  }
  return stock(symbol);
}

export type RiskRule = 'exp' | 'asg' | 'move' | 'loss';
export type RiskSeverity = 'high' | 'warn' | 'info';

export interface RiskAlert {
  /** Stable id: rule + contract key (used for de-duplicating notifications). */
  id: string;
  rule: RiskRule;
  severity: RiskSeverity;
  position: Position;
  /** exp: days to expiry. */
  days?: number;
  /** asg: the short leg is already in the money. */
  itm?: boolean;
  /** move: underlying change today, percent. */
  movePct?: number;
  /** loss: loss as a percent of the premium paid / received. */
  lossPct?: number;
}

export const EXPIRY_WINDOW_DAYS = 7;
export const ASSIGNMENT_DELTA = 0.4;
/** Without a delta, a short option within this distance of the strike counts as near the money. */
export const NEAR_MONEY_PCT = 2;
export const BIG_MOVE_PCT = 5;

const SEVERITY_ORDER: Record<RiskSeverity, number> = { high: 0, warn: 1, info: 2 };

/**
 * Evaluates every option position. `underlyingQuote` returns the quote of the position's
 * underlying when one is available.
 */
export function computeRiskAlerts(
  positions: Position[],
  quotes: Record<string, Quote>,
  underlyingQuote: (p: Position) => Quote | undefined,
  now: Date = new Date(),
): RiskAlert[] {
  const out: RiskAlert[] = [];
  const movedSymbols = new Set<string>();
  for (const p of positions) {
    const c = p.contract;
    if ((c.secType !== 'OPT' && c.secType !== 'FOP') || !p.quantity || !c.lastTradeDate || c.strike == null) continue;
    const key = contractKey(c);
    const q = quotes[key];
    const uq = underlyingQuote(p);
    const spot = lastOf(uq) ?? (q?.undPrice && q.undPrice > 0 ? q.undPrice : undefined);
    const short = p.quantity < 0;

    const days = daysToExpiry(c.lastTradeDate, now);
    if (days >= 0 && days <= EXPIRY_WINDOW_DAYS) out.push({ id: `exp:${key}`, rule: 'exp', severity: 'warn', position: p, days });

    if (short) {
      const delta = q?.delta;
      const itm = spot != null ? (c.right === 'C' ? spot > c.strike : spot < c.strike) : delta != null && Math.abs(delta) >= 0.5;
      const near = delta != null ? Math.abs(delta) >= ASSIGNMENT_DELTA : spot != null && (itm || Math.abs(spot / c.strike - 1) * 100 <= NEAR_MONEY_PCT);
      if (near) out.push({ id: `asg:${key}`, rule: 'asg', severity: 'high', position: p, itm });
    }

    const chg = uq && uq.close ? ((lastOf(uq) ?? uq.close) / uq.close - 1) * 100 : undefined;
    if (chg != null && Math.abs(chg) >= BIG_MOVE_PCT && !movedSymbols.has(c.symbol)) {
      movedSymbols.add(c.symbol);
      out.push({ id: `move:${c.symbol}`, rule: 'move', severity: 'info', position: p, movePct: chg });
    }

    const cost = Math.abs(p.avgPrice * p.quantity * (p.multiplier || 100));
    const mark = markOf(q) ?? p.marketPrice;
    const pnl = p.unrealizedPnL ?? (mark != null ? (mark - p.avgPrice) * p.quantity * (p.multiplier || 100) : undefined);
    if (cost > 0 && pnl != null && pnl < 0) {
      const lossPct = (-pnl / cost) * 100;
      if (lossPct >= (short ? 100 : 50)) out.push({ id: `loss:${key}`, rule: 'loss', severity: short ? 'warn' : 'info', position: p, lossPct });
    }
  }
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.days ?? 99) - (b.days ?? 99));
}

function lastOf(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (q.last != null && q.last > 0) return q.last;
  const mid = markOf(q);
  return mid ?? (q.close && q.close > 0 ? q.close : undefined);
}

/** Dot color for a severity (design: accent for expiry, red for risk, muted for info). */
export function severityColor(s: RiskSeverity): string {
  return s === 'high' ? 'var(--r)' : s === 'warn' ? 'var(--ac)' : 'var(--mu)';
}
