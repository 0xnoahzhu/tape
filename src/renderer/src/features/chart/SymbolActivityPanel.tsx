// Bottom-left panel of the Trade page: positions and open orders of the current symbol
// (the stock and its derivatives), with Modify / Cancel for this app's working orders.

import { useMemo } from 'react';
import { contractKey, contractLabel, sameContract } from '@shared/contract';
import { f0, MINUS, px, sg, signColor } from '@shared/format';
import { timeColumn } from '@shared/timeFormat';
import { isOrderActive, type Position, type WorkingOrder } from '@shared/types';
import { lastPrice } from '../../hooks/useQuotes';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { confirmCancel } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { TabItems } from '../../ui/primitives';
import { livePrice, positionRow } from '../portfolio/calc';
import { useChartPrefs } from './chartPrefs';
import { useChartMessages } from './messages';
import { canModifyInTicket, orderPriceText, orderStatusText, ticketPatchFromOrder } from './orderModel';

const signed0 = (n: number | undefined) => (n == null ? '—' : sg(n, f0));

/** Right-aligned number that clips with an ellipsis (full value on hover) instead of overlapping its neighbor. */
function NumCell({ text, color }: { text: string; color?: string }) {
  return (
    <div className="ellipsis" title={text} style={{ textAlign: 'right', color }}>
      {text}
    </div>
  );
}

/** Stock first, then derivatives by label. */
function byInstrument(a: Position, b: Position): number {
  const sa = a.contract.secType === 'STK' ? 0 : 1;
  const sb = b.contract.secType === 'STK' ? 0 : 1;
  return sa - sb || contractLabel(a.contract).localeCompare(contractLabel(b.contract));
}

function PositionRow({ p, netLiq }: { p: Position; netLiq: number | undefined }) {
  // Valued like the Portfolio page: one price for value and P&L (the live quote, else IB's mark).
  const quote = useStore((s) => s.quotes[contractKey(p.contract)]);
  const r = positionRow(p, livePrice(p.contract.secType, quote, lastPrice(quote)), netLiq, '');
  const mv = r.value;
  const weight = mv != null && netLiq ? `${mv < 0 ? MINUS : ''}${((Math.abs(mv) / netLiq) * 100).toFixed(1)}%` : '—';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,2fr) repeat(6,minmax(0,1fr))',
        gap: 12,
        padding: '0 24px',
        height: 34,
        alignItems: 'center',
        font: '13px/1 var(--num)',
        fontVariantNumeric: 'tabular-nums',
        boxShadow: 'inset 0 1px 0 var(--ln2)',
      }}
    >
      <div className="ellipsis" style={{ fontFamily: 'var(--sans)' }}>
        {contractLabel(p.contract)}
      </div>
      <NumCell text={(p.quantity < 0 ? MINUS : '') + f0(Math.abs(p.quantity))} />
      <NumCell text={px(p.avgPrice)} color="var(--mu)" />
      <NumCell text={f0(mv)} />
      <NumCell text={weight} color="var(--mu)" />
      <NumCell text={signed0(r.unrealized)} color={signColor(r.unrealized)} />
      <NumCell text={signed0(r.dayPnl)} color={signColor(r.dayPnl)} />
    </div>
  );
}

/** Only orders placed by this API client can be modified or cancelled here (as on the Orders page). */
function OrderRow({ o, own }: { o: WorkingOrder; own: boolean }) {
  const m = useChartMessages();
  const common = useCommon();
  const clock = useClock();
  const st = orderStatusText(o, m.status, clock);
  const buy = o.action === 'BUY';
  const modify = () => {
    const s = useStore.getState();
    // The ticket trades the selected instrument: stock orders keep the underlying selected,
    // option orders select the option so the modification goes to the right contract.
    if (!sameContract(o.contract, s.symbol)) {
      const sameUnderlying = o.contract.secType === s.symbol.secType && o.contract.symbol === s.symbol.symbol;
      s.selectSymbol(o.contract, sameUnderlying ? s.symbolName : undefined);
    }
    s.patchTicket(ticketPatchFromOrder(o));
    s.showToast(m.modifyHint(o.orderId));
  };
  return (
    <div
      style={{
        display: 'grid',
        // The time column is sized for the clock format (timeColumn). "qty @ price" keeps room for
        // "100 @ 226.50" and grows little beyond it; the rest goes to contract and status (with its
        // good-after and GTD times, the larger share), which clip first in a narrow window.
        gridTemplateColumns: `${timeColumn(clock)} 48px minmax(0,1.2fr) minmax(96px,0.5fr) minmax(0,2fr) 110px`,
        gap: 12,
        padding: '0 24px',
        height: 34,
        alignItems: 'center',
        fontSize: 13,
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
      }}
    >
      <div style={{ font: '13px/1 var(--num)', color: 'var(--dm)', whiteSpace: 'nowrap' }}>{clock.time(o.createdAt, { seconds: true })}</div>
      <div style={{ color: buy ? 'var(--up)' : 'var(--dn)', fontWeight: 500 }}>{buy ? common.buyShort : common.sellShort}</div>
      <div className="ellipsis">{contractLabel(o.contract)}</div>
      <div className="ellipsis" style={{ fontFamily: 'var(--num)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
        {f0(o.totalQuantity)} @ {orderPriceText(o)}
      </div>
      <div className="ellipsis" title={o.message ?? o.whyHeld ?? st.text} style={{ color: st.accent ? 'var(--ac)' : 'var(--mu)' }}>
        {st.text}
      </div>
      <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
        {own && o.status !== 'PendingCancel' && (
          <>
            {canModifyInTicket(o) && (
              <div onClick={modify} style={{ color: 'var(--ac)', cursor: 'pointer' }}>
                {m.modify}
              </div>
            )}
            <div onClick={() => confirmCancel(o)} className="hover-tx" style={{ color: 'var(--dm)', cursor: 'pointer' }}>
              {m.cancel}
            </div>
          </>
        )}
        {!own && <div style={{ color: 'var(--mu)' }}>{o.clientId === 0 ? m.tws : m.clientN(o.clientId)}</div>}
      </div>
    </div>
  );
}

export function SymbolActivityPanel() {
  const m = useChartMessages();
  const symbol = useStore((s) => s.symbol);
  const allPositions = useStore((s) => s.positions);
  const allOrders = useStore((s) => s.orders);
  const netLiq = useStore((s) => s.account?.netLiquidation);
  const myClientId = useStore((s) => s.connection.clientId);
  const setPage = useStore((s) => s.setPage);
  const tab = useChartPrefs((s) => s.activityTab);
  const setTab = useChartPrefs((s) => s.setActivityTab);

  const sym = symbol.symbol;
  const positions = useMemo(() => allPositions.filter((p) => p.contract.symbol === sym && p.quantity !== 0).sort(byInstrument), [allPositions, sym]);
  const orders = useMemo(
    () => allOrders.filter((o) => isOrderActive(o.status) && o.contract.symbol === sym).sort((a, b) => b.createdAt - a.createdAt),
    [allOrders, sym],
  );

  return (
    <div style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div
          style={{
            height: 40,
            display: 'flex',
            alignItems: 'stretch',
            gap: 22,
            padding: '0 24px',
            fontSize: 13,
            flexShrink: 0,
            boxShadow: 'inset 0 -1px 0 var(--ln2)',
          }}
        >
          <TabItems
            tabs={[
              { key: 'pos', label: m.position, count: positions.length ? String(positions.length) : '' },
              { key: 'open', label: m.openOrders, count: orders.length ? String(orders.length) : '' },
            ]}
            value={tab}
            onChange={setTab}
          />
          <div style={{ flex: 1 }} />
          <div onClick={() => setPage('ord')} style={{ display: 'flex', alignItems: 'center', color: 'var(--ac)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
            {m.allOrders}
          </div>
        </div>
        {tab === 'open' ? (
          orders.length ? (
            // orderId is unique per API client only (TWS orders all have 0).
            orders.map((o) => <OrderRow key={o.permId ?? `${o.clientId}:${o.orderId}`} o={o} own={o.clientId === myClientId} />)
          ) : (
            <div style={{ padding: '10px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.noOrders(sym)}</div>
          )
        ) : positions.length ? (
          <div>
            {positions.map((p) => (
              <PositionRow key={p.key} p={p} netLiq={netLiq} />
            ))}
          </div>
        ) : (
          <div style={{ padding: '8px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.noPosition(sym)}</div>
        )}
      </div>
    </div>
  );
}
