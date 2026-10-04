// Turns the order ticket into an OrderRequest plus the review dialog rows.
// Pure: no React, no store access, so every order type can be unit tested.

import { contractLabel, isTradable } from '@shared/contract';
import { f0, parseNum, roundToTick } from '@shared/format';
import { ibEasternTime, sessionOutsideRth, timingProblem, timingText, type TimingProblem } from '@shared/orderTiming';
import { parseTypedTime, type Clock, type TimeFormat } from '@shared/timeFormat';
import type { ContractRef, OrderRequest, OrderType, SecType, TradingSession } from '@shared/types';
import type { ConfirmRow, PendingOrder, TicketState } from '../../state/store';
import { conditionContract, money, positive, priceText, resolveTicket, type TicketMarket, type TicketModel } from './ticketModel';
import { goodTillTime, ticketTiming, type SessionHours } from './timing';

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
  | 'cond'
  | 'ice'
  | 'gat'
  | TimingProblem;

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
}

export type BuildResult = { ok: true; request: OrderRequest; model: TicketModel } | { ok: false; error: TicketError };

export function buildOrderRequest({ contract, ticket: t, market, now = Date.now(), hours, timeFormat }: OrderInput): BuildResult {
  if (!isTradable(contract)) return { ok: false, error: 'index' };
  if (!Number.isInteger(t.qty) || t.qty <= 0) return { ok: false, error: 'qty' };

  // Combinations IBKR does not take (the ticket shows the same problem inline).
  const goodTill = t.tif === 'GTD' ? goodTillTime(t.goodTill, now, hours) : null;
  const timing = timingProblem(ticketTiming(t, contract, t.session, goodTill), now);
  if (timing) return { ok: false, error: timing };

  const model = resolveTicket(t, market);
  const tick = market.minTick;
  const buy = model.buy;
  const req: OrderRequest = {
    contract,
    action: t.side,
    orderType: t.orderType,
    quantity: t.qty,
    tif: t.tif,
    outsideRth: sessionOutsideRth(t.session),
    session: t.session,
  };
  if (goodTill) req.goodTillDate = ibEasternTime(goodTill.ymd, goodTill.hhmm);

  switch (t.orderType) {
    case 'LMT':
      if (!positive(model.limit)) return { ok: false, error: 'limit' };
      req.limitPrice = roundToTick(model.limit, tick);
      break;
    case 'MKT':
      break;
    case 'STP':
      if (!positive(model.stop)) return { ok: false, error: 'stop' };
      req.stopPrice = roundToTick(model.stop, tick);
      break;
    case 'STP LMT':
      if (!positive(model.stop)) return { ok: false, error: 'stop' };
      if (!positive(model.limit)) return { ok: false, error: 'limit' };
      req.stopPrice = roundToTick(model.stop, tick);
      req.limitPrice = roundToTick(model.limit, tick);
      break;
    case 'TRAIL':
      if (!positive(model.trail) || (t.trailMode === 'pct' && model.trail >= 100)) return { ok: false, error: 'trail' };
      if (t.trailMode === 'pct') req.trailingPercent = model.trail;
      else req.trailingAmount = model.trail;
      // Without a last price IB computes the initial stop itself.
      if (positive(model.stop)) req.trailStopPrice = roundToTick(model.stop, tick);
      break;
  }

  // Bracket children cannot be attached when modifying an existing order.
  if (t.bracket && t.modifyingOrderId == null) {
    if (!positive(model.takeProfit)) return { ok: false, error: 'tp' };
    if (!positive(model.stopLoss)) return { ok: false, error: 'sl' };
    const tp = roundToTick(model.takeProfit, tick);
    const sl = roundToTick(model.stopLoss, tick);
    if (model.entry != null) {
      if (buy && tp <= model.entry) return { ok: false, error: 'tpAbove' };
      if (!buy && tp >= model.entry) return { ok: false, error: 'tpBelow' };
      if (buy && sl >= model.entry) return { ok: false, error: 'slBelow' };
      if (!buy && sl <= model.entry) return { ok: false, error: 'slAbove' };
    }
    req.bracket = { takeProfit: tp, stopLoss: sl };
  }

  if (t.condition) {
    if (!positive(model.condPrice)) return { ok: false, error: 'cond' };
    const price = roundToTick(model.condPrice, market.refMinTick ?? tick);
    req.condition = { contract: conditionContract(contract), operator: t.condOp, price, outsideRth: t.condRth };
  }

  if (t.iceberg) {
    const size = parseNum(t.iceQty);
    if (!Number.isInteger(size) || size < 1 || size > t.qty) return { ok: false, error: 'ice' };
    req.displaySize = size;
  }

  if (t.goodAfter) {
    // Typed in either format ("9:35 AM", "09:35", "21:35"); IB gets 24-hour "HH:MM" (ET).
    const time = parseTypedTime(t.goodAfterTime, timeFormat);
    if (!time) return { ok: false, error: 'gat' };
    req.goodAfterTime = time;
  }

  return { ok: true, request: req, model };
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
}

const withUnits = (req: OrderRequest, labels: ReviewLabels) => (labels.units ? labels.units(f0(req.quantity), req.contract.secType) : f0(req.quantity));

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
    case 'TRAIL': {
      const by = req.trailingPercent != null ? `${req.trailingPercent}%` : `$${p(req.trailingAmount)}`;
      return req.trailStopPrice != null ? `${name} ${by} · ${p(req.trailStopPrice)}` : `${name} ${by}`;
    }
  }
}

/** TIF, session and the order's extra attributes, e.g. "GTD 10/09 4:00 PM ET · Extended hours · GAT 9:35 AM ET". */
export function tifText(req: OrderRequest, labels: ReviewLabels): string {
  const x = labels.extras;
  return (
    timingText(req, labels.sessions, labels.clock) +
    (req.bracket ? x.bracket : '') +
    (req.condition ? x.conditional : '') +
    (req.displaySize != null ? x.iceberg : '') +
    (req.goodAfterTime ? x.goodAfter(labels.clock.wall(req.goodAfterTime, { zone: 'ET' })) : '')
  );
}

export function reviewRows(req: OrderRequest, model: TicketModel, labels: ReviewLabels, market: Pick<TicketMarket, 'minTick' | 'refMinTick'>): ConfirmRow[] {
  const minTick = market.minTick;
  const buy = req.action === 'BUY';
  const rows: ConfirmRow[] = [
    { label: labels.contract, value: contractLabel(req.contract) },
    { label: labels.side, value: buy ? labels.buy : labels.sell, color: buy ? 'var(--up)' : 'var(--dn)' },
    { label: labels.qty, value: withUnits(req, labels) },
    { label: labels.typePrice, value: typePriceText(req, labels, minTick) },
    { label: labels.tif, value: tifText(req, labels) },
  ];
  if (req.bracket) {
    rows.push({ label: labels.tpSl, value: `${priceText(req.bracket.takeProfit, minTick)} / ${priceText(req.bracket.stopLoss, minTick)}` });
  }
  if (req.condition) {
    const c = req.condition;
    rows.push({ label: labels.trigger, value: `${contractLabel(c.contract)} ${c.operator === '>=' ? '≥' : '≤'} ${priceText(c.price, market.refMinTick ?? minTick)}` });
  }
  rows.push({ label: labels.estAmount, value: money(model.est, req.contract.currency) });
  return rows;
}

/** The review dialog payload handed to submitOrder(). */
export function pendingOrder(
  req: OrderRequest,
  model: TicketModel,
  labels: ReviewLabels,
  market: Pick<TicketMarket, 'minTick' | 'refMinTick'>,
  modifyOrderId?: number | null,
): PendingOrder {
  const side = req.action === 'BUY' ? labels.buy : labels.sell;
  return {
    request: req,
    rows: reviewRows(req, model, labels, market),
    label: side,
    ...(modifyOrderId != null ? { modifyOrderId } : {}),
    summary: `${side} ${withUnits(req, labels)} ${contractLabel(req.contract)}`,
  };
}
