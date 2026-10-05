// App-level dialogs: generic confirmation ("act"), order review, and toasts.

import { useEffect, useState } from 'react';
import { f2 } from '@shared/format';
import type { OrderPreview, OrderRequest } from '@shared/types';
import { useCommon } from '../i18n/common';
import { errorText, sendOrder } from '../state/orderActions';
import { useStore } from '../state/store';
import { Button, KeyValueRows, Modal } from '../ui/primitives';

export function ConfirmDialog() {
  const m = useCommon();
  const req = useStore((s) => s.confirm);
  const close = useStore((s) => s.closeConfirm);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, close]);
  if (!req) return null;
  const ok = async () => {
    setBusy(true);
    close();
    try {
      await req.run();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={close} zIndex={20}>
      <div style={{ font: '600 18px/1.2 var(--sans)' }}>{req.title}</div>
      <KeyValueRows rows={req.rows} />
      {req.note && <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dm)' }}>{req.note}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
        <Button kind="secondary" onClick={close}>
          {m.back}
        </Button>
        <Button bg={req.danger ? 'var(--r)' : undefined} onClick={ok} disabled={busy}>
          {req.label}
        </Button>
      </div>
    </Modal>
  );
}

/** Elements that handle Enter themselves (buttons, fields, links). */
function handlesEnter(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('button, input, textarea, select, a[href], [contenteditable="true"], [role="button"]') != null;
}

type PreviewState = { status: 'loading' } | { status: 'done'; preview: OrderPreview } | { status: 'error'; message: string };

const signedMoney = (n: number) => `${n > 0 ? '+' : ''}${f2(n)}`;

/** Commission as IB gives it: an amount, or a range ("1.00 – 1.35 USD"). */
export function commissionText(p: OrderPreview): string | null {
  const cur = p.commissionCurrency ? ` ${p.commissionCurrency}` : '';
  const range = p.minCommission != null && p.maxCommission != null;
  // A commission of 0 next to a range is IB's placeholder: the range is the estimate.
  if (p.commission != null && !(p.commission === 0 && range)) return `${f2(p.commission)}${cur}`;
  if (range) {
    // Cents of a cent apart (one share: 0.010 – 0.013) show three decimals.
    const d = Math.max(Math.abs(p.minCommission!), Math.abs(p.maxCommission!)) < 0.1 ? 3 : 2;
    const lo = f2(p.minCommission, d);
    const hi = f2(p.maxCommission, d);
    return lo === hi ? `${lo}${cur}` : `${lo} – ${hi}${cur}`;
  }
  return null;
}

/** A margin line: the change ("+110.06") and, under it, before → after ("11,005.50 → 11,115.56"). */
export function marginText(t: OrderPreview['initMargin']): { value: string; sub?: string } | null {
  if (!t) return null;
  const range = t.before != null && t.after != null ? `${f2(t.before)} → ${f2(t.after)}` : undefined;
  if (t.change != null) return { value: signedMoney(t.change), sub: range };
  if (range) return { value: range };
  return t.after != null ? { value: f2(t.after) } : null;
}

/**
 * IB's what-if estimate of an order (margin before / after, commission, IB's notice), asked when
 * the review opens. IB answers like it would for the real order, so a refusal here is shown as
 * such; sending is never blocked by the estimate.
 */
function OrderEstimate({ request }: { request: OrderRequest }) {
  const m = useCommon().preview;
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    window.tape.previewOrder(request).then(
      (preview) => alive && setState({ status: 'done', preview }),
      (err: unknown) => alive && setState({ status: 'error', message: errorText(err) }),
    );
    return () => {
      alive = false;
    };
  }, [request]);
  const rows: Array<{ label: string; value: string; sub?: string }> = [];
  if (state.status === 'done') {
    const p = state.preview;
    const commission = commissionText(p);
    if (commission) rows.push({ label: m.commission, value: commission });
    const init = marginText(p.initMargin);
    if (init) rows.push({ label: m.initMargin, ...init });
    const maint = marginText(p.maintMargin);
    if (maint) rows.push({ label: m.maintMargin, ...maint });
    if (p.equityWithLoan?.after != null) rows.push({ label: m.equityWithLoan, value: f2(p.equityWithLoan.after) });
  }
  const noMargin = state.status === 'done' && !state.preview.initMargin && !state.preview.maintMargin;
  return (
    <div data-testid="order-estimate" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: 'var(--p2)', fontSize: 12, marginTop: -6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: 'var(--dm)', fontSize: 11 }}>
        <div>{m.title}</div>
        {state.status === 'loading' && <div>{m.loading}</div>}
      </div>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <div style={{ color: 'var(--mu)', flexShrink: 0 }}>{r.label}</div>
          <div className="num selectable" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, minWidth: 0 }}>
            <div>{r.value}</div>
            {r.sub && <div style={{ fontSize: 11, color: 'var(--dm)' }}>{r.sub}</div>}
          </div>
        </div>
      ))}
      {noMargin && <div style={{ color: 'var(--dm)', lineHeight: 1.45 }}>{m.noMargin}</div>}
      {state.status === 'done' && state.preview.warningText && (
        <div
          className="selectable"
          title={state.preview.warningText}
          style={{ color: 'var(--dm)', fontSize: 11, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {state.preview.warningText}
        </div>
      )}
      {state.status === 'error' && (
        <div className="selectable" style={{ color: 'var(--r)', lineHeight: 1.45 }}>
          {m.failed(state.message)}
        </div>
      )}
    </div>
  );
}

export function OrderConfirmDialog() {
  const m = useCommon();
  const p = useStore((s) => s.pendingOrder);
  const setPending = useStore((s) => s.setPendingOrder);
  const connected = useStore((s) => s.connection.status === 'connected');
  useEffect(() => {
    if (!p) return;
    // Capture phase: runs before the order ticket's own Enter shortcut.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null);
      if (e.key !== 'Enter' || e.isComposing) return;
      // A held Enter must not confirm the order its first keystroke submitted for review.
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      // The focused button (confirm is focused on open, Cancel after Tab) activates natively.
      if (handlesEnter(e.target)) return;
      e.preventDefault();
      void sendOrder(p);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p, setPending]);
  if (!p) return null;
  const buy = p.request.action === 'BUY';
  // IB estimates new single-instrument orders (a modify would be estimated as an extra order).
  const estimate = connected && p.modifyOrderId == null && p.request.contract.secType !== 'BAG';
  return (
    <Modal onClose={() => setPending(null)} zIndex={21}>
      <div style={{ font: '600 18px/1.2 var(--sans)', flexShrink: 0 }}>{p.modifyOrderId != null ? m.modifyOrder : m.confirmOrder}</div>
      {/* The rows and IB's estimate scroll when they do not fit; the title and buttons stay. */}
      <div style={{ minHeight: 0, overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 18 }}>
        <KeyValueRows rows={p.rows} />
        {estimate && <OrderEstimate request={p.request} />}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, flexShrink: 0 }}>
        <Button kind="secondary" onClick={() => setPending(null)}>
          {m.cancel}
        </Button>
        <Button bg={buy ? 'var(--up)' : 'var(--dn)'} onClick={() => void sendOrder(p)} autoFocus>
          {m.confirm} {p.label}
        </Button>
      </div>
    </Modal>
  );
}

export function ToastHost() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState<typeof toast>(null);
  useEffect(() => {
    if (!toast) return;
    setVisible(toast);
    const t = setTimeout(() => setVisible((v) => (v?.id === toast.id ? null : v)), toast.tone === 'error' ? 6000 : 3200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!visible) return null;
  return (
    <div
      key={visible.id}
      onClick={() => setVisible(null)}
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        zIndex: 30,
        maxWidth: 560,
        padding: '10px 16px',
        background: 'var(--p)',
        color: visible.tone === 'error' ? 'var(--r)' : 'var(--tx)',
        boxShadow: `0 0 0 1px ${visible.tone === 'error' ? 'var(--r)' : 'var(--ln)'}, 0 12px 32px rgba(0,0,0,.2)`,
        fontSize: 13,
        lineHeight: 1.5,
        cursor: 'pointer',
        animation: 'tape-fade-in .15s ease-out',
      }}
    >
      {visible.text}
    </div>
  );
}
