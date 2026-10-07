// Quote subscription bookkeeping (pure, unit-tested): unions the subscriptions of all owners
// (renderer views and main-process services) per contract, merges their profiles, keeps a stable
// priority order (visible views before background owners, then first come) and maps each contract
// to its IB generic tick list, within the ids IB accepts for the type.

import { contractKey } from '@shared/contract';
import { ADD_ON_TICKS, isAddOnProfile } from '@shared/quoteProfiles';
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
 * background and yields market data lines to these when the line limit is reached. The Positions
 * table's extra ticks ('positions-table') stay background on purpose: they ask for the portfolio's
 * own contracts, so they open no line and change no line's priority.
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
 * The generic ticks IB accepts per instrument type: the "Legal ones" its error 321 lists (live probe
 * of the paper account, server 193, October 2026). IB sent the same 30 ids for every type it was
 * asked about, so the list only rules out ids illegal everywhere (104 historical volatility, 576,
 * 578); which ticks a type answers with is in ADD_ON_TICKS and ticksFor. Warrants were not
 * resolved and combos not probed: they get none.
 */
const PROBED: readonly number[] = [100, 101, 105, 106, 165, 221, 225, 232, 233, 236, 258, 292, 293, 294, 295, 318, 375, 411, 456, 460, 499, 577, 586, 587, 588, 595, 614, 619, 623, 787];
const LEGAL = new Set(PROBED);
const NONE: ReadonlySet<number> = new Set();
export const LEGAL_GENERIC_TICKS: Record<SecType, ReadonlySet<number>> = {
  STK: LEGAL,
  OPT: LEGAL,
  IND: LEGAL,
  FUT: LEGAL,
  FOP: LEGAL,
  CASH: LEGAL,
  CRYPTO: LEGAL,
  CFD: LEGAL,
  BOND: LEGAL,
  WAR: NONE,
  BAG: NONE,
};

/**
 * Legal ids Tape never asks for: 258 (fundamentals, needs a subscription; seen ending the line) and
 * 787 (odd-lot quotes, seen ending the line), 232 (the same mark as 221), and ids that describe no
 * holding (292 news, 375 RT trade volume, 586 IPO prices, 587 delayed mark, 619 slow mark).
 */
export const NEVER_REQUESTED: ReadonlySet<number> = new Set([232, 258, 292, 375, 586, 587, 619, 787]);

/**
 * How much of a line's generic tick list IB gets (market/quotes.ts steps down on error 321):
 * 'full' every profile, 'core' without the add-on profiles, 'none' no generic tick at all.
 */
export type TickLevel = 'full' | 'core' | 'none';

const BASE_PROFILES: ReadonlySet<string> = new Set(['basic', 'underlying', 'option', 'dividends']);

/** A profile the main process knows (profiles come over IPC). */
export const isQuoteProfile = (v: unknown): v is QuoteProfile => (typeof v === 'string' && BASE_PROFILES.has(v)) || isAddOnProfile(v);

/**
 * Generic ticks per instrument type and base profile:
 * - stocks/ETFs: 318 = last RTH trade; underlying adds option volume (100), open interest (101),
 *   implied (106) and real-time historical volatility (411; 104 is not legal), 52-week statistics
 *   (165) and the dividends tick (456), so it covers the dividends profile
 * - options: option volume / open interest, implied volatility and the mark price (221 -> tick
 *   37; model greeks always arrive)
 * - indices: no generic ticks for plain quotes; the underlying profile adds the option statistics
 * - dividends (stocks only): basic + 456, IB's dividend summary (tick 59). IB sends it on live
 *   lines only (a delayed line gets none); other instruments get their basic ticks
 * An add-on profile is the type's basic ticks plus its own (shared/quoteProfiles.ts → ADD_ON_TICKS).
 */
function ticksFor(secType: SecType, profile: QuoteProfile): readonly number[] {
  if (isAddOnProfile(profile)) return [...ticksFor(secType, 'basic'), ...(ADD_ON_TICKS[profile][secType] ?? [])];
  switch (secType) {
    case 'STK':
      // The stock lists nest (basic ⊂ dividends ⊂ underlying), so a line switched between the
      // options view and the dashboard is requested again at most once and then kept.
      if (profile === 'underlying') return [100, 101, 106, 165, 318, 411, 456];
      return profile === 'dividends' ? [318, 456] : [318];
    case 'OPT':
    case 'FOP':
      return [100, 101, 106, 221];
    case 'IND':
      return profile === 'underlying' ? [100, 101, 106, 165, 411] : [];
    default:
      return [];
  }
}

/**
 * The generic tick list of a line wanted with `profiles`, at `level` (see TickLevel): only ids IB
 * accepts for the type (LEGAL_GENERIC_TICKS) that Tape asks for at all (not NEVER_REQUESTED).
 */
export function genericTicksFor(contract: Pick<ContractRef, 'secType'>, profiles: Iterable<QuoteProfile>, level: TickLevel = 'full'): string {
  if (level === 'none') return '';
  const legal = LEGAL_GENERIC_TICKS[contract.secType] ?? NONE;
  const ticks = new Set<number>();
  for (const p of profiles) {
    // 'core' keeps what the add-ons build on: the basic ticks.
    const profile = level === 'core' && isAddOnProfile(p) ? 'basic' : p;
    for (const t of ticksFor(contract.secType, profile)) if (legal.has(t) && !NEVER_REQUESTED.has(t)) ticks.add(t);
  }
  return [...ticks].sort((a, b) => a - b).join(',');
}

/** True when a line requested with `have` (a genericTicksFor list) delivers every tick of `need`. */
export function coversTicks(have: string, need: string): boolean {
  if (have === need || !need) return true;
  const set = new Set(have.split(','));
  return need.split(',').every((t) => set.has(t));
}

/**
 * Generic ticks a line is requested again without as soon as no owner wants them: RTVolume (233)
 * sends a message per trade, each one a quote update. Other ticks a line no longer needs stay on it
 * until its next request (dropping them would cost a cancel and a request per line).
 */
export const HEAVY_GENERIC_TICKS: ReadonlySet<string> = new Set(['233']);

/**
 * True when a line requested with `have` can stay the line of a contract wanted with `need`: it
 * delivers every tick of `need` and carries no heavy tick `need` lacks (HEAVY_GENERIC_TICKS).
 */
export function lineServes(have: string, need: string): boolean {
  if (have === need) return true;
  if (!coversTicks(have, need)) return false;
  const wanted = new Set(need.split(','));
  return !have.split(',').some((t) => HEAVY_GENERIC_TICKS.has(t) && !wanted.has(t));
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
    // An unknown profile (an older renderer, a typo over IPC) gets the basic ticks.
    const valid = subs
      .filter((s) => s && s.contract && s.contract.symbol && s.contract.secType)
      .map((s) => (isQuoteProfile(s.profile) ? s : { ...s, profile: 'basic' as const }));
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
