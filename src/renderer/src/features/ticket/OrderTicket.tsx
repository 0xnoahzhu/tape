// Order ticket (design 3a, right column of the Trade page). Its state lives in store.ticket so the
// Book, "Modify" and the command bar can prefill it; prices nobody typed follow the market.
// With Level 2 on, the Book (DepthBlock.tsx) sits between the bid / ask and the entry fields.
// The parts and the controller are shared with the floating ticket (features/panels):
// parts.tsx, DepthBlock.tsx, useTicket.ts.
//
// Docked, the ticket is focusable (TICKET_KEYS_ATTR, like a floating panel's root): a press in it
// gives it the keys, and its B / S / ↑ / ↓ / ⏎ work only while the focus is in it
// (useTicketKeys.ts), never from the page. Its button reads "Submitting…" while its order (or the
// docked strategy builder's) waits for IB, and nothing more is sent meanwhile.

import { useRef, type PointerEvent, type ReactNode } from 'react';
import type { PanelId } from '../panels/model';
import { isDockedSending, useOrderFeedback } from '../../state/orderFeedback';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';
import { DepthBlock } from './DepthBlock';
import {
  AdvancedBlock,
  AdvancedToggle,
  DOCKED_SCALE,
  kindLabel,
  MarketIssue,
  NotTradableNote,
  OrderTypeRow,
  QtyPriceRow,
  QuoteBoxes,
  SideSwitch,
  SubmitBlock,
  TifRow,
  Totals,
  TypeExtras,
  type TicketScale,
} from './parts';
import { useTicket, type TicketCtl } from './useTicket';
import { TICKET_KEYS_ATTR } from './useTicketKeys';

/** Controls that take the focus themselves when pressed (a press elsewhere focuses the ticket). */
const FOCUSABLE = 'input, textarea, select, button, a[href], [tabindex], [contenteditable="true"]';

/**
 * `header` replaces the title row and `footer` the totals and the submit button, `origin` names the
 * floating panel the ticket is drawn in (the floating ticket in its narrow layout); `actions` goes
 * at the end of the title row (the pop-out button).
 */
export function OrderTicket({
  actions,
  header,
  footer,
  origin,
}: { actions?: ReactNode; header?: (T: TicketCtl) => ReactNode; footer?: (T: TicketCtl) => ReactNode; origin?: PanelId } = {}) {
  const T = useTicket(origin);
  const { m, c, symbol, label } = T;
  const S: TicketScale = DOCKED_SCALE;
  // Docked (no panel around it): the ticket itself holds the keys, and the in-flight guard is its own.
  const docked = origin == null;
  const sending = useOrderFeedback(isDockedSending) && docked;
  const root = useRef<HTMLDivElement>(null);
  const takeKeys = (e: PointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t !== root.current && t.closest(FOCUSABLE) !== root.current) return;
    root.current?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={root}
      {...(docked ? { tabIndex: -1, [TICKET_KEYS_ATTR]: '', onPointerDown: takeKeys } : null)}
      style={{ gridColumn: 2, gridRow: '1 / 3', background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, outline: 'none', ...(header ? { flex: 1 } : null) }}
    >
      {header ? (
        header(T)
      ) : (
        <div
          style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '0 24px',
            boxShadow: 'inset 0 -1px 0 var(--ln2)',
            flexShrink: 0,
          }}
        >
          <div className="ellipsis" style={{ fontWeight: 600 }}>
            {m.title(label)}
          </div>
          {actions ? (
            // The 24px button does not make the row taller.
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--dm)' }}>{kindLabel(symbol, c, m)}</div>
              {actions}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--dm)', flexShrink: 0 }}>{kindLabel(symbol, c, m)}</div>
          )}
        </div>
      )}

      {/* Opening Advanced makes the body scroll; its fields keep their width (scrollGutter.ts). */}
      <div
        className="ticket-body"
        style={{ flex: 1, overflow: 'auto', ...stableGutter, padding: `18px ${lessGutter(24)} 20px 24px`, display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <NotTradableNote T={T} />
        <QuoteBoxes T={T} S={S} />
        <MarketIssue T={T} />
        <DepthBlock T={T} S={S} />
        <SideSwitch T={T} S={S} />
        <OrderTypeRow T={T} S={S} />
        <QtyPriceRow T={T} S={S} />
        <TypeExtras T={T} S={S} />
        <TifRow T={T} S={S} />
        <AdvancedToggle T={T} />
        {T.t.advancedOpen && <AdvancedBlock T={T} />}

        <div style={{ flex: 1 }} />

        {footer ? (
          footer(T)
        ) : (
          <>
            <Totals T={T} S={S} />
            <SubmitBlock T={T} S={S} busy={sending} label={sending ? c.submitting : undefined} />
          </>
        )}
      </div>
    </div>
  );
}
