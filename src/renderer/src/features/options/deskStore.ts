// Feature-local UI state of the options desk. Lives outside the component so the selected
// expiry, columns and strategy legs survive switching between the Chart and Options views.

import { create } from 'zustand';
import type { ColumnPreset } from './chain';
import { addLeg, type Leg, type NewLeg, type StrategyKey } from './strategies';

export type DeskTab = 'chain' | 'vol' | 'flow' | 'pos';
/** Strikes on each side of ATM (design ranges). */
export type StrikeRange = 5 | 12 | 25 | 'all';

interface DeskState {
  /** contractKey of the underlying the legs belong to. */
  underlyingKey: string;
  tab: DeskTab;
  preset: ColumnPreset;
  range: StrikeRange;
  /** Selected expiry (YYYYMMDD); null = first available. */
  expiry: string | null;
  expOpen: boolean;
  tmplOpen: boolean;
  tmpl: StrategyKey | null;
  legs: Leg[];
  seq: number;
  cond: boolean;
  condOp: '>=' | '<=';
  /** Raw trigger input; null = default (±3% from the underlying). */
  condPx: string | null;
  /** How the legs are sent: at the net mark (limit) or at market, DAY or GTC. */
  ordType: 'LMT' | 'MKT';
  tif: 'DAY' | 'GTC';
  /** Combos: SMART may fill the legs separately (leg risk). */
  nonGuaranteed: boolean;
  /**
   * The limit price the user set with the floating strategy panel's − / + (per share or combo unit);
   * null follows the legs' prices. Any change to the legs drops it.
   */
  netPrice: number | null;

  /** Resets per-underlying state (legs, expiry) when the instrument changes. */
  setUnderlying(key: string): void;
  patch(p: Partial<Pick<DeskState, 'tab' | 'preset' | 'range' | 'expiry' | 'expOpen' | 'tmplOpen' | 'cond' | 'condOp' | 'condPx' | 'ordType' | 'tif' | 'nonGuaranteed' | 'netPrice'>>): void;
  addLeg(leg: NewLeg): void;
  setLegs(legs: NewLeg[], tmpl: StrategyKey | null): void;
  updateLeg(id: number, f: (l: Leg) => Leg): void;
  removeLeg(id: number): void;
  clearLegs(): void;
}

export const useDesk = create<DeskState>()((set) => ({
  underlyingKey: '',
  tab: 'chain',
  preset: 'key',
  range: 12,
  expiry: null,
  expOpen: false,
  tmplOpen: false,
  tmpl: null,
  legs: [],
  seq: 1,
  cond: false,
  condOp: '>=',
  condPx: null,
  ordType: 'LMT',
  tif: 'DAY',
  nonGuaranteed: false,
  netPrice: null,

  setUnderlying: (key) =>
    set((s) => (s.underlyingKey === key ? s : { underlyingKey: key, expiry: null, legs: [], tmpl: null, expOpen: false, condPx: null, netPrice: null })),
  patch: (p) => set(p),
  addLeg: (leg) => set((s) => ({ legs: addLeg(s.legs, leg, s.seq), seq: s.seq + 1, tmpl: null, netPrice: null })),
  setLegs: (legs, tmpl) => set((s) => ({ legs: legs.map((l, i) => ({ ...l, id: s.seq + i })), seq: s.seq + legs.length, tmpl, tmplOpen: false, netPrice: null })),
  updateLeg: (id, f) => set((s) => ({ legs: s.legs.map((l) => (l.id === id ? f(l) : l)), tmpl: null, netPrice: null })),
  removeLeg: (id) => set((s) => ({ legs: s.legs.filter((l) => l.id !== id), tmpl: null, netPrice: null })),
  clearLegs: () => set({ legs: [], tmpl: null, netPrice: null }),
}));
