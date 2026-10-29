// A floating panel's status strip: the latest order sent from that panel, from "Submitting…" to
// IB's live status (stripModel.ts), with inline Modify / Cancel while it works (and Tape can cancel
// it: lib/orders.ts → orderRowAction; "Cancelling…" while a cancel waits for IB) and a × to dismiss
// it. A rejection turns it red with IB's reason; the form keeps every value. An order the closing
// connection left unconfirmed says to check Orders before sending it again.

import { f0 } from '@shared/format';
import { useCommon } from '../../i18n/common';
import { orderRowAction } from '../../lib/orders';
import { useConnectedExecutions, useConnectedOrders } from '../../state/connectedLists';
import { useOrderFeedback } from '../../state/orderFeedback';
import { confirmCancel } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { canModifyInTicket } from '../orders/model';
import { modifyOrderInTicket } from './actions';
import { usePanelMessages } from './messages';
import type { PanelId } from './model';
import { sentPosition, stripView, type StripTone, type StripView } from './stripModel';

const TONE: Record<StripTone, string> = { busy: 'var(--dm)', working: 'var(--ac)', filled: 'var(--ac)', muted: 'var(--dm)', error: 'var(--r)', held: 'var(--r)' };

/** The strip's view of panel `id`'s latest order, or null when there is none. */
export function useStripView(id: PanelId): StripView | null {
  const sent = useOrderFeedback((s) => s.sent[id]);
  const m = usePanelMessages();
  const c = useCommon();
  const orders = useConnectedOrders();
  const executions = useConnectedExecutions();
  const position = useStore((s) => (sent ? sentPosition(sent, s.positions, s.connection.account) : 0));
  if (!sent) return null;
  return stripView(sent, { orders, executions, position }, m, (side) => (side === 'BUY' ? c.buyShort : c.sellShort));
}

export function OrderStrip({ id }: { id: PanelId }) {
  const m = usePanelMessages();
  const c = useCommon();
  const sent = useOrderFeedback((s) => s.sent[id]);
  const view = useStripView(id);
  const status = useStore((s) => s.connection.status);
  const clientId = useStore((s) => s.connection.clientId);
  const accounts = useStore((s) => s.connection.accounts);
  const pending = useStore((s) => s.pendingCancels);
  const dismiss = () => useOrderFeedback.getState().dismiss(id);
  if (!sent || !view) return null;
  const color = TONE[view.tone];
  const o = view.working;
  const action = o ? orderRowAction(o, { status, clientId, accounts }, pending).kind : 'none';
  const link = { cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as const;
  return (
    <div
      role="status"
      data-testid="order-strip"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: 'var(--p2)', boxShadow: `inset 2px 0 0 ${color}`, fontSize: 12, flexShrink: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 600, color, whiteSpace: 'nowrap' }}>
          {view.tone === 'filled' || view.tone === 'working' ? '✓ ' : ''}
          {view.head}
        </div>
        {view.status && (
          <div className="ellipsis" style={{ color: 'var(--mu)', minWidth: 0 }}>
            {view.status}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <div onClick={dismiss} title={m.dismiss} aria-label={m.dismiss} role="button" className="hover-tx" style={{ ...link, color: 'var(--dm)', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>
          ×
        </div>
      </div>
      <div className="ellipsis num" title={sent.summary} style={{ color: 'var(--tx)' }}>
        {sent.summary}
      </div>
      {view.progress && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 4, background: 'var(--ln)' }}>
            <div style={{ height: '100%', width: `${(100 * view.progress.filled) / Math.max(1, view.progress.total)}%`, background: color }} />
          </div>
          <div className="num" style={{ color: 'var(--mu)', whiteSpace: 'nowrap' }}>
            {f0(view.progress.filled)} / {f0(view.progress.total)}
          </div>
        </div>
      )}
      {view.details.length > 0 && <div className="num selectable" style={{ color: 'var(--mu)', lineHeight: 1.45 }}>{view.details.join(' · ')}</div>}
      {(view.tone === 'error' || view.tone === 'held') && (
        <>
          {view.error && (
            <div className="selectable" style={{ color: 'var(--r)', lineHeight: 1.45 }}>
              {view.error}
            </div>
          )}
          {view.tone === 'error' && sent.phase !== 'unconfirmed' && (
            <div onClick={dismiss} style={{ ...link, color: 'var(--ac)', alignSelf: 'flex-start' }}>
              {m.fix}
            </div>
          )}
        </>
      )}
      {o && action === 'actions' && (
        <div style={{ display: 'flex', gap: 14 }}>
          {id === 'ticket' && canModifyInTicket(o) && (
            <div onClick={() => modifyOrderInTicket(o)} style={{ ...link, color: 'var(--ac)' }}>
              {m.modify}
            </div>
          )}
          <div onClick={() => confirmCancel(o)} className="hover-tx" style={{ ...link, color: 'var(--dm)' }}>
            {m.cancel}
          </div>
        </div>
      )}
      {o && action === 'cancelling' && <div style={{ ...link, color: 'var(--dm)' }}>{c.cancelling}</div>}
    </div>
  );
}
