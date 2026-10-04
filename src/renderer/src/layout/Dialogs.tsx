// App-level dialogs: generic confirmation ("act"), order review, and toasts.

import { useEffect, useState } from 'react';
import { useCommon } from '../i18n/common';
import { sendOrder } from '../state/orderActions';
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

export function OrderConfirmDialog() {
  const m = useCommon();
  const p = useStore((s) => s.pendingOrder);
  const setPending = useStore((s) => s.setPendingOrder);
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
  return (
    <Modal onClose={() => setPending(null)} zIndex={21}>
      <div style={{ font: '600 18px/1.2 var(--sans)' }}>{p.modifyOrderId != null ? m.modifyOrder : m.confirmOrder}</div>
      <KeyValueRows rows={p.rows} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
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
