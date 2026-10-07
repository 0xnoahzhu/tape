// Order ticket (design 3a, right column of the Trade page). Its state lives in store.ticket so the
// Book, "Modify" and the command bar can prefill it; prices nobody typed follow the market.
// With Level 2 on, the Book (DepthBlock.tsx) sits between the bid / ask and the entry fields.
// The parts and the controller are shared with the floating ticket (features/panels):
// parts.tsx, DepthBlock.tsx, useTicket.ts.

import type { ReactNode } from 'react';
import type { PanelId } from '../panels/model';
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

  return (
    <div style={{ gridColumn: 2, gridRow: '1 / 3', background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, ...(header ? { flex: 1 } : null) }}>
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

      <div className="ticket-body" style={{ flex: 1, overflow: 'auto', padding: '18px 24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            <SubmitBlock T={T} S={S} />
          </>
        )}
      </div>
    </div>
  );
}
