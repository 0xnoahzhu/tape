// Sending orders: review dialog (optional), placement, cancellation and user feedback.

import { contractLabel } from '@shared/contract';
import { f0 } from '@shared/format';
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
 * Text of a failed order request. IB's Read-Only API rejection (error 321) also says where to
 * turn that option off, in the app (TWS or IB Gateway) Tape is connected to.
 */
export function orderErrorText(err: unknown): string {
  const text = errorText(err);
  if (!READ_ONLY_API_RE.test(text)) return text;
  const { connection, settings } = useStore.getState();
  // No-break spaces keep the app's name on one line in the toast.
  const path =
    hostAppName(connection.port, settings.connection.mode) === 'TWS'
      ? 'TWS › Global\u00a0Configuration › API › Settings'
      : 'IB\u00a0Gateway › Configure › Settings › API › Settings';
  return `${text} ${useCommon.now().readOnlyApiHint(path)}`;
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
    } else {
      await window.tape.placeOrder(p.request);
      s.showToast(m.orderSubmitted(p.summary));
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
      { label: m.type, value: `${o.orderType} · ${o.tif}` },
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
