// Working orders table (design "ordRows" for the work tab), with a Last column beside the order price.
// The actions cell (OrderActions.tsx) offers Modify / Cancel only for orders Tape can cancel, and
// names who placed the others with a "Why?".

import { useEffect } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { f0 } from '@shared/format';
import { timeColumn } from '@shared/timeFormat';
import type { WorkingOrder } from '@shared/types';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { useOrdersMessages } from './messages';
import { OrderActions } from './OrderActions';
import { openTicket } from '../panels/actions';
import { lastCellTitle, lastPriceText, orderLastPrice, ORDERS_QUOTE_OWNER, useOrderQuotes } from './lastPrice';
import { canModifyInTicket, isChildRow, orderPriceText, orderStatusText, orderTypeLabel, ticketPatchFromOrder, timeCell } from './model';
import { openInstrument } from './navigation';
import { EmptyRow, HeaderRow, Row, TableBody } from './table';

// The design gives the status column 70px, which truncates every status ("Working…");
// it gets the largest flexible share here so "Waiting · AAPL ≥ 235.00" and the TIF with its
// session or GTD expiry ("Pre-submitted · DAY · Overnight + Day", "Pre-submitted · GTD 10/09
// 04:00 PM ET", about 248px) stay readable at the minimum window width before IB's messages.
// Contract gets the next share, for option labels ("AAPL 10/16 230 Call"); at that width Price
// and Last, beside it, keep room for "12,345.67", Qty and Filled for "100,000" (longer values, such
// as a stop-limit's "240.00 / 239.50", are in full on hover). The time column is sized for the
// clock format (timeColumn).
export const workingColumns = (time: string): string =>
  `${time} minmax(0,1.3fr) 60px 80px minmax(0,0.6fr) minmax(0,0.8fr) minmax(0,0.8fr) minmax(0,0.6fr) minmax(70px,2.75fr) 120px`;

function modify(o: WorkingOrder): void {
  const s = useStore.getState();
  // openSymbol resets the ticket's price overrides, so patch the ticket afterwards.
  openInstrument(o.contract, s.view === 'opt' ? 'chart' : undefined);
  // A floating ticket collapsed to its bar expands with the order.
  openTicket(ticketPatchFromOrder(o));
  s.showToast(useOrdersMessages.now().modifyHint(o.orderId));
}

export function WorkingTable({ orders }: { orders: WorkingOrder[] }) {
  const m = useOrdersMessages();
  const c = useCommon();
  const clock = useClock();
  const columns = workingColumns(timeColumn(clock));
  const myClientId = useStore((s) => s.connection.clientId);
  const connected = useStore((s) => s.connection.status === 'connected');
  const quotes = useOrderQuotes(ORDERS_QUOTE_OWNER, orders);

  // Other apps' orders get no updates between IB's lists (main asks every 30 s): ask when the tab opens.
  useEffect(() => {
    if (connected) window.tape.refreshOrders().catch(() => undefined);
  }, [connected]);

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
          <div style={{ textAlign: 'right' }} title={m.lastTitle}>
            {m.last}
          </div>
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
        const title = (own ? m.ownOrder(o.orderId, o.clientId) : m.otherOrder(o)) + (o.message ? `\n${o.message}` : '');
        const price = orderPriceText(o);
        const quote = quotes[contractKey(o.contract)];
        const last = orderLastPrice(o.contract, quote);
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
            <div className="ellipsis" style={{ color: 'var(--mu)' }} title={`${m.typeNames[o.orderType] ?? orderTypeLabel(o.orderType, m)} (${o.orderType})`}>
              {orderTypeLabel(o.orderType, m)}
            </div>
            <div className="num ellipsis" style={{ textAlign: 'right' }} title={f0(o.totalQuantity)}>
              {f0(o.totalQuantity)}
            </div>
            <div className="num ellipsis" style={{ textAlign: 'right' }} title={o.orderType === 'STP LMT' ? `${m.stopLimitTitle}: ${price}` : price}>
              {price}
            </div>
            <div className="num ellipsis" style={{ textAlign: 'right' }} title={lastCellTitle(o, last, quote, m)}>
              {lastPriceText(last)}
            </div>
            <div className="num ellipsis" style={{ textAlign: 'right', color: 'var(--mu)' }} title={f0(o.filled)}>
              {f0(o.filled)}
            </div>
            <div className="ellipsis" style={{ color: st.tone === 'ac' ? 'var(--ac)' : 'var(--mu)' }} title={st.text}>
              {st.text}
            </div>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', whiteSpace: 'nowrap', minWidth: 0 }}>
              <OrderActions o={o} onModify={canModifyInTicket(o) ? () => modify(o) : undefined} />
            </div>
          </Row>
        );
      })}
    </TableBody>
  );
}
