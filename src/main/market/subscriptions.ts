// Quote subscription bookkeeping (pure, unit-tested): unions the subscriptions of all UI
// owners per contract, merges their profiles, keeps a stable priority order (visible views
// before background owners, then first come) and maps each contract to its IB generic tick list.

import { contractKey } from '@shared/contract';
import type { ContractRef, QuoteProfile, QuoteSubscription, SecType } from '@shared/types';

/** IB allows 100 concurrent market data lines by default; keep headroom for other clients. */
export const MAX_MARKET_DATA_LINES = 95;

export const LINE_LIMIT_ERROR = { code: -1, message: 'Market data line limit reached' } as const;

export interface WantedContract {
  key: string;
  contract: ContractRef;
  profiles: QuoteProfile[];
  /** Best owner priority (OwnerPriority); lower = served first when lines run out. */
  priority: number;
  /** Order in which the contract was first wanted; lower = higher priority within a class. */
  seq: number;
}

/**
 * Owners whose quotes are on screen while they hold subscriptions. Everything else (price
 * alerts, the options risk watcher, the term structure, the portfolio, bell counters, …) is
 * background and yields market data lines to these when the line limit is reached.
 */
const VISIBLE_OWNERS: ReadonlySet<string> = new Set([
  'chart',
  'ticket',
  'watchlist',
  'search',
  'options-chain',
  'options-underlying',
  'options-legs',
  'options-positions',
  'options-alerts',
  'alert-form',
]);

export const OwnerPriority = { Visible: 0, Background: 1 } as const;

/** Priority class of an owner ("<owner>-und" companions share their owner's class). */
export function ownerPriority(owner: string): number {
  const base = owner.endsWith('-und') ? owner.slice(0, -4) : owner;
  return VISIBLE_OWNERS.has(base) ? OwnerPriority.Visible : OwnerPriority.Background;
}

/**
 * Generic ticks per instrument type and profile:
 * - stocks/ETFs: 318 = last RTH trade; underlying adds option volume (100), open interest (101),
 *   historical (104) and implied volatility (106) and 52-week statistics (165)
 * - options: option volume / open interest, implied volatility and the mark price (221 -> tick
 *   37; model greeks always arrive)
 * - indices: no generic ticks for plain quotes; the underlying profile adds the option statistics
 * - dividends (stocks only): basic + 456, IB's dividend summary (tick 59). IB sends it on live
 *   lines only (a delayed line gets none); other instruments get their basic ticks
 */
function ticksFor(secType: SecType, profile: QuoteProfile): number[] {
  switch (secType) {
    case 'STK':
      if (profile === 'underlying') return [100, 101, 104, 106, 165, 318];
      return profile === 'dividends' ? [318, 456] : [318];
    case 'OPT':
    case 'FOP':
      return [100, 101, 106, 221];
    case 'IND':
      return profile === 'underlying' ? [100, 101, 104, 106, 165] : [];
    default:
      return [];
  }
}

export function genericTicksFor(contract: Pick<ContractRef, 'secType'>, profiles: Iterable<QuoteProfile>): string {
  const ticks = new Set<number>();
  for (const p of profiles) for (const t of ticksFor(contract.secType, p)) ticks.add(t);
  return [...ticks].sort((a, b) => a - b).join(',');
}

/** True when a line requested with `have` (a genericTicksFor list) delivers every tick of `need`. */
export function coversTicks(have: string, need: string): boolean {
  if (have === need || !need) return true;
  const set = new Set(have.split(','));
  return need.split(',').every((t) => set.has(t));
}

/** Prefers the more specific description of the same instrument (resolved conId first). */
function richer(a: ContractRef, b: ContractRef): ContractRef {
  if (!a.conId && b.conId) return b;
  if (!a.primaryExchange && b.primaryExchange && !a.conId) return b;
  return a;
}

export class SubscriptionBook {
  private readonly owners = new Map<string, QuoteSubscription[]>();
  private readonly seqs = new Map<string, number>();
  private counter = 0;

  /**
   * Replaces one owner's subscriptions. Returns true when the wanted set changed (contracts,
   * their profiles or their priority).
   */
  set(owner: string, subs: QuoteSubscription[]): boolean {
    const before = this.signature();
    const valid = subs.filter((s) => s && s.contract && s.contract.symbol && s.contract.secType);
    if (valid.length) this.owners.set(owner, valid);
    else this.owners.delete(owner);
    const wanted = new Set<string>();
    for (const list of this.owners.values()) {
      for (const s of list) {
        const key = contractKey(s.contract);
        wanted.add(key);
        if (!this.seqs.has(key)) this.seqs.set(key, ++this.counter);
      }
    }
    for (const key of [...this.seqs.keys()]) if (!wanted.has(key)) this.seqs.delete(key);
    return this.signature() !== before;
  }

  /** All wanted contracts in priority order (visible owners first, then first come), with the union of their profiles. */
  wanted(): WantedContract[] {
    const byKey = new Map<string, { contract: ContractRef; profiles: Set<QuoteProfile>; priority: number }>();
    for (const [owner, list] of this.owners) {
      const priority = ownerPriority(owner);
      for (const s of list) {
        const key = contractKey(s.contract);
        const entry = byKey.get(key);
        if (entry) {
          entry.contract = richer(entry.contract, s.contract);
          entry.profiles.add(s.profile ?? 'basic');
          entry.priority = Math.min(entry.priority, priority);
        } else {
          byKey.set(key, { contract: s.contract, profiles: new Set([s.profile ?? 'basic']), priority });
        }
      }
    }
    return [...byKey.entries()]
      .map(([key, e]) => ({ key, contract: e.contract, profiles: [...e.profiles].sort(), priority: e.priority, seq: this.seqs.get(key) ?? 0 }))
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  has(key: string): boolean {
    return this.seqs.has(key);
  }

  private signature(): string {
    return this.wanted()
      .map((w) => `${w.key}|${w.profiles.join('+')}|${w.priority}`)
      .join(',');
  }
}

/** Splits wanted contracts into those that get a market data line and the overflow. */
export function allocateLines(wanted: WantedContract[], cap = MAX_MARKET_DATA_LINES): { active: WantedContract[]; overflow: WantedContract[] } {
  return { active: wanted.slice(0, cap), overflow: wanted.slice(cap) };
}
