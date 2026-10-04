// Working orders table (design "ordRows" for the work tab).

import { contractLabel } from '@shared/contract';
import { f0 } from '@shared/format';
import { timeColumn } from '@shared/timeFormat';
import type { WorkingOrder } from '@shared/types';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { confirmCancel } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { useOrdersMessages, type OrdersMessages } from './messages';
import { canModifyInTicket, isChildRow, orderPriceText, orderStatusText, orderTypeLabel, ticketPatchFor, timeCell } from './model';
import { openInstrument } from './navigation';
import { EmptyRow, HeaderRow, Row, TableBody } from './table';

// The design gives the status column 70px, which truncates every status ("Working…");
// it gets the largest flexible share here so "Waiting · AAPL ≥ 235.00" and the TIF with its
// session or GTD expiry ("Pre-submitted · DAY · Overnight + Day", "Pre-submitted · GTD 10/09
// 4:00 PM ET") stay readable at the minimum window width before IB's messages. Contract keeps room
// for an option ("AAPL Oct16 230 Call") and Price for a stop-limit "240.00 / 239.50".
// The time column is sized for the clock format (timeColumn).
export const workingColumns = (time: string): string =>
  `${time} minmax(0,1.3fr) 60px 80px minmax(0,0.75fr) minmax(0,1.25fr) minmax(0,0.75fr) minmax(70px,2.45fr) 120px`;

function modify(o: WorkingOrder): void {
  const s = useStore.getState();
  // openSymbol resets the ticket's price overrides, so patch the ticket afterwards.
  openInstrument(o.contract, s.view === 'opt' ? 'chart' : undefined);
  s.patchTicket(ticketPatchFor(o));
  s.showToast(useOrdersMessages.now().modifyHint(o.orderId));
}

function clientLabel(clientId: number, m: OrdersMessages): string {
  return clientId === 0 ? m.tws : m.clientN(clientId);
}

export function WorkingTable({ orders }: { orders: WorkingOrder[] }) {
  const m = useOrdersMessages();
  const c = useCommon();
  const clock = useClock();
  const columns = workingColumns(timeColumn(clock));
  const myClientId = useStore((s) => s.connection.clientId);
  const connected = useStore((s) => s.connection.status === 'connected');

  return (
    <TableBody
      header={
        <HeaderRow columns={columns}>
          <div>{m.time}</div>
          <div>{m.contract}</div>
          <div>{m.side}</div>
          <div>{m.type}</div>
          <div style={{ textAlign: 'right' }}>{m.qty}</div>
          <div style={{ textAlign: 'right' }}>{m.price}</div>
          <div style={{ textAlign: 'right' }}>{m.filled}</div>
          <div>{m.statusTif}</div>
          <div />
        </HeaderRow>
      }
    >
      {orders.length === 0 && <EmptyRow>{connected ? c.noWorkingOrders : c.notConnected}</EmptyRow>}
      {orders.map((o) => {
        const own = o.clientId === myClientId;
        const st = orderStatusText(o, m, clock);
        const buy = o.action === 'BUY';
        const child = isChildRow(o, orders);
        const title = (own ? m.ownOrder(o.orderId, o.clientId) : m.otherOrder(o.orderId, o.clientId)) + (o.message ? `\n${o.message}` : '');
        const price = orderPriceText(o);
        return (
          <Row key={o.permId ?? `${o.clientId}:${o.orderId}`} columns={columns} title={title}>
            <div className="num" style={{ color: 'var(--dm)', whiteSpace: 'nowrap' }}>
              {timeCell(o.createdAt, clock)}
            </div>
            <div className="ellipsis selectable" style={{ fontSize: 14 }}>
              {child && <span style={{ color: 'var(--dm)' }}>↳ </span>}
              {contractLabel(o.contract)}
            </div>
            <div style={{ color: buy ? 'var(--up)' : 'var(--dn)', fontWeight: 500 }}>{buy ? c.buyShort : c.sellShort}</div>
            <div className="ellipsis" style={{ color: 'var(--mu)' }}>
              {orderTypeLabel(o.orderType, m)}
            </div>
            <div className="num" style={{ textAlign: 'right' }}>
              {f0(o.totalQuantity)}
            </div>
            <div className="num ellipsis" style={{ textAlign: 'right' }} title={o.orderType === 'STP LMT' ? `${m.stopLimitTitle}: ${price}` : undefined}>
              {price}
            </div>
            <div className="num" style={{ textAlign: 'right', color: 'var(--mu)' }}>
              {f0(o.filled)}
            </div>
            <div className="ellipsis" style={{ color: st.tone === 'ac' ? 'var(--ac)' : 'var(--mu)' }} title={st.text}>
              {st.text}
            </div>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
              {own && o.status !== 'PendingCancel' && (
                <>
                  {canModifyInTicket(o) && (
                    <div onClick={() => modify(o)} style={{ color: 'var(--ac)', cursor: 'pointer' }}>
                      {m.modify}
                    </div>
                  )}
                  <div onClick={() => confirmCancel(o)} className="hover-tx" style={{ color: 'var(--dm)', cursor: 'pointer' }}>
                    {m.cancel}
                  </div>
                </>
              )}
              {!own && <div style={{ color: 'var(--mu)' }}>{clientLabel(o.clientId, m)}</div>}
            </div>
          </Row>
        );
      })}
    </TableBody>
  );
}
