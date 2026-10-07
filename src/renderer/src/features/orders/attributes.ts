// How an order's attributes read: fill attributes, trigger method, IB algo, conditions, adjustable
// stop, OCA group, destination and note. Shared by the order review, the Orders page, the chart's
// activity panel and the cancel dialog; pure (the labels come from attributeMessages.ts), so it
// works on requests and working orders alike.

import { contractLabel } from '@shared/contract';
import { f0, px } from '@shared/format';
import { algoInfo } from '@shared/orderRules';
import { NEW_YORK, parseIbDateTime } from '@shared/orderTiming';
import { CLOCK_24H, type Clock } from '@shared/timeFormat';
import type { AdjustedStop, AlgoSpec, ContractRef, OcaType, OrderConditionItem, OrderConditions, TriggerMethod } from '@shared/types';

/** The attribute fields of an OrderRequest and a WorkingOrder. */
export interface AttributeFields {
  allOrNone?: boolean;
  minQty?: number;
  hidden?: boolean;
  sweepToFill?: boolean;
  discretionaryAmt?: number;
  displaySize?: number;
  triggerMethod?: TriggerMethod;
  algo?: AlgoSpec;
  conditions?: OrderConditions;
  adjustStop?: AdjustedStop;
  oca?: { group: string; type: OcaType };
  route?: string;
  nonGuaranteed?: boolean;
  cashQty?: number;
  orderRef?: string;
}

export type AttributeLabels = {
  aon: string;
  minQty: (n: string) => string;
  hidden: string;
  sweep: string;
  disc: (amount: string) => string;
  iceberg: (n: string) => string;
  nonGuaranteed: string;
  cashQty: (amount: string) => string;
  triggerMethods: Record<TriggerMethod, string>;
  /** Short form in lists: "Trigger: Midpoint". */
  triggerShort: (name: string) => string;
  algos: Record<string, string>;
  algoParams: Record<string, string>;
  /** IB's choice values (risk aversion, adaptive priority). */
  algoChoices: Record<string, string>;
  ocaTypes: Record<OcaType, string>;
  oca: (group: string) => string;
  route: (exchange: string) => string;
  note: (text: string) => string;
  and: string;
  or: string;
  condPrice: (symbol: string, op: string, price: string) => string;
  condTime: (time: string) => string;
  condPercent: (symbol: string, op: string, pct: string) => string;
  condVolume: (symbol: string, op: string, volume: string) => string;
  condMargin: (op: string, pct: string) => string;
  condExecution: (symbol: string, secType: string) => string;
  /** "+2" more conditions in a short status text. */
  more: (n: number) => string;
  /** Status flag of a conditional cancel: "Cancel if AAPL ≥ 235.00". */
  cancelIf: (cond: string) => string;
  adjust: (trigger: string, to: string) => string;
  adjStop: (p: string) => string;
  adjStopLimit: (stop: string, limit: string) => string;
  adjTrail: (amount: string) => string;
};

const op = (o: '>=' | '<=') => (o === '>=' ? '≥' : '≤');
/** A condition's number, or "—" while it is not a number (being typed). */
const n = (v: number, text: (x: number) => string = String) => (Number.isFinite(v) ? text(v) : '—');
const symbolOf = (c: ContractRef) => (c.secType === 'STK' || c.secType === 'IND' ? c.symbol : contractLabel(c));

/** One condition: "AAPL ≥ 235.00", "after 10/09 10:00 AM ET", "SPY ≤ -2% today", "margin cushion ≤ 30%". */
export function conditionText(c: OrderConditionItem, L: AttributeLabels, clock: Clock = CLOCK_24H): string {
  switch (c.kind) {
    case 'price':
      return L.condPrice(symbolOf(c.contract), op(c.operator), n(c.price, px)) + (c.triggerMethod ? ` (${L.triggerMethods[c.triggerMethod]})` : '');
    case 'time': {
      const at = parseIbDateTime(c.time);
      return L.condTime(at != null ? clock.time(at, { timeZone: NEW_YORK, zone: 'ET', date: 'md' }) : c.time);
    }
    case 'percentChange':
      return L.condPercent(symbolOf(c.contract), op(c.operator), n(c.percent, (x) => `${x > 0 ? '+' : ''}${x}`));
    case 'volume':
      return L.condVolume(symbolOf(c.contract), op(c.operator), n(c.volume, f0));
    case 'margin':
      return L.condMargin(op(c.operator), n(c.percent));
    case 'execution':
      return L.condExecution(c.symbol, c.secType);
  }
}

/** Every condition joined by and / or: "AAPL ≥ 235.00 or after 10/09 10:00 AM ET". */
export function conditionsText(c: OrderConditions, L: AttributeLabels, clock?: Clock): string {
  return c.items.map((i, n) => (n === 0 ? '' : ` ${c.items[n - 1].join === 'or' ? L.or : L.and} `) + conditionText(i, L, clock)).join('');
}

/** The first condition, with the number of the others: "AAPL ≥ 235.00 +2". */
export function conditionsShort(c: OrderConditions, L: AttributeLabels, clock?: Clock): string {
  const first = conditionText(c.items[0], L, clock);
  return c.items.length > 1 ? `${first} ${L.more(c.items.length - 1)}` : first;
}

const fraction = (v: unknown) => (typeof v === 'number' ? `${+(v * 100).toFixed(2)}%` : String(v));

/** "Adaptive · Priority Normal", "VWAP · Max % volume 10% · Start 09:45". */
export function algoText(a: AlgoSpec, L: AttributeLabels, clock: Clock = CLOCK_24H): string {
  const info = algoInfo(a.strategy);
  const parts = [L.algos[a.strategy] ?? a.strategy];
  for (const p of info?.params ?? []) {
    const v = a.params[p.tag];
    if (v == null || v === '' || v === false) continue;
    const name = L.algoParams[p.tag] ?? p.tag;
    if (p.kind === 'switch') parts.push(name);
    else if (p.kind === 'fraction') parts.push(`${name} ${fraction(v)}`);
    else if (p.kind === 'time') parts.push(`${name} ${clock.wall(String(v), { zone: 'ET' })}`);
    else if (p.kind === 'choice') parts.push(`${name} ${L.algoChoices[String(v)] ?? v}`);
    else parts.push(`${name} ${typeof v === 'number' ? f0(v) : v}`);
  }
  return parts.join(' · ');
}

/** "At 230.00 → stop 226.00". */
export function adjustText(a: AdjustedStop, L: AttributeLabels): string {
  const to =
    a.type === 'STP'
      ? L.adjStop(px(a.stopPrice))
      : a.type === 'STP LMT'
        ? L.adjStopLimit(px(a.stopPrice), px(a.limitPrice))
        : L.adjTrail(a.trailUnit === 'percent' ? `${a.trailAmount}%` : px(a.trailAmount));
  return L.adjust(px(a.trigger), to);
}

/** Fill attributes in a row: "AON · Min 5 · Hidden · Sweep · Disc 0.05 · Ice 100". */
export function fillFlags(o: AttributeFields, L: AttributeLabels, withIceberg = true): string[] {
  const out: string[] = [];
  if (o.allOrNone) out.push(L.aon);
  if (o.minQty) out.push(L.minQty(f0(o.minQty)));
  if (o.hidden) out.push(L.hidden);
  if (o.sweepToFill) out.push(L.sweep);
  if (o.discretionaryAmt) out.push(L.disc(px(o.discretionaryAmt)));
  if (withIceberg && o.displaySize) out.push(L.iceberg(f0(o.displaySize)));
  if (o.cashQty) out.push(L.cashQty(px(o.cashQty)));
  if (o.nonGuaranteed) out.push(L.nonGuaranteed);
  return out;
}

/**
 * Short flags of a working order for the lists and the cancel dialog: fill attributes, trigger
 * method, algo name, a conditional cancel, adjustable stop, OCA group, destination and note.
 */
export function attributeFlags(o: AttributeFields, L: AttributeLabels, clock?: Clock, withIceberg = false): string[] {
  const out = fillFlags(o, L, withIceberg);
  if (o.triggerMethod) out.push(L.triggerShort(L.triggerMethods[o.triggerMethod]));
  if (o.algo) out.push(L.algos[o.algo.strategy] ?? o.algo.strategy);
  if (o.conditions?.cancel && o.conditions.items.length) out.push(L.cancelIf(conditionsShort(o.conditions, L, clock)));
  if (o.adjustStop) out.push(adjustText(o.adjustStop, L));
  if (o.oca) out.push(L.oca(o.oca.group));
  if (o.route) out.push(L.route(o.route));
  if (o.orderRef) out.push(L.note(o.orderRef));
  return out;
}
