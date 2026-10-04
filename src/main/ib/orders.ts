// Order service: working and finished orders of all clients, executions with commissions,
// placing / modifying / cancelling orders, and fill and order-status notifications.
//
// On every handshake: reqAllOpenOrders (orders of every client, including TWS), reqCompletedOrders
// (today's finished orders) and reqExecutions (today's fills). Orders placed by this client then
// stream openOrder / orderStatus / execDetails / commissionReport updates.
//
// Orders are keyed by client id + order id (order ids are per API client). modify / cancel take
// an order id and act only on orders of the connected client id; other clients' orders (TWS is
// client 0) can only be cancelled with cancelAll (reqGlobalCancel).
//
// Tape has no read-only switch of its own: with "Read-Only API" on in TWS / IB Gateway, IB rejects
// orders with error 321, which reaches the caller (and the rejection notification) as IB's message.
//
// A working order keeps its trading session: IB refuses to move it to the OVERNIGHT venue (105)
// or to add includeOvernight (462), so modify() refuses a request with another session. Its TIF
// changes only between DAY and GTC, or to IOC (462 otherwise, see tifChangeAllowed).
//
// IB rejects some orders after taking them: an Inactive openOrder, then the reason (201). place()
// and modify() fail with that reason instead of resolving on the Inactive order, and the rejection
// notice waits for it.
//
// Every execution (with its commission) is written to the database's execution journal; on start
// today's journaled fills are restored, since IB may not resend them after a Gateway restart.
// Restored fills of accounts the connected login does not have are dropped on the handshake.

import { EventName, type CommissionReport, type Contract, type ContractDetails, type Execution as IbExecution, type IBApi, type Order, type OrderState } from './tws';
import { contractLabel } from '@shared/contract';
import { sessionOf, tifChangeAllowed } from '@shared/orderTiming';
import { nyClock } from '@shared/session';
import { isOrderActive, type ContractRef, type Execution, type OrderRequest, type PlaceOrderResult, type WorkingOrder } from '@shared/types';
import { LOCKED_MESSAGE } from '@shared/ipc';
import type { MainContext, OrderService } from '../context';
import { cleanIbMessage, isErrorCode } from './errorCodes';
import { num } from './ibContract';
import { buildOrders, validateOrderRequest } from './orderBuilder';
import {
  applyOrderStatus,
  execBaseId,
  fillNotice,
  mapCompletedOrder,
  mapExecution,
  mapOpenOrder,
  orderKey,
  orderNotice,
  type NoticeOrder,
  type NoticeText,
  type StatusUpdate,
} from './orderMapping';

/** How long place / modify wait for IB to accept or reject an order. */
const ACK_MS = 2_000;
const CANCEL_ACK_MS = 1_500;
/** How long a rejection notice waits for IB's reason, which follows the Inactive openOrder. */
const REJECT_REASON_WAIT_MS = 1_000;
/** A fill is announced when its commission report arrives, or after this delay without one. */
const FILL_NOTICE_WAIT_MS = 3_000;
const EMIT_MS = 100;
const CONTRACT_LOOKUP_TIMEOUT_MS = 10_000;

export const NOT_CONNECTED_MESSAGE = 'Not connected to TWS / IB Gateway';
export const CONNECTION_CHANGED_MESSAGE = 'The connection changed while the order was being prepared; nothing was sent';

interface Waiter {
  ids: Set<number>;
  acked: Set<number>;
  /** True when this update settles the wait for its order. */
  accept(o: WorkingOrder): boolean;
  /** An Inactive order fails the wait (place / modify): with IB's error, or when the wait runs out. */
  failInactive: boolean;
  /** Orders IB reported as Inactive while waiting. */
  inactive: Set<number>;
  resolve(): void;
  reject(err: Error): void;
}

/**
 * Start of the current New York calendar day (unix ms), the "today" of the executions list.
 * On daylight saving changes it is off by an hour, which only widens the window.
 */
function nyDayStart(now: number): number {
  return now - nyClock(new Date(now)).minutes * 60_000 - (now % 60_000);
}

/** Order errors that do not mean the order was rejected. */
const isOrderWarning = (code: number, message: string) => !isErrorCode(code) || /warning/i.test(message);

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
  const symbolLookups = new Map<number, number>(); // reqId -> conId
  const symbolsRequested = new Set<number>();

  /** Keys of orders this client sent and IB has not reported back yet (see ownOrder). */
  const sentKeys = new Set<string>();

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

  /** Executions (by base id) to write to the journal, and the JSON last written per base id. */
  const journalDirty = new Set<string>();
  const journaled = new Map<string, string>();
  /** Base ids of executions restored from the journal that IB has not sent in this session. */
  const restored = new Set<string>();

  /** Notifications start after the first complete load (openOrderEnd / execDetailsEnd). */
  let ordersLoaded = false;
  let executionsLoaded = false;
  let execReqId = -1;

  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let dirtyOrders = false;
  let dirtyExecutions = false;

  const myClientId = () => ctx.ib.getState().clientId;

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
    writeJournal();
  }

  // ---------------------------------------------------------------------------
  // Execution journal (partial contexts in unit tests have no database)

  function journal(base: string): void {
    journalDirty.add(base);
    markDirty(false, true);
  }

  /** Writes changed executions in one call (IB resends the whole day on every reconnect). */
  function writeJournal(): void {
    if (!journalDirty.size) return;
    const changed: Execution[] = [];
    for (const base of journalDirty) {
      const e = executions.get(base);
      const json = e && JSON.stringify(e);
      if (!e || !json || journaled.get(base) === json) continue;
      journaled.set(base, json);
      changed.push(e);
    }
    journalDirty.clear();
    if (changed.length) void ctx.db?.executions.put(changed);
  }

  /** Restores today's journaled fills that IB has not (re)sent; IB's own data always wins. */
  async function restoreJournal(): Promise<void> {
    const db = ctx.db as MainContext['db'] | undefined;
    if (!db) return;
    const latest = new Map<string, Execution>();
    for (const e of await db.executions.since(nyDayStart(Date.now()))) {
      const base = execBaseId(e.execId);
      const cur = latest.get(base);
      // A correction (".01" -> ".02") replaces the original.
      if (!cur || e.execId > cur.execId) latest.set(base, e);
    }
    let changed = false;
    for (const [base, e] of latest) {
      if (executions.has(base) || !ofThisLogin(e)) continue;
      executions.set(base, e);
      journaled.set(base, JSON.stringify(e));
      restored.add(base);
      changed = true;
    }
    if (changed) markDirty(false, true);
  }

  /**
   * Whether an execution belongs to the connected login. The journal holds every account traded
   * today (e.g. paper earlier, live now), IB reports only the login's own; before the first
   * handshake the accounts are unknown and everything is kept.
   */
  function ofThisLogin(e: Execution): boolean {
    const { accounts, account } = ctx.ib.getState();
    const known = accounts.length ? accounts : account ? [account] : [];
    return !e.account || !known.length || known.includes(e.account);
  }

  /** Drops restored executions of other logins (called once the handshake named the accounts). */
  function dropForeignRestored(): void {
    let dropped = false;
    for (const base of restored) {
      const e = executions.get(base);
      if (e && ofThisLogin(e)) continue;
      executions.delete(base);
      journaled.delete(base);
      restored.delete(base);
      dropped = true;
    }
    if (dropped) markDirty(false, true);
  }

  function notify(n: NoticeText, contract: ContractRef, kind: 'fill' | 'order'): void {
    try {
      ctx.notifier.notify({ kind, title: n.title, body: n.body, contract });
    } catch (err) {
      console.error('[orders] notification failed:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Condition symbols (price conditions only carry a conId)

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

  function store(key: string, prev: WorkingOrder | undefined, next: WorkingOrder, opts: { prevKey?: string; snapshot?: boolean } = {}): void {
    if (opts.prevKey && opts.prevKey !== key) orders.delete(opts.prevKey);
    orders.set(key, next);
    sentKeys.delete(key);
    if (next.permId) keyByPermId.set(next.permId, key);
    markDirty(true, false);
    announce(key, prev, next, !!opts.snapshot);
    settleWaiters(next);
  }

  function findByPermId(permId: number | undefined): [string, WorkingOrder] | undefined {
    const key = permId ? keyByPermId.get(permId) : undefined;
    const o = key ? orders.get(key) : undefined;
    return key && o ? [key, o] : undefined;
  }

  function onOpenOrder(orderId: number, contract: Contract, order: Order, state: OrderState): void {
    const key = orderKey(order.clientId, orderId, order.permId);
    const byPerm = findByPermId(order.permId);
    const prevKey = orders.has(key) ? key : byPerm?.[0];
    const prev = prevKey ? orders.get(prevKey) : undefined;
    rememberSymbol(contract);
    let next = mapOpenOrder(orderId, contract, order, state, prev, Date.now(), symbolOf);
    const early = earlyStatus.get(key);
    if (early) {
      earlyStatus.delete(key);
      next = applyOrderStatus(next, early, Date.now());
    }
    store(key, prev, next, { prevKey });
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
    const update: StatusUpdate = { status, filled, remaining, avgFillPrice, permId, parentId, whyHeld };
    const key = orderKey(clientId ?? myClientId(), orderId, permId);
    const found = orders.has(key) ? ([key, orders.get(key)!] as const) : findByPermId(permId);
    if (!found) {
      earlyStatus.set(key, update);
      return;
    }
    const [k, prev] = found;
    store(k, prev, applyOrderStatus(prev, update, Date.now()));
  }

  function onCompletedOrder(contract: Contract, order: Order, state: OrderState): void {
    const found = findByPermId(order.permId);
    const key = found?.[0] ?? orderKey(order.clientId, order.orderId, order.permId);
    const prev = found?.[1] ?? orders.get(key);
    rememberSymbol(contract);
    const next = mapCompletedOrder(contract, order, state, prev, Date.now(), symbolOf);
    // reqCompletedOrders is a snapshot of the day: record the state, announce nothing.
    store(key, prev, next, { snapshot: true });
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
    notify(orderNotice(next, kind), next.contract, 'order');
  }

  /** The rejection notice of an order, with IB's reason when it has arrived. */
  function announceRejection(key: string): void {
    clearTimeout(pendingRejections.get(key));
    pendingRejections.delete(key);
    const o = orders.get(key);
    if (o) notify(orderNotice(o, 'rejected', orderErrors.get(key) ?? o.message), o.contract, 'order');
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
    restored.delete(base);
    const avg = num(exec.avgPrice);
    if (avg) execAvgPrice.set(base, avg);
    rememberSymbol(contract);
    journal(base);
    // Fills after the first load are new: live ones (reqId -1) and those found on reconnect.
    if (executionsLoaded && !prev) scheduleFillNotice(base);
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
    if (e) notify(fillNotice(e, execAvgPrice.get(base), e.commission), e.contract, 'fill');
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
      journal(base);
    }
    if (pendingFills.has(base)) announceFill(base);
  }

  // ---------------------------------------------------------------------------
  // Waiting for IB to accept, reject or cancel an order

  function awaitOrders(ids: number[], timeoutMs: number, { accept = () => true, failInactive = false }: { accept?: (o: WorkingOrder) => boolean; failInactive?: boolean } = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(w);
      };
      const w: Waiter = {
        ids: new Set(ids),
        acked: new Set(),
        accept,
        failInactive,
        inactive: new Set(),
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      // No answer in time: the order was sent; its updates will still arrive. An order IB set
      // Inactive without giving a reason (yet) was not accepted.
      const timer = setTimeout(() => {
        const [inactive] = w.inactive;
        if (inactive == null) w.resolve();
        else w.reject(new Error(`IB did not accept order #${inactive} (Inactive)`));
      }, timeoutMs);
      waiters.add(w);
    });
  }

  function settleWaiters(o: WorkingOrder): void {
    if (o.clientId !== myClientId()) return;
    for (const w of [...waiters]) {
      if (!w.ids.has(o.orderId)) continue;
      // IB's reason (201) follows the Inactive openOrder and fails the wait (onRequestError).
      if (w.failInactive && o.status === 'Inactive') {
        w.inactive.add(o.orderId);
        continue;
      }
      if (!w.accept(o)) continue;
      w.inactive.delete(o.orderId);
      w.acked.add(o.orderId);
      if (w.acked.size === w.ids.size) w.resolve();
    }
  }

  function onRequestError(e: { reqId: number; code: number; message: string }): void {
    const message = cleanIbMessage(e.message);
    const warning = isOrderWarning(e.code, e.message);
    // Only orders of this client have errors with their id.
    const key = orderKey(myClientId(), e.reqId, undefined);
    if (!warning) {
      for (const w of [...waiters]) if (w.ids.has(e.reqId)) w.reject(new Error(`${message} (${e.code})`));
      // The reason of a rejection, which may also arrive before IB reports the order.
      if (orders.has(key) || sentKeys.has(key)) orderErrors.set(key, `${message} (${e.code})`);
    }
    // Attach the text to the order.
    const o = orders.get(key);
    if (o && e.code !== 202) {
      orders.set(key, { ...o, message, updatedAt: Date.now() });
      markDirty(true, false);
    }
    if (!warning && pendingRejections.has(key)) announceRejection(key);
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
   * The API instance to send an order on, after an `await`: still the session the order was
   * checked against. Another client id or Gateway (a new instance) would take the order id for
   * a different order, so nothing is sent then.
   */
  function sameSession(api: IBApi, clientId: number): IBApi {
    requireUnlocked();
    const now = requireApi();
    if (now !== api || myClientId() !== clientId) throw new Error(CONNECTION_CHANGED_MESSAGE);
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

  async function prepare(req: OrderRequest): Promise<{ req: OrderRequest; conditionConId?: number }> {
    const problem = validateOrderRequest(req);
    if (problem) throw new Error(problem);
    let contract = await resolve(req.contract);
    if (sessionOf(req) === 'overnight') contract = await withPrimaryExchange(contract);
    rememberSymbol(contract);
    let conditionConId: number | undefined;
    if (req.condition) {
      const cond = req.condition.contract;
      const resolved = contract.conId && cond.symbol === contract.symbol && cond.secType === contract.secType ? contract : await resolve(cond);
      conditionConId = resolved.conId;
      rememberSymbol(resolved);
      if (!conditionConId) throw new Error(`Could not resolve ${contractLabel(cond)} for the price condition`);
    }
    return { req: { ...req, contract }, conditionConId };
  }

  /**
   * Announces a request IB refused, unless IB reported one of its orders as rejected (announce
   * does that one, with the same reason). Its orders IB has not reported are not announced again.
   */
  function rejected(req: OrderRequest, orderIds: number[], reason: string): void {
    const keys = orderIds.map((id) => orderKey(myClientId(), id, undefined));
    if (keys.some((k) => rejectionNoticed.has(k))) return;
    for (const k of keys) {
      rejectionNoticed.add(k);
      if (!orders.has(k)) notified.set(k, 'rejected');
    }
    const o: NoticeOrder = {
      contract: req.contract,
      action: req.action,
      totalQuantity: req.quantity,
      orderType: req.orderType,
      limitPrice: req.limitPrice,
      auxPrice: req.orderType === 'TRAIL' ? req.trailingAmount : req.stopPrice,
      trailingPercent: req.trailingPercent,
      tif: req.tif,
      session: sessionOf(req),
      goodTillDate: req.goodTillDate,
      filled: 0,
    };
    notify(orderNotice(o, 'rejected', reason), req.contract, 'order');
  }

  async function place(input: OrderRequest): Promise<PlaceOrderResult> {
    requireUnlocked();
    const checked = requireApi();
    const clientId = myClientId();
    const { req, conditionConId } = await prepare(input);
    // A Gateway or client id switched to meanwhile (perhaps another account) does not get it.
    const api = sameSession(checked, clientId);
    const orderId = ctx.ib.nextOrderId();
    const built = buildOrders(req, {
      orderId,
      nextOrderId: () => ctx.ib.nextOrderId(),
      account: ctx.ib.getState().account,
      conditionConId,
    });
    const ids = built.map((b) => b.orderId);
    const ack = awaitOrders(ids, ACK_MS, { failInactive: true });
    for (const b of built) {
      const key = orderKey(clientId, b.orderId, undefined);
      sentKeys.add(key);
      orderErrors.delete(key);
      api.placeOrder(b.orderId, b.contract, b.order);
    }
    try {
      await ack;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      rejected(req, ids, reason);
      throw err;
    }
    return { orderId, childOrderIds: built.slice(1).map((b) => b.orderId) };
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
    if (own) return own;
    if (sentKeys.has(key)) return null;
    const other = [...orders.values()].find((o) => o.orderId === orderId);
    if (other) throw new Error(foreignOrderMessage(other, verb));
    throw new Error(`Order #${orderId} was not found`);
  }

  function foreignOrderMessage(o: WorkingOrder, verb: 'modify' | 'cancel'): string {
    // TWS orders can be bound to an API session with client id 0 (reqAutoOpenOrders, see onReady).
    const owner = o.clientId === 0 ? `client 0 (TWS): only client id 0 can ${verb} it` : `API client ${o.clientId}: only that client can ${verb} it`;
    // reqGlobalCancel cancels the orders of every client.
    const hint = verb === 'cancel' ? '; Cancel all cancels every order of the account' : '';
    return `Order #${o.orderId} belongs to ${owner}${hint}`;
  }

  /** This client's confirmed, still working order `orderId` (see ownOrder). */
  function modifiable(orderId: number): WorkingOrder {
    const existing = ownOrder(orderId, 'modify');
    if (!existing) throw new Error(`Order #${orderId} has not been confirmed by IB yet`);
    if (!isOrderActive(existing.status)) throw new Error(`Order #${orderId} is ${existing.status} and can no longer be modified`);
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

  async function modify(orderId: number, input: OrderRequest): Promise<void> {
    requireUnlocked();
    const checked = requireApi();
    const clientId = myClientId();
    const current = modifiable(orderId);
    checkSession(current, input);
    checkTif(current, input);
    const { req, conditionConId } = await prepare({ ...input, bracket: undefined });
    // While the contract was resolved, the connection may have changed (the order id would name
    // another client's order, or a new one) and the order may have been filled or cancelled.
    const api = sameSession(checked, clientId);
    const existing = modifiable(orderId);
    const [main] = buildOrders(req, {
      orderId,
      nextOrderId: () => {
        throw new Error('Brackets cannot be added when modifying an order');
      },
      account: existing.account ?? ctx.ib.getState().account,
      conditionConId,
      parentId: existing.parentId,
    });
    const ack = awaitOrders([orderId], ACK_MS, { failInactive: true });
    orderErrors.delete(orderKey(clientId, orderId, undefined));
    api.placeOrder(orderId, main.contract, main.order);
    await ack;
  }

  async function cancel(orderId: number): Promise<void> {
    requireUnlocked();
    const api = requireApi();
    const existing = ownOrder(orderId, 'cancel');
    if (existing && !isOrderActive(existing.status)) throw new Error(`Order #${orderId} is already ${existing.status}`);
    const ack = awaitOrders([orderId], CANCEL_ACK_MS, { accept: (o) => o.status === 'PendingCancel' || o.status === 'Cancelled' || o.status === 'ApiCancelled' });
    api.cancelOrder(orderId);
    await ack;
  }

  async function cancelAll(): Promise<void> {
    requireUnlocked();
    requireApi().reqGlobalCancel();
  }

  async function refreshExecutions(): Promise<void> {
    const api = requireApi();
    execReqId = ctx.ib.nextReqId();
    api.reqExecutions(execReqId, {});
  }

  // ---------------------------------------------------------------------------
  // Wiring

  function onReady(api: IBApi): void {
    dropForeignRestored();
    // Client 0 can bind orders entered in TWS so they can be modified and cancelled here.
    if (myClientId() === 0) api.reqAutoOpenOrders(true);
    api.reqAllOpenOrders();
    api.reqCompletedOrders(false);
    execReqId = ctx.ib.nextReqId();
    api.reqExecutions(execReqId, {});
  }

  function onClosed(): void {
    for (const w of [...waiters]) w.reject(new Error('Connection to TWS / IB Gateway closed'));
    symbolLookups.clear();
    symbolsRequested.clear();
  }

  setImmediate(() => {
    restoreJournal().catch((err) => console.error('[orders] execution journal could not be read:', err));

    const ib = ctx.ib;
    ib.onReady(onReady);
    ib.onClosed(onClosed);
    ib.onRequestError(onRequestError);
    ib.on(EventName.openOrder, onOpenOrder);
    ib.on(EventName.orderStatus, onOrderStatus);
    ib.on(EventName.openOrderEnd, () => {
      ordersLoaded = true;
    });
    ib.on(EventName.completedOrder, onCompletedOrder);
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
        if (o.condition?.symbol === String(conId)) orders.set(key, { ...o, condition: { ...o.condition, symbol } });
      }
      markDirty(true, false);
    });
  });

  return {
    getOrders: orderList,
    getExecutions: executionList,
    place,
    modify,
    cancel,
    cancelAll,
    refreshExecutions,
  };
}
