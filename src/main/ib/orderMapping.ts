// Maps IB order callbacks (openOrder, orderStatus, completedOrder, execDetails) to the app's
// WorkingOrder / Execution models, and builds the texts of order and fill notifications.

import { OrderConditionType, type Contract, type Execution as IbExecution, type Order, type OrderState } from './tws';
import { contractKey, contractLabel } from '@shared/contract';
import { f2, px } from '@shared/format';
import { timingText, type TimingFields } from '@shared/orderTiming';
import type { ContractRef, Execution, LocalizedText, OrderStatus, TradingSession, WorkingOrder } from '@shared/types';
import { createMessages } from '../i18n';
import { fromIbContract, num, parseIbTime } from './ibContract';

const STATUSES: ReadonlySet<string> = new Set<OrderStatus>([
  'ApiPending',
  'PendingSubmit',
  'PendingCancel',
  'PreSubmitted',
  'Submitted',
  'ApiCancelled',
  'Cancelled',
  'Filled',
  'Inactive',
  'Unknown',
]);

export const toStatus = (s: unknown): OrderStatus => (STATUSES.has(String(s)) ? (s as OrderStatus) : 'Unknown');

/**
 * Identity of an order across callbacks: client id + order id; orders entered in TWS
 * without an API id (orderId 0) are identified by their permanent id.
 */
export function orderKey(clientId: number | undefined, orderId: number | undefined, permId: number | undefined): string {
  if (orderId) return `${clientId ?? 0}:${orderId}`;
  return permId ? `p:${permId}` : `0:0`;
}

/** Looks up the symbol of a conId (for price conditions). */
export type SymbolOf = (conId: number) => string | undefined;

function priceCondition(order: Order, symbolOf: SymbolOf): WorkingOrder['condition'] {
  for (const c of order.conditions ?? []) {
    if (c.type !== OrderConditionType.Price) continue;
    const pc = c as unknown as { price?: number; conId?: number; isMore?: boolean };
    const price = num(pc.price);
    if (price == null) continue;
    const conId = pc.conId ?? 0;
    return {
      symbol: (conId && symbolOf(conId)) || String(conId),
      operator: pc.isMore ? '>=' : '<=',
      price,
      outsideRth: !!order.conditionsIgnoreRth,
    };
  }
  return undefined;
}

/** IB's TIF of SMART orders with includeOvernight. */
const OVERNIGHT_DAY_TIF = 'OVERNIGHT + DAY';

/**
 * The trading session of an IB order: the OVERNIGHT venue, includeOvernight ("OVERNIGHT + DAY"),
 * or outsideRth. IB ignores outsideRth for IOC, FOK and OPG (and reports it set for IOC / FOK).
 */
export function ibOrderSession(contract: Contract, order: Order): TradingSession {
  const tif = String(order.tif ?? '');
  if (contract.exchange === 'OVERNIGHT') return 'overnight';
  if (order.includeOvernight || tif === OVERNIGHT_DAY_TIF) return 'overnightDay';
  if (tif === 'IOC' || tif === 'FOK' || tif === 'OPG') return 'regular';
  return order.outsideRth ? 'extended' : 'regular';
}

function orderFields(contract: Contract, order: Order, symbolOf: SymbolOf) {
  const session = ibOrderSession(contract, order);
  const ref = fromIbContract(contract);
  // The instrument is the SMART-routed one; the venue is part of the session.
  if (session === 'overnight') ref.exchange = 'SMART';
  const tif = String(order.tif || 'DAY');
  const orderType = String(order.orderType ?? '');
  const lmt = num(order.lmtPrice);
  const aux = num(order.auxPrice);
  const display = num(order.displaySize);
  const trailing = orderType.startsWith('TRAIL');
  const fields = {
    key: contractKey(ref),
    contract: ref,
    action: order.action === 'BUY' ? ('BUY' as const) : ('SELL' as const),
    orderType,
    totalQuantity: num(order.totalQuantity) ?? 0,
    // Zero means "not set" except for limit-type prices (combos can be priced at 0).
    limitPrice: lmt != null && (lmt !== 0 || orderType.includes('LMT')) ? lmt : undefined,
    auxPrice: aux ? aux : undefined,
    // IB fills these in for other order types too; they only mean something for trailing stops.
    trailingPercent: trailing ? num(order.trailingPercent) || undefined : undefined,
    trailStopPrice: trailing ? num(order.trailStopPrice) || undefined : undefined,
    tif: tif === OVERNIGHT_DAY_TIF ? 'DAY' : tif,
    outsideRth: !!order.outsideRth,
    session,
    goodTillDate: tif === 'GTD' ? order.goodTillDate || undefined : undefined,
    goodAfterTime: order.goodAfterTime || undefined,
    displaySize: display && display > 0 ? display : undefined,
    condition: priceCondition(order, symbolOf),
    account: order.account || undefined,
    parentId: order.parentId || undefined,
  };
  return fields;
}

/** openOrder -> WorkingOrder, keeping fill progress and first-seen time from `prev`. */
export function mapOpenOrder(
  orderId: number,
  contract: Contract,
  order: Order,
  state: OrderState | undefined,
  prev: WorkingOrder | undefined,
  now: number,
  symbolOf: SymbolOf,
): WorkingOrder {
  const f = orderFields(contract, order, symbolOf);
  const status = state?.status ? toStatus(state.status) : (prev?.status ?? 'Unknown');
  return clean({
    ...f,
    orderId: orderId || order.orderId || 0,
    permId: order.permId || prev?.permId,
    clientId: order.clientId ?? prev?.clientId ?? 0,
    status,
    filled: prev?.filled ?? 0,
    remaining: prev?.remaining ?? f.totalQuantity,
    avgFillPrice: prev?.avgFillPrice ?? 0,
    message: state?.warningText || prev?.message,
    whyHeld: prev?.whyHeld,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  });
}

export interface StatusUpdate {
  status: string;
  filled?: number;
  remaining?: number;
  avgFillPrice?: number;
  permId?: number;
  parentId?: number;
  whyHeld?: string;
}

/** orderStatus -> updated WorkingOrder. */
export function applyOrderStatus(prev: WorkingOrder, u: StatusUpdate, now: number): WorkingOrder {
  return clean({
    ...prev,
    status: toStatus(u.status),
    filled: num(u.filled) ?? prev.filled,
    remaining: num(u.remaining) ?? prev.remaining,
    avgFillPrice: num(u.avgFillPrice) ?? prev.avgFillPrice,
    permId: u.permId || prev.permId,
    parentId: u.parentId || prev.parentId,
    whyHeld: u.whyHeld || undefined,
    updatedAt: now,
  });
}

/** completedOrder (today's finished orders) -> WorkingOrder with its final status. */
export function mapCompletedOrder(
  contract: Contract,
  order: Order,
  state: OrderState | undefined,
  prev: WorkingOrder | undefined,
  now: number,
  symbolOf: SymbolOf,
): WorkingOrder {
  const f = orderFields(contract, order, symbolOf);
  const status = toStatus(state?.status);
  const filled = num(order.filledQuantity) ?? (status === 'Filled' ? f.totalQuantity : (prev?.filled ?? 0));
  const completedAt = parseIbTime(state?.completedTime);
  return clean({
    ...f,
    orderId: prev?.orderId ?? order.orderId ?? 0,
    permId: order.permId || prev?.permId,
    clientId: prev?.clientId ?? order.clientId ?? 0,
    status,
    filled,
    remaining: Math.max(0, f.totalQuantity - filled),
    avgFillPrice: prev?.avgFillPrice ?? 0,
    message: state?.completedStatus || state?.warningText || prev?.message,
    // First seen as a finished order: its completion time is closer to the truth than "now".
    createdAt: prev?.createdAt ?? completedAt ?? now,
    updatedAt: completedAt ?? now,
  });
}

/** execDetails -> Execution (commission and realized P&L are merged from commissionReport). */
export function mapExecution(contract: Contract, e: IbExecution, now: number): Execution {
  const ref = fromIbContract(contract);
  return clean({
    execId: e.execId ?? '',
    orderId: e.orderId ?? 0,
    permId: e.permId || undefined,
    account: e.acctNumber || undefined,
    key: contractKey(ref),
    contract: ref,
    side: e.side === 'SLD' || e.side === 'SELL' ? 'SELL' : 'BUY',
    shares: num(e.shares) ?? 0,
    price: num(e.price) ?? 0,
    time: parseIbTime(e.time) ?? now,
    exchange: e.exchange || undefined,
  });
}

/**
 * Corrections of an execution keep the id up to the last dot and change the suffix
 * ("0000e0d5.6704b3a5.01.01" -> ".01.02"); the correction replaces the original.
 */
export function execBaseId(execId: string): string {
  const i = execId.lastIndexOf('.');
  return i > 0 ? execId.slice(0, i) : execId;
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

// ---------------------------------------------------------------------------
// Notification texts

const m = createMessages({
  en: {
    buy: 'Buy',
    sell: 'Sell',
    submitted: (side: string, qty: string, label: string) => `${side} ${qty} ${label} submitted`,
    cancelled: (side: string, qty: string, label: string) => `${side} ${qty} ${label} cancelled`,
    rejected: (side: string, qty: string, label: string) => `${side} ${qty} ${label} rejected`,
    working: 'awaiting fill',
    market: 'Market',
    limit: (p: string) => `Limit ${p}`,
    stop: (p: string) => `Stop ${p}`,
    trailPct: (p: string) => `Trail ${p}%`,
    trailAmt: (p: string) => `Trail ${p}`,
    filledOf: (filled: string, total: string) => `${filled} of ${total} filled`,
    sessions: { regular: 'Regular hours', extended: 'Extended hours', overnight: 'Overnight', overnightDay: 'Overnight + Day' } as Record<TradingSession, string>,
    fillTitle: (label: string, buy: boolean, qty: string, units: boolean, one: boolean) =>
      `${label}: ${buy ? 'bought' : 'sold'} ${qty} ${units ? (one ? 'contract' : 'contracts') : one ? 'share' : 'shares'}`,
    fillBody: (avg: string, commission: string, orderId: number) => `Avg ${avg} · Commission ${commission} · Order #${orderId}`,
  },
  zh: {
    buy: '买入',
    sell: '卖出',
    submitted: (side: string, qty: string, label: string) => `${side} ${qty} ${label} 已提交`,
    cancelled: (side: string, qty: string, label: string) => `${side} ${qty} ${label} 已撤销`,
    rejected: (side: string, qty: string, label: string) => `${side} ${qty} ${label} 被拒绝`,
    working: '等待成交',
    market: '市价',
    limit: (p: string) => `限价 ${p}`,
    stop: (p: string) => `止损 ${p}`,
    trailPct: (p: string) => `跟踪止损 ${p}%`,
    trailAmt: (p: string) => `跟踪止损 ${p}`,
    filledOf: (filled: string, total: string) => `已成交 ${filled} / ${total}`,
    sessions: { regular: '常规时段', extended: '盘前盘后', overnight: '夜盘', overnightDay: '夜盘 + 日盘' } as Record<TradingSession, string>,
    fillTitle: (label: string, buy: boolean, qty: string, units: boolean) => `${label} ${buy ? '买入' : '卖出'} ${qty} ${units ? '张' : '股'}已成交`,
    fillBody: (avg: string, commission: string, orderId: number) => `均价 ${avg} · 佣金 ${commission} · 订单 #${orderId}`,
  },
});

type Texts = ReturnType<typeof m>;

/** Quantities: whole numbers with separators, fractional shares as they are. */
export const qtyText = (q: number): string => (Number.isInteger(q) ? q.toLocaleString('en-US') : String(q));

/** Options, futures and combos trade in contracts; everything else in shares. */
const inContracts = (c: ContractRef) => c.secType === 'OPT' || c.secType === 'FOP' || c.secType === 'FUT' || c.secType === 'BAG';

/** The order fields a notification describes (a WorkingOrder, or a request IB never accepted). */
export type NoticeOrder = Pick<WorkingOrder, 'contract' | 'action' | 'totalQuantity' | 'orderType' | 'limitPrice' | 'auxPrice' | 'trailingPercent' | 'filled'> &
  TimingFields;

function priceText(o: NoticeOrder, t: Texts): string {
  switch (o.orderType) {
    case 'MKT':
      return t.market;
    case 'LMT':
      return t.limit(px(o.limitPrice));
    case 'STP':
      return t.stop(px(o.auxPrice));
    case 'STP LMT':
      return `${t.stop(px(o.auxPrice))} · ${t.limit(px(o.limitPrice))}`;
    case 'TRAIL':
      return o.trailingPercent ? t.trailPct(String(o.trailingPercent)) : t.trailAmt(px(o.auxPrice));
    default:
      return o.limitPrice != null ? `${o.orderType} ${px(o.limitPrice)}` : o.orderType;
  }
}

export interface NoticeText {
  title: LocalizedText;
  body: LocalizedText;
}

/** "Buy 100 AAPL submitted" / "Limit 226.95 · DAY · Overnight + Day · awaiting fill". */
export function orderNotice(o: NoticeOrder, kind: 'submitted' | 'cancelled' | 'rejected', reason?: string): NoticeText {
  const label = contractLabel(o.contract);
  const qty = qtyText(o.totalQuantity);
  const title = m.both((t) => t[kind](o.action === 'BUY' ? t.buy : t.sell, qty, label));
  const body = m.both((t) => {
    const parts = [priceText(o, t), timingText(o, t.sessions)];
    if (kind === 'submitted') parts.push(t.working);
    if (kind === 'cancelled' && o.filled > 0) parts.push(t.filledOf(qtyText(o.filled), qty));
    if (kind === 'rejected' && reason) return reason;
    return parts.join(' · ');
  });
  return { title, body };
}

/** "AAPL: bought 100 shares" / "Avg 226.95 · Commission 1.00 · Order #4008". */
export function fillNotice(e: Execution, avgPrice: number | undefined, commission: number | undefined): NoticeText {
  const label = contractLabel(e.contract);
  const qty = qtyText(e.shares);
  const units = inContracts(e.contract);
  return {
    title: m.both((t) => t.fillTitle(label, e.side === 'BUY', qty, units, e.shares === 1)),
    body: m.both((t) => t.fillBody(px(avgPrice ?? e.price), commission != null ? f2(commission) : '—', e.orderId)),
  };
}
