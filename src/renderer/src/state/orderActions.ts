// Sending orders: the review dialog (every order, modify and strategy; no setting skips it),
// placement, cancellation (one order, why another app's order cannot be cancelled, Cancel all) and
// user feedback. IB's silence is never reported as success: an order or modify IB has not
// confirmed, or a cancel it has not, says so.

import { contractKey, contractLabel } from '@shared/contract';
import { f0, px } from '@shared/format';
import {
  CANCEL_ALL_NO_LIST_MESSAGE,
  CANCEL_ALL_UNCONFIRMED_MESSAGE,
  CONNECTION_CHANGED_MESSAGE,
  GATEWAY_UNRESPONSIVE_MESSAGE,
  IB_LINK_LOST_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  ORDER_LIST_CHANGED_MESSAGE,
  ORDER_NOT_SENT_MESSAGE,
  ORDER_UNCONFIRMED_MESSAGE,
  SESSION_CHANGED_MESSAGE,
  STALE_ORDER_MESSAGE,
} from '@shared/ipc';
import type { SourceBlock } from '@shared/orderOwnership';
import { timingText } from '@shared/orderTiming';
import { isOrderActive, type CancelAllExpect, type OrderRef, type WorkingOrder } from '@shared/types';
import { attributeFlags } from '../features/orders/attributes';
import { useOrdersMessages } from '../features/orders/messages';
import { orderPriceText, orderTypeLabel, sourceLabel } from '../features/orders/model';
import { hostAppName } from '../features/settings/logic';
import { currentClock } from '../i18n';
import { useCommon } from '../i18n/common';
import { accountRow, maskAccounts } from '../lib/account';
import { cancelKey, isCancelPending, ofConnectedAccounts } from '../lib/orders';
import { panelShown } from '../features/panels/actions';
import type { PanelId } from '../features/panels/model';
import { usePanels } from '../features/panels/panelStore';
import { useOrderFeedback } from './orderFeedback';
import { useStore, type ConfirmRow, type PendingOrder, type StoreState } from './store';

/** Strips Electron's IPC wrapper from error messages. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/**
 * IB's rejection while TWS / IB Gateway has "Read-Only API" on: "…in Read-Only mode. (321)" (a
 * bracket's error goes on with what happened to its other orders).
 */
const READ_ONLY_API_RE = /read[- ]only.*\(321\)/is;
/**
 * IB's 10329 for a directly routed order (the overnight-only session goes to OVERNIGHT) while the
 * API precautions hold such orders back: "This order will be directly routed to OVERNIGHT.
 * Restriction is specified in Precautionary Settings of Global Configuration/API. (10329)".
 */
const DIRECT_ROUTE_RE = /\(10329\)/;

/** Where a TWS / IB Gateway API settings page is, in the app Tape is connected to. */
export function apiSettingsPath(page: 'Settings' | 'Precautions'): string {
  const { connection, settings } = useStore.getState();
  // No-break spaces keep the app's name on one line in the toast.
  return hostAppName(connection.port, settings.connection.mode) === 'TWS'
    ? `TWS › Global\u00a0Configuration › API › ${page}`
    : `IB\u00a0Gateway › Configure › Settings › API › ${page}`;
}

/**
 * Main's fixed refusals (shared/ipc.ts) in the user's language; undefined for any other text (IB's
 * own, or one main builds with details).
 */
function refusalText(text: string): string | undefined {
  const m = useCommon.now();
  const app = () => {
    const { connection, settings } = useStore.getState();
    return hostAppName(connection.port, settings.connection.mode);
  };
  switch (text) {
    case NOT_CONNECTED_MESSAGE:
      return m.notConnected;
    case SESSION_CHANGED_MESSAGE:
      return m.refused.sessionChanged;
    case CONNECTION_CHANGED_MESSAGE:
      return m.refused.connectionChanged;
    case ORDER_NOT_SENT_MESSAGE:
      return m.refused.orderNotSent;
    case STALE_ORDER_MESSAGE:
      return m.refused.orderListStale;
    case ORDER_LIST_CHANGED_MESSAGE:
      return m.refused.orderListChanged;
    case CANCEL_ALL_NO_LIST_MESSAGE:
      return m.refused.cancelAllNoList;
    case CANCEL_ALL_UNCONFIRMED_MESSAGE:
      return m.cancelAllUnconfirmed;
    case IB_LINK_LOST_MESSAGE:
      return m.health.linkLostOrder(app());
    case GATEWAY_UNRESPONSIVE_MESSAGE:
      return m.health.unresponsiveOrder(app());
  }
  return undefined;
}

/**
 * Text of a failed order request: main's own refusals in the user's language. IB's Read-Only API
 * rejection (error 321) also says where to turn that option off, and its refusal of directly
 * routed orders (10329) where to allow them, in the app (TWS or IB Gateway) Tape is connected to.
 */
export function orderErrorText(err: unknown): string {
  const text = errorText(err);
  const refusal = refusalText(text);
  if (refusal) return refusal;
  if (READ_ONLY_API_RE.test(text)) return `${text} ${useCommon.now().readOnlyApiHint(apiSettingsPath('Settings'))}`;
  if (DIRECT_ROUTE_RE.test(text)) return `${text} ${useCommon.now().directRouteHint(apiSettingsPath('Precautions'))}`;
  return text;
}

/**
 * The warning of the order and cancel dialogs while IB has answered a request of this connection
 * with its Read-Only refusal (ConnectionState.readOnlyApi): IB refuses orders and cancels, and
 * where to turn it off. Nothing is refused on it (the user may have turned it off meanwhile).
 */
export function readOnlyWarning(): string | undefined {
  const { connection, settings } = useStore.getState();
  if (!connection.readOnlyApi || connection.status !== 'connected') return undefined;
  return useCommon.now().readOnlyApiOn(hostAppName(connection.port, settings.connection.mode), apiSettingsPath('Settings'));
}

/** What a text about TWS / IB Gateway's health is for (connectionHealthText). */
export type HealthUse = 'chip' | 'tip' | 'order' | 'review' | 'cancel';

/**
 * While TWS / IB Gateway cannot carry an order (ConnectionState.ibLinkLost: it lost its link to IB,
 * 1100; `unresponsive`: it does not answer the heartbeat), what that means for `use`: the top bar's
 * chip and its tooltip, an order refused before it is sent, the review's red line (its Confirm does
 * not arm meanwhile), the cancel dialog's warning (a cancel is still sent). Undefined while it can.
 */
export function connectionHealthText(use: HealthUse): string | undefined {
  const { connection, settings } = useStore.getState();
  if (connection.status !== 'connected' || !(connection.ibLinkLost || connection.unresponsive)) return undefined;
  const app = hostAppName(connection.port, settings.connection.mode);
  const h = useCommon.now().health;
  const lost = !!connection.ibLinkLost;
  switch (use) {
    case 'chip':
      return lost ? h.linkLostChip : h.unresponsiveChip(app);
    case 'tip':
      return (lost ? h.linkLostTip : h.unresponsiveTip)(app);
    case 'order':
      return (lost ? h.linkLostOrder : h.unresponsiveOrder)(app);
    case 'review':
      return (lost ? h.linkLostReview : h.unresponsiveReview)(app);
    case 'cancel':
      return (lost ? h.linkLostCancel : h.unresponsiveCancel)(app);
  }
}

/** How long after "Submitted" / "Modified" a rejection by IB still replaces that toast. */
const LATE_REJECTION_MS = 5_000;

/**
 * IB sometimes acknowledges an order (PreSubmitted) and rejects it half a second later (Inactive,
 * then the reason as error 201), after placeOrder / modifyOrder have resolved. For a few seconds
 * such a rejection replaces the success feedback with the failure and IB's reason.
 */
function watchLateRejection(orderIds: number[], onReject: (reason: string) => void): void {
  const { clientId, session } = useStore.getState().connection;
  const unsubscribe = useStore.subscribe((s, prev) => {
    // Another account or Gateway: these ids name its orders now.
    if (s.connection.session !== session) return stop();
    if (s.orders === prev.orders) return;
    const o = s.orders.find((x) => x.clientId === clientId && orderIds.includes(x.orderId) && x.status === 'Inactive');
    if (!o) return;
    stop();
    onReject(o.message || useCommon.now().orderInactive);
  });
  const timer = setTimeout(() => stop(), LATE_REJECTION_MS);
  function stop() {
    clearTimeout(timer);
    unsubscribe();
  }
}

/**
 * An order as the UI builds it: submitOrder binds it to the connection session it is submitted on
 * and names the account (paper or live) it goes to.
 */
export type OrderSubmission = Omit<PendingOrder, 'session' | 'account' | 'isPaper'> & Partial<Pick<PendingOrder, 'session' | 'account' | 'isPaper'>>;

/**
 * Entry point for every order the UI sends (the ticket, its ⏎, Modify, the strategy builder): it
 * always opens the review dialog, whose Confirm alone sends (sendOrder). The order is bound to the
 * current connection session, so it is never sent to another account or Gateway, and carries the
 * account and paper / live it was reviewed for. While not connected nothing opens (a toast says
 * so): nothing could be sent, and the review could not name the account.
 */
export function submitOrder(order: OrderSubmission): void {
  const s = useStore.getState();
  const { connection } = s;
  if (connection.status !== 'connected') {
    s.showToast(useCommon.now().notConnected, 'error');
    return;
  }
  const account = order.account ?? connection.account;
  s.setPendingOrder({ ...order, session: order.session ?? connection.session, ...(account ? { account } : {}), isPaper: order.isPaper ?? connection.isPaper });
}

/** The status strip's line: "Buy 100 AAPL · Limit 227.56 · DAY" / "买入 100 股 AAPL · 限价 227.56 · DAY". */
export function orderLine(p: Pick<PendingOrder, 'summary' | 'request'>): string {
  const r = p.request;
  const price = r.orderType === 'MKT' ? '' : r.limitPrice != null ? ` ${px(r.limitPrice)}` : r.stopPrice != null ? ` ${px(r.stopPrice)}` : '';
  return `${p.summary} · ${orderTypeLabel(r.orderType, useOrdersMessages.now())}${price} · ${r.tif}`;
}

/** Whether floating panel `id` is on screen now (floating, on its page and view), so its strip and bar can report. */
function panelOnScreen(id: PanelId): boolean {
  return usePanels.getState().panels[id].floating && panelShown(id, useStore.getState());
}

/**
 * Sends an order once the review's Confirm is pressed (OrderConfirmDialog; nothing else calls it).
 * It reports with toasts, or, sent from a floating
 * panel (`origin`, features/panels), with that panel's status strip and bar
 * (state/orderFeedback.ts): an accepted order collapses the panel to its bar, a rejection keeps it
 * expanded (and a late one expands it again) with the form as it was. When that panel is not on
 * screen when IB answers (docked back, another page or view), the toasts report as well, so no
 * answer goes unseen. A panel's second order while the first still waits for IB is not sent (its
 * button is disabled, and ⏎ must not send it twice). Nothing is sent either while TWS / IB Gateway
 * cannot carry it (connectionHealthText).
 */
export async function sendOrder(p: PendingOrder): Promise<boolean> {
  const s = useStore.getState();
  const m = useCommon.now();
  s.setPendingOrder(null);
  const panel = p.origin ?? null;
  const feedback = useOrderFeedback.getState();
  if (panel && feedback.sent[panel]?.phase === 'sending') return false;
  const key = contractKey(p.request.contract);
  const seq = panel
    ? feedback.begin(panel, {
        kind: p.modifyOrderId != null ? 'modify' : 'place',
        summary: orderLine(p),
        side: p.request.action,
        quantity: p.request.quantity,
        contractKey: key,
        // The account the review named (a modified order's own, which may not be the connected one).
        positionBefore: s.positions.find((x) => contractKey(x.contract) === key && (!p.account || !x.account || x.account === p.account))?.quantity ?? 0,
        ...(p.account ? { account: p.account } : {}),
        ...(p.modifyOrderId != null ? { orderId: p.modifyOrderId, clientId: s.connection.clientId } : {}),
      })
    : 0;
  /** Reported by a toast: the docked ticket, or a panel that is not on screen now. */
  const toast = () => !panel || !panelOnScreen(panel);
  const fail = (text: string) => {
    if (panel) useOrderFeedback.getState().update(panel, seq, { phase: 'failed', error: text });
    if (toast()) s.showToast(m.orderFailed(text), 'error');
  };
  const rejectedLater = (reason: string) => {
    if (toast()) s.showToast(m.orderFailed(reason), 'error');
    if (!panel) return;
    const cur = useOrderFeedback.getState().sent[panel];
    useOrderFeedback.getState().update(panel, seq, { phase: 'failed', error: reason });
    // A rejection is fixed in the expanded panel: one this order collapsed opens again.
    if (cur?.seq === seq && cur.autoCollapsed) usePanels.getState().setCollapsed(panel, false);
  };
  /** IB accepted it (`confirmed`), or it was sent and IB has not answered yet: a warning, not "Submitted". */
  const accepted = (orderId: number, text: string, confirmed: boolean) => {
    if (toast()) s.showToast(text, confirmed ? 'info' : 'warning');
    if (!panel) return;
    const panels = usePanels.getState();
    // The panel steps aside (the chart shows; the bar follows the fills) unless it is docked now.
    const collapse = panels.panels[panel].floating && !panels.panels[panel].collapsed;
    useOrderFeedback.getState().update(panel, seq, {
      phase: 'sent',
      orderId,
      clientId: useStore.getState().connection.clientId,
      acceptedAt: Date.now(),
      ...(collapse ? { autoCollapsed: true } : {}),
    });
    if (collapse) panels.setCollapsed(panel, true);
  };
  if (s.connection.status !== 'connected') {
    if (panel) useOrderFeedback.getState().update(panel, seq, { phase: 'failed', error: m.notConnected });
    if (toast()) s.showToast(m.notConnected, 'error');
    return false;
  }
  // Reviewed on another account or Gateway: never sent to this one (main refuses it too).
  if (p.session !== s.connection.session) {
    if (panel) useOrderFeedback.getState().update(panel, seq, { phase: 'failed', error: m.sessionChanged });
    if (toast()) s.showToast(m.sessionChanged, 'error');
    return false;
  }
  // TWS / IB Gateway lost IB (1100) or hangs: the order could not reach IB (main refuses it too).
  const unhealthy = connectionHealthText('order');
  if (unhealthy) {
    fail(unhealthy);
    return false;
  }
  try {
    if (p.modifyOrderId != null) {
      const { confirmed } = await window.tape.modifyOrder(p.modifyOrderId, p.request, p.session);
      s.patchTicket({ modifyingOrderId: null });
      accepted(p.modifyOrderId, confirmed ? m.orderModified(p.modifyOrderId) : m.modifySentUnconfirmed(p.modifyOrderId), confirmed);
      watchLateRejection([p.modifyOrderId], rejectedLater);
    } else {
      const placed = await window.tape.placeOrder(p.request, p.session);
      accepted(placed.orderId, placed.confirmed ? m.orderSubmitted(p.summary) : m.orderSentUnconfirmed(placed.orderId), placed.confirmed);
      watchLateRejection([placed.orderId, ...placed.childOrderIds], rejectedLater);
    }
    return true;
  } catch (err) {
    // The connection closed after the order was written: IB may have it. Neither "failed" nor
    // "Fix and resubmit": the user checks Orders first.
    if (errorText(err).includes(ORDER_UNCONFIRMED_MESSAGE)) {
      if (panel) useOrderFeedback.getState().update(panel, seq, { phase: 'unconfirmed', error: m.orderUnconfirmed });
      if (toast()) s.showToast(m.orderUnconfirmed, 'warning');
      return false;
    }
    fail(orderErrorText(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cancelling

/** How long after "Cancel sent" the order list has to show the order cancelled before a warning says to check it. */
const CANCEL_CONFIRM_MS = 10_000;

/** "#3"; an order placed outside the API has no order id, so its permId names it. */
const orderTag = (o: Pick<WorkingOrder, 'orderId' | 'permId'>) => (o.orderId ? `#${o.orderId}` : `permId ${o.permId ?? '?'}`);

/** The order as the list shows it: main cancels it only if IB's order under these ids is still this one. */
const orderRef = (o: WorkingOrder): OrderRef => ({ orderId: o.orderId, clientId: o.clientId, ...(o.permId ? { permId: o.permId } : {}), ...(o.account ? { account: o.account } : {}) });

/**
 * A dialog's account row: paper or live (the login's) always, the id unless account IDs are hidden
 * (Settings › Privacy); live in red.
 */
function orderAccountRow(account: string | undefined): ConfirmRow {
  const { connection, settings } = useStore.getState();
  return accountRow(connection.isPaper, account ?? connection.account, settings.appearance.showAccountId);
}

/** Rows describing an order: contract, side, quantity and price, what has filled, type and timing, attributes. */
function orderRows(o: WorkingOrder): ConfirmRow[] {
  const m = useCommon.now();
  const om = useOrdersMessages.now();
  const clock = currentClock();
  const price = o.orderType === 'MKT' ? 'MKT' : orderPriceText(o);
  const flags = attributeFlags(o, om.attr, clock, true);
  return [
    { label: m.contract, value: contractLabel(o.contract) },
    { label: m.side, value: o.action === 'BUY' ? m.buy : m.sell, color: o.action === 'BUY' ? 'var(--up)' : 'var(--dn)' },
    { label: `${m.qty} / ${m.price}`, value: `${f0(o.totalQuantity)} @ ${price}` },
    // Only the rest is cancelled.
    ...(o.filled > 0 ? [{ label: m.filled, value: m.filledOf(f0(o.filled), f0(o.totalQuantity), f0(o.remaining)) }] : []),
    { label: m.type, value: `${om.typeNames[o.orderType] ?? orderTypeLabel(o.orderType, om)} · ${timingText(o, m.sessions, clock)}` },
    ...(flags.length ? [{ label: m.orderAttributes, value: flags.join(' · ') }] : []),
  ];
}

/** A bracket's stop-loss leg (a stop or trailing stop; its take-profit is a limit order). */
const STOP_TYPES: readonly string[] = ['STP', 'STP LMT', 'TRAIL', 'TRAIL LIMIT'];

/**
 * What cancelling a bracket order does: a parent takes its working exits with it (IB cancels them
 * too); an exit leaves the rest working, and a stop-loss leaves the position without stop
 * protection (now, when the entry has filled or is not listed; once it fills, while it works).
 */
function bracketEffect(o: WorkingOrder, orders: WorkingOrder[]): { rows: ConfirmRow[]; note?: string; warning?: string } {
  const m = useCommon.now();
  const exits = orders.filter((c) => c.clientId === o.clientId && c.parentId === o.orderId && isOrderActive(c.status));
  if (exits.length) {
    const exitText = (c: WorkingOrder) => `${c.action === 'BUY' ? m.buy : m.sell} ${f0(c.remaining || c.totalQuantity)} ${c.orderType === 'LMT' ? '@' : c.orderType} ${orderPriceText(c)}`;
    return { rows: exits.map((c) => ({ label: STOP_TYPES.includes(c.orderType) ? m.stopLoss : m.takeProfit, value: exitText(c) })), note: m.exitsCancelledWith };
  }
  if (!o.parentId) return { rows: [] };
  const parent = orders.find((p) => p.clientId === o.clientId && p.orderId === o.parentId);
  const rows = [{ label: m.bracket, value: m.bracketOf(o.parentId), prose: true }];
  // A working exit whose entry is not listed: the entry filled (IB cancels the exits of one that
  // did not), offline or on an earlier day, so this exit protects a position.
  if (!parent) return STOP_TYPES.includes(o.orderType) ? { rows, warning: m.stopLossUnprotected } : { rows, note: m.otherLegStays };
  if (STOP_TYPES.includes(o.orderType)) {
    if (parent.filled > 0) return { rows, warning: m.stopLossUnprotected };
    if (isOrderActive(parent.status)) return { rows, warning: m.entryLosesStop(parent.orderId) };
  }
  return { rows, note: m.otherLegStays };
}

/**
 * Asks for confirmation, then cancels a working order: the dialog names the order and the account
 * (paper or live), what has filled, and what cancelling does to a bracket. It belongs to the
 * connection session it was opened on: it closes when Tape moves to another account or Gateway,
 * and main refuses the cancel on any other session (or when IB's order under these ids is another).
 */
export function confirmCancel(o: WorkingOrder): void {
  const s = useStore.getState();
  // Its cancel already waits for IB: a second one sends nothing.
  if (isCancelPending(o, s.pendingCancels)) return;
  const session = s.connection.session;
  const m = useCommon.now();
  const bracket = bracketEffect(o, ofConnectedAccounts(s.orders, s.connection.accounts));
  // A cancel still goes out while TWS / IB Gateway lost IB or hangs, with a warning that it may not arrive.
  const warnings = [bracket.warning, readOnlyWarning(), connectionHealthText('cancel')].filter((w): w is string => !!w);
  s.ask({
    title: m.cancelOrderTitle(orderTag(o)),
    rows: [orderAccountRow(o.account), ...orderRows(o), ...bracket.rows],
    ...(bracket.note ? { note: bracket.note } : {}),
    ...(warnings.length ? { warnings } : {}),
    label: m.cancelOrderLabel,
    danger: true,
    session,
    run: () => runCancel(o, session),
  });
}

/**
 * Sends the cancel. The row shows "Cancelling…" at once (StoreState.pendingCancels), so a second
 * click sends nothing. IB's answer: cancelled (a toast); pending or no answer yet ("Cancel sent",
 * then the order list has CANCEL_CONFIRM_MS to show it cancelled before a warning says to check
 * it); a refusal (IB's reason, with where to turn Read-Only API off).
 */
async function runCancel(o: WorkingOrder, session: number): Promise<void> {
  const s = useStore.getState();
  if (isCancelPending(o, s.pendingCancels)) return;
  const m = useCommon.now();
  const key = cancelKey(o);
  s.setCancelPending(key, true);
  let watching = false;
  try {
    const r = await window.tape.cancelOrder(orderRef(o), session);
    if (r.status === 'Cancelled') {
      useStore.getState().showToast(m.orderCancelled(orderTag(o)));
      return;
    }
    useStore.getState().showToast(m.cancelSent(orderTag(o)));
    watchCancel(o, key, session);
    watching = true;
  } catch (err) {
    useStore.getState().showToast(orderErrorText(err), 'error');
  } finally {
    if (!watching) useStore.getState().setCancelPending(key, false);
  }
}

/**
 * After "Cancel sent": the order list shows the order cancelled (a toast says so), ended otherwise
 * (filled or rejected: its own notice says so), or gone with a session change; else a warning after
 * CANCEL_CONFIRM_MS. Either way the row offers Cancel again.
 */
function watchCancel(o: WorkingOrder, key: string, session: number): void {
  const m = useCommon.now();
  let done = false;
  const same = (x: WorkingOrder) => (o.permId && x.permId ? x.permId === o.permId : x.clientId === o.clientId && x.orderId === o.orderId);
  const check = (st: StoreState) => {
    if (st.connection.session !== session) return stop();
    const x = st.orders.find(same);
    if (!x) return stop();
    if (x.status === 'Cancelled' || x.status === 'ApiCancelled') {
      stop();
      useStore.getState().showToast(m.orderCancelled(orderTag(o)));
    } else if (!isOrderActive(x.status)) stop();
  };
  const unsubscribe = useStore.subscribe((st, prev) => {
    if (st.orders !== prev.orders || st.connection.session !== prev.connection.session) check(st);
  });
  const timer = setTimeout(() => {
    if (done) return;
    stop();
    useStore.getState().showToast(m.cancelUnconfirmed(orderTag(o)), 'warning');
  }, CANCEL_CONFIRM_MS);
  function stop() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unsubscribe();
    useStore.getState().setCancelPending(key, false);
  }
  check(useStore.getState());
}

/**
 * Why Tape cannot cancel an order of another app, client or account ("Why?" beside its source):
 * the order, where it was placed and its account, and the way that works. For another app's or
 * client's order that way is to cancel it there, or IB's global cancel, which the dialog's button
 * opens (Cancel all orders…). Bound to the session it was opened on.
 */
export function explainCancelBlock(o: WorkingOrder, block: SourceBlock): void {
  const s = useStore.getState();
  const m = useCommon.now();
  const note =
    block === 'manual' ? m.whyManual : block === 'otherClient' ? m.whyOtherClient(o.clientId) : m.whyOtherAccount(maskAccounts(o.account ?? '', s.settings.appearance.showAccountId));
  s.ask({
    title: m.whyTitle,
    rows: [{ label: m.placedIn, value: sourceLabel(o, block, useOrdersMessages.now()), prose: true }, orderAccountRow(o.account), ...orderRows(o)],
    note,
    session: s.connection.session,
    ...(block === 'otherAccount' ? { label: m.close } : { label: m.cancelAllAction, run: openCancelAll }),
  });
}

/**
 * Opens the Cancel all dialog (layout/Dialogs.tsx → CancelAllDialog) for the current session, and
 * asks IB for its lists again: other apps' orders get no updates in between, so the dialog lists
 * IB's current orders (an order placed or ended elsewhere since) before the user confirms.
 */
export function openCancelAll(): void {
  const s = useStore.getState();
  s.setCancelAll({ session: s.connection.session });
  if (s.connection.status === 'connected') window.tape.refreshOrders().catch(() => undefined);
}

/**
 * IB's global cancel for the orders and account the Cancel all dialog listed (`expect`): main
 * refuses it, sending nothing, when they are not the ones in its list and in IB's full list of open
 * orders, asked right before the cancel. A toast reports how many IB cancelled, filled, no longer
 * lists without saying how, and still works (a warning unless all were cancelled).
 */
export async function sendCancelAll(expect: CancelAllExpect): Promise<void> {
  const m = useCommon.now();
  useStore.getState().setCancelAll(null);
  try {
    const r = await window.tape.cancelAllOrders(expect);
    useStore.getState().showToast(m.cancelAllDone(r), r.stillWorking || r.filled || r.unknown ? 'warning' : 'info');
  } catch (err) {
    // The global cancel went out before the connection closed: IB may have cancelled them (not "failed").
    const unconfirmed = errorText(err) === CANCEL_ALL_UNCONFIRMED_MESSAGE;
    useStore.getState().showToast(orderErrorText(err), unconfirmed ? 'warning' : 'error');
  }
}
