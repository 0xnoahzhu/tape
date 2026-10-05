// Quote subscription bookkeeping (pure, unit-tested): unions the subscriptions of all owners
// (renderer views and main-process services) per contract, merges their profiles, keeps a stable
// priority order (visible views before background owners, then first come) and maps each contract
// to its IB generic tick list.

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

/** The market data check's owner (market/marketCheck.ts). */
export const MARKET_CHECK_OWNER = 'md-check';

/**
 * Where an owner lives. The renderer holds exactly the quotes its own owners want (it drops the
 * others, state/quoteSubscriptions.ts), so only those are sent to it; a main-process owner (price
 * alerts, the market data check) reads its quotes in main.
 */
export type OwnerKind = 'main' | 'renderer';

/** Priority class of an owner ("<owner>-und" companions share their owner's class). */
export function ownerPriority(owner: string): number {
  const base = owner.endsWith('-und') ? owner.slice(0, -4) : owner;
  return VISIBLE_OWNERS.has(base) ? OwnerPriority.Visible : OwnerPriority.Background;
}

/**
 * Generic ticks per instrument type and profile:
 * - stocks/ETFs: 318 = last RTH trade; underlying adds option volume (100), open interest (101),
 *   historical (104) and implied volatility (106), 52-week statistics (165) and the dividends
 *   tick (456), so it covers the dividends profile
 * - options: option volume / open interest, implied volatility and the mark price (221 -> tick
 *   37; model greeks always arrive)
 * - indices: no generic ticks for plain quotes; the underlying profile adds the option statistics
 * - dividends (stocks only): basic + 456, IB's dividend summary (tick 59). IB sends it on live
 *   lines only (a delayed line gets none); other instruments get their basic ticks
 */
function ticksFor(secType: SecType, profile: QuoteProfile): number[] {
  switch (secType) {
    case 'STK':
      // The stock lists nest (basic ⊂ dividends ⊂ underlying), so a line switched between the
      // options view and the dashboard is requested again at most once and then kept.
      if (profile === 'underlying') return [100, 101, 104, 106, 165, 318, 456];
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

interface Owner {
  name: string;
  kind: OwnerKind;
  subs: QuoteSubscription[];
}

export class SubscriptionBook {
  /** By kind and name, so a renderer owner never replaces a main-process one of the same name. */
  private readonly owners = new Map<string, Owner>();
  private readonly seqs = new Map<string, number>();
  /** Keys some renderer owner wants. */
  private readonly shown = new Set<string>();
  private counter = 0;

  /**
   * Replaces one owner's subscriptions. Returns true when the wanted set changed (contracts,
   * their profiles, their priority, or whether the renderer gets their quotes).
   */
  set(owner: string, subs: QuoteSubscription[], kind: OwnerKind = 'main'): boolean {
    const before = this.signature();
    const valid = subs.filter((s) => s && s.contract && s.contract.symbol && s.contract.secType);
    const id = `${kind}:${owner}`;
    if (valid.length) this.owners.set(id, { name: owner, kind, subs: valid });
    else this.owners.delete(id);
    this.update();
    return this.signature() !== before;
  }

  /** Drops every renderer owner (the renderer was replaced or closed). Returns true when the wanted set changed. */
  clearRenderer(): boolean {
    const before = this.signature();
    for (const [id, o] of [...this.owners]) if (o.kind === 'renderer') this.owners.delete(id);
    this.update();
    return this.signature() !== before;
  }

  private update(): void {
    const wanted = new Set<string>();
    this.shown.clear();
    for (const o of this.owners.values()) {
      for (const s of o.subs) {
        const key = contractKey(s.contract);
        wanted.add(key);
        if (o.kind === 'renderer') this.shown.add(key);
        if (!this.seqs.has(key)) this.seqs.set(key, ++this.counter);
      }
    }
    for (const key of [...this.seqs.keys()]) if (!wanted.has(key)) this.seqs.delete(key);
  }

  /** All wanted contracts in priority order (visible owners first, then first come), with the union of their profiles. */
  wanted(): WantedContract[] {
    const byKey = new Map<string, { contract: ContractRef; profiles: Set<QuoteProfile>; priority: number }>();
    for (const { name, subs: list } of this.owners.values()) {
      const priority = ownerPriority(name);
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

  /** True when a renderer owner wants the contract (its quotes go to the renderer). */
  published(key: string): boolean {
    return this.shown.has(key);
  }

  private signature(): string {
    return this.wanted()
      .map((w) => `${w.key}|${w.profiles.join('+')}|${w.priority}|${this.shown.has(w.key) ? 'p' : 'q'}`)
      .join(',');
  }
}

/** Splits wanted contracts into those that get a market data line and the overflow. */
export function allocateLines(wanted: WantedContract[], cap = MAX_MARKET_DATA_LINES): { active: WantedContract[]; overflow: WantedContract[] } {
  return { active: wanted.slice(0, cap), overflow: wanted.slice(cap) };
}
