// Today's executions (design "trades" for the fill tab).

import { useEffect } from 'react';
import { contractLabel } from '@shared/contract';
import { f0, f2, hms, px } from '@shared/format';
import type { Execution } from '@shared/types';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { useOrdersMessages } from './messages';
import { priceOrUndefined, tradeAmount } from './model';
import { EmptyRow, HeaderRow, Row, TableBody } from './table';

const TRADE_COLUMNS = '90px minmax(0,2fr) 60px repeat(4,minmax(0,1fr)) 110px';

export function TradesTable({ executions }: { executions: Execution[] }) {
  const m = useOrdersMessages();
  const c = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');

  // Executions arrive as they happen; re-request today's list when the tab opens.
  useEffect(() => {
    if (connected) window.tape.refreshExecutions().catch(() => undefined);
  }, [connected]);

  const headers = [m.time, m.contract, m.side, m.qty, m.fillPrice, m.amount, m.commission, m.orderId];
  return (
    <TableBody
      header={
        <HeaderRow columns={TRADE_COLUMNS}>
          {headers.map((h, i) => (
            <div key={i} style={{ textAlign: i >= 3 ? 'right' : 'left' }}>
              {h}
            </div>
          ))}
        </HeaderRow>
      }
    >
      {executions.length === 0 && <EmptyRow>{connected ? m.noTrades : c.notConnected}</EmptyRow>}
      {executions.map((e) => {
        const buy = e.side === 'BUY';
        const title = [e.exchange, e.execId].filter(Boolean).join(' · ');
        return (
          <Row key={e.execId} columns={TRADE_COLUMNS} title={title}>
            <div className="num" style={{ color: 'var(--dm)' }}>
              {hms(e.time)}
            </div>
            <div className="ellipsis selectable" style={{ fontSize: 14 }}>
              {contractLabel(e.contract)}
            </div>
            <div style={{ color: buy ? 'var(--up)' : 'var(--dn)', fontWeight: 500 }}>{buy ? c.buyShort : c.sellShort}</div>
            <div className="num" style={{ textAlign: 'right' }}>
              {f0(e.shares)}
            </div>
            <div className="num" style={{ textAlign: 'right' }}>
              {px(e.price)}
            </div>
            <div className="num" style={{ textAlign: 'right' }}>
              {f2(tradeAmount(e))}
            </div>
            <div className="num" style={{ textAlign: 'right', color: 'var(--mu)' }}>
              {f2(priceOrUndefined(e.commission))}
            </div>
            <div className="num selectable" style={{ textAlign: 'right', color: 'var(--dm)' }}>
              #{e.orderId}
            </div>
          </Row>
        );
      })}
    </TableBody>
  );
}
