// Maps IB order callbacks (openOrder, orderStatus, completedOrder, execDetails) to the app's
// WorkingOrder / Execution models, and builds the texts of order and fill notifications.

import { OrderConditionType, type Contract, type Execution as IbExecution, type Order, type OrderCondition, type OrderState } from './tws';
import { contractKey, contractLabel } from '@shared/contract';
import { f2, px } from '@shared/format';
import { algoInfo, TRIGGER_METHODS, UTC_TIME_PARAMS } from '@shared/orderRules';
import { NEW_YORK, parseIbDateTime, timingText, zonedParts, type TimingFields } from '@shared/orderTiming';
import { TOKEN_CLOCK } from '@shared/timeFormat';
import type {
  AdjustedStop,
  AlgoParamValue,
  AlgoSpec,
  AlgoStrategy,
  ContractRef,
  Execution,
  LocalizedText,
  OrderConditionItem,
  OrderConditions,
  OrderPreview,
  OrderStatus,
  SecType,
  TradingSession,
  TriggerMethod,
  WorkingOrder,
} from '@shared/types';
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
/**
 * Whether IB reaches a stock through SMART (true), or quotes and routes it on its own exchange
 * (false: SEHK, NSE, … see market/contracts.ts); undefined when not known.
 */
export type SmartRouted = (conId: number) => boolean | undefined;

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

/**
 * The instrument a condition watches, as far as IB tells: the conId and exchange, the symbol once
 * known (the conId until then), the order's own security type when it watches the order's
 * instrument, otherwise a stock on SMART and an index elsewhere.
 */
function conditionContract(conId: number, exchange: string | undefined, own: Contract, symbolOf: SymbolOf): ContractRef {
  if (own.conId && conId === own.conId) {
    const ref = fromIbContract(own);
    return { ...ref, exchange: exchange || ref.exchange };
  }
  const venue = exchange || 'SMART';
  const secType: SecType = venue === 'SMART' ? 'STK' : 'IND';
  return { symbol: symbolOf(conId) || String(conId), secType, exchange: venue, currency: own.currency || 'USD', conId };
}

/** Every condition of an IB order, in the request's form. */
export function orderConditions(order: Order, own: Contract, symbolOf: SymbolOf): OrderConditions | undefined {
  const items: OrderConditionItem[] = [];
  for (const raw of order.conditions ?? []) {
    const c = raw as OrderCondition & {
      isMore?: boolean;
      price?: number;
      percent?: number;
      volume?: number;
      time?: string;
      conId?: number;
      exchange?: string;
      triggerMethod?: number;
      secType?: string;
      symbol?: string;
    };
    const join = c.conjunctionConnection === 'o' ? ('or' as const) : ('and' as const);
    const operator = c.isMore ? ('>=' as const) : ('<=' as const);
    const watched = () => conditionContract(c.conId ?? 0, c.exchange, own, symbolOf);
    switch (c.type) {
      case OrderConditionType.Price: {
        const tm = TRIGGER_METHODS.includes(c.triggerMethod as TriggerMethod) && c.triggerMethod ? { triggerMethod: c.triggerMethod as TriggerMethod } : {};
        items.push({ kind: 'price', contract: watched(), operator, price: num(c.price) ?? 0, ...tm, join });
        break;
      }
      case OrderConditionType.Time:
        items.push({ kind: 'time', time: String(c.time ?? ''), join });
        break;
      case OrderConditionType.PercentChange:
        items.push({ kind: 'percentChange', contract: watched(), operator, percent: num(c.percent) ?? 0, join });
        break;
      case OrderConditionType.Volume:
        items.push({ kind: 'volume', contract: watched(), operator, volume: num(c.volume) ?? 0, join });
        break;
      case OrderConditionType.Margin:
        items.push({ kind: 'margin', operator, percent: num(c.percent) ?? 0, join });
        break;
      case OrderConditionType.Execution:
        items.push({ kind: 'execution', symbol: String(c.symbol ?? ''), secType: (c.secType || 'STK') as SecType, join });
        break;
    }
  }
  if (!items.length) return undefined;
  // The last condition's conjunction joins nothing.
  delete items[items.length - 1].join;
  return { items, outsideRth: !!order.conditionsIgnoreRth, ...(order.conditionsCancelOrder ? { cancel: true } : {}) };
}

/** An IB algo time ("20261005 09:30:00 US/Eastern", "09:30:00 US/Eastern", UTC "13:30:00") -> "HH:MM" New York. */
function algoTime(value: string, utc: boolean, now: number): string | undefined {
  const v = value.trim();
  const bare = /^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s+(\S+))?$/.exec(v);
  if (bare && !utc && (!bare[3] || /^(US\/Eastern|America\/New_York|EST5EDT|EST|EDT)$/.test(bare[3]))) return `${bare[1].padStart(2, '0')}:${bare[2]}`;
  if (bare && utc) {
    const d = new Date(now);
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(bare[1]), Number(bare[2]));
    return zonedParts(t, NEW_YORK).hhmm;
  }
  const at = parseIbDateTime(v);
  return at != null ? zonedParts(at, NEW_YORK).hhmm : undefined;
}

/** An IB order's algo with its parameters typed (parameters IB adds by itself are left out). */
export function orderAlgo(order: Order, now: number = Date.now()): AlgoSpec | undefined {
  const strategy = order.algoStrategy?.trim();
  if (!strategy) return undefined;
  const info = algoInfo(strategy);
  const params: Record<string, AlgoParamValue> = {};
  for (const { tag, value } of order.algoParams ?? []) {
    if (!tag || value == null || value === '') continue;
    const p = info?.params.find((x) => x.tag === tag);
    if (!info) params[tag] = value;
    if (!p) continue;
    if (p.kind === 'switch') params[tag] = value === '1' || value.toLowerCase() === 'true';
    else if (p.kind === 'fraction' || p.kind === 'integer') {
      const n = num(value);
      if (n != null) params[tag] = n;
    } else if (p.kind === 'time') {
      const t = algoTime(value, UTC_TIME_PARAMS.has(tag), now);
      if (t) params[tag] = t;
    } else params[tag] = value;
  }
  // An accumulate / distribute order sent without an active window comes back with both ends at
  // the time it was placed: IB's fill-in, which a modify must not send as a zero-length window.
  if (strategy === 'AD' && params.activeTimeStart != null && params.activeTimeStart === params.activeTimeEnd) {
    delete params.activeTimeStart;
    delete params.activeTimeEnd;
  }
  return { strategy: strategy as AlgoStrategy, params };
}

/** An IB order's adjustable-stop rule. */
function adjustedStop(order: Order): AdjustedStop | undefined {
  const type = order.adjustedOrderType;
  const trigger = num(order.triggerPrice);
  if (!(type === 'STP' || type === 'STP LMT' || type === 'TRAIL') || !trigger) return undefined;
  const a: AdjustedStop = { trigger, type };
  const stop = num(order.adjustedStopPrice);
  if (stop) a.stopPrice = stop;
  const limit = num(order.adjustedStopLimitPrice);
  if (type === 'STP LMT' && limit) a.limitPrice = limit;
  if (type === 'TRAIL') {
    a.trailAmount = num(order.adjustedTrailingAmount) ?? 0;
    a.trailUnit = order.adjustableTrailingUnit === 1 ? 'percent' : 'amount';
  }
  return a;
}

/** IB's TIF of SMART orders with includeOvernight. */
const OVERNIGHT_DAY_TIF = 'OVERNIGHT + DAY';
/** IB's TIF of orders on the OVERNIGHT venue (sent as DAY). */
const OVERNIGHT_TIF = 'OVERNIGHT';

/**
 * The trading session of an IB order: the OVERNIGHT venue, includeOvernight ("OVERNIGHT + DAY"),
 * or outsideRth. IB ignores outsideRth for IOC, FOK and OPG (and reports it set for IOC / FOK).
 */
export function ibOrderSession(contract: Contract, order: Order): TradingSession {
  const tif = String(order.tif ?? '');
  if (contract.exchange === 'OVERNIGHT' || tif === OVERNIGHT_TIF) return 'overnight';
  if (order.includeOvernight || tif === OVERNIGHT_DAY_TIF) return 'overnightDay';
  if (tif === 'IOC' || tif === 'FOK' || tif === 'OPG') return 'regular';
  return order.outsideRth ? 'extended' : 'regular';
}

function orderFields(contract: Contract, order: Order, symbolOf: SymbolOf, smartRouted: SmartRouted) {
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
  // A directed stock order: the instrument is the SMART one, the venue is the route. A stock IB
  // does not reach through SMART is traded on its own exchange, which is no route. openOrder
  // carries no primary exchange: unless known, US dollar stocks count as SMART-routed.
  const venue = String(contract.exchange ?? '');
  const directed = ref.secType === 'STK' && venue && venue !== 'SMART' && session !== 'overnight' && (smartRouted(contract.conId ?? 0) ?? (contract.currency || 'USD') === 'USD');
  const route = directed ? venue : undefined;
  if (route) ref.exchange = 'SMART';
  const tm = order.triggerMethod as TriggerMethod;
  const ocaGroup = order.ocaGroup?.trim();
  const ocaType = order.ocaType === 2 || order.ocaType === 3 ? order.ocaType : 1;
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
    tif: tif === OVERNIGHT_DAY_TIF || tif === OVERNIGHT_TIF ? 'DAY' : tif,
    outsideRth: !!order.outsideRth,
    session,
    goodTillDate: tif === 'GTD' ? order.goodTillDate || undefined : undefined,
    goodAfterTime: order.goodAfterTime || undefined,
    displaySize: display && display > 0 ? display : undefined,
    condition: priceCondition(order, symbolOf),
    conditions: orderConditions(order, contract, symbolOf),
    // IB reports the limit of a trailing limit order as the current stop plus the offset.
    limitOffset: orderType === 'TRAIL LIMIT' || orderType === 'TRAIL LIT' ? num(order.lmtPriceOffset) : undefined,
    percentOffset: orderType === 'REL' ? num(order.percentOffset) || undefined : undefined,
    allOrNone: order.allOrNone || undefined,
    minQty: num(order.minQty) || undefined,
    hidden: order.hidden || undefined,
    sweepToFill: order.sweepToFill || undefined,
    discretionaryAmt: num(order.discretionaryAmt) || undefined,
    triggerMethod: tm && TRIGGER_METHODS.includes(tm) ? tm : undefined,
    adjustStop: adjustedStop(order),
    algo: orderAlgo(order),
    // Bracket children carry IB's own group (their one-cancels-the-other link), not the user's.
    oca: ocaGroup && !order.parentId ? { group: ocaGroup, type: ocaType as 1 | 2 | 3 } : undefined,
    route,
    nonGuaranteed: order.smartComboRoutingParams?.some((p) => p.tag === 'NonGuaranteed' && p.value === '1') || undefined,
    cashQty: ref.secType === 'CASH' ? num(order.cashQty) || undefined : undefined,
    orderRef: order.orderRef || undefined,
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
  smartRouted: SmartRouted = () => undefined,
): WorkingOrder {
  const f = orderFields(contract, order, symbolOf, smartRouted);
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
  smartRouted: SmartRouted = () => undefined,
): WorkingOrder {
  const f = orderFields(contract, order, symbolOf, smartRouted);
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

/** A what-if openOrder's OrderState -> OrderPreview; values IB left unset are left out. */
export function mapPreview(state: OrderState | undefined): OrderPreview {
  const s = state ?? ({} as OrderState);
  // IB's changes carry float noise (110.05999999999949).
  const round = (v: unknown) => {
    const n = num(v);
    return n == null ? undefined : Math.round(n * 1e6) / 1e6;
  };
  const triple = (before: unknown, change: unknown, after: unknown) => {
    const t = clean({ before: round(before), change: round(change), after: round(after) });
    return Object.keys(t).length ? t : undefined;
  };
  return clean({
    commission: num(s.commission),
    minCommission: num(s.minCommission),
    maxCommission: num(s.maxCommission),
    commissionCurrency: s.commissionCurrency || undefined,
    initMargin: triple(s.initMarginBefore, s.initMarginChange, s.initMarginAfter),
    maintMargin: triple(s.maintMarginBefore, s.maintMarginChange, s.maintMarginAfter),
    equityWithLoan: triple(s.equityWithLoanBefore, s.equityWithLoanChange, s.equityWithLoanAfter),
    warningText: s.warningText?.trim() || undefined,
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
    limitOffset: (p: string) => `limit offset ${p}`,
    touched: (p: string) => `If touched ${p}`,
    onClose: 'At the close',
    marketToLimit: 'Market to limit',
    midprice: 'Midprice',
    cap: (p: string) => `cap ${p}`,
    floor: (p: string) => `floor ${p}`,
    relative: 'Relative',
    snapMid: 'Snap to midpoint',
    snapMkt: 'Snap to market',
    pegMid: 'Pegged to midpoint',
    /** IB algo names as the ticket shows them. */
    algos: {
      Adaptive: 'Adaptive',
      Vwap: 'VWAP',
      Twap: 'TWAP',
      ArrivalPx: 'Arrival price',
      ClosePx: 'Close price',
      PctVol: '% of volume',
      PctVolPx: '% of volume (price)',
      PctVolSz: '% of volume (size)',
      PctVolTm: '% of volume (time)',
      DarkIce: 'Dark ice',
      AD: 'Accumulate / distribute',
      MinImpact: 'Minimise impact',
      BalanceImpactRisk: 'Balance impact and risk',
    } as Record<string, string>,
    offset: (p: string) => `offset ${p}`,
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
    limitOffset: (p: string) => `限价偏移 ${p}`,
    touched: (p: string) => `触价 ${p}`,
    onClose: '收盘竞价',
    marketToLimit: '市价转限价',
    midprice: '中间价',
    cap: (p: string) => `上限 ${p}`,
    floor: (p: string) => `下限 ${p}`,
    relative: '相对价',
    snapMid: '即时中间价',
    snapMkt: '即时市价',
    pegMid: '挂钩中间价',
    algos: {
      Adaptive: '自适应',
      Vwap: 'VWAP',
      Twap: 'TWAP',
      ArrivalPx: '到达价格',
      ClosePx: '收盘价格',
      PctVol: '成交量占比',
      PctVolPx: '成交量占比（随价格）',
      PctVolSz: '成交量占比（随数量）',
      PctVolTm: '成交量占比（随时间）',
      DarkIce: '暗冰',
      AD: '累积 / 分配',
      MinImpact: '最小冲击',
      BalanceImpactRisk: '平衡冲击与风险',
    } as Record<string, string>,
    offset: (p: string) => `偏移 ${p}`,
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
  Partial<Pick<WorkingOrder, 'limitOffset' | 'percentOffset' | 'algo' | 'allOrNone'>> &
  TimingFields;

function trailText(o: NoticeOrder, t: Texts): string {
  return o.trailingPercent ? t.trailPct(String(o.trailingPercent)) : t.trailAmt(px(o.auxPrice));
}

function basePriceText(o: NoticeOrder, t: Texts): string {
  // The limit of a midprice / relative / pegged order: a buy's cap, a sell's floor.
  const capText = o.limitPrice ? ` · ${(o.action === 'SELL' ? t.floor : t.cap)(px(o.limitPrice))}` : '';
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
      return trailText(o, t);
    case 'TRAIL LIMIT':
      return o.limitOffset != null ? `${trailText(o, t)} · ${t.limitOffset(px(o.limitOffset))}` : trailText(o, t);
    case 'TRAIL MIT':
      return `${trailText(o, t)} · ${t.market}`;
    case 'TRAIL LIT':
      return o.limitOffset != null ? `${trailText(o, t)} · ${t.limitOffset(px(o.limitOffset))}` : trailText(o, t);
    case 'MIT':
      return `${t.market} · ${t.touched(px(o.auxPrice))}`;
    case 'LIT':
      return `${t.limit(px(o.limitPrice))} · ${t.touched(px(o.auxPrice))}`;
    case 'MOC':
      return `${t.market} · ${t.onClose}`;
    case 'LOC':
      return `${t.limit(px(o.limitPrice))} · ${t.onClose}`;
    case 'MTL':
      return t.marketToLimit;
    case 'MIDPRICE':
      return t.midprice + capText;
    case 'REL':
      return `${t.relative} · ${t.offset(o.percentOffset ? `${o.percentOffset}%` : px(o.auxPrice ?? 0))}${capText}`;
    case 'SNAP MID':
      return `${t.snapMid} · ${t.offset(px(o.auxPrice ?? 0))}`;
    case 'SNAP MKT':
      return `${t.snapMkt} · ${t.offset(px(o.auxPrice ?? 0))}`;
    case 'PEG MID':
      return `${t.pegMid} · ${t.offset(px(o.auxPrice ?? 0))}${capText}`;
    default:
      return o.limitPrice != null ? `${o.orderType} ${px(o.limitPrice)}` : o.orderType;
  }
}

/** Price text of an order, with its algo and all-or-none: "Limit 226.95 · Adaptive · AON". */
function priceText(o: NoticeOrder, t: Texts): string {
  const algo = o.algo ? (t.algos[o.algo.strategy] ?? o.algo.strategy) : undefined;
  return [basePriceText(o, t), algo, o.allOrNone ? 'AON' : undefined].filter(Boolean).join(' · ');
}

export interface NoticeText {
  title: LocalizedText;
  body: LocalizedText;
}

/**
 * "Buy 100 AAPL submitted" / "Limit 226.95 · DAY · Overnight + Day · awaiting fill". A GTD expiry
 * is a time token, shown in the time format of the moment it is read (resolveTimeTokens).
 */
export function orderNotice(o: NoticeOrder, kind: 'submitted' | 'cancelled' | 'rejected', reason?: string): NoticeText {
  const label = contractLabel(o.contract);
  const qty = qtyText(o.totalQuantity);
  const title = m.both((t) => t[kind](o.action === 'BUY' ? t.buy : t.sell, qty, label));
  const body = m.both((t) => {
    const parts = [priceText(o, t), timingText(o, t.sessions, TOKEN_CLOCK)];
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
