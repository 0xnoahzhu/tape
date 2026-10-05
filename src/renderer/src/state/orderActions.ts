// Sending orders: review dialog (optional), placement, cancellation and user feedback.

import { contractKey, contractLabel } from '@shared/contract';
import { f0, px } from '@shared/format';
import { timingText } from '@shared/orderTiming';
import { attributeFlags } from '../features/orders/attributes';
import { useOrdersMessages } from '../features/orders/messages';
import { orderPriceText, orderTypeLabel } from '../features/orders/model';
import { hostAppName } from '../features/settings/logic';
import type { WorkingOrder } from '@shared/types';
import { currentClock } from '../i18n';
import { useCommon } from '../i18n/common';
import { panelShown } from '../features/panels/actions';
import type { PanelId } from '../features/panels/model';
import { usePanels } from '../features/panels/panelStore';
import { useOrderFeedback } from './orderFeedback';
import { useStore, type PendingOrder } from './store';

/** Strips Electron's IPC wrapper from error messages. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** IB's rejection while TWS / IB Gateway has "Read-Only API" on: "…in Read-Only mode. (321)". */
const READ_ONLY_API_RE = /read[- ]only.*\(321\)$/is;
/**
 * IB's 10329 for a directly routed order (the overnight-only session goes to OVERNIGHT) while the
 * API precautions hold such orders back: "This order will be directly routed to OVERNIGHT.
 * Restriction is specified in Precautionary Settings of Global Configuration/API. (10329)".
 */
const DIRECT_ROUTE_RE = /\(10329\)$/;

/** Where a TWS / IB Gateway API settings page is, in the app Tape is connected to. */
function apiSettingsPath(page: 'Settings' | 'Precautions'): string {
  const { connection, settings } = useStore.getState();
  // No-break spaces keep the app's name on one line in the toast.
  return hostAppName(connection.port, settings.connection.mode) === 'TWS'
    ? `TWS › Global\u00a0Configuration › API › ${page}`
    : `IB\u00a0Gateway › Configure › Settings › API › ${page}`;
}

/**
 * Text of a failed order request. IB's Read-Only API rejection (error 321) also says where to
 * turn that option off, and its refusal of directly routed orders (10329) where to allow them,
 * in the app (TWS or IB Gateway) Tape is connected to.
 */
export function orderErrorText(err: unknown): string {
  const text = errorText(err);
  if (READ_ONLY_API_RE.test(text)) return `${text} ${useCommon.now().readOnlyApiHint(apiSettingsPath('Settings'))}`;
  if (DIRECT_ROUTE_RE.test(text)) return `${text} ${useCommon.now().directRouteHint(apiSettingsPath('Precautions'))}`;
  return text;
}

/** How long after "Submitted" / "Modified" a rejection by IB still replaces that toast. */
const LATE_REJECTION_MS = 5_000;

/**
 * IB sometimes acknowledges an order (PreSubmitted) and rejects it half a second later (Inactive,
 * then the reason as error 201), after placeOrder / modifyOrder have resolved. For a few seconds
 * such a rejection replaces the success feedback with the failure and IB's reason.
 */
function watchLateRejection(orderIds: number[], onReject: (reason: string) => void): void {
  const clientId = useStore.getState().connection.clientId;
  const unsubscribe = useStore.subscribe((s, prev) => {
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
 * Entry point for every order the UI sends. Shows the review dialog when
 * Settings › Trade › "Confirm before sending" is on, otherwise sends immediately.
 */
export function submitOrder(p: PendingOrder): void {
  const s = useStore.getState();
  if (s.settings.trading.confirmOrders) {
    s.setPendingOrder(p);
    return;
  }
  void sendOrder(p);
}

/** The status strip's line: "Buy 100 AAPL · LMT 227.56 · DAY". */
export function orderLine(p: Pick<PendingOrder, 'summary' | 'request'>): string {
  const r = p.request;
  const price = r.orderType === 'MKT' ? '' : r.limitPrice != null ? ` ${px(r.limitPrice)}` : r.stopPrice != null ? ` ${px(r.stopPrice)}` : '';
  return `${p.summary} · ${r.orderType}${price} · ${r.tif}`;
}

/** Whether floating panel `id` is on screen now (floating, on its page and view), so its strip and bar can report. */
function panelOnScreen(id: PanelId): boolean {
  return usePanels.getState().panels[id].floating && panelShown(id, useStore.getState());
}

/**
 * Sends an order (after the review, if any). It reports with toasts, or, sent from a floating
 * panel (`origin`, features/panels), with that panel's status strip and bar
 * (state/orderFeedback.ts): an accepted order collapses the panel to its bar, a rejection keeps it
 * expanded (and a late one expands it again) with the form as it was. When that panel is not on
 * screen when IB answers (docked back, another page or view), the toasts report as well, so no
 * answer goes unseen. A panel's second order while the first still waits for IB is not sent (its
 * button is disabled, and ⏎ must not send it twice).
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
        positionBefore: s.positions.find((x) => contractKey(x.contract) === key)?.quantity ?? 0,
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
  const accepted = (orderId: number, text: string) => {
    if (toast()) s.showToast(text);
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
  try {
    if (p.modifyOrderId != null) {
      await window.tape.modifyOrder(p.modifyOrderId, p.request);
      s.patchTicket({ modifyingOrderId: null });
      accepted(p.modifyOrderId, m.orderModified(p.modifyOrderId));
      watchLateRejection([p.modifyOrderId], rejectedLater);
    } else {
      const placed = await window.tape.placeOrder(p.request);
      accepted(placed.orderId, m.orderSubmitted(p.summary));
      watchLateRejection([placed.orderId, ...placed.childOrderIds], rejectedLater);
    }
    return true;
  } catch (err) {
    fail(orderErrorText(err));
    return false;
  }
}

/** Asks for confirmation, then cancels a working order. */
export function confirmCancel(o: WorkingOrder): void {
  const s = useStore.getState();
  const m = useCommon.now();
  const om = useOrdersMessages.now();
  const clock = currentClock();
  const price = o.orderType === 'MKT' ? 'MKT' : orderPriceText(o);
  const flags = attributeFlags(o, om.attr, clock, true);
  s.ask({
    title: m.cancelOrderTitle,
    rows: [
      { label: m.contract, value: contractLabel(o.contract) },
      { label: m.side, value: o.action === 'BUY' ? m.buy : m.sell, color: o.action === 'BUY' ? 'var(--up)' : 'var(--dn)' },
      { label: `${m.qty} / ${m.price}`, value: `${f0(o.totalQuantity)} @ ${price}` },
      { label: m.type, value: `${om.typeNames[o.orderType] ?? orderTypeLabel(o.orderType, om)} · ${timingText(o, m.sessions, clock)}` },
      ...(flags.length ? [{ label: m.orderAttributes, value: flags.join(' · ') }] : []),
    ],
    label: m.cancelOrderLabel,
    danger: true,
    run: async () => {
      try {
        await window.tape.cancelOrder(o.orderId);
      } catch (err) {
        useStore.getState().showToast(orderErrorText(err), 'error');
      }
    },
  });
}
