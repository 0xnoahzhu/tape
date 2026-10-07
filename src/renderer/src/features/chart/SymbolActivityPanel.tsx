// Bottom-left panel of the Trade page, under the chart and under the options desk: positions and
// open orders of the current symbol (the stock and its derivatives), with Modify / Cancel for this
// app's working orders. The rows are valued like the Portfolio page (calc.ts → positionRow: one price
// for value and P&L) from the panel's own quote lines ('symbol-activity', a visible owner; options
// with their model greeks).
// Under the options desk (`options`) the panel adds the underlying's exposure (Δ, $Δ, Γ, Θ, Vega:
// exposure.ts → portfolioGreeks, as on the Positions toolbar), DTE and Δ cells on the rows, and a
// click on an option row opens its expiry in the chain. An order just placed from a floating panel
// flashes in the open orders (activityModel.ts → isFreshOrder).

import { useMemo } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { f0, MINUS, px, sg, signColor } from '@shared/format';
import { timeColumn } from '@shared/timeFormat';
import { isOrderActive, type ContractRef, type Position, type Quote, type QuoteSubscription, type WorkingOrder } from '@shared/types';
import { lastPrice, useQuotesByKey, useQuoteSubscriptionList } from '../../hooks/useQuotes';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { confirmCancel } from '../../state/orderActions';
import { useOrderFeedback } from '../../state/orderFeedback';
import { useStore } from '../../state/store';
import { DoubleChevronIcon } from '../../ui/icons';
import { TabItems } from '../../ui/primitives';
import { useDesk } from '../options/deskStore';
import { modifyOrderInTicket } from '../panels/actions';
import { livePrice, positionRow, quoteContract, type PositionRow } from '../portfolio/calc';
import { useMinute } from '../portfolio/data';
import { optionLine, portfolioGreeks, positionDelta, underlyingKey } from '../portfolio/exposure';
import { GreeksLine } from '../portfolio/GreeksLine';
import { showPortfolio } from '../portfolio/uiState';
import { byInstrument, isFreshOrder } from './activityModel';
import { useChartPrefs } from './chartPrefs';
import { useChartMessages } from './messages';
import { canModifyInTicket, orderPriceText, orderStatusText } from './orderModel';
import { useNow } from './useNow';

/** The panel's quote owner (main/market/subscriptions.ts counts it as visible). */
const QUOTE_OWNER = 'symbol-activity';

const signed0 = (n: number | undefined) => (n == null ? '—' : sg(n, f0));
const isOption = (c: ContractRef) => c.secType === 'OPT' || c.secType === 'FOP';

/** Column templates shared by the rows and their header. */
const POS_GRID = 'minmax(0,2fr) repeat(6,minmax(0,1fr))';
/** Under the options desk: DTE and Δ after Qty. */
const POS_GRID_OPT = 'minmax(0,2fr) repeat(8,minmax(0,1fr))';
// The time column is sized for the clock format (timeColumn). "qty @ price" keeps room for
// "100 @ 226.50" and grows little beyond it; the rest goes to contract and status (with its
// good-after and GTD times, the larger share), which clip first in a narrow window.
const orderGrid = (clock: Parameters<typeof timeColumn>[0]) => `${timeColumn(clock)} 48px minmax(0,1.2fr) minmax(96px,0.5fr) minmax(0,2fr) 110px`;

/**
 * The column names above the rows: [label, full name on hover]; `right` marks the numeric columns.
 * `ruled`: a rule under the names, for rows that draw theirs below (orders) rather than above (positions).
 */
function HeaderRow({ grid, headers, right, ruled }: { grid: string; headers: Array<[string, string]>; right: (i: number) => boolean; ruled?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: grid,
        gap: 12,
        padding: '0 24px',
        height: 30,
        alignItems: 'center',
        fontSize: 12,
        color: 'var(--dm)',
        boxShadow: ruled ? 'inset 0 -1px 0 var(--ln2)' : undefined,
      }}
    >
      {headers.map(([label, full], i) => (
        <div key={i} className="ellipsis" title={full} style={{ textAlign: right(i) ? 'right' : 'left' }}>
          {label}
        </div>
      ))}
    </div>
  );
}

/** Right-aligned number that clips with an ellipsis (full value on hover) instead of overlapping its neighbor. */
function NumCell({ text, color, cell }: { text: string; color?: string; cell?: string }) {
  return (
    <div className="ellipsis" data-cell={cell} title={text || undefined} style={{ textAlign: 'right', color }}>
      {text}
    </div>
  );
}

/** The cells a row adds under the options desk. */
interface OptionCells {
  /** Calendar days to expiry (New York's) and whether that is SOON_DAYS or fewer; undefined for the stock. */
  dte?: { days: number; soon: boolean };
  /** Share-equivalent delta (exposure.ts → positionDelta); undefined while IB has not sent the greeks. */
  delta?: number;
  /** The option's expiry (YYYYMMDD), opened in the chain by a click. */
  expiry?: string;
}

function HoldingRow({ r, netLiq, opt }: { r: PositionRow; netLiq: number | undefined; opt?: OptionCells }) {
  const m = useChartMessages();
  const p = r.position;
  const mv = r.value;
  const weight = mv != null && netLiq ? `${mv < 0 ? MINUS : ''}${((Math.abs(mv) / netLiq) * 100).toFixed(1)}%` : '—';
  const expiry = opt?.expiry;
  return (
    <div
      data-activity="position"
      data-position={r.key}
      data-expiry={expiry}
      onClick={expiry ? () => useDesk.getState().patch({ expiry, tab: 'chain' }) : undefined}
      title={expiry ? m.openExpiry : undefined}
      className={expiry ? 'hover-p2' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: opt ? POS_GRID_OPT : POS_GRID,
        gap: 12,
        padding: '0 24px',
        height: 34,
        alignItems: 'center',
        font: '13px/1 var(--num)',
        fontVariantNumeric: 'tabular-nums',
        boxShadow: 'inset 0 1px 0 var(--ln2)',
        cursor: expiry ? 'pointer' : undefined,
      }}
    >
      <div className="ellipsis" style={{ fontFamily: 'var(--sans)' }}>
        {contractLabel(p.contract)}
      </div>
      <NumCell text={(p.quantity < 0 ? MINUS : '') + f0(Math.abs(p.quantity))} />
      {opt && (
        <>
          <NumCell cell="dte" text={opt.dte ? f0(opt.dte.days) : ''} color={opt.dte?.soon ? 'var(--ac)' : undefined} />
          <NumCell cell="delta" text={signed0(opt.delta)} />
        </>
      )}
      <NumCell text={px(p.avgPrice)} color="var(--mu)" />
      <NumCell text={f0(mv)} />
      <NumCell text={weight} color="var(--mu)" />
      <NumCell text={signed0(r.unrealized)} color={signColor(r.unrealized)} />
      <NumCell text={signed0(r.dayPnl)} color={signColor(r.dayPnl)} />
    </div>
  );
}

/** Only orders placed by this API client can be modified or cancelled here (as on Portfolio › Orders). */
function OrderRow({ o, own, fresh }: { o: WorkingOrder; own: boolean; fresh: boolean }) {
  const m = useChartMessages();
  const common = useCommon();
  const clock = useClock();
  const st = orderStatusText(o, m.status, clock);
  const buy = o.action === 'BUY';
  const modify = () => {
    // The order's own contract is selected first (and the chart shown); a floating ticket collapsed to its bar expands.
    modifyOrderInTicket(o);
    useStore.getState().showToast(m.modifyHint(o.orderId));
  };
  return (
    <div
      data-activity="order"
      data-fresh={fresh || undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: orderGrid(clock),
        gap: 12,
        padding: '0 24px',
        height: 34,
        alignItems: 'center',
        fontSize: 13,
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
        ...(fresh ? { animation: 'tape-flash 2.4s ease-out' } : null),
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

/** The open orders with their column names; the order a floating panel just placed flashes (for FRESH_MS). */
function OrderList({ orders, myClientId }: { orders: WorkingOrder[]; myClientId: number }) {
  const m = useChartMessages();
  const clock = useClock();
  const sent = useOrderFeedback((s) => s.sent);
  const now = useNow(5_000).getTime();
  return (
    <div>
      {/* The actions column has no name. */}
      <HeaderRow grid={orderGrid(clock)} headers={[...m.orderHeaders, ['', '']]} right={(i) => i === 3} ruled />
      {/* orderId is unique per API client only (TWS orders all have 0). */}
      {orders.map((o) => (
        <OrderRow
          key={o.permId ?? `${o.clientId}:${o.orderId}`}
          o={o}
          own={o.clientId === myClientId}
          fresh={isFreshOrder(o, sent.ticket, now) || isFreshOrder(o, sent.strategy, now)}
        />
      ))}
    </div>
  );
}

/** The current symbol's positions (stock first, then options by expiry) and working orders (newest first). */
function useSymbolActivity() {
  const symbol = useStore((s) => s.symbol);
  const allPositions = useStore((s) => s.positions);
  const allOrders = useStore((s) => s.orders);
  const sym = symbol.symbol;
  const positions = useMemo(() => allPositions.filter((p) => p.contract.symbol === sym && p.quantity !== 0).sort(byInstrument), [allPositions, sym]);
  const orders = useMemo(
    () => allOrders.filter((o) => isOrderActive(o.status) && o.contract.symbol === sym).sort((a, b) => b.createdAt - a.createdAt),
    [allOrders, sym],
  );
  return { sym, positions, orders };
}

/**
 * The positions as rows valued like the Portfolio page, with the quotes they read: each position's
 * own and an option's underlying's. Subscribes every position: an option with its model greeks
 * (the options risk watcher already holds those lines in the background, and the chart or the desk
 * the stock's, so this mostly raises their priority).
 */
function useActivityRows(positions: Position[]): { rows: PositionRow[]; quotes: Record<string, Quote>; netLiq: number | undefined } {
  const netLiq = useStore((s) => s.account?.netLiquidation);
  const subs = useMemo(() => {
    const seen = new Set<string>();
    const out: QuoteSubscription[] = [];
    for (const p of positions) {
      const key = contractKey(p.contract);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ contract: quoteContract(p.contract), profile: isOption(p.contract) ? 'option' : 'basic' });
    }
    return out;
  }, [positions]);
  useQuoteSubscriptionList(QUOTE_OWNER, subs);
  const keys = useMemo(() => [...new Set(positions.flatMap((p) => (isOption(p.contract) ? [contractKey(p.contract), underlyingKey(p.contract)] : [contractKey(p.contract)])))], [positions]);
  const quotes = useQuotesByKey(keys);
  const rows = useMemo(
    () =>
      positions.map((p) => {
        const q = quotes[contractKey(p.contract)];
        return positionRow(p, livePrice(p.contract.secType, q, lastPrice(q)), netLiq, '');
      }),
    [positions, quotes, netLiq],
  );
  return { rows, quotes, netLiq };
}

/** 28px icon button in the panel's header and bar. */
function PanelIconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="hover-tx hover-p2"
      style={{ width: 28, height: 28, alignSelf: 'center', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 'none', background: 'transparent', color: 'var(--dm)', cursor: 'pointer' }}
    >
      {children}
    </button>
  );
}

/** Height of the collapsed bar (TradePage reserves this row). */
export const ACTIVITY_BAR_H = 32;

/** The collapsed panel: counts of the symbol's positions and working orders, click to expand. */
export function SymbolActivityBar({ onExpand }: { onExpand: () => void }) {
  const m = useChartMessages();
  const { positions, orders } = useSymbolActivity();
  return (
    <div
      data-activity="bar"
      onClick={onExpand}
      title={m.expandPanel}
      className="hover-tx"
      style={{ height: ACTIVITY_BAR_H, display: 'flex', alignItems: 'center', gap: 16, padding: '0 10px 0 24px', background: 'var(--p)', color: 'var(--mu)', fontSize: 12, cursor: 'pointer', minWidth: 0 }}
    >
      <div>
        {m.position} <span className="num">{positions.length}</span>
      </div>
      <div>
        {m.openOrders} <span className="num">{orders.length}</span>
      </div>
      <div style={{ flex: 1 }} />
      <PanelIconButton title={m.expandPanel} onClick={onExpand}>
        <DoubleChevronIcon dir="up" size={14} />
      </PanelIconButton>
    </div>
  );
}

/** `options`: under the options desk (the exposure line, DTE and Δ, option rows open their expiry). */
export function SymbolActivityPanel({ onCollapse, options = false }: { onCollapse?: () => void; options?: boolean }) {
  const m = useChartMessages();
  const myClientId = useStore((s) => s.connection.clientId);
  const tab = useChartPrefs((s) => s.activityTab);
  const setTab = useChartPrefs((s) => s.setActivityTab);
  const { sym, positions, orders } = useSymbolActivity();
  const { rows, quotes, netLiq } = useActivityRows(positions);
  const minute = useMinute();
  // As the Positions toolbar: shown while the symbol's rows hold an option.
  const greeks = useMemo(() => (options ? portfolioGreeks(rows, quotes) : null), [options, rows, quotes]);
  const optionCells = (r: PositionRow): OptionCells => {
    const c = r.position.contract;
    const line = optionLine(r, quotes, rows, new Date(minute));
    const expiry = isOption(c) && /^\d{8}/.test(c.lastTradeDate ?? '') ? c.lastTradeDate!.slice(0, 8) : undefined;
    return { dte: line?.dte != null ? { days: line.dte, soon: line.soon } : undefined, delta: positionDelta(r, quotes), expiry };
  };
  const posHeaders = options ? [m.posHeaders[0], m.posHeaders[1], m.dteHeader, m.deltaHeader, ...m.posHeaders.slice(2)] : m.posHeaders;

  return (
    <div data-activity="panel" data-view={options ? 'opt' : 'chart'} style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div
          style={{
            height: 40,
            display: 'flex',
            alignItems: 'stretch',
            gap: 22,
            padding: onCollapse ? '0 10px 0 24px' : '0 24px',
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
          {greeks && greeks.options > 0 && (
            <div data-activity="exposure" title={m.exposureHint(sym)} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, minWidth: 0, overflow: 'hidden' }}>
              <span style={{ color: 'var(--mu)', whiteSpace: 'nowrap' }}>{m.exposure}</span>
              <GreeksLine g={greeks} />
            </div>
          )}
          <div onClick={() => showPortfolio('ord')} style={{ display: 'flex', alignItems: 'center', color: 'var(--ac)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
            {m.allOrders}
          </div>
          {onCollapse && (
            <PanelIconButton title={m.collapsePanel} onClick={onCollapse}>
              <DoubleChevronIcon dir="down" size={14} />
            </PanelIconButton>
          )}
        </div>
        {tab === 'open' ? (
          orders.length ? (
            <OrderList orders={orders} myClientId={myClientId} />
          ) : (
            <div style={{ padding: '10px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.noOrders(sym)}</div>
          )
        ) : rows.length ? (
          <div>
            <HeaderRow grid={options ? POS_GRID_OPT : POS_GRID} headers={posHeaders} right={(i) => i > 0} />
            {rows.map((r) => (
              <HoldingRow key={r.key} r={r} netLiq={netLiq} opt={options ? optionCells(r) : undefined} />
            ))}
          </div>
        ) : (
          <div style={{ padding: '8px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.noPosition(sym)}</div>
        )}
      </div>
    </div>
  );
}
