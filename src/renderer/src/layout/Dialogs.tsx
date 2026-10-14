// App-level dialogs: generic confirmation ("act"), order review, Cancel all, and toasts.
//
// A confirming button arms CONFIRM_ARM_MS after it becomes available (the order review's Confirm,
// a danger confirmation's button, Cancel all's): until then its click does nothing and ⏎ is held
// back in the capture phase, so a double-click or ⏎⏎ that opened the dialog never confirms it.
// The button keeps the focus meanwhile (never `disabled`, which would leave ⏎ on a button behind
// the dialog), and fades in as it arms. Escape and Cancel / Back always work; a dialog's Escape is
// marked handled (preventDefault), so nothing behind it (a floating panel, the notifications
// panel) takes the same key as its own once the dialog is gone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { contractLabel } from '@shared/contract';
import { DASH, f0, f2 } from '@shared/format';
import { cancelBlock, isSourceBlock } from '@shared/orderOwnership';
import type { OrderPreview, OrderRequest, WorkingOrder } from '@shared/types';
import { useOrdersMessages, type OrdersMessages } from '../features/orders/messages';
import { orderPriceText, orderTypeLabel, sourceLabel } from '../features/orders/model';
import { useCommon } from '../i18n/common';
import { cancelAllExpect, cancelAllOrders } from '../lib/orders';
import { connectionHealthText, orderErrorText, readOnlyWarning, sendCancelAll, sendOrder } from '../state/orderActions';
import { useStore } from '../state/store';
import { keysHome, useRefocus } from '../ui/focus';
import { AccountTag, Button, KeyValueRows, Modal } from '../ui/primitives';
import { stableGutter } from '../ui/scrollGutter';
import { CONFIRM_ARM_MS, confirmLabel, enterAction, mayArm, needsAcknowledgement, reviewRows, reviewTitle, warningRows } from './orderReview';

export { CONFIRM_ARM_MS } from './orderReview';

/**
 * Arms a confirming button CONFIRM_ARM_MS after `ready` turns true (and again for every new `key`,
 * e.g. the next order under review): `armed` for drawing, `ref` for the key and click handlers,
 * which must see the current value at once.
 */
function useArming(ready: boolean, key: unknown): { armed: boolean; ref: { readonly current: boolean } } {
  const ref = useRef(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    ref.current = false;
    setArmed(false);
    if (!ready) return;
    const t = setTimeout(() => {
      ref.current = true;
      setArmed(true);
    }, CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, [ready, key]);
  return { armed, ref };
}

/** The look of a confirming button while it arms: faded, then full as it becomes usable. */
const armingStyle = (armed: boolean) => ({ opacity: armed ? 1 : 0.55, transition: `opacity ${CONFIRM_ARM_MS}ms ease-in` });

/** Red lines in a dialog: what an action costs, or why it may fail. */
function Warnings({ lines }: { lines: readonly string[] }) {
  if (!lines.length) return null;
  return (
    <div data-testid="dialog-warnings" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, lineHeight: 1.6, color: 'var(--r)' }}>
      {lines.map((line) => (
        <div key={line} className="selectable">
          {line}
        </div>
      ))}
    </div>
  );
}

/**
 * The generic confirmation. A danger one (cancel an order, disconnect, delete) arms its button like
 * the order review: focused on open, inert for CONFIRM_ARM_MS.
 */
export function ConfirmDialog() {
  const m = useCommon();
  const req = useStore((s) => s.confirm);
  const close = useStore((s) => s.closeConfirm);
  const [busy, setBusy] = useState(false);
  const danger = !!req?.danger && !!req.run;
  const arming = useArming(danger, req);
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, close]);
  useEffect(() => {
    if (!danger) return;
    // Capture phase: a ⏎ on the focused button before it arms (or held) never presses it.
    const onKey = (e: KeyboardEvent) => {
      const target = e.target === actionRef.current ? 'confirm' : handlesEnter(e.target) ? 'other' : 'none';
      if (enterAction(e, arming.ref.current, target) === 'block') e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [danger, arming.ref]);
  if (!req) return null;
  const { run } = req;
  const ok = async () => {
    if (danger && !arming.ref.current) return;
    setBusy(true);
    close();
    try {
      await run?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={close} zIndex={20}>
      <div style={{ font: '600 18px/1.2 var(--sans)' }}>{req.title}</div>
      <KeyValueRows rows={req.rows} />
      {req.note && <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dm)' }}>{req.note}</div>}
      <Warnings lines={req.warnings ?? []} />
      {run ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
          <Button kind="secondary" onClick={close}>
            {m.back}
          </Button>
          <Button
            bg={req.danger ? 'var(--r)' : undefined}
            onClick={ok}
            disabled={busy}
            buttonRef={actionRef}
            autoFocus={danger}
            style={danger ? armingStyle(arming.armed) : undefined}
          >
            {req.label}
          </Button>
        </div>
      ) : (
        // Information only: one button closes it.
        <Button kind="secondary" onClick={close} autoFocus>
          {req.label}
        </Button>
      )}
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
function OrderEstimate({ request, session }: { request: OrderRequest; session: number }) {
  const m = useCommon().preview;
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    // For the account the order was reviewed on only (main refuses another session).
    window.tape.previewOrder(request, session).then(
      (preview) => alive && setState({ status: 'done', preview }),
      // Main's own refusals (not connected, another session, IB link lost) in the user's language.
      (err: unknown) => alive && setState({ status: 'error', message: orderErrorText(err) }),
    );
    return () => {
      alive = false;
    };
  }, [request, session]);
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

/**
 * The order review: every order, modify and strategy is sent from here only (state/orderActions.ts
 * → submitOrder; no setting skips it). The title names the order ("Modify order #58") beside the
 * PAPER / LIVE tag of the account it was submitted for, and the first row is that account. Red rows
 * follow for prices that are not live and for the pre-trade checks' risks, which "I have checked
 * these warnings" acknowledges before Confirm can arm. Confirm keeps the focus and arms
 * CONFIRM_ARM_MS after the order (or the tick) arrives; a modify that changes nothing says so and
 * never arms, nor does any order while Tape is not connected or TWS / IB Gateway lost IB or does
 * not answer (a red line says so; it arms once that is over).
 *
 * Dismissed (Escape, Cancel, a click outside), it gives the keys back to the ticket or floating panel
 * it was opened from, so B / S / ↑ / ↓ / ⏎ work there again at once. After Confirm the focus stays on
 * the page: ⏎ pressed again and again never chains into a second review and send of the same order.
 */
export function OrderConfirmDialog() {
  const m = useCommon();
  const p = useStore((s) => s.pendingOrder);
  const setPending = useStore((s) => s.setPendingOrder);
  const open = p != null;
  // Read in the render that opens the review, before its commit gives Confirm the focus (autoFocus).
  const home = useMemo(() => (open ? keysHome(document.activeElement) : null), [open]);
  const refocus = useRefocus();
  const dismiss = useCallback(() => {
    setPending(null);
    refocus(() => home);
  }, [setPending, refocus, home]);
  const connected = useStore((s) => s.connection.status === 'connected');
  const showId = useStore((s) => s.settings.appearance.showAccountId);
  // IB answered with its Read-Only refusal on this connection: it will refuse this order too.
  const readOnly = useStore((s) => (s.connection.readOnlyApi ? readOnlyWarning() : undefined));
  // Not connected (a plain reconnect keeps the review), or TWS / IB Gateway lost IB (1100) or hangs:
  // Confirm does not arm until the connection can carry the order again.
  const held = useStore((s) =>
    s.connection.status !== 'connected' ? m.reviewOffline : s.connection.ibLinkLost || s.connection.unresponsive ? connectionHealthText('review') : undefined,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  // Every order under review is acknowledged anew.
  useEffect(() => setAcknowledged(false), [p]);
  const arming = useArming(!!p && mayArm(p, acknowledged, !!held), p);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!p) return;
    // Capture phase: runs before the order ticket's own Enter shortcut.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
        return;
      }
      const target = e.target === confirmRef.current ? 'confirm' : handlesEnter(e.target) ? 'other' : 'none';
      const action = enterAction(e, arming.ref.current, target);
      if (action === 'block') e.preventDefault();
      else if (action === 'confirm') {
        e.preventDefault();
        void sendOrder(p);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p, dismiss, arming.ref]);
  if (!p) return null;
  const buy = p.request.action === 'BUY';
  // IB estimates new single-instrument orders (a modify would be estimated as an extra order).
  const estimate = connected && p.modifyOrderId == null && p.request.contract.secType !== 'BAG';
  const ack = needsAcknowledgement(p);
  const toggleAck = () => setAcknowledged((a) => !a);
  return (
    <Modal onClose={dismiss} zIndex={21}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0 }}>
        <div style={{ font: '600 18px/1.2 var(--sans)', minWidth: 0 }}>{reviewTitle(p)}</div>
        <AccountTag paper={p.isPaper} text={p.isPaper ? m.paperTag : m.liveTag} title={p.isPaper ? m.paperTip : m.liveTip} />
      </div>
      {/* The rows and IB's estimate scroll when they do not fit; the title and buttons stay. The
          estimate arriving can start the scroll: room for the scrollbar is kept in the dialog's
          right padding, so the rows keep the buttons' width (scrollGutter.ts). */}
      <div style={{ minHeight: 0, overflowY: 'auto', ...stableGutter, marginRight: 'calc(0px - var(--sbw, 0px))', display: 'grid', alignContent: 'start', gap: 18 }}>
        <KeyValueRows rows={[...reviewRows(p, showId), ...warningRows(p)]} />
        {p.unchanged && <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dm)' }}>{m.nothingChanged}</div>}
        <Warnings lines={[held, readOnly].filter((w): w is string => !!w)} />
        {estimate && <OrderEstimate request={p.request} session={p.session} />}
      </div>
      {ack && (
        // Space ticks it; ⏎ stays the dialog's (Confirm, once armed).
        <div
          role="checkbox"
          aria-checked={acknowledged}
          tabIndex={0}
          data-testid="review-acknowledge"
          onClick={toggleAck}
          onKeyDown={(e) => {
            if (e.key === ' ') {
              e.preventDefault();
              toggleAck();
            }
          }}
          style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}
        >
          <div style={{ width: 14, height: 14, flexShrink: 0, boxShadow: `inset 0 0 0 ${acknowledged ? 7 : 1}px ${acknowledged ? 'var(--r)' : 'var(--mu)'}` }} />
          <div>{m.risk.acknowledge}</div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, flexShrink: 0 }}>
        <Button kind="secondary" onClick={dismiss}>
          {m.cancel}
        </Button>
        <Button
          bg={buy ? 'var(--up)' : 'var(--dn)'}
          buttonRef={confirmRef}
          autoFocus
          onClick={() => {
            if (arming.ref.current) void sendOrder(p);
          }}
          title={p.unchanged ? m.nothingChanged : undefined}
          style={armingStyle(arming.armed)}
        >
          {confirmLabel(p)}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Cancel all orders (Portfolio › Orders): IB's global cancel, which reaches every open order of
 * every account of the login, whichever app placed it. It lists those orders with who placed them
 * and the accounts (paper or live), says what cannot be undone, and confirms in two steps that no
 * setting skips: a check box naming the count, then the red button, armed CONFIRM_ARM_MS after it.
 * A changed list (an order placed, filled or cancelled meanwhile) unticks the box; opening it asks IB
 * for its lists again (openCancelAll), since other apps' orders get no updates in between. Bound to the
 * session it was opened on (state/sessionReset.ts closes it); main refuses it for any other list,
 * checked against IB's full list of open orders asked right before the global cancel.
 */
export function CancelAllDialog() {
  const m = useCommon();
  const om = useOrdersMessages();
  const req = useStore((s) => s.cancelAll);
  const connection = useStore((s) => s.connection);
  const showId = useStore((s) => s.settings.appearance.showAccountId);
  const orders = useStore((s) => s.orders);
  const list = useMemo(() => cancelAllOrders(orders, connection.accounts), [orders, connection.accounts]);
  const expect = cancelAllExpect(list, connection);
  const listed = expect?.permIds.join(',') ?? '';
  const [understood, setUnderstood] = useState(false);
  const [armed, setArmed] = useState(false);
  const close = () => useStore.getState().setCancelAll(null);
  // Another list (or the dialog opened again) is confirmed anew.
  useEffect(() => setUnderstood(false), [listed, req]);
  useEffect(() => {
    setArmed(false);
    if (!understood) return;
    const t = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, [understood]);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      useStore.getState().setCancelAll(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);
  if (!req) return null;
  const n = list.length;
  const ready = !!expect && connection.status === 'connected' && req.session === connection.session && understood && armed;
  const readOnly = connection.readOnlyApi ? readOnlyWarning() : undefined;
  // Still sent while TWS / IB Gateway lost IB or hangs (getting out stays possible), with a warning.
  const unhealthy = connection.ibLinkLost || connection.unresponsive ? connectionHealthText('cancel') : undefined;
  const tag = connection.isPaper ? m.paperTag : m.liveTag;
  const accountRows = (connection.accounts.length ? connection.accounts : ['']).map((a) => ({
    label: m.account,
    value: m.accountValue(tag, showId ? a : ''),
    ...(connection.isPaper ? {} : { color: 'var(--r)' }),
  }));
  const toggle = () => n > 0 && setUnderstood((u) => !u);
  return (
    <Modal onClose={close} zIndex={20} width={480}>
      <div style={{ font: '600 18px/1.2 var(--sans)', flexShrink: 0 }}>{m.cancelAllTitle}</div>
      <div style={{ minHeight: 0, overflowY: 'auto', ...stableGutter, marginRight: 'calc(0px - var(--sbw, 0px))', display: 'grid', alignContent: 'start', gap: 14 }}>
        <KeyValueRows rows={accountRows} />
        <div data-testid="cancel-all-orders" style={{ display: 'flex', flexDirection: 'column', fontSize: 13 }}>
          {list.map((o) => {
            const block = cancelBlock(o, { ...connection, status: 'connected' });
            const source = isSourceBlock(block) ? sourceLabel(o, block, om) : om.thisApp;
            const buy = o.action === 'BUY';
            return (
              <div key={o.permId ?? `${o.clientId}:${o.orderId}`} style={{ minHeight: 32, display: 'flex', alignItems: 'center', gap: 10, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
                <div style={{ color: buy ? 'var(--up)' : 'var(--dn)', fontWeight: 500, flexShrink: 0 }}>{buy ? m.buyShort : m.sellShort}</div>
                <div className="ellipsis num selectable" style={{ flex: 1, minWidth: 0 }} title={cancelAllLine(o, om)}>
                  {cancelAllLine(o, om)}
                </div>
                <div className="ellipsis" style={{ color: 'var(--mu)', flexShrink: 0, maxWidth: '40%' }}>
                  {source}
                </div>
              </div>
            );
          })}
          {!n && <div style={{ minHeight: 32, display: 'flex', alignItems: 'center', color: 'var(--dm)' }}>{m.noWorkingOrders}</div>}
        </div>
        <Warnings lines={[m.cancelAllWarning, readOnly, unhealthy].filter((w): w is string => !!w)} />
      </div>
      <div
        role="checkbox"
        aria-checked={understood}
        aria-disabled={!n || undefined}
        tabIndex={n ? 0 : -1}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggle();
          }
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: n ? 'pointer' : 'not-allowed', opacity: n ? 1 : 0.5, flexShrink: 0 }}
      >
        <div style={{ width: 14, height: 14, flexShrink: 0, boxShadow: `inset 0 0 0 ${understood ? 7 : 1}px ${understood ? 'var(--r)' : 'var(--mu)'}` }} />
        <div>{m.cancelAllUnderstand(n)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, flexShrink: 0 }}>
        {/* Focus starts on Back: ⏎ closes, it never cancels. */}
        <Button kind="secondary" onClick={close} autoFocus>
          {m.back}
        </Button>
        <Button bg="var(--r)" disabled={!ready} onClick={() => expect && ready && void sendCancelAll(expect)}>
          {m.cancelAllConfirm(n)}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * An order of the Cancel all list: "AAPL · 100 @ 220.00 · DAY" for a limit order; other types name
 * themselves ("NVDA · 200 Stop 110.00 · GTC", "MSFT · 5 Market · DAY"), so a protective stop-loss
 * does not read as a limit order.
 */
function cancelAllLine(o: WorkingOrder, om: OrdersMessages): string {
  const price = orderPriceText(o);
  const type = orderTypeLabel(o.orderType, om);
  const how = o.orderType === 'LMT' ? `@ ${price}` : price === DASH ? type : `${type} ${price}`;
  return `${contractLabel(o.contract)} · ${f0(o.totalQuantity)} ${how} · ${o.tif}`;
}

export function ToastHost() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState<typeof toast>(null);
  useEffect(() => {
    if (!toast) return;
    setVisible(toast);
    const t = setTimeout(() => setVisible((v) => (v?.id === toast.id ? null : v)), toast.tone === 'info' ? 3200 : 6000);
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
        // A warning (sent, not confirmed by IB) keeps the text's colour with a red edge: not a failure, not a success either.
        boxShadow: `${visible.tone === 'warning' ? 'inset 3px 0 0 var(--r), ' : ''}0 0 0 1px ${visible.tone === 'error' ? 'var(--r)' : 'var(--ln)'}, 0 12px 32px rgba(0,0,0,.2)`,
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
