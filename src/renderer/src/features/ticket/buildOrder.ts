// Turns the order ticket into an OrderRequest plus the review dialog rows.
// Pure: no React, no store access, so every order type can be unit tested.
//
// composeOrder() always builds the request as far as the ticket allows and notes the first problem
// on the way; buildOrderRequest() refuses a request with a problem and then checks the shared
// order rules (shared/orderRules.ts), which the main process applies again. The ticket also uses
// the composed request to grey out choices that would not combine (choiceProblem).

import { contractLabel, isTradable } from '@shared/contract';
import { f0, parseNum, roundToTick } from '@shared/format';
import { algoInfo, ORDER_TYPE_FIELDS, orderProblems, problemsInvolving, TRIGGER_ORDER_TYPES, type OrderField, type OrderProblem, type OrderRulesContext } from '@shared/orderRules';
import { ibEasternTime, sessionOutsideRth, timingProblem, timingText, type TimingProblem } from '@shared/orderTiming';
import { parseTypedTime, type Clock, type TimeFormat } from '@shared/timeFormat';
import type {
  AdjustedStop,
  AlgoParamValue,
  AlgoSpec,
  BracketSpec,
  ContractRef,
  OrderConditionItem,
  OrderRequest,
  OrderType,
  SecType,
  TradingSession,
  WorkingOrder,
} from '@shared/types';
import type { ConfirmRow, PendingOrder, TicketCondition, TicketState } from '../../state/store';
import { adjustText, algoText, conditionsText, fillFlags, type AttributeLabels } from '../orders/attributes';
import { defaultConditionTime } from './ticketConditions';
import { conditionContract, isTouched, money, positive, priceText, resolveTicket, type TicketMarket, type TicketModel } from './ticketModel';
import { fromLocalInput, goodTillTime, ticketTiming, type SessionHours } from './timing';

export type TicketError =
  | 'index'
  | 'qty'
  | 'limit'
  | 'stop'
  | 'trail'
  | 'tp'
  | 'sl'
  | 'tpAbove'
  | 'tpBelow'
  | 'slBelow'
  | 'slAbove'
  | 'triggerBelow'
  | 'triggerAbove'
  | 'cond'
  | 'ice'
  | 'gat'
  | TimingProblem
  | OrderProblem;

export interface OrderInput {
  contract: ContractRef;
  ticket: TicketState;
  market: TicketMarket;
  /** Unix ms (GTD expiry checks and default); now by default. */
  now?: number;
  /** Trading hours of the instrument, for the default GTD expiry. */
  hours?: SessionHours;
  /** The user's clock format: in '12h' a good-after "3:55" without AM / PM is ambiguous. */
  timeFormat: TimeFormat;
  /** What IB says the contract takes (ContractInfo.orderTypes / validExchanges), when known. */
  rules?: OrderRulesContext;
}

export type BuildResult = { ok: true; request: OrderRequest; model: TicketModel } | { ok: false; error: TicketError };

export interface Composed {
  request: OrderRequest;
  model: TicketModel;
  /** The first problem met while composing (the request is built anyway). */
  error: TicketError | null;
}

const isNum = (n: number) => Number.isFinite(n);

/** Algo parameters as IB values: percentages typed as fractions, times as "HH:MM" New York. */
export function algoParams(strategy: AlgoSpec['strategy'], typed: Record<string, string | boolean>, timeFormat: TimeFormat): Record<string, AlgoParamValue> {
  const out: Record<string, AlgoParamValue> = {};
  for (const p of algoInfo(strategy)?.params ?? []) {
    const v = typed[p.tag];
    if (v == null || v === '' || v === false) continue;
    if (p.kind === 'switch') out[p.tag] = true;
    else if (p.kind === 'choice') out[p.tag] = String(v);
    else if (p.kind === 'time') out[p.tag] = parseTypedTime(String(v), timeFormat) ?? String(v);
    else {
      const n = parseNum(String(v));
      // An unreadable number stays as typed, so the rules name the parameter.
      out[p.tag] = isNum(n) ? (p.kind === 'fraction' ? Math.round(n * 1e4) / 1e6 : n) : String(v);
    }
  }
  return out;
}

/** The conditions editor's rows as the request's conditions (invalid values stay NaN for the rules). */
function conditionItems(rows: TicketCondition[], texts: string[], contract: ContractRef, market: TicketMarket, now: number): { items: OrderConditionItem[]; priceError: boolean } {
  const ref = conditionContract(contract);
  let priceError = false;
  const items = rows.map((c, i): OrderConditionItem => {
    const text = texts[i] ?? c.value ?? '';
    const n = parseNum(text);
    const join = i < rows.length - 1 ? { join: c.join } : {};
    switch (c.kind) {
      case 'price': {
        if (!positive(n)) priceError = true;
        const price = positive(n) && c.contract == null ? roundToTick(n, market.refMinTick ?? market.minTick) : n;
        return { kind: 'price', contract: c.contract ?? ref, operator: c.op, price, ...(c.trigger ? { triggerMethod: c.trigger } : {}), ...join };
      }
      case 'time': {
        const at = fromLocalInput(c.time ?? defaultConditionTime(now));
        return { kind: 'time', time: at ? ibEasternTime(at.ymd, at.hhmm) : '', ...join };
      }
      case 'percentChange':
        return { kind: 'percentChange', contract: c.contract ?? ref, operator: c.op, percent: n, ...join };
      case 'volume':
        return { kind: 'volume', contract: c.contract ?? ref, operator: c.op, volume: n, ...join };
      case 'margin':
        return { kind: 'margin', operator: c.op, percent: n, ...join };
      case 'execution':
        return { kind: 'execution', symbol: c.symbol.trim().toUpperCase() || contract.symbol, secType: c.secType ?? contract.secType, ...join };
    }
  });
  return { items, priceError };
}

/** The adjustable stop of the ticket (on the bracket's stop-loss or the order itself). */
function adjustedStop(t: TicketState, model: TicketModel, tick: number): AdjustedStop {
  const r = (n: number | undefined) => (positive(n) ? roundToTick(n, tick) : (n ?? Number.NaN));
  const a: AdjustedStop = { trigger: r(model.adjTrigger), type: t.adjType };
  if (t.adjType === 'STP' || t.adjType === 'STP LMT') a.stopPrice = r(model.adjStop);
  if (t.adjType === 'STP LMT') a.limitPrice = r(model.adjLimit);
  if (t.adjType === 'TRAIL') {
    a.trailAmount = model.adjTrail ?? Number.NaN;
    a.trailUnit = t.adjTrailUnit;
  }
  return a;
}

/** Builds the request of the ticket, noting the first problem (see the file comment). */
export function composeOrder({ contract, ticket: t, market, now = Date.now(), hours, timeFormat }: OrderInput): Composed {
  let error: TicketError | null = null;
  const fail = (e: TicketError) => {
    error ??= e;
  };
  if (!isTradable(contract)) fail('index');
  const cashSized = t.cashQtyOn && contract.secType === 'CASH';
  if (!cashSized && (!Number.isInteger(t.qty) || t.qty <= 0)) fail('qty');

  // Combinations IBKR does not take (the ticket shows the same problem inline).
  const goodTill = t.tif === 'GTD' ? goodTillTime(t.goodTill, now, hours) : null;
  const timing = timingProblem(ticketTiming(t, contract, t.session, goodTill), now);
  if (timing) fail(timing);

  // A forex order sized by an amount (cashQty, in the order's currency) is worth that amount; the
  // share quantity it replaces in the ticket is not sent.
  const cash = cashSized ? parseNum(t.cashQty) : undefined;
  const model = cashSized ? { ...resolveTicket(t, market), est: positive(cash) ? cash : undefined } : resolveTicket(t, market);
  const tick = market.minTick;
  const buy = model.buy;
  // A modify sends every attribute, switched-off ones as false / 0 / '': IB replaces the whole order.
  const explicit = t.modifyingOrderId != null;
  const req: OrderRequest = {
    contract,
    action: t.side,
    orderType: t.orderType,
    quantity: cashSized ? 0 : t.qty,
    tif: t.tif,
    outsideRth: sessionOutsideRth(t.session),
    session: t.session,
  };
  if (goodTill) req.goodTillDate = ibEasternTime(goodTill.ymd, goodTill.hhmm);

  // Prices: the main types keep their own errors; the others are named by the shared rules.
  const fields = ORDER_TYPE_FIELDS[t.orderType];
  const round = (n: number | undefined) => (positive(n) ? roundToTick(n, tick) : undefined);
  if (fields.limit !== 'none') {
    if (positive(model.limit)) req.limitPrice = round(model.limit);
    else if (fields.limit === 'required') fail('limit');
  }
  if (fields.stop !== 'none') {
    if (positive(model.stop)) req.stopPrice = round(model.stop);
    else fail('stop');
  }
  if (fields.trail !== 'none') {
    const pct = t.trailMode === 'pct';
    if (!positive(model.trail) || (pct && model.trail >= 100)) fail('trail');
    else if (pct) req.trailingPercent = model.trail;
    else req.trailingAmount = model.trail;
    // Without a last price IB computes the initial stop of a TRAIL itself; the others need it.
    if (positive(model.stop)) req.trailStopPrice = round(model.stop);
    else if (fields.trailStop === 'required') fail('trailStop');
  }
  // A touched order whose trigger is already through the market (a buy above, a sell below)
  // triggers at once: refuse it as the bracket checks refuse a take-profit on the wrong side.
  const last = market.last;
  if (isTouched(t.orderType) && positive(last) && positive(req.stopPrice ?? req.trailStopPrice)) {
    const trigger = (req.stopPrice ?? req.trailStopPrice) as number;
    if (buy && trigger >= last) fail('triggerBelow');
    if (!buy && trigger <= last) fail('triggerAbove');
  }
  if (fields.limitOffset !== 'none') {
    if (model.limitOffset != null) req.limitOffset = roundToTick(model.limitOffset, tick);
    else fail('limitOffset');
  }
  if (fields.offset !== 'none') {
    if (t.orderType === 'REL' && t.offsetMode === 'pct') req.percentOffset = model.offset;
    else req.offset = model.offset;
  }

  // Bracket children cannot be attached when modifying an existing order.
  if (t.bracket && t.modifyingOrderId == null) {
    if (!positive(model.takeProfit)) fail('tp');
    if (!positive(model.stopLoss)) fail('sl');
    const tp = round(model.takeProfit);
    const sl = round(model.stopLoss);
    if (model.entry != null && tp != null && sl != null) {
      if (buy && tp <= model.entry) fail('tpAbove');
      if (!buy && tp >= model.entry) fail('tpBelow');
      if (buy && sl >= model.entry) fail('slBelow');
      if (!buy && sl <= model.entry) fail('slAbove');
    }
    const b: BracketSpec = { takeProfit: tp, stopLoss: sl };
    if (t.slType !== 'STP') {
      b.stopType = t.slType;
      if (t.slType === 'STP LMT') b.stopLimit = round(model.slLimit) ?? Number.NaN;
      if (t.slType === 'TRAIL' || t.slType === 'TRAIL LIMIT') {
        if (t.slTrailMode === 'pct') b.stopTrailPercent = model.slTrail ?? Number.NaN;
        else b.stopTrailAmount = model.slTrail ?? Number.NaN;
      }
      if (t.slType === 'TRAIL LIMIT') b.stopLimitOffset = model.slOffset != null ? roundToTick(model.slOffset, tick) : Number.NaN;
    }
    if (t.adjust) b.adjust = adjustedStop(t, model, tick);
    req.bracket = b;
  } else if (t.adjust) {
    req.adjustStop = adjustedStop(t, model, tick);
  }

  if (t.condition) {
    const { items, priceError } = conditionItems(t.conds, model.condTexts, contract, market, now);
    if (priceError) fail('cond');
    req.conditions = { items, outsideRth: t.condRth, ...(t.condCancel ? { cancel: true } : {}) };
  }

  if (t.iceberg) {
    const size = parseNum(t.iceQty);
    if (!Number.isInteger(size) || size < 1 || (!cashSized && size > t.qty)) fail('ice');
    req.displaySize = size;
  }

  if (t.goodAfter) {
    // Typed in either format ("9:35 AM", "09:35", "21:35"); IB gets 24-hour "HH:MM" (ET).
    const time = parseTypedTime(t.goodAfterTime, timeFormat);
    if (!time) fail('gat');
    else req.goodAfterTime = time;
  }

  // Fill attributes.
  if (t.allOrNone || explicit) req.allOrNone = t.allOrNone;
  if (t.minQtyOn) req.minQty = parseNum(t.minQty);
  else if (explicit) req.minQty = 0;
  if (t.hidden || explicit) req.hidden = t.hidden;
  if (t.sweep || explicit) req.sweepToFill = t.sweep;
  if (t.disc) req.discretionaryAmt = parseNum(t.discAmt);
  else if (explicit) req.discretionaryAmt = 0;
  if (cashSized) req.cashQty = cash;
  // The trigger method belongs to stops and touched orders; it is not sent with the others.
  if (TRIGGER_ORDER_TYPES.includes(t.orderType) && (t.triggerMethod || explicit)) req.triggerMethod = t.triggerMethod;

  if (t.algo) req.algo = { strategy: t.algo, params: algoParams(t.algo, t.algoParams, timeFormat) };
  if (t.oca) req.oca = { group: t.ocaGroup.trim(), type: t.ocaType };
  if (t.route && t.route !== 'SMART') req.route = t.route;
  const note = t.orderRef.trim();
  if (note || explicit) req.orderRef = note;

  return { request: req, model, error };
}

export function buildOrderRequest(input: OrderInput): BuildResult {
  const { request, model, error } = composeOrder(input);
  if (error) return { ok: false, error };
  const problem = orderProblems(request, input.rules)[0];
  if (problem) return { ok: false, error: problem };
  return { ok: true, request, model };
}

/**
 * Problems that are about a value still to be typed (a price, a parameter, a group name): they
 * are reported when the order is sent, never a reason to grey out a choice.
 */
const VALUE_PROBLEMS: ReadonlySet<OrderProblem> = new Set<OrderProblem>([
  'limitPrice',
  'stopPrice',
  'trailAmount',
  'trailStop',
  'limitOffset',
  'offset',
  'percentOffset',
  'minQty',
  'discretionaryAmt',
  'conditionValue',
  'conditionCount',
  'algoParam',
  'bracketStopFields',
  'adjustFields',
  'ocaGroup',
  'routeName',
  'cashQtyQuantity',
]);

/**
 * Why the ticket cannot take `patch` with the rest of the order as it is: the first problem of
 * the shared order rules that involves `field` (a value still to be typed does not count). Null
 * when it can.
 */
export function choiceProblem(input: OrderInput, patch: Partial<TicketState>, field: OrderField): OrderProblem | null {
  const { request } = composeOrder({ ...input, ticket: { ...input.ticket, ...patch } });
  return problemsInvolving(request, field, input.rules).find((p) => !VALUE_PROBLEMS.has(p)) ?? null;
}

/** The first problem of the ticket as it is that is not about a value still to be typed. */
export function combinationProblem(input: OrderInput): OrderProblem | null {
  const { request } = composeOrder(input);
  return orderProblems(request, input.rules).find((p) => !VALUE_PROBLEMS.has(p)) ?? null;
}

/** Labels for the review rows, in the current language. */
export interface ReviewLabels {
  contract: string;
  side: string;
  qty: string;
  typePrice: string;
  tif: string;
  trigger: string;
  estAmount: string;
  tpSl: string;
  buy: string;
  sell: string;
  orderTypes: Record<OrderType, string>;
  sessions: Record<TradingSession, string>;
  /** Clock times (GTD expiry, good-after time) in the user's format. */
  clock: Clock;
  /** Quantity with its unit ("100 股" in Chinese); the bare number when absent. */
  units?: (qty: string, secType: SecType) => string;
  extras: { bracket: string; conditional: string; iceberg: string; goodAfter: (t: string) => string };
  /** Rows of the other choices; without them only the basic rows are shown. */
  review?: {
    fill: string;
    triggerMethod: string;
    algo: string;
    conditions: string;
    adjust: string;
    oca: string;
    route: string;
    note: string;
    cancelWhenMet: string;
    inclExt: string;
  };
  stopTypes?: Record<string, string>;
  attr?: AttributeLabels;
  /** A modify's Filled row ("30 / 100 · 70 remaining"). */
  filled?: { label: string; text: (filled: string, total: string, remaining: string) => string };
}

const withUnits = (req: OrderRequest, labels: ReviewLabels) => (labels.units ? labels.units(f0(req.quantity), req.contract.secType) : f0(req.quantity));

/** The limit of a midprice / relative / pegged order: a cap for a buy (≤), a floor for a sell (≥). */
const capSign = (req: OrderRequest) => (req.action === 'SELL' ? '≥' : '≤');

/** "Limit 227.49", "Stop limit 229.75 / 230.21", "Trail 3% · 220.65", "Market". */
export function typePriceText(req: OrderRequest, labels: ReviewLabels, minTick: number): string {
  const name = labels.orderTypes[req.orderType];
  const p = (n: number | undefined) => priceText(n, minTick);
  switch (req.orderType) {
    case 'MKT':
      return name;
    case 'LMT':
      return `${name} ${p(req.limitPrice)}`;
    case 'STP':
      return `${name} ${p(req.stopPrice)}`;
    case 'STP LMT':
      return `${name} ${p(req.stopPrice)} / ${p(req.limitPrice)}`;
    case 'TRAIL':
    case 'TRAIL MIT':
    case 'TRAIL LIMIT':
    case 'TRAIL LIT': {
      const by = req.trailingPercent != null ? `${req.trailingPercent}%` : `$${p(req.trailingAmount)}`;
      const text = req.trailStopPrice != null ? `${name} ${by} · ${p(req.trailStopPrice)}` : `${name} ${by}`;
      return req.limitOffset != null ? `${text} · ±${p(req.limitOffset)}` : text;
    }
    case 'MIT':
      return `${name} ${p(req.stopPrice)}`;
    case 'LIT':
      return `${name} ${p(req.stopPrice)} / ${p(req.limitPrice)}`;
    case 'MOC':
    case 'MTL':
      return name;
    case 'LOC':
      return `${name} ${p(req.limitPrice)}`;
    case 'MIDPRICE':
      return req.limitPrice != null ? `${name} ${capSign(req)} ${p(req.limitPrice)}` : name;
    case 'REL':
    case 'SNAP MID':
    case 'SNAP MKT':
    case 'PEG MID': {
      const off = req.percentOffset != null ? `${req.percentOffset}%` : p(req.offset ?? 0);
      return req.limitPrice != null ? `${name} ±${off} · ${capSign(req)} ${p(req.limitPrice)}` : `${name} ±${off}`;
    }
  }
}

/**
 * TIF, session and the order's extra attributes, e.g. "GTD 10/09 04:00 PM ET · Extended hours · GAT
 * 09:35 AM ET". A bracket and conditions have rows of their own (conditions without the attribute
 * labels only the single price condition's).
 */
export function tifText(req: OrderRequest, labels: ReviewLabels): string {
  const x = labels.extras;
  return (
    timingText(req, labels.sessions, labels.clock) +
    (req.conditions?.items.length && !labels.attr ? x.conditional : '') +
    (req.displaySize != null ? x.iceberg : '') +
    (req.goodAfterTime ? x.goodAfter(labels.clock.wall(req.goodAfterTime, { zone: 'ET' })) : '')
  );
}

/** "Stop 220.50", "Stop limit 220.50 / 220.06", "Trail 2% · 220.50 · ±0.44". */
function stopLossText(b: BracketSpec, labels: ReviewLabels, minTick: number): string {
  const p = (n: number | undefined) => priceText(n, minTick);
  const type = b.stopType ?? 'STP';
  if (!labels.stopTypes || type === 'STP') return p(b.stopLoss);
  const name = labels.stopTypes[type] ?? type;
  if (type === 'STP LMT') return `${name} ${p(b.stopLoss)} / ${p(b.stopLimit)}`;
  const by = b.stopTrailPercent != null ? `${b.stopTrailPercent}%` : `$${p(b.stopTrailAmount)}`;
  return `${name} ${by} · ${p(b.stopLoss)}${type === 'TRAIL LIMIT' ? ` · ±${p(b.stopLimitOffset)}` : ''}`;
}

export function reviewRows(req: OrderRequest, model: TicketModel, labels: ReviewLabels, market: Pick<TicketMarket, 'minTick' | 'refMinTick'>): ConfirmRow[] {
  const minTick = market.minTick;
  const buy = req.action === 'BUY';
  const r = labels.review;
  const a = labels.attr;
  const rows: ConfirmRow[] = [
    { label: labels.contract, value: contractLabel(req.contract) },
    { label: labels.side, value: buy ? labels.buy : labels.sell, color: buy ? 'var(--up)' : 'var(--dn)' },
    { label: labels.qty, value: req.cashQty != null && req.quantity === 0 && a ? a.cashQty(`${priceText(req.cashQty, 0.01)} ${req.contract.currency}`) : withUnits(req, labels) },
    { label: labels.typePrice, value: typePriceText(req, labels, minTick) },
    { label: labels.tif, value: tifText(req, labels) },
  ];
  if (req.bracket) {
    rows.push({ label: labels.tpSl, value: `${priceText(req.bracket.takeProfit, minTick)} / ${stopLossText(req.bracket, labels, minTick)}` });
  }
  if (req.condition) {
    const c = req.condition;
    rows.push({ label: labels.trigger, value: `${contractLabel(c.contract)} ${c.operator === '>=' ? '≥' : '≤'} ${priceText(c.price, market.refMinTick ?? minTick)}` });
  }
  if (req.conditions?.items.length && a) {
    const c = req.conditions;
    const extra = [c.cancel && r ? r.cancelWhenMet : '', c.outsideRth && r ? r.inclExt : ''].filter(Boolean);
    rows.push({ label: r?.conditions ?? labels.trigger, value: conditionsText(c, a, labels.clock) + (extra.length ? ` (${extra.join(', ')})` : '') });
  }
  if (r && a) {
    const fill = fillFlags(req, a, false);
    if (fill.length) rows.push({ label: r.fill, value: fill.join(' · ') });
    if (req.triggerMethod) rows.push({ label: r.triggerMethod, value: a.triggerMethods[req.triggerMethod] });
    if (req.algo) rows.push({ label: r.algo, value: algoText(req.algo, a, labels.clock), parts: true });
    const adjust = req.adjustStop ?? req.bracket?.adjust;
    if (adjust) rows.push({ label: r.adjust, value: adjustText(adjust, a) });
    if (req.oca) rows.push({ label: r.oca, value: `${req.oca.group} · ${a.ocaTypes[req.oca.type]}` });
    if (req.route) rows.push({ label: r.route, value: req.route });
    if (req.orderRef) rows.push({ label: r.note, value: req.orderRef });
  }
  rows.push({ label: labels.estAmount, value: money(model.est, req.contract.currency) });
  return rows;
}

/**
 * A modify's starting point: the working order and the ticket as "Modify" loaded it
 * (ticketPatchFromOrder), composed by the same rules as the ticket now. Comparing the two shows
 * what the modify changes in the same words.
 */
export interface ModifyBase {
  order: WorkingOrder;
  request: OrderRequest;
  model: TicketModel;
}

/** JSON with sorted keys: two requests built the same way compare equal when they ask the same. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x,
  );
}

/** Whether a modify asks IB for anything the working order does not already have. */
export const modifyChanges = (before: OrderRequest, after: OrderRequest): boolean => canonical(before) !== canonical(after);

/**
 * The modify's rows: each row of the new order whose value differs from the order as it is reads
 * "before → after" and is `changed`; a row the order loses reads "before → —", one it gains
 * "— → after". The unchanged rows stay as they are.
 */
export function modifyRows(after: ConfirmRow[], before: ConfirmRow[]): ConfirmRow[] {
  const left = [...before];
  const rows = after.map((r): ConfirmRow => {
    const i = left.findIndex((b) => b.label === r.label);
    if (i < 0) return { ...r, value: `— → ${r.value}`, changed: true };
    const [b] = left.splice(i, 1);
    return b.value === r.value ? r : { ...r, value: `${b.value} → ${r.value}`, changed: true };
  });
  return [...rows, ...left.map((b): ConfirmRow => ({ ...b, value: `${b.value} → —`, changed: true }))];
}

/**
 * The review dialog payload handed to submitOrder() (which binds it to the connection session and
 * the account). A modify (`modify`) shows what changes, before → after, and what has filled; a
 * modify that changes nothing is `unchanged`.
 */
export function pendingOrder(
  req: OrderRequest,
  model: TicketModel,
  labels: ReviewLabels,
  market: Pick<TicketMarket, 'minTick' | 'refMinTick'>,
  modify?: ModifyBase | null,
): Omit<PendingOrder, 'session' | 'isPaper'> {
  const side = req.action === 'BUY' ? labels.buy : labels.sell;
  const now = reviewRows(req, model, labels, market);
  let rows = now;
  if (modify) {
    rows = modifyRows(now, reviewRows(modify.request, modify.model, labels, market));
    const o = modify.order;
    // What has filled stays filled: the new quantity is the order's total.
    if (o.filled > 0 && labels.filled) {
      const at = rows.findIndex((r) => r.label === labels.qty) + 1;
      rows.splice(at, 0, { label: labels.filled.label, value: labels.filled.text(f0(o.filled), f0(o.totalQuantity), f0(o.remaining)) });
    }
  }
  return {
    request: req,
    rows,
    label: side,
    ...(modify ? { modifyOrderId: modify.order.orderId } : {}),
    ...(modify && !modifyChanges(modify.request, req) ? { unchanged: true } : {}),
    summary: `${side} ${req.quantity === 0 && req.cashQty != null ? `${f0(req.cashQty)} ${req.contract.currency}` : withUnits(req, labels)} ${contractLabel(req.contract)}`,
  };
}
