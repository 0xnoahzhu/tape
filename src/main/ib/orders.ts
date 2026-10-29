// Order service: working and finished orders of all clients, executions with commissions,
// placing / modifying / cancelling orders, and fill and order-status notifications.
//
// On every handshake: reqAllOpenOrders (orders of every client, including TWS), reqCompletedOrders
// (today's finished orders) and reqExecutions (today's fills). Orders placed by this client then
// stream openOrder / orderStatus / execDetails / commissionReport updates; of other apps' and
// clients' orders this client gets none, so the open and completed orders are asked again every
// ORDERS_REFRESH_MS while connected, when Portfolio › Orders or Cancel all opens, and around Cancel
// all (see Reconciliation below).
//
// Orders are keyed by client id + order id (order ids are per API client). modify takes an order
// id, cancel the order as the list showed it (OrderRef: permId, client id + order id, account), and
// both act only on orders of the connected client id (shared/orderOwnership.ts → cancelBlock).
// Orders placed in IBKR Mobile, TWS or the web (order id 0, client 0) and other API clients' orders
// are cancelled where they were placed, or with cancelAll: IB's global cancel (reqGlobalCancel)
// reaches every open order of every account of the login, so it is sent only for the account and
// the exact orders (permIds) the user confirmed, on the same session, checked against IB's full list
// of open orders asked right before it (an order placed elsewhere between that list's end and the
// cancel is still reached). Its result counts an order IB no longer lists as cancelled only once IB's
// completed orders say so (filled ones as filled, the rest as unknown).
//
// Orders, fills and notices belong to one session (ConnectionState.session). A plain reconnect
// keeps them: nothing is announced twice, and fills found on reconnect are announced. Another
// Gateway, client id or account (onSessionChange) starts empty at once, and its first load is not
// announced: ids and permIds name that login's orders, so the previous session's would list
// another account's orders as this one's, let a cancel or modify hit this login's order with the
// same id, and silence or repeat its notices. The renderer passes the session the user reviewed a
// request on: place / modify / cancel / preview / cancelAll refuse it on any other, before
// anything is sent, and an order of an account the login does not manage is never acted on.
//
// Tape has no read-only switch of its own: with "Read-Only API" on in TWS / IB Gateway, IB rejects
// orders and cancels with error 321, which reaches the caller (and the rejection notification) as
// IB's message. The connection notes it for the UI's warnings (ConnectionState.readOnlyApi); nothing
// is refused on it here, since the user may have turned the setting off meanwhile.
//
// A connection that cannot carry an order is refused, before anything is sent: TWS / IB Gateway
// lost its link to IB (1100, ConnectionState.ibLinkLost) or does not answer the heartbeat
// (unresponsive). place() and modify() throw then (IB would get such an order late, at another
// price, or never, and Tape could not tell); cancel() and cancelAll() still send, since getting out
// must stay possible.
//
// IB's silence is never reported as success. place() and modify() resolve with `confirmed: false`
// when IB has not answered within the wait (a refusal arriving within LATE_REFUSAL_MS after it is
// still announced), cancel() with status 'sent' (or 'PendingCancel'; IB's 202 counts as cancelled),
// and a cancel IB refuses after the wait is announced too (an ApiPending status is no answer: see
// Held orders). A socket that closes during the wait
// ends it according to what was written: a frame the client still held never reached IB ("nothing
// was sent"), one written may be at IB (placed: an "unconfirmed" notice, never "rejected"; the key
// stays sent, so a reconnect to the same account lists the order and announces it). When one leg
// of a bracket fails, the legs still alive are cancelled (unless the entry has filled: the other
// exit then keeps protecting the position), and the error and notice say what happened.
//
// Held orders. TWS / IB Gateway may keep an order of this client without sending it to IB (status
// ApiPending, permId 0), e.g. while a message of its own waits for a click (seen 2026-10-29: after
// a margin rejection every order, what-if ones included, stayed ApiPending until IB Gateway was
// quit). It then sends no openOrder, only an orderStatus with each list of open orders, and IB's
// apps do not list the order. Such an order is listed from the request this client sent
// (sentOrders), stays while TWS / IB Gateway reports it in each full list (sweep), can be cancelled,
// and is announced once (held), so it is not taken for lost and sent again.
//
// Reconciliation: one open-orders request is outstanding at a time (openOrderEnd names none). At the
// end of a full list (reqAllOpenOrders: on every handshake, every ORDERS_REFRESH_MS, before and
// after Cancel all), active orders it left out are marked not reported: they ended while Tape could
// not hear it (disconnected, or another client's order, of which this client gets no updates).
// reqCompletedOrders, answered right after, says how (announced once: cancelled, rejected, expired;
// another app's or client's order that filled gets a fill notice, since none of its executions
// reach this client); at its end, or VANISHED_WAIT_MS after the list when IB refuses it (Read-Only
// API), the rest are announced as no longer working and dropped. A session change forgets them
// silently. Such an order is never cancelled or modified. A modify counts as answered only by an
// openOrder that is not part of such a list (or one showing its change).
//
// A working order keeps its trading session: IB refuses to move it to the OVERNIGHT venue (105)
// or to add includeOvernight (462), so modify() refuses a request with another session. Its TIF
// changes only between DAY and GTC, or to IOC (462 otherwise, see tifChangeAllowed). IB reports an
// OVERNIGHT-venue order's TIF as "OVERNIGHT" and refuses DAY when it is modified (462), so modify()
// leaves the TIF empty there, which keeps the order's own.
//
// IB rejects some orders after taking them: an Inactive openOrder, then the reason (201). place()
// and modify() fail with that reason instead of resolving on the Inactive order, and the rejection
// notice waits for it.
//
// IB replaces the whole order on a modify: modify() fills in the working order's attributes the
// request leaves out (all or none, algo, conditions, OCA group, …; shared/orderRules.ts ›
// withOrderAttributes) and refuses the changes IB refuses or ignores (modifyProblems) without
// sending them. MOC / LOC modifies get no openOrder back from IB: the 2 s wait then ends without
// an error, which is sent and not confirmed (this client's open orders are asked for).
//
// preview() asks IB for the margin and commission of an order (whatIf) under a fresh order id; an
// order that is not a what-if one is never sent from there (fail closed).
// IB answers with openOrders flagged whatIf, which never become working orders: often one with the
// commission and IB's notice, then one with the margin; the parts are merged, and the answer is
// complete once the margin arrives or a moment after the last part. Previews run
// one at a time, and an identical request for the same account within 10 s gets the same answer
// (IB asks for few what-if requests); answers are not kept past the socket's close (the next
// session may be another account).

import { EventName, MIN_SERVER_VER, OUT_MSG_ID, type CommissionReport, type Contract, type ContractDetails, type Execution as IbExecution, type IBApi, type Order, type OrderState } from './tws';
import { contractLabel } from '@shared/contract';
import { cancelBlock, type CancelBlock } from '@shared/orderOwnership';
import { modifyProblems, MODIFY_PROBLEM_TEXT, requestConditions, withOrderAttributes, type OrderRulesContext } from '@shared/orderRules';
import { parseIbDateTime, sessionOf, tifChangeAllowed } from '@shared/orderTiming';
import { nyClock } from '@shared/session';
import {
  isOrderActive,
  type CancelAllExpect,
  type CancelAllResult,
  type CancelResult,
  type ContractRef,
  type Execution,
  type LocalizedText,
  type ModifyOrderResult,
  type OrderConditions,
  type OrderPreview,
  type OrderRef,
  type OrderRequest,
  type PlaceOrderResult,
  type WorkingOrder,
} from '@shared/types';
import {
  CANCEL_ALL_NO_LIST_MESSAGE,
  CANCEL_ALL_UNCONFIRMED_MESSAGE,
  CONNECTION_CHANGED_MESSAGE,
  GATEWAY_UNRESPONSIVE_MESSAGE,
  IB_LINK_LOST_MESSAGE,
  LOCKED_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  ORDER_LIST_CHANGED_MESSAGE,
  ORDER_NOT_SENT_MESSAGE,
  ORDER_UNCONFIRMED_MESSAGE,
  SESSION_CHANGED_MESSAGE,
  STALE_ORDER_MESSAGE,
} from '@shared/ipc';
import type { MainContext, OrderService } from '../context';
import { isPaperAccount } from './connectionModel';
import { cleanIbMessage, isErrorCode } from './errorCodes';
import { num } from './ibContract';
import { buildOrders, buildPreviewOrder, validateOrderRequest, type BuiltOrder } from './orderBuilder';
import {
  accountTag,
  applyOrderStatus,
  bracketOutcomeText,
  execBaseId,
  fillNotice,
  legName,
  mapCompletedOrder,
  mapExecution,
  mapOpenOrder,
  mapPreview,
  orderKey,
  orderNotice,
  type BracketOutcome,
  type BracketRole,
  type NoticeOrder,
  type NoticeText,
  type StatusUpdate,
  withAccount,
} from './orderMapping';

/** How long place / modify wait for IB to accept or reject an order. */
const ACK_MS = 2_000;
/** How long cancel waits for IB to cancel the order (PendingCancel alone does not end it). */
const CANCEL_ACK_MS = 4_000;
/** After a wait IB did not answer, how long its refusal is still announced (place, modify, cancel). */
const LATE_REFUSAL_MS = 60_000;
/** How long a modify answered with an echo that cannot show the change waits for IB's refusal. */
const MODIFY_REFUSAL_WAIT_MS = 500;
/** How long a rejection notice waits for IB's reason, which follows the Inactive openOrder. */
const REJECT_REASON_WAIT_MS = 1_000;
/** A fill is announced when its commission report arrives, or after this delay without one. */
const FILL_NOTICE_WAIT_MS = 3_000;
const EMIT_MS = 100;
const CONTRACT_LOOKUP_TIMEOUT_MS = 10_000;
/** How long a what-if preview waits for IB's answer. */
const PREVIEW_TIMEOUT_MS = 8_000;
/** An identical preview request (same account, same socket) within this time gets the previous answer. */
const PREVIEW_REUSE_MS = 10_000;
/** How long a what-if answer without margin waits for IB's next part (the margin follows within ms). */
const PREVIEW_SETTLE_MS = 400;
/** An open-orders request IB has not ended by then no longer holds the others back. */
const OPEN_ORDERS_TIMEOUT_MS = 15_000;
/**
 * Orders a full list left out wait this long after its end for reqCompletedOrders, which IB answers
 * right after it (and refuses with Read-Only API on), before they are announced as no longer working.
 */
const VANISHED_WAIT_MS = 3_000;
/** Cancel all: IB's global cancel takes a moment; the open and completed orders are asked again after it. */
const CANCEL_ALL_SETTLE_MS = 1_000;
/** Cancel all reports at the latest this long after the global cancel, from the order list then. */
const CANCEL_ALL_WAIT_MS = 6_000;
/** Cancel all left orders working (PendingCancel, say): IB's lists are asked again this much later. */
const CANCEL_ALL_RECHECK_MS = 5_000;
/**
 * While connected, IB's full lists of open and completed orders are asked again this often: of
 * other apps' and clients' orders this client gets no updates (see the header).
 */
const ORDERS_REFRESH_MS = 30_000;

// The fixed refusals live in shared/ipc.ts, where the renderer shows them in the user's language
// (orderActions.ts → orderErrorText).
export {
  CANCEL_ALL_NO_LIST_MESSAGE,
  CANCEL_ALL_UNCONFIRMED_MESSAGE,
  CONNECTION_CHANGED_MESSAGE,
  GATEWAY_UNRESPONSIVE_MESSAGE,
  IB_LINK_LOST_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  ORDER_LIST_CHANGED_MESSAGE,
  ORDER_NOT_SENT_MESSAGE,
  SESSION_CHANGED_MESSAGE,
  STALE_ORDER_MESSAGE,
};
export const PREVIEW_TIMEOUT_MESSAGE = 'IB did not answer the margin and commission preview in time';
const CLOSED_MESSAGE = 'Connection to TWS / IB Gateway closed';

interface Waiter {
  ids: Set<number>;
  acked: Set<number>;
  /**
   * True when this update settles the wait for its order. `round`: it came while IB sends a list of
   * open orders (see requestOpenOrders), where an unchanged order is no answer to a modify.
   */
  accept(o: WorkingOrder, round: boolean): boolean;
  /** An Inactive order fails the wait (place / modify): with IB's error, or when the wait runs out. */
  failInactive: boolean;
  /** Orders IB reported as Inactive while waiting. */
  inactive: Set<number>;
  /** `answered`: IB answered for every order; false: the wait ran out. */
  resolve(answered: boolean): void;
  reject(err: Error): void;
}

/** A wait for IB's answer to orders (awaitOrders). */
interface Wait {
  /** True once IB has answered for every order, false when the wait runs out; rejects on a refusal. */
  done: Promise<boolean>;
  /** Ends the wait as answered (IB's 202 for a cancel). */
  answer(): void;
}

/** IB's refusal of one order of a request: the id names the leg of a bracket that failed. */
class OrderRefused extends Error {
  constructor(
    message: string,
    readonly orderId: number,
  ) {
    super(message);
  }
}

/** A bracket this session placed: when one leg fails, the others are withdrawn (see withdraw). */
interface Bracket {
  clientId: number;
  session: number;
  api: IBApi;
  /** The entry first, then its exits, as built. */
  legs: Array<{ orderId: number; role: BracketRole }>;
  /** Set once a leg failed: what happened to the rest. */
  outcome?: BracketOutcome;
}

/** A place or modify IB had not answered when its wait ended: a refusal that follows is announced. */
interface LateRequest {
  verb: 'place' | 'modify';
  req: OrderRequest;
  ids: number[];
  session: number;
  /** The account the request was sent for (its notices name it). */
  account?: string;
  bracket?: Bracket;
  /** modify: the order before it and how to read IB's echo. */
  existing?: WorkingOrder;
  echo?: ReturnType<typeof modifyEcho>;
  timer: ReturnType<typeof setTimeout>;
}

/** Why a full list of open orders was asked (the notice of an order it left out). */
type SweepReason = 'reconnect' | 'refresh';

/** An open-orders request: every client's (reqAllOpenOrders) or this client's (reqOpenOrders). */
interface OpenOrdersRequest {
  kind: 'all' | 'own';
  /** At its end, active orders the list left out are marked not reported (a full list only). */
  sweep?: SweepReason;
  /** Called at its end: `answered` by IB's openOrderEnd, false when it timed out or its socket closed. */
  onEnd?: (answered: boolean) => void;
}

/** Order errors that do not mean the order was rejected. */
const isOrderWarning = (code: number, message: string) => !isErrorCode(code) || /warning/i.test(message);

const samePrice = (a: number | undefined, b: number | undefined) => a != null && b != null && Math.abs(a - b) < 1e-9;

/** An order IB reports again (or has ended): no longer "not reported". */
function reported(o: WorkingOrder): WorkingOrder {
  if (!o.notReported) return o;
  const { notReported: _gone, ...rest } = o;
  return rest;
}

/** "Order #40", or for an order without an API id (placed outside the API) its permId. */
const orderName = (o: Pick<WorkingOrder, 'orderId' | 'permId'>) => (o.orderId ? `Order #${o.orderId}` : o.permId ? `The order with permId ${o.permId}` : 'This order');

/** The order fields a notice describes, of a request IB has not reported as an order. */
function requestNotice(req: OrderRequest): NoticeOrder {
  return {
    contract: req.contract,
    action: req.action,
    totalQuantity: req.quantity,
    orderType: req.orderType,
    limitPrice: req.limitPrice,
    auxPrice: req.orderType.startsWith('TRAIL') ? req.trailingAmount : (req.stopPrice ?? req.offset),
    trailingPercent: req.trailingPercent,
    limitOffset: req.limitOffset,
    percentOffset: req.percentOffset,
    algo: req.algo,
    allOrNone: req.allOrNone,
    tif: req.tif,
    session: sessionOf(req),
    goodTillDate: req.goodTillDate,
    filled: 0,
  };
}

/**
 * How to read IB's answer to a modify: the quantity and prices the modify changes, an echo still
 * showing an old value (IB's unchanged order ahead of its refusal), or one showing the new values.
 */
export function modifyEcho(existing: WorkingOrder, sent: Order): { stale(o: WorkingOrder): boolean; applied(o: WorkingOrder): boolean } {
  const usable = (n: number | undefined) => (n != null && Number.isFinite(n) && n !== Number.MAX_VALUE ? n : undefined);
  const fields: Array<{ from: number | undefined; to: number; of: (o: WorkingOrder) => number | undefined }> = [];
  const add = (from: number | undefined, to: number | undefined, of: (o: WorkingOrder) => number | undefined) => {
    const t = usable(to);
    if (t != null && !samePrice(from, t)) fields.push({ from, to: t, of });
  };
  add(existing.totalQuantity, sent.totalQuantity, (o) => o.totalQuantity);
  add(existing.limitPrice, sent.lmtPrice, (o) => o.limitPrice);
  add(existing.auxPrice, sent.auxPrice, (o) => o.auxPrice);
  return {
    stale: (o) => fields.some((f) => samePrice(f.of(o), f.from) && !samePrice(f.of(o), f.to)),
    applied: (o) => fields.length > 0 && fields.every((f) => samePrice(f.of(o), f.to)),
  };
}

/**
 * A modify carries its good-after time as "HH:MM", which orderBuilder places on the next weekday
 * once that time has passed today: an order already active would be held for another day. When
 * the time is unchanged, IB's own good-after date and time (`existing`) is sent back instead.
 */
export function sameGoodAfter(existing: string | undefined, hhmm: string | undefined): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? '');
  if (!m || !existing) return undefined;
  const at = parseIbDateTime(existing);
  if (at == null) return undefined;
  return nyClock(new Date(at)).minutes === Number(m[1]) * 60 + Number(m[2]) ? existing : undefined;
}

export function createOrderService(ctx: MainContext): OrderService {
  const orders = new Map<string, WorkingOrder>();
  /** permId -> key in `orders`, to match completedOrder and TWS orders. */
  const keyByPermId = new Map<number, string>();
  /** orderStatus that arrived before the order's openOrder. */
  const earlyStatus = new Map<string, StatusUpdate>();
  /** Executions by execution id without the correction suffix. */
  const executions = new Map<string, Execution>();
  /** Cumulative average fill price per execution, for the fill notification. */
  const execAvgPrice = new Map<string, number>();
  const commissions = new Map<string, CommissionReport>();
  const symbols = new Map<number, string>();
  /** Stocks this client has sent orders for: whether IB reaches them through SMART (see SmartRouted). */
  const smartStocks = new Map<number, boolean>();
  const symbolLookups = new Map<number, number>(); // reqId -> conId
  const symbolsRequested = new Set<number>();

  /** Keys of orders this client sent and IB has not reported back yet (see ownOrder). */
  const sentKeys = new Set<string>();
  /** What this client sent per order key, to list an order TWS / IB Gateway holds (see Held orders). */
  const sentOrders = new Map<string, { contract: Contract; order: Order }>();
  /** Held orders already announced. */
  const heldNoticed = new Set<string>();

  /** Last notified state per order, so repeated statuses notify once. */
  const notified = new Map<string, 'submitted' | 'cancelled' | 'rejected' | 'filled' | 'other'>();
  const pendingFills = new Map<string, ReturnType<typeof setTimeout>>();
  const waiters = new Set<Waiter>();
  /** Rejection notices waiting for IB's reason, by order key (see announce). */
  const pendingRejections = new Map<string, ReturnType<typeof setTimeout>>();
  /** Order keys whose rejection has been announced or is about to be, so it is announced once. */
  const rejectionNoticed = new Set<string>();
  /** IB's last error (not a warning) per order key since the order was sent: a rejection's reason. */
  const orderErrors = new Map<string, string>();
  /** openOrder messages per order key so far (a modify IB does not echo asks for the open orders). */
  const echoes = new Map<string, number>();
  /** What-if requests waiting for IB's answer, by order id. */
  const previews = new Map<number, { resolve(p: OrderPreview): void; reject(err: Error): void; part?: OrderPreview; settle?: ReturnType<typeof setTimeout> }>();
  /** The preview queue (one at a time) and recent answers by request. */
  let previewChain: Promise<unknown> = Promise.resolve();
  const previewCache = new Map<string, { at: number; result: Promise<OrderPreview> }>();

  /** The open-orders request IB answers now and those queued behind it (see requestOpenOrders). */
  let openRequest: OpenOrdersRequest | null = null;
  const openQueue: OpenOrdersRequest[] = [];
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keys of the orders the full list IB sends now has named so far; null when none is coming. */
  let snapshotKeys: Set<string> | null = null;
  /** Orders a full list left out, by key, until reqCompletedOrders says how they ended (see sweep). */
  const vanished = new Map<string, SweepReason>();
  let vanishedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Places and modifies IB had not answered when their wait ended, by order key (see lateRefusal). */
  const lateRequests = new Map<string, LateRequest>();
  /** Cancels IB had not confirmed when their wait ended, by order key: a refusal that follows is announced. */
  const cancelsInFlight = new Map<string, ReturnType<typeof setTimeout>>();
  /** Cancels waiting for IB, by order key: IB's 202 ends the wait. */
  const cancelWaits = new Map<string, () => void>();
  /** Brackets this session placed, by the key of each leg (see withdraw). */
  const brackets = new Map<string, Bracket>();
  /** What happened to the rest of a bracket, by the key of the leg that failed (its rejection notice says it). */
  const legOutcomes = new Map<string, BracketOutcome>();
  /** Cancel all waits for IB (one at a time). */
  let cancellingAll = false;
  /** Called once the orders a full list left out are settled (see settleVanished): Cancel all's count waits for it. */
  const afterSettle: Array<() => void> = [];
  /** Asks IB's lists again while connected (ORDERS_REFRESH_MS, see refreshLists). */
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** resetSession is giving the previous session's owed notices (see noticeAccountId). */
  let flushingOwed = false;
  /**
   * permIds of other apps' and clients' orders whose fill IB's completed orders reported (this
   * client gets no executions of them): announced once from there, not again by an execution.
   */
  const completedFills = new Set<number>();

  /** Notifications start after the session's first complete load (openOrderEnd / execDetailsEnd). */
  let ordersLoaded = false;
  let executionsLoaded = false;
  let execReqId = -1;

  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let dirtyOrders = false;
  let dirtyExecutions = false;

  const myClientId = () => ctx.ib.getState().clientId;
  const sessionNow = () => ctx.ib.getState().session;

  // ---------------------------------------------------------------------------
  // Lists and emitting

  const orderList = () => [...orders.values()].sort((a, b) => b.createdAt - a.createdAt || b.orderId - a.orderId);
  const executionList = () => [...executions.values()].sort((a, b) => b.time - a.time);

  function markDirty(o: boolean, x: boolean): void {
    dirtyOrders ||= o;
    dirtyExecutions ||= x;
    if (!emitTimer) emitTimer = setTimeout(flush, EMIT_MS);
  }

  function flush(): void {
    emitTimer = null;
    if (dirtyOrders) ctx.emit({ type: 'orders', orders: orderList() });
    if (dirtyExecutions) ctx.emit({ type: 'executions', executions: executionList() });
    dirtyOrders = dirtyExecutions = false;
  }

  /**
   * The account a notice is about: the event's own (the order's, the fill's, the one a request was
   * sent for), else the session's. Not the connected one while resetSession gives the notices owed
   * to the previous session (`flushingOwed`): the connection names the new account by then.
   */
  function noticeAccountId(account: string | undefined): string | undefined {
    return account || (flushingOwed ? undefined : ctx.ib.getState().account) || undefined;
  }

  /**
   * The account a notice names (orderMapping.ts → accountTag), its id left out while Settings ›
   * Privacy hides account IDs, never PAPER / LIVE.
   */
  function noticeAccount(account: string | undefined): LocalizedText | undefined {
    if (!account) return undefined;
    // The context of some tests has no store.
    const show = (ctx.store as MainContext['store'] | undefined)?.getSettings().appearance.showAccountId ?? true;
    return accountTag(isPaperAccount(account), show ? account : '');
  }

  /**
   * A notice about an order or fill (`about`: its contract, for the click, and its account, which
   * the title names and the click checks: Orders and Trades list the connected login's).
   * `orderDone`: the order is cancelled or rejected (no longer on Portfolio › Orders, where a click
   * on an order notice leads). `critical`: a rejection, a cancel or modify IB refused late, or an
   * order the closing connection left unconfirmed: the order is not what the user believes, so the
   * notice comes through do-not-disturb.
   */
  function notify(n: NoticeText, about: { contract: ContractRef; account?: string }, kind: 'fill' | 'order', orderDone = false, critical = false): void {
    try {
      const account = noticeAccountId(about.account);
      const { title, body } = withAccount(n, noticeAccount(account));
      ctx.notifier.notify({
        kind,
        title,
        body,
        contract: about.contract,
        ...(orderDone && { orderDone: true as const }),
        ...(critical && { critical: true as const }),
        ...(account ? { account } : {}),
      });
    } catch (err) {
      console.error('[orders] notification failed:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Condition symbols (price conditions only carry a conId)

  function smartRouted(conId: number): boolean | undefined {
    return smartStocks.get(conId);
  }

  function symbolOf(conId: number): string | undefined {
    const known = symbols.get(conId);
    if (known) return known;
    const held = ctx.account.getPositions().find((p) => p.contract.conId === conId);
    if (held) return held.contract.symbol;
    lookUpSymbol(conId);
    return undefined;
  }

  function lookUpSymbol(conId: number): void {
    const api = ctx.ib.api;
    if (!api || symbolsRequested.has(conId)) return;
    symbolsRequested.add(conId);
    const reqId = ctx.ib.nextReqId();
    symbolLookups.set(reqId, conId);
    api.reqContractDetails(reqId, { conId });
    setTimeout(() => symbolLookups.delete(reqId), CONTRACT_LOOKUP_TIMEOUT_MS);
  }

  function rememberSymbol(c: ContractRef | Contract): void {
    if (c.conId && c.symbol && (c as ContractRef).secType !== 'BAG') symbols.set(c.conId, c.symbol);
  }

  // ---------------------------------------------------------------------------
  // Order updates

  /**
   * Records what IB reports of an order. `round`: it came while IB sends a list of open orders (see
   * requestOpenOrders); `snapshot`: a state to record without a notice.
   */
  function store(key: string, prev: WorkingOrder | undefined, update: WorkingOrder, opts: { prevKey?: string; snapshot?: boolean; round?: boolean } = {}): void {
    // IB reports it: an order a full list had left out is back, or has ended (completedOrder).
    const next = reported(update);
    vanished.delete(key);
    if (opts.prevKey && opts.prevKey !== key) {
      orders.delete(opts.prevKey);
      vanished.delete(opts.prevKey);
    }
    orders.set(key, next);
    sentKeys.delete(key);
    if (next.status !== 'ApiPending') sentOrders.delete(key);
    if (next.permId) keyByPermId.set(next.permId, key);
    markDirty(true, false);
    // A failed bracket leg withdraws the rest before its rejection is announced (the notice says so).
    checkBracket(key, prev, next);
    announce(key, prev, next, !!opts.snapshot);
    settleWaiters(next, !!opts.round);
    settleLate(key, next);
  }

  function findByPermId(permId: number | undefined): [string, WorkingOrder] | undefined {
    const key = permId ? keyByPermId.get(permId) : undefined;
    const o = key ? orders.get(key) : undefined;
    return key && o ? [key, o] : undefined;
  }

  function onOpenOrder(orderId: number, contract: Contract, order: Order, state: OrderState): void {
    // A what-if answer is an estimate, not an order.
    if (order.whatIf) {
      const p = previews.get(orderId || order.orderId || 0);
      if (!p) return;
      // IB sends the estimate in parts (commission and notice, then margin): merge them. A limit
      // order's first part has a placeholder commission of 0, the later one IB's min–max range.
      const next = mapPreview(state);
      const part: OrderPreview = { ...p.part, ...next };
      if (next.commission == null && (next.minCommission != null || next.maxCommission != null)) delete part.commission;
      if (p.part?.warningText && !part.warningText) part.warningText = p.part.warningText;
      p.part = part;
      if (p.settle) clearTimeout(p.settle);
      if (part.initMargin) p.resolve(part);
      else p.settle = setTimeout(() => p.resolve(part), PREVIEW_SETTLE_MS);
      return;
    }
    const key = orderKey(order.clientId, orderId, order.permId);
    const round = openRequest != null;
    snapshotKeys?.add(key);
    // Only an openOrder outside a list of open orders can be IB's answer to a modify (see modify).
    if (!round) echoes.set(key, (echoes.get(key) ?? 0) + 1);
    const byPerm = findByPermId(order.permId);
    const prevKey = orders.has(key) ? key : byPerm?.[0];
    const prev = prevKey ? orders.get(prevKey) : undefined;
    rememberSymbol(contract);
    let next = mapOpenOrder(orderId, contract, order, state, prev, Date.now(), symbolOf, smartRouted);
    const early = earlyStatus.get(key);
    if (early) {
      earlyStatus.delete(key);
      next = applyOrderStatus(next, early, Date.now());
    }
    store(key, prev, next, { prevKey, round });
  }

  function onOrderStatus(
    orderId: number,
    status: string,
    filled: number,
    remaining: number,
    avgFillPrice: number,
    permId?: number,
    parentId?: number,
    _lastFillPrice?: number,
    clientId?: number,
    whyHeld?: string,
  ): void {
    if (previews.has(orderId) && (clientId == null || clientId === myClientId())) return;
    const update: StatusUpdate = { status, filled, remaining, avgFillPrice, permId, parentId, whyHeld };
    const key = orderKey(clientId ?? myClientId(), orderId, permId);
    const found = orders.has(key) ? ([key, orders.get(key)!] as const) : findByPermId(permId);
    const round = openRequest != null;
    if (!found) {
      // An order TWS / IB Gateway holds gets no openOrder: it is listed from what was sent (see Held orders).
      const sent = status === 'ApiPending' ? sentOrders.get(key) : undefined;
      if (!sent) {
        earlyStatus.set(key, update);
        return;
      }
      const now = Date.now();
      // The request carries no client id: the order is this client's (its key says so).
      const order = { ...sent.order, clientId: clientId ?? myClientId() };
      const held = applyOrderStatus(mapOpenOrder(orderId, sent.contract, order, undefined, undefined, now, symbolOf, smartRouted), update, now);
      snapshotKeys?.add(key);
      store(key, undefined, held, { round });
      announceHeld(key, held);
      return;
    }
    const [k, prev] = found;
    const next = applyOrderStatus(prev, update, Date.now());
    // A held order is in no list of IB's: TWS / IB Gateway reporting it keeps it (sweep).
    if (next.status === 'ApiPending') snapshotKeys?.add(k);
    store(k, prev, next, { round });
    if (next.status === 'ApiPending') announceHeld(k, next);
  }

  /** An order of this client TWS / IB Gateway holds without sending it to IB: announced once (see Held orders). */
  function announceHeld(key: string, o: WorkingOrder): void {
    if (heldNoticed.has(key) || o.clientId !== myClientId()) return;
    heldNoticed.add(key);
    notify(orderNotice(o, 'held'), o, 'order', false, true);
  }

  function onCompletedOrder(contract: Contract, order: Order, state: OrderState): void {
    const found = findByPermId(order.permId);
    const key = found?.[0] ?? orderKey(order.clientId, order.orderId, order.permId);
    const prev = found?.[1] ?? orders.get(key);
    rememberSymbol(contract);
    const next = mapCompletedOrder(contract, order, state, prev, Date.now(), symbolOf, smartRouted);
    // reqCompletedOrders is a snapshot of the day: an order first seen there, or already ended here,
    // is recorded without a notice. One this session knew as working ended while Tape could not hear
    // it (disconnected; another client's order, of which this client gets no updates): announced
    // (cancelled, rejected or expired; this client's fills come with the executions).
    const snapshot = !prev || !isOrderActive(prev.status);
    store(key, prev, next, { snapshot });
    if (!snapshot && next.status === 'Filled') announceCompletedFill(next);
  }

  /**
   * Another app's or client's order this session knew as working has filled (IB's completed orders
   * say so): no execution of it reaches this client, so its fill is announced from here, once, and
   * unless an execution of it is known (its own notice says it).
   */
  function announceCompletedFill(o: WorkingOrder): void {
    const own = o.orderId !== 0 && o.clientId === myClientId();
    if (own || !ordersLoaded || !o.permId || completedFills.has(o.permId)) return;
    if ([...executions.values()].some((e) => e.permId === o.permId)) return;
    completedFills.add(o.permId);
    notify(orderNotice(o, 'filled'), o, 'fill');
  }

  /** Order-status notifications for changes after the initial load. */
  function announce(key: string, prev: WorkingOrder | undefined, next: WorkingOrder, snapshot: boolean): void {
    const kind =
      next.status === 'PreSubmitted' || next.status === 'Submitted'
        ? 'submitted'
        : next.status === 'Cancelled' || next.status === 'ApiCancelled'
          ? 'cancelled'
          : next.status === 'Inactive'
            ? 'rejected'
            : next.status === 'Filled'
              ? 'filled' // announced by the fill notification
              : 'other';
    const before = notified.get(key);
    notified.set(key, before === 'rejected' && kind === 'cancelled' ? 'rejected' : kind);
    if (!ordersLoaded || snapshot || kind === before || kind === 'other' || kind === 'filled') return;
    // An order cancelled right after a rejection (IB often sends both) is announced once.
    if (kind === 'cancelled' && before === 'rejected') return;
    if (kind === 'submitted' && prev && (prev.status === 'PreSubmitted' || prev.status === 'Submitted')) return;
    // Bracket children follow their parent (submitted / cancelled with it); their fills are announced.
    if (next.parentId && kind !== 'rejected') return;
    if (kind === 'rejected') {
      if (rejectionNoticed.has(key)) return;
      rejectionNoticed.add(key);
      // IB sends the reason (201) right after the Inactive openOrder: the notice waits for it.
      if (!orderErrors.has(key)) {
        pendingRejections.set(key, setTimeout(() => announceRejection(key), REJECT_REASON_WAIT_MS));
        return;
      }
      announceRejection(key);
      return;
    }
    notify(orderNotice(next, kind), next, 'order', kind === 'cancelled');
  }

  /** The rejection notice of an order, with IB's reason when it has arrived (and, for a bracket leg, what happened to the rest). */
  function announceRejection(key: string): void {
    clearTimeout(pendingRejections.get(key));
    pendingRejections.delete(key);
    const o = orders.get(key);
    const outcome = legOutcomes.get(key);
    legOutcomes.delete(key);
    if (o) notify(orderNotice(o, 'rejected', orderErrors.get(key) ?? o.message, { outcome: outcome && bracketOutcomeText(outcome) }), o, 'order', true, true);
  }

  // ---------------------------------------------------------------------------
  // Executions

  function onExecDetails(_reqId: number, contract: Contract, exec: IbExecution): void {
    const e = mapExecution(contract, exec, Date.now());
    if (!e.execId) return;
    const base = execBaseId(e.execId);
    const prev = executions.get(base);
    const report = commissions.get(e.execId) ?? (prev ? commissions.get(prev.execId) : undefined);
    const merged: Execution = { ...e };
    const commission = num(report?.commission) ?? prev?.commission;
    const realized = num(report?.realizedPNL) ?? prev?.realizedPnL;
    if (commission != null) merged.commission = commission;
    if (realized != null) merged.realizedPnL = realized;
    executions.set(base, merged);
    const avg = num(exec.avgPrice);
    if (avg) execAvgPrice.set(base, avg);
    rememberSymbol(contract);
    markDirty(false, true);
    // Fills after the first load are new: live ones (reqId -1) and those found on reconnect, unless
    // IB's completed orders announced the order's fill already (announceCompletedFill).
    if (executionsLoaded && !prev && !(e.permId && completedFills.has(e.permId))) scheduleFillNotice(base);
  }

  function scheduleFillNotice(base: string): void {
    if (pendingFills.has(base)) return;
    pendingFills.set(
      base,
      setTimeout(() => announceFill(base), FILL_NOTICE_WAIT_MS),
    );
  }

  function announceFill(base: string): void {
    const timer = pendingFills.get(base);
    if (!timer) return;
    clearTimeout(timer);
    pendingFills.delete(base);
    const e = executions.get(base);
    if (e) notify(fillNotice(e, execAvgPrice.get(base), e.commission), e, 'fill');
  }

  function onCommissionReport(report: CommissionReport): void {
    if (!report.execId) return;
    commissions.set(report.execId, report);
    const base = execBaseId(report.execId);
    const e = executions.get(base);
    if (e) {
      const next: Execution = { ...e };
      const commission = num(report.commission);
      const realized = num(report.realizedPNL);
      if (commission != null) next.commission = commission;
      if (realized != null) next.realizedPnL = realized;
      executions.set(base, next);
      markDirty(false, true);
    }
    if (pendingFills.has(base)) announceFill(base);
  }

  // ---------------------------------------------------------------------------
  // Waiting for IB to accept, reject or cancel an order

  function awaitOrders(
    ids: number[],
    timeoutMs: number,
    { accept = () => true, failInactive = false }: { accept?: (o: WorkingOrder, round: boolean) => boolean; failInactive?: boolean } = {},
  ): Wait {
    let w!: Waiter;
    const done = new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(w);
      };
      w = {
        ids: new Set(ids),
        acked: new Set(),
        accept,
        failInactive,
        inactive: new Set(),
        resolve: (answered) => {
          cleanup();
          resolve(answered);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      // No answer in time: the request was sent, IB has not confirmed it (its updates, or a refusal,
      // may still come). An order IB set Inactive without giving a reason (yet) was not accepted.
      const timer = setTimeout(() => {
        const [inactive] = w.inactive;
        if (inactive == null) w.resolve(false);
        else w.reject(new OrderRefused(`IB did not accept order #${inactive} (Inactive)`, inactive));
      }, timeoutMs);
      waiters.add(w);
    });
    return { done, answer: () => w.resolve(true) };
  }

  function settleWaiters(o: WorkingOrder, round: boolean): void {
    if (o.clientId !== myClientId()) return;
    for (const w of [...waiters]) {
      if (!w.ids.has(o.orderId)) continue;
      // IB's reason (201) follows the Inactive openOrder and fails the wait (onRequestError).
      if (w.failInactive && o.status === 'Inactive') {
        w.inactive.add(o.orderId);
        continue;
      }
      if (!w.accept(o, round)) continue;
      w.inactive.delete(o.orderId);
      w.acked.add(o.orderId);
      if (w.acked.size === w.ids.size) {
        w.resolve(true);
        // IB took an order request: Read-Only API is off (whatever an earlier 321 said).
        ctx.ib.noteOrderAccepted();
      }
    }
  }

  function onRequestError(e: { reqId: number; code: number; message: string }): void {
    const message = cleanIbMessage(e.message);
    const warning = isOrderWarning(e.code, e.message);
    const preview = previews.get(e.reqId);
    if (preview) {
      if (!warning) preview.reject(new Error(`${message} (${e.code})`));
      return;
    }
    // Only orders of this client have errors with their id.
    const key = orderKey(myClientId(), e.reqId, undefined);
    // 202 "Order Canceled": IB confirms a cancel (also one whose wait has ended).
    if (e.code === 202) {
      const answer = cancelWaits.get(key);
      if (answer) {
        answer();
        ctx.ib.noteOrderAccepted();
      }
      forgetCancel(key);
    }
    if (!warning) {
      const text = `${message} (${e.code})`;
      let waited = false;
      for (const w of [...waiters]) {
        if (!w.ids.has(e.reqId)) continue;
        waited = true;
        w.reject(new OrderRefused(text, e.reqId));
      }
      // The reason of a rejection, which may also arrive before IB reports the order.
      if (orders.has(key) || sentKeys.has(key)) orderErrors.set(key, text);
      // A refusal after its request's wait: announced on its own (see lateRefusal).
      if (!waited) lateRefusal(key, text);
    }
    // Attach the text to the order.
    const o = orders.get(key);
    if (o && e.code !== 202) {
      orders.set(key, { ...o, message, updatedAt: Date.now() });
      markDirty(true, false);
    }
    if (!warning && pendingRejections.has(key)) announceRejection(key);
  }

  /**
   * Which of `ids`' frames (placeOrder / cancelOrder) reached the socket: the TWS client's 'sent'
   * event (as market/ibRequest.ts). A frame the client still held when the socket closed is dropped
   * with its queue, so it never reached IB; one written may have.
   */
  function watchWrites(msgId: number, ids: number[]): { written: Set<number>; stop(): void } {
    const written = new Set<number>();
    // cancelOrder carries a version field before the id below server version 192.
    const at = msgId === OUT_MSG_ID.CANCEL_ORDER && (ctx.ib.getState().serverVersion ?? MIN_SERVER_VER.CME_TAGGING_FIELDS) < MIN_SERVER_VER.CME_TAGGING_FIELDS ? 2 : 1;
    const stop = ctx.ib.on(EventName.sent, (tokens: unknown) => {
      if (!Array.isArray(tokens) || Number(tokens[0]) !== msgId) return;
      const id = Number(tokens[at]);
      if (ids.includes(id)) written.add(id);
    });
    return { written, stop };
  }

  // ---------------------------------------------------------------------------
  // Answers after the wait

  /** Watches a place or modify IB has not answered for LATE_REFUSAL_MS (see lateRefusal). */
  function watchLate(r: Omit<LateRequest, 'timer'>, clientId: number, orderIds: number[]): void {
    const late: LateRequest = {
      ...r,
      timer: setTimeout(() => dropLate(late), LATE_REFUSAL_MS),
    };
    for (const id of orderIds) lateRequests.set(orderKey(clientId, id, undefined), late);
  }

  function dropLate(late: LateRequest): void {
    clearTimeout(late.timer);
    for (const [k, v] of [...lateRequests]) if (v === late) lateRequests.delete(k);
  }

  /** Watches a cancel IB has not confirmed for LATE_REFUSAL_MS: a refusal that follows is announced. */
  function trackCancel(key: string): void {
    forgetCancel(key);
    cancelsInFlight.set(
      key,
      setTimeout(() => cancelsInFlight.delete(key), LATE_REFUSAL_MS),
    );
  }

  function forgetCancel(key: string): void {
    clearTimeout(cancelsInFlight.get(key));
    cancelsInFlight.delete(key);
  }

  /** IB's update of an order is a definite answer to a request still watched after its wait. */
  function settleLate(key: string, o: WorkingOrder): void {
    const late = lateRequests.get(key);
    if (late && (late.verb === 'place' ? o.status !== 'Inactive' : late.echo?.applied(o))) {
      lateRequests.delete(key);
      if (![...lateRequests.values()].includes(late)) clearTimeout(late.timer);
      ctx.ib.noteOrderAccepted();
    }
    if (cancelsInFlight.has(key) && !isOrderActive(o.status)) forgetCancel(key);
  }

  /**
   * IB refused a request after Tape's wait for it had ended (the user was told it was sent, not
   * confirmed): a cancel or modify is announced as refused (the order is unchanged), a place as
   * rejected unless IB reported the order itself (announce() does that one), with a bracket's
   * other legs withdrawn.
   */
  function lateRefusal(key: string, reason: string): void {
    if (cancelsInFlight.has(key)) {
      forgetCancel(key);
      const o = orders.get(key);
      if (o) notify(orderNotice(o, 'cancelRefused', reason), o, 'order', false, true);
      return;
    }
    const late = lateRequests.get(key);
    if (!late) return;
    dropLate(late);
    if (late.verb === 'modify') {
      if (late.existing) notify(orderNotice(late.existing, 'modifyRefused', reason), late.existing, 'order', false, true);
      return;
    }
    if (orders.has(key)) return;
    const orderId = Number(key.slice(key.indexOf(':') + 1));
    rejected(late.req, late.ids, reason, late.session, late.account, late.bracket && withdraw(late.bracket, orderId));
  }

  // ---------------------------------------------------------------------------
  // Brackets

  const legKey = (b: Bracket, orderId: number) => orderKey(b.clientId, orderId, undefined);

  function trackBracket(api: IBApi, clientId: number, session: number, built: BuiltOrder[]): Bracket {
    const b: Bracket = { api, clientId, session, legs: built.map(({ orderId, role }) => ({ orderId, role })) };
    for (const l of b.legs) brackets.set(legKey(b, l.orderId), b);
    return b;
  }

  function forgetBracket(b: Bracket): void {
    for (const l of b.legs) if (brackets.get(legKey(b, l.orderId)) === b) brackets.delete(legKey(b, l.orderId));
  }

  /** A leg IB reported as Inactive withdraws the rest; a bracket whose legs have all ended is forgotten. */
  function checkBracket(key: string, prev: WorkingOrder | undefined, next: WorkingOrder): void {
    const b = brackets.get(key);
    if (!b) return;
    if (next.status === 'Inactive' && prev?.status !== 'Inactive') {
      withdraw(b, next.orderId);
      return;
    }
    const ended = (orderId: number) => {
      const o = orders.get(legKey(b, orderId));
      return !!o && !isOrderActive(o.status);
    };
    if (b.legs.every((l) => ended(l.orderId))) forgetBracket(b);
  }

  /**
   * One leg of bracket `b` failed (`failedId`): the legs still alive (reported working, or sent and
   * not reported yet) are cancelled, so no entry works without its stop-loss and no exit without
   * its entry. Not when the entry has filled: the exit left then protects the position. Once per
   * bracket; the outcome goes into the error and the failed leg's rejection notice.
   */
  function withdraw(b: Bracket, failedId: number): BracketOutcome {
    if (b.outcome) return b.outcome;
    const [entry] = b.legs;
    const failed = b.legs.find((l) => l.orderId === failedId) ?? entry;
    const entryRow = orders.get(legKey(b, entry.orderId));
    let outcome: BracketOutcome;
    if (failed !== entry && entryRow && entryRow.filled > 0) {
      outcome = { kind: 'entryFilled', entryId: entry.orderId, filled: entryRow.filled, missing: failed.role };
    } else {
      const alive = b.legs.filter((l) => {
        if (l === failed) return false;
        const o = orders.get(legKey(b, l.orderId));
        return o ? isOrderActive(o.status) : sentKeys.has(legKey(b, l.orderId));
      });
      const api = ctx.ib.api;
      // Only on the session and socket the bracket went out on: its ids name these orders there.
      const reachable = !!api && api === b.api && sessionNow() === b.session && myClientId() === b.clientId;
      if (reachable) for (const l of alive) api.cancelOrder(l.orderId);
      outcome = alive.length ? { kind: reachable ? 'withdrawn' : 'notWithdrawn', legs: alive } : { kind: 'nothingLeft' };
    }
    b.outcome = outcome;
    legOutcomes.set(legKey(b, failed.orderId), outcome);
    forgetBracket(b);
    return outcome;
  }

  // ---------------------------------------------------------------------------
  // Open orders and reconciliation

  /**
   * Asks IB for open orders. openOrderEnd names no request, so one is outstanding at a time and the
   * others wait their turn: an end answers the request in flight (a modify's own-orders request
   * never ends a full list, see sweep). Requests of a closed socket are dropped (onClosed).
   */
  function requestOpenOrders(r: OpenOrdersRequest, api: IBApi | null = ctx.ib.api): void {
    if (openRequest) {
      openQueue.push(r);
      return;
    }
    if (!api) {
      // No socket to ask (it is closing): neither this request nor those queued is answered.
      for (const d of [r, ...openQueue.splice(0)]) d.onEnd?.(false);
      return;
    }
    openRequest = r;
    snapshotKeys = r.kind === 'all' ? new Set() : null;
    openTimer = setTimeout(() => endOpenRequest(false), OPEN_ORDERS_TIMEOUT_MS);
    if (r.kind === 'all') api.reqAllOpenOrders();
    else api.reqOpenOrders();
  }

  /** The open-orders request in flight has ended (`answered`: by IB's openOrderEnd); the next one goes out. */
  function endOpenRequest(answered: boolean): void {
    const r = openRequest;
    const seen = snapshotKeys;
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
    openRequest = null;
    snapshotKeys = null;
    if (answered && r?.sweep && seen) sweep(seen, r.sweep);
    r?.onEnd?.(answered);
    const next = openQueue.shift();
    if (next) requestOpenOrders(next);
  }

  /** The socket closed or the session changed: no request is answered now (those waiting are told so). */
  function clearOpenRequests(): void {
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
    const dropped = [...(openRequest ? [openRequest] : []), ...openQueue];
    openRequest = null;
    snapshotKeys = null;
    openQueue.length = 0;
    for (const r of dropped) r.onEnd?.(false);
    // Cancel all no longer waits for orders to settle: its own checks say what happened.
    for (const f of afterSettle.splice(0)) f();
  }

  /**
   * Asks IB for every client's open orders, swept at their end (a refresh), and today's completed
   * orders, which say how the orders the list left out ended. `completed`: false with Read-Only API
   * on, where IB refuses that request (321); the swept orders then settle after VANISHED_WAIT_MS.
   */
  function requestLists(api: IBApi, onEnd?: (answered: boolean) => void, completed = !ctx.ib.getState().readOnlyApi): void {
    requestOpenOrders({ kind: 'all', sweep: 'refresh', onEnd }, api);
    if (completed) api.reqCompletedOrders(false);
  }

  /**
   * IB's lists again (see the header): every ORDERS_REFRESH_MS while connected, when Portfolio ›
   * Orders or Cancel all opens (refreshOrders), and after Cancel all left orders working. Not while
   * a full list is asked already or Cancel all waits for its own, nor while TWS / IB Gateway has lost
   * IB or does not answer (its list may not be IB's then).
   */
  function refreshLists(api: IBApi): void {
    const s = ctx.ib.getState();
    if (api !== ctx.ib.api || !ctx.ib.isConnected() || s.ibLinkLost || s.unresponsive || cancellingAll) return;
    if (openRequest?.kind === 'all' || openQueue.some((r) => r.kind === 'all')) return;
    requestLists(api);
  }

  function stopRefresh(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  /**
   * IB's full list of open orders ended without these active orders: they ended while Tape could not
   * hear it (see the header). Marked not reported until reqCompletedOrders says how they ended.
   */
  function sweep(seen: Set<string>, reason: SweepReason): void {
    const now = Date.now();
    let found = false;
    for (const [key, o] of orders) {
      if (seen.has(key) || !isOrderActive(o.status)) continue;
      found = true;
      if (!o.notReported) orders.set(key, { ...o, notReported: true, updatedAt: now });
      vanished.set(key, reason);
    }
    if (!found) return;
    markDirty(true, false);
    if (vanishedTimer) clearTimeout(vanishedTimer);
    vanishedTimer = setTimeout(settleVanished, VANISHED_WAIT_MS);
  }

  /**
   * reqCompletedOrders has ended (or was refused): how the orders a list left out ended is known now,
   * as far as IB says (Cancel all counts them).
   */
  function settleVanished(): void {
    if (vanishedTimer) clearTimeout(vanishedTimer);
    vanishedTimer = null;
    dropVanished();
    for (const f of afterSettle.splice(0)) f();
  }

  /** The orders IB did not account for are announced once as no longer working and dropped (a bracket child goes with its parent's notice). */
  function dropVanished(): void {
    if (!vanished.size) return;
    const gone = [...vanished];
    vanished.clear();
    const goneKeys = new Set(gone.map(([key]) => key));
    for (const [key, reason] of gone) {
      const o = orders.get(key);
      if (!o?.notReported) continue;
      orders.delete(key);
      if (o.permId && keyByPermId.get(o.permId) === key) keyByPermId.delete(o.permId);
      earlyStatus.delete(key);
      echoes.delete(key);
      if (o.parentId && goneKeys.has(orderKey(o.clientId, o.parentId, undefined))) continue;
      notify(orderNotice(o, 'notReported', undefined, { offline: reason === 'reconnect' }), o, 'order', true);
    }
    markDirty(true, false);
  }

  // ---------------------------------------------------------------------------
  // Requests

  /**
   * Orders are never sent while Tape is locked. IPC already refuses these calls (LOCK_POLICY);
   * this is the backstop for any other path.
   */
  function requireUnlocked(): void {
    // The context of some tests has no lock service.
    if ((ctx.lock as MainContext['lock'] | undefined)?.isLocked()) throw new Error(LOCKED_MESSAGE);
  }

  function requireApi(): IBApi {
    const api = ctx.ib.api;
    if (!api || !ctx.ib.isConnected()) throw new Error(NOT_CONNECTED_MESSAGE);
    return api;
  }

  /**
   * Orders and modifies need TWS / IB Gateway to reach IB now (see the header): not after a 1100,
   * not while it ignores the heartbeat. The renderer refuses them first; this is the backstop.
   */
  function requireIbLink(): void {
    const s = ctx.ib.getState();
    if (s.ibLinkLost) throw new Error(IB_LINK_LOST_MESSAGE);
    if (s.unresponsive) throw new Error(GATEWAY_UNRESPONSIVE_MESSAGE);
  }

  /**
   * A request made for session `session` (the one the user reviewed it on) is refused on any
   * other, before anything is sent: an order reviewed on paper never reaches live.
   */
  function requireSession(session: number | undefined): void {
    if (session != null && session !== sessionNow()) throw new Error(SESSION_CHANGED_MESSAGE);
  }

  /**
   * The API instance to send an order on, after an `await`: still the session the order was
   * checked against. Another client id or Gateway (a new instance) would take the order id for
   * a different order, and another login on the same instance (a new session epoch) is another
   * account, so nothing is sent then.
   */
  function sameSession(api: IBApi, clientId: number, session: number): IBApi {
    requireUnlocked();
    const now = requireApi();
    if (now !== api || myClientId() !== clientId || sessionNow() !== session) throw new Error(CONNECTION_CHANGED_MESSAGE);
    return now;
  }

  /** Fills in the conId (IB matches orders by it); combos carry their legs' conIds already. */
  async function resolve(c: ContractRef): Promise<ContractRef> {
    if (c.conId || c.secType === 'BAG') return c;
    try {
      return (await ctx.contracts.resolve(c)) ?? c;
    } catch (err) {
      throw new Error(`${contractLabel(c)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The OVERNIGHT venue needs the primary listing exchange; a resolved conId may come without it. */
  async function withPrimaryExchange(c: ContractRef): Promise<ContractRef> {
    if (c.primaryExchange) return c;
    const primaryExchange = (await ctx.contracts.getInfo(c).catch(() => null))?.contract.primaryExchange;
    return primaryExchange ? { ...c, primaryExchange } : c;
  }

  interface Prepared {
    req: OrderRequest;
    conditionConIds?: Array<number | undefined>;
    rules: OrderRulesContext;
  }

  /** What IB says the contract takes (cached contract details); nothing when unknown. */
  async function rulesContext(c: ContractRef): Promise<OrderRulesContext> {
    if (c.secType === 'BAG') return {};
    const info = await Promise.resolve(ctx.contracts.getInfo?.(c)).catch(() => null);
    return info ? { orderTypes: info.orderTypes, validExchanges: info.validExchanges } : {};
  }

  /** Resolves the conIds of the instruments the conditions watch, by position. */
  async function conditionConIds(conds: OrderConditions | undefined, contract: ContractRef): Promise<Array<number | undefined> | undefined> {
    if (!conds) return undefined;
    const out: Array<number | undefined> = [];
    for (const c of conds.items) {
      if (!('contract' in c)) {
        out.push(undefined);
        continue;
      }
      const cond = c.contract;
      const resolved = cond.conId ? cond : contract.conId && cond.symbol === contract.symbol && cond.secType === contract.secType ? contract : await resolve(cond);
      rememberSymbol(resolved);
      if (!resolved.conId) throw new Error(`Could not resolve ${contractLabel(cond)} for the ${c.kind === 'price' ? 'price ' : ''}condition`);
      out.push(resolved.conId);
    }
    return out;
  }

  async function prepare(req: OrderRequest): Promise<Prepared> {
    const problem = validateOrderRequest(req);
    if (problem) throw new Error(problem);
    let contract = await resolve(req.contract);
    if (sessionOf(req) === 'overnight') contract = await withPrimaryExchange(contract);
    rememberSymbol(contract);
    const ids = await conditionConIds(requestConditions(req), contract);
    const rules = await rulesContext(contract);
    if (contract.secType === 'STK' && contract.conId && sessionOf(req) !== 'overnight') {
      smartStocks.set(contract.conId, rules.validExchanges?.length ? rules.validExchanges.includes('SMART') : contract.exchange === 'SMART');
    }
    const next = { ...req, contract };
    // Checked again with what IB says the contract takes (order types, attributes, venues).
    const refused = validateOrderRequest(next, Date.now(), rules);
    if (refused) throw new Error(refused);
    return { req: next, conditionConIds: ids, rules };
  }

  /**
   * Announces a request IB refused, unless IB reported one of its orders as rejected (announce
   * does that one, with the same reason). Its orders IB has not reported are not announced again.
   * `session`: the session the request was sent on. After a switch its ids name the new login's
   * orders, whose notices must not be marked as given. `account`: the account it was sent for.
   * `outcome`: what happened to the rest of a bracket.
   */
  function rejected(req: OrderRequest, orderIds: number[], reason: string, session: number, account: string | undefined, outcome?: BracketOutcome): void {
    if (session === sessionNow()) {
      const keys = orderIds.map((id) => orderKey(myClientId(), id, undefined));
      if (keys.some((k) => rejectionNoticed.has(k))) return;
      for (const k of keys) {
        rejectionNoticed.add(k);
        legOutcomes.delete(k);
        if (!orders.has(k)) notified.set(k, 'rejected');
      }
    }
    notify(orderNotice(requestNotice(req), 'rejected', reason, { outcome: outcome && bracketOutcomeText(outcome) }), { contract: req.contract, account }, 'order', true, true);
  }

  async function place(input: OrderRequest, reviewed?: number): Promise<PlaceOrderResult> {
    requireUnlocked();
    requireSession(reviewed);
    const checked = requireApi();
    requireIbLink();
    const clientId = myClientId();
    const session = sessionNow();
    const { req, conditionConIds, rules } = await prepare(input);
    // A Gateway, client id or account switched to meanwhile does not get it, nor a link lost meanwhile.
    const api = sameSession(checked, clientId, session);
    requireIbLink();
    const orderId = ctx.ib.nextOrderId();
    const account = ctx.ib.getState().account;
    const built = buildOrders(req, {
      orderId,
      nextOrderId: () => ctx.ib.nextOrderId(),
      account,
      conditionConIds,
      rules,
    });
    const ids = built.map((b) => b.orderId);
    const bracket = built.length > 1 ? trackBracket(api, clientId, session, built) : undefined;
    // ApiPending is TWS / IB Gateway holding the order, not IB taking it (see Held orders).
    const wait = awaitOrders(ids, ACK_MS, { failInactive: true, accept: (o) => o.status !== 'ApiPending' });
    const writes = watchWrites(OUT_MSG_ID.PLACE_ORDER, ids);
    for (const b of built) {
      const key = orderKey(clientId, b.orderId, undefined);
      sentKeys.add(key);
      sentOrders.set(key, { contract: b.contract, order: b.order });
      orderErrors.delete(key);
      api.placeOrder(b.orderId, b.contract, b.order);
    }
    let confirmed: boolean;
    try {
      confirmed = await wait.done;
    } catch (err) {
      throw placeFailed(err, { req, ids, clientId, session, account, written: writes.written, bracket });
    } finally {
      writes.stop();
    }
    // Sent, not answered yet: IB's refusal within LATE_REFUSAL_MS is still announced.
    if (!confirmed) watchLate({ verb: 'place', req, ids, session, account, bracket }, clientId, ids);
    return { orderId, childOrderIds: ids.slice(1), confirmed };
  }

  /**
   * The error of a place() IB did not accept. A socket that closed before IB answered: nothing was
   * sent when no frame had been written (its keys go); otherwise IB may have the order, which is
   * no rejection (an "unconfirmed" notice; its keys stay sent, so a reconnect to the same account
   * lists and announces it). A refusal by IB is announced, and a bracket's other legs withdrawn.
   */
  function placeFailed(
    err: unknown,
    p: { req: OrderRequest; ids: number[]; clientId: number; session: number; account?: string; written: Set<number>; bracket?: Bracket },
  ): Error {
    const reason = err instanceof Error ? err.message : String(err);
    if (!(err instanceof OrderRefused) && reason === CLOSED_MESSAGE) {
      for (const id of p.ids) if (!p.written.has(id)) sentKeys.delete(orderKey(p.clientId, id, undefined));
      if (!p.written.size) {
        if (p.bracket) forgetBracket(p.bracket);
        return new Error(ORDER_NOT_SENT_MESSAGE);
      }
      notify(orderNotice(requestNotice(p.req), 'unconfirmed'), { contract: p.req.contract, account: p.account }, 'order', false, true);
      return new Error(ORDER_UNCONFIRMED_MESSAGE);
    }
    const leg = p.bracket && err instanceof OrderRefused ? p.bracket.legs.find((l) => l.orderId === err.orderId) : undefined;
    const outcome = p.bracket && leg ? withdraw(p.bracket, leg.orderId) : undefined;
    rejected(p.req, p.ids, reason, p.session, p.account, outcome);
    return leg && outcome ? new Error(`${legName(leg.role, leg.orderId)} rejected: ${reason}. ${bracketOutcomeText(outcome).en}`) : err instanceof Error ? err : new Error(reason);
  }

  /**
   * The order of this client with `orderId`; null for one this client has sent and IB has not
   * reported back yet. Order ids are per API client and IB applies placeOrder / cancelOrder to
   * the sender's own order with that id, so an id only ever names an order of this client id.
   * An id that only another client's order has (TWS is client 0) or that no order has is refused,
   * instead of being sent to IB, where it could hit this client's order with the same id.
   */
  function ownOrder(orderId: number, verb: 'modify' | 'cancel'): WorkingOrder | null {
    // 0 is the id of TWS orders not bound to an API client; ids are integers.
    if (!Number.isSafeInteger(orderId) || orderId === 0) throw new Error(`Order #${orderId} cannot be ${verb === 'modify' ? 'modified' : 'cancelled'} from Tape`);
    const key = orderKey(myClientId(), orderId, undefined);
    const own = orders.get(key);
    // Backstop: the lists are emptied when the session changes, so an order of an account this
    // login does not manage can only be a leftover; IB would apply the id to this login's order.
    const { accounts } = ctx.ib.getState();
    if (own?.account && !accounts.includes(own.account)) throw new Error(`Order #${orderId} belongs to account ${own.account}, which is not connected; nothing was sent`);
    if (own) return own;
    if (sentKeys.has(key)) return null;
    const other = [...orders.values()].find((o) => o.orderId === orderId);
    if (other) throw new Error(foreignOrderMessage(other, verb));
    throw new Error(`Order #${orderId} was not found`);
  }

  function foreignOrderMessage(o: WorkingOrder, verb: 'modify' | 'cancel'): string {
    // TWS orders can be bound to an API session with client id 0 (reqAutoOpenOrders, see onReady).
    const owner = o.clientId === 0 ? `client 0 (TWS): only client id 0 can ${verb} it` : `API client ${o.clientId}: only that client can ${verb} it`;
    // IB's global cancel reaches every client's orders (Portfolio › Orders › Cancel all…).
    const hint = verb === 'cancel' ? ', or use Cancel all orders…' : '';
    return `Order #${o.orderId} belongs to ${owner}${hint}`;
  }

  /** Why cancel() refuses an order (see cancelBlock); nothing is sent. */
  function blockMessage(o: WorkingOrder, block: CancelBlock): string {
    switch (block) {
      case 'notConnected':
        return NOT_CONNECTED_MESSAGE;
      case 'done':
        return `${orderName(o)} is already ${o.status}`;
      case 'notReported':
        return `${orderName(o)} is no longer listed by IB as working; nothing was sent`;
      case 'manual':
        return `${orderName(o)} was placed outside Tape (IBKR Mobile, TWS or the web); cancel it there or use Cancel all orders…`;
      case 'otherClient':
        return foreignOrderMessage(o, 'cancel');
      case 'otherAccount':
        return `${orderName(o)} belongs to account ${o.account}, which is not connected; nothing was sent`;
      case 'pendingCancel':
        return `${orderName(o)} is already being cancelled; nothing was sent`;
    }
  }

  /**
   * The order a cancel is for, as the list showed it (`ref`): by permId first, then by client id
   * + order id. Refused, sending nothing, when the order found disagrees with the list (another
   * order now has these ids) or Tape cannot cancel it (cancelBlock). Null for an order this client
   * has sent and IB has not reported back yet (its id is this client's).
   */
  function cancelTarget(ref: OrderRef): WorkingOrder | null {
    if (!Number.isSafeInteger(ref.orderId) || !Number.isSafeInteger(ref.clientId)) throw new Error(`Order #${ref.orderId} cannot be cancelled from Tape`);
    const byPerm = ref.permId ? findByPermId(ref.permId)?.[1] : undefined;
    const row = byPerm ?? (ref.orderId ? orders.get(orderKey(ref.clientId, ref.orderId, undefined)) : undefined);
    if (!row) {
      if (ref.orderId === 0) throw new Error(blockMessage({ orderId: 0, permId: ref.permId } as WorkingOrder, 'manual'));
      if (ref.clientId === myClientId() && sentKeys.has(orderKey(ref.clientId, ref.orderId, undefined))) return null;
      throw new Error(`Order #${ref.orderId} was not found`);
    }
    const differs =
      row.clientId !== ref.clientId ||
      row.orderId !== ref.orderId ||
      (ref.permId != null && row.permId != null && row.permId !== ref.permId) ||
      (ref.account != null && row.account != null && row.account !== ref.account);
    if (differs) throw new Error(STALE_ORDER_MESSAGE);
    const block = cancelBlock(row, ctx.ib.getState());
    if (block) throw new Error(blockMessage(row, block));
    return row;
  }

  /** This client's confirmed, still working order `orderId` that IB still lists (see ownOrder). */
  function modifiable(orderId: number): WorkingOrder {
    const existing = ownOrder(orderId, 'modify');
    if (!existing) throw new Error(`Order #${orderId} has not been confirmed by IB yet`);
    if (!isOrderActive(existing.status)) throw new Error(`Order #${orderId} is ${existing.status} and can no longer be modified`);
    // IB's last full list left it out: it has ended, IB has not said how yet (see sweep).
    if (existing.notReported) throw new Error(blockMessage(existing, 'notReported'));
    return existing;
  }

  /** IB keeps a working order in its session (see the header); a request for another one fails here. */
  function checkSession(existing: WorkingOrder, req: OrderRequest): void {
    if (sessionOf(existing) === sessionOf(req)) return;
    throw new Error(`Order #${existing.orderId} cannot move to another trading session (IB refuses it); cancel it and place a new order`);
  }

  /** IB changes a working order's TIF only between DAY and GTC, or to IOC (see the header). */
  function checkTif(existing: WorkingOrder, req: OrderRequest): void {
    if (tifChangeAllowed(existing.tif, req.tif)) return;
    throw new Error(`Order #${existing.orderId} cannot change its time in force from ${existing.tif} to ${req.tif} (IB refuses it); cancel it and place a new order`);
  }

  /** The changes IB refuses or ignores on a working order (see the header). */
  function checkChanges(existing: WorkingOrder, req: OrderRequest): void {
    const [problem] = modifyProblems(existing, req);
    if (problem) throw new Error(`Order #${existing.orderId} ${MODIFY_PROBLEM_TEXT[problem]} (IB refuses it); cancel it and place a new order`);
  }

  async function modify(orderId: number, input: OrderRequest, reviewed?: number): Promise<ModifyOrderResult> {
    requireUnlocked();
    requireSession(reviewed);
    const checked = requireApi();
    requireIbLink();
    const clientId = myClientId();
    const session = sessionNow();
    const current = modifiable(orderId);
    // IB replaces the whole order: attributes the request leaves out keep the order's own.
    const full = withOrderAttributes({ ...input, bracket: undefined }, current);
    checkSession(current, full);
    checkTif(current, full);
    checkChanges(current, full);
    const { req, conditionConIds, rules } = await prepare(full);
    // While the contract was resolved, the connection may have changed (the order id would name
    // another client's or account's order, or a new one) and the order may have been filled or cancelled.
    const api = sameSession(checked, clientId, session);
    requireIbLink();
    const existing = modifiable(orderId);
    const [main] = buildOrders(req, {
      orderId,
      nextOrderId: () => {
        throw new Error('Brackets cannot be added when modifying an order');
      },
      account: existing.account ?? ctx.ib.getState().account,
      conditionConIds,
      rules,
      parentId: existing.parentId,
    });
    const keptGoodAfter = sameGoodAfter(existing.goodAfterTime, req.goodAfterTime);
    if (keptGoodAfter) main.order.goodAfterTime = keptGoodAfter;
    // IB answers a modify it refuses with the unchanged order first and its reason (201) right
    // after: an echo still showing the old value of a field this modify changes is not the answer,
    // nor is the order as a list of open orders shows it (a reconnect, Cancel all) unless it shows
    // the change.
    const echo = modifyEcho(existing, main.order);
    let applied = false;
    const wait = awaitOrders([orderId], ACK_MS, {
      failInactive: true,
      accept: (o, round) => {
        if (echo.stale(o) || (round && !echo.applied(o))) return false;
        applied = echo.applied(o);
        return true;
      },
    });
    const key = orderKey(clientId, orderId, undefined);
    orderErrors.delete(key);
    const order = sessionOf(req) === 'overnight' ? { ...main.order, tif: '' as Order['tif'] } : main.order;
    const echoed = echoes.get(key) ?? 0;
    const writes = watchWrites(OUT_MSG_ID.PLACE_ORDER, [orderId]);
    api.placeOrder(orderId, main.contract, order);
    let confirmed: boolean;
    try {
      confirmed = await wait.done;
      // An echo that cannot show the change (only an attribute changed) may still be followed by
      // IB's refusal: wait a moment for it.
      if (confirmed && !applied) await awaitOrders([orderId], MODIFY_REFUSAL_WAIT_MS, { accept: () => false }).done;
    } catch (err) {
      if (err instanceof OrderRefused || !(err instanceof Error) || err.message !== CLOSED_MESSAGE) throw err;
      throw new Error(
        writes.written.size
          ? `The connection closed before IB confirmed the modify of order #${orderId}: it may have changed. Check it in Orders after reconnecting`
          : `The connection closed before the modify was sent; order #${orderId} is unchanged`,
      );
    } finally {
      writes.stop();
    }
    if (confirmed) return { confirmed };
    // IB sends no openOrder back for some modifies (MOC / LOC); this client's open orders show the
    // change. Client 0 asks for every client's: its reqOpenOrders would bind TWS orders to it.
    const answered = (echoes.get(key) ?? 0) !== echoed;
    if (!answered && ctx.ib.api === api && ctx.ib.isConnected()) requestOpenOrders({ kind: clientId === 0 ? 'all' : 'own' }, api);
    // Sent, not confirmed: IB's refusal within LATE_REFUSAL_MS is still announced.
    watchLate({ verb: 'modify', req, ids: [orderId], session, account: existing.account, existing, echo }, clientId, [orderId]);
    return { confirmed };
  }

  /** IB's margin and commission estimate of a request (whatIf); see the header. */
  async function preview(input: OrderRequest, reviewed?: number): Promise<OrderPreview> {
    requireUnlocked();
    requireSession(reviewed);
    requireApi();
    // Margin is the account's: another account's answer is never reused (the cache is also
    // emptied when the socket closes, see onClosed).
    const session = sessionNow();
    const key = `${myClientId()}|${ctx.ib.getState().account ?? ''}|${JSON.stringify({ ...input, bracket: undefined })}`;
    const now = Date.now();
    for (const [k, v] of previewCache) if (now - v.at > PREVIEW_REUSE_MS) previewCache.delete(k);
    const cached = previewCache.get(key);
    if (cached) return cached.result;
    const result = previewChain.then(() => sendPreview(input, session));
    previewChain = result.catch(() => undefined);
    previewCache.set(key, { at: now, result });
    // A failed preview is not reused; a newer entry under the same key (the cache was emptied
    // meanwhile) stays.
    result.catch(() => {
      if (previewCache.get(key)?.result === result) previewCache.delete(key);
    });
    return result;
  }

  async function sendPreview(input: OrderRequest, session: number): Promise<OrderPreview> {
    requireUnlocked();
    // Queued behind other previews: the session it was asked on may have ended meanwhile.
    requireSession(session);
    const checked = requireApi();
    const clientId = myClientId();
    const { req, conditionConIds, rules } = await prepare({ ...input, bracket: undefined });
    const api = sameSession(checked, clientId, session);
    const orderId = ctx.ib.nextOrderId();
    const built = buildPreviewOrder(req, { orderId, account: ctx.ib.getState().account, conditionConIds, rules });
    // Fail closed: an order that is not a what-if one would be placed for real.
    if (built.order.whatIf !== true || built.order.parentId) throw new Error('Internal error: a preview must be a what-if order; nothing was sent');
    return new Promise<OrderPreview>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        const settle = previews.get(orderId)?.settle;
        if (settle) clearTimeout(settle);
        previews.delete(orderId);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(PREVIEW_TIMEOUT_MESSAGE));
      }, PREVIEW_TIMEOUT_MS);
      previews.set(orderId, {
        resolve: (p) => {
          done();
          resolve(p);
        },
        reject: (err) => {
          done();
          reject(err);
        },
      });
      api.placeOrder(orderId, built.contract, built.order);
    });
  }

  /**
   * Cancels the order the list showed (see cancelTarget). Resolves 'Cancelled' once IB has cancelled
   * it (or answered 202), else after CANCEL_ACK_MS 'PendingCancel' (IB has the cancel) or 'sent'
   * (no answer): never a silent success. A refusal then is announced (lateRefusal).
   */
  async function cancel(ref: OrderRef, reviewed?: number): Promise<CancelResult> {
    requireUnlocked();
    requireSession(reviewed);
    const api = requireApi();
    cancelTarget(ref);
    const { orderId } = ref;
    const key = orderKey(myClientId(), orderId, undefined);
    if (cancelWaits.has(key)) throw new Error(`Order #${orderId} is already being cancelled; nothing was sent`);
    let pending = false;
    const wait = awaitOrders([orderId], CANCEL_ACK_MS, {
      accept: (o) => {
        if (o.status === 'PendingCancel') pending = true;
        return o.status === 'Cancelled' || o.status === 'ApiCancelled';
      },
    });
    cancelWaits.set(key, wait.answer);
    const writes = watchWrites(OUT_MSG_ID.CANCEL_ORDER, [orderId]);
    let cancelled: boolean;
    try {
      api.cancelOrder(orderId);
      cancelled = await wait.done;
    } catch (err) {
      if (err instanceof OrderRefused || !(err instanceof Error) || err.message !== CLOSED_MESSAGE) throw err;
      // The socket closed: a cancel still held by the client never reached IB; one written may have.
      if (!writes.written.size) throw new Error('The connection closed before the cancel was sent; nothing reached IB');
      cancelled = false;
    } finally {
      cancelWaits.delete(key);
      writes.stop();
    }
    if (cancelled) return { status: 'Cancelled' };
    trackCancel(key);
    return { status: pending ? 'PendingCancel' : 'sent' };
  }

  /** The orders Cancel all lists and IB's global cancel reaches: active ones of the login's accounts that IB still reports. */
  function cancellableAll(accounts: readonly string[]): WorkingOrder[] {
    return [...orders.values()].filter((o) => isOrderActive(o.status) && !o.notReported && (!o.account || accounts.includes(o.account)));
  }

  /** Refuses Cancel all, sending nothing, unless the active orders are exactly the ones the user confirmed (by permId). */
  function checkCancelAll(expect: CancelAllExpect): void {
    const active = cancellableAll(ctx.ib.getState().accounts);
    if (!active.length) throw new Error('No open orders to cancel; nothing was sent');
    const listed = new Set(expect.permIds);
    const same = listed.size === expect.permIds.length && active.length === listed.size && active.every((o) => o.permId != null && listed.has(o.permId));
    if (!same) throw new Error(ORDER_LIST_CHANGED_MESSAGE);
  }

  /**
   * IB's global cancel (reqGlobalCancel): every open order of every account of the login, whichever
   * app placed it. Sent only when the account and the active orders (by permId) are the ones the
   * user confirmed, on that session: checked against Tape's list, then against IB's full list of
   * open orders, asked right before (other apps' orders reach this client only through such a list;
   * one placed elsewhere in the moment between its end and the cancel is still reached). The lists
   * are asked again after the cancel, and the result waits until IB's completed orders said how the
   * orders it left out ended (or CANCEL_ALL_WAIT_MS): how many of the confirmed orders IB cancelled,
   * how many filled, how many it no longer lists without saying how, and how many still work.
   */
  async function cancelAll(expect: CancelAllExpect): Promise<CancelAllResult> {
    requireUnlocked();
    requireSession(expect.session);
    const api = requireApi();
    const { accounts } = ctx.ib.getState();
    if (!accounts.includes(expect.account)) throw new Error(`Account ${expect.account} is not connected; nothing was sent`);
    checkCancelAll(expect);
    if (cancellingAll) throw new Error('Cancel all is already waiting for IB; nothing more was sent');
    cancellingAll = true;
    const session = sessionNow();
    try {
      const listed = await new Promise<boolean>((resolve) => requestLists(api, resolve));
      // Tape may have locked, or moved to another login, while IB listed its orders.
      requireUnlocked();
      requireSession(session);
      if (!listed || ctx.ib.api !== api || !ctx.ib.isConnected()) throw new Error(CANCEL_ALL_NO_LIST_MESSAGE);
      checkCancelAll(expect);
      api.reqGlobalCancel();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(settle);
          clearTimeout(limit);
          resolve();
        };
        const limit = setTimeout(done, CANCEL_ALL_WAIT_MS);
        const settle = setTimeout(() => {
          if (ctx.ib.api !== api || sessionNow() !== session) return;
          // The orders the list leaves out have ended: the count waits for IB to say how (settleVanished).
          const waitForOutcomes = (answered: boolean) => answered && expect.permIds.some((id) => findByPermId(id)?.[1].notReported);
          // The completed orders are asked whatever an earlier 321 said: the outcomes depend on them.
          requestLists(api, (answered) => (waitForOutcomes(answered) ? afterSettle.push(done) : done()), true);
        }, CANCEL_ALL_SETTLE_MS);
      });
      if (sessionNow() !== session || !ctx.ib.isConnected()) throw new Error(CANCEL_ALL_UNCONFIRMED_MESSAGE);
      const result: CancelAllResult = { requested: expect.permIds.length, cancelled: 0, filled: 0, unknown: 0, stillWorking: 0 };
      for (const permId of expect.permIds) {
        const o = findByPermId(permId)?.[1];
        // Gone from IB's lists without IB saying how: never counted as cancelled.
        if (!o || o.notReported) result.unknown++;
        else if (o.status === 'Cancelled' || o.status === 'ApiCancelled') result.cancelled++;
        else if (o.status === 'Filled') result.filled++;
        else if (isOrderActive(o.status)) result.stillWorking++;
        else result.unknown++;
      }
      // Still working (PendingCancel, say): IB's lists once more a moment later, as other apps' orders get no updates.
      if (result.stillWorking) setTimeout(() => sessionNow() === session && refreshLists(api), CANCEL_ALL_RECHECK_MS);
      return result;
    } finally {
      cancellingAll = false;
    }
  }

  /** IB's lists of open and completed orders again (Portfolio › Orders, Cancel all; see refreshLists). */
  async function refreshOrders(): Promise<void> {
    refreshLists(requireApi());
  }

  async function refreshExecutions(): Promise<void> {
    const api = requireApi();
    execReqId = ctx.ib.nextReqId();
    api.reqExecutions(execReqId, {});
  }

  // ---------------------------------------------------------------------------
  // Wiring

  function onReady(api: IBApi): void {
    // Client 0 can bind orders entered in TWS so they can be modified and cancelled here.
    if (myClientId() === 0) api.reqAutoOpenOrders(true);
    // Every client's open orders; at their end, those IB no longer lists are swept (see sweep), and
    // the completed orders IB answers next say how they ended.
    requestOpenOrders({ kind: 'all', sweep: 'reconnect' }, api);
    api.reqCompletedOrders(false);
    execReqId = ctx.ib.nextReqId();
    api.reqExecutions(execReqId, {});
    // Then again while connected: of other apps' and clients' orders nothing else comes.
    stopRefresh();
    refreshTimer = setInterval(() => refreshLists(api), ORDERS_REFRESH_MS);
  }

  /** Requests still waiting for IB get no answer on a socket that has closed. */
  function failWaiting(): void {
    for (const w of [...waiters]) w.reject(new Error(CLOSED_MESSAGE));
    for (const p of [...previews.values()]) p.reject(new Error(CLOSED_MESSAGE));
  }

  function onClosed(): void {
    stopRefresh();
    failWaiting();
    // The next session may be another account (a port change): its margin is not this one's.
    previewCache.clear();
    symbolLookups.clear();
    symbolsRequested.clear();
    // The closed socket answers none of its open-orders requests.
    clearOpenRequests();
  }

  /**
   * Tape moved to another Gateway, client id or account (see the header): the previous session's
   * orders, fills and notice state go at once, and the renderer gets the empty lists before
   * anything of the new session. Instrument facts (symbols, SMART routing) stay.
   */
  function resetSession(): void {
    // Notices still owed for the previous session (a fill waiting for its commission, a rejection
    // for IB's reason) describe real events on that account: given now, not dropped, and named by
    // their own account only (the connection's is the new one).
    flushingOwed = true;
    try {
      for (const base of [...pendingFills.keys()]) announceFill(base);
      for (const key of [...pendingRejections.keys()]) announceRejection(key);
    } finally {
      flushingOwed = false;
    }
    // onClosed has failed them already; nothing of that session may answer them now.
    failWaiting();
    for (const m of [orders, keyByPermId, earlyStatus, executions, execAvgPrice, commissions, notified, orderErrors, echoes, previewCache, brackets, legOutcomes, cancelWaits]) m.clear();
    sentKeys.clear();
    sentOrders.clear();
    heldNoticed.clear();
    rejectionNoticed.clear();
    completedFills.clear();
    // What was watched for the previous login goes without a word: its ids name other orders now.
    for (const late of new Set(lateRequests.values())) clearTimeout(late.timer);
    lateRequests.clear();
    for (const timer of cancelsInFlight.values()) clearTimeout(timer);
    cancelsInFlight.clear();
    vanished.clear();
    if (vanishedTimer) clearTimeout(vanishedTimer);
    vanishedTimer = null;
    stopRefresh();
    clearOpenRequests();
    // The new account's open orders and today's fills are its first load, not news.
    ordersLoaded = executionsLoaded = false;
    execReqId = -1;
    if (emitTimer) clearTimeout(emitTimer);
    dirtyOrders = dirtyExecutions = true;
    flush();
  }

  setImmediate(() => {
    const ib = ctx.ib;
    ib.onReady(onReady);
    ib.onClosed(onClosed);
    ib.onSessionChange(resetSession);
    ib.onRequestError(onRequestError);
    ib.on(EventName.openOrder, onOpenOrder);
    ib.on(EventName.orderStatus, onOrderStatus);
    ib.on(EventName.openOrderEnd, () => {
      // The first load is this session's first full list. IB opens every connection with this
      // client's own open orders and an openOrderEnd of its own, before Tape asks for anything (live:
      // order 40 of client 7, then the end, 0.6 s before reqAllOpenOrders' answer): that end leaves
      // out other apps' orders (IBKR Mobile's, order id 0), which would otherwise be announced as
      // submitted on every connect.
      if (openRequest?.kind === 'all') ordersLoaded = true;
      endOpenRequest(true);
    });
    ib.on(EventName.completedOrder, onCompletedOrder);
    // How the swept orders ended has been said (completedOrder); the rest are announced now.
    ib.on(EventName.completedOrdersEnd, settleVanished);
    ib.on(EventName.execDetails, onExecDetails);
    ib.on(EventName.execDetailsEnd, (reqId: number) => {
      if (reqId === execReqId) executionsLoaded = true;
    });
    ib.on(EventName.commissionReport, onCommissionReport);
    ib.on(EventName.contractDetails, (reqId: number, details: ContractDetails) => {
      const conId = symbolLookups.get(reqId);
      if (conId == null) return;
      symbolLookups.delete(reqId);
      const symbol = details?.contract?.symbol;
      if (!symbol) return;
      symbols.set(conId, symbol);
      for (const [key, o] of orders) {
        const named = (c: ContractRef) => (c.conId === conId && c.symbol === String(conId) ? { ...c, symbol } : c);
        const conditions = o.conditions && { ...o.conditions, items: o.conditions.items.map((c) => ('contract' in c ? { ...c, contract: named(c.contract) } : c)) };
        const condition = o.condition?.symbol === String(conId) ? { ...o.condition, symbol } : o.condition;
        if (condition !== o.condition || JSON.stringify(conditions) !== JSON.stringify(o.conditions)) orders.set(key, { ...o, condition, conditions } as WorkingOrder);
      }
      markDirty(true, false);
    });
  });

  return {
    getOrders: orderList,
    getExecutions: executionList,
    place,
    modify,
    preview,
    cancel,
    cancelAll,
    refreshOrders,
    refreshExecutions,
  };
}
