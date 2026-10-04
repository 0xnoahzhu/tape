// Sending orders: review dialog (optional), placement, cancellation and user feedback.

import { contractLabel } from '@shared/contract';
import { f0 } from '@shared/format';
import { timingText } from '@shared/orderTiming';
import { orderPriceText } from '../features/orders/model';
import { hostAppName } from '../features/settings/logic';
import type { WorkingOrder } from '@shared/types';
import { useCommon } from '../i18n/common';
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
 * such a rejection replaces the success toast with the failure and IB's reason.
 */
function watchLateRejection(orderIds: number[]): void {
  const clientId = useStore.getState().connection.clientId;
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.orders === prev.orders) return;
    const o = s.orders.find((x) => x.clientId === clientId && orderIds.includes(x.orderId) && x.status === 'Inactive');
    if (!o) return;
    stop();
    const m = useCommon.now();
    s.showToast(m.orderFailed(o.message || m.orderInactive), 'error');
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

export async function sendOrder(p: PendingOrder): Promise<boolean> {
  const s = useStore.getState();
  const m = useCommon.now();
  s.setPendingOrder(null);
  if (s.connection.status !== 'connected') {
    s.showToast(m.notConnected, 'error');
    return false;
  }
  try {
    if (p.modifyOrderId != null) {
      await window.tape.modifyOrder(p.modifyOrderId, p.request);
      s.showToast(m.orderModified(p.modifyOrderId));
      s.patchTicket({ modifyingOrderId: null });
      watchLateRejection([p.modifyOrderId]);
    } else {
      const placed = await window.tape.placeOrder(p.request);
      s.showToast(m.orderSubmitted(p.summary));
      watchLateRejection([placed.orderId, ...placed.childOrderIds]);
    }
    return true;
  } catch (err) {
    s.showToast(m.orderFailed(orderErrorText(err)), 'error');
    return false;
  }
}

/** Asks for confirmation, then cancels a working order. */
export function confirmCancel(o: WorkingOrder): void {
  const s = useStore.getState();
  const m = useCommon.now();
  const price = o.orderType === 'MKT' ? 'MKT' : orderPriceText(o);
  s.ask({
    title: m.cancelOrderTitle,
    rows: [
      { label: m.contract, value: contractLabel(o.contract) },
      { label: m.side, value: o.action === 'BUY' ? m.buy : m.sell, color: o.action === 'BUY' ? 'var(--up)' : 'var(--dn)' },
      { label: `${m.qty} / ${m.price}`, value: `${f0(o.totalQuantity)} @ ${price}` },
      { label: m.type, value: `${o.orderType} · ${timingText(o, m.sessions)}` },
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
