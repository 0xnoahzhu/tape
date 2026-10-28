// Bottom-left panel of the Trade page, under the chart and under the options desk: positions and
// open orders of the current symbol (the stock and its derivatives), with Modify / Cancel for the
// orders Tape can cancel (who placed the others, with a "Why?": orders/OrderActions.tsx) and, where
// the panel is wide enough, each order's last price beside its price.
// The positions show IB's own figures as the Portfolio page does (calc.ts → positionRow): IB's average
// cost, and the value, unrealized and day P&L from IB's P&L engine in real time, else its portfolio
// update (each cell's tooltip says which). The panel's own quote lines ('symbol-activity', a visible
// owner; options with their model greeks) serve the exposure below; the open orders' lines are held
// only while their tab shows ('symbol-orders'). Under the options desk (`options`) the panel adds
// the underlying's exposure (Δ, $Δ, Γ, Θ, Vega: exposure.ts → portfolioGreeks), DTE and Δ cells on
// the rows, and a click on an option row opens its expiry in the chain. A click on any other row,
// a position or an order (not on its Modify / Cancel), opens that instrument's own chart (an
// option's too: orders/navigation.ts → openRowChart), under either view. An option row's context
// menu opens the option's own chart too (it becomes the ticket's instrument). An order just
// placed from a floating panel flashes in the open orders (activityModel.ts → isFreshOrder).

import { useMemo, useRef, useState } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { f0, MINUS, px, sg, signColor } from '@shared/format';
import { timeColumn } from '@shared/timeFormat';
import { isOrderActive, type ContractRef, type Position, type Quote, type QuoteSubscription, type WorkingOrder } from '@shared/types';
import { useQuotesByKey, useQuoteSubscriptionList } from '../../hooks/useQuotes';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { useConnectedOrders } from '../../state/connectedLists';
import { useOrderFeedback } from '../../state/orderFeedback';
import { useStore } from '../../state/store';
import { DoubleChevronIcon } from '../../ui/icons';
import { TabItems } from '../../ui/primitives';
import { stableGutter } from '../../ui/scrollGutter';
import { Dropdown, MenuChoice } from '../../ui/select';
import { useDesk } from '../options/deskStore';
import { distanceText, lastCellTitle, lastPriceText, orderLastPrice, SYMBOL_ORDERS_QUOTE_OWNER, useOrderQuotes } from '../orders/lastPrice';
import { useOrdersMessages } from '../orders/messages';
import { openOptionChart, openRowChart } from '../orders/navigation';
import { clickForControl } from '../orders/table';
import { OrderActions } from '../orders/OrderActions';
import { modifyOrderInTicket } from '../panels/actions';
import { positionRow, quoteContract, type FigureSource, type PositionRow } from '../portfolio/calc';
import { useMinute } from '../portfolio/data';
import { optionDte, portfolioGreeks, positionDelta, underlyingKey } from '../portfolio/exposure';
import { GreeksLine } from '../portfolio/GreeksLine';
import { usePortfolioMessages } from '../portfolio/messages';
import { showPortfolio } from '../portfolio/uiState';
import { byInstrument, isFreshOrder } from './activityModel';
import { useChartPrefs } from './chartPrefs';
import { useChartMessages } from './messages';
import { canModifyInTicket, lastColumnFits, orderColumns, orderPriceText, orderStatusText } from './orderModel';
import { useNow } from './useNow';
import { useSize } from './useSize';

/** The panel's quote owner (main/market/subscriptions.ts counts it as visible). */
const QUOTE_OWNER = 'symbol-activity';

const signed0 = (n: number | undefined) => (n == null ? '—' : sg(n, f0));
const isOption = (c: ContractRef) => c.secType === 'OPT' || c.secType === 'FOP';

/** Column templates shared by the rows and their header. */
const POS_GRID = 'minmax(0,2fr) repeat(5,minmax(0,1fr))';
/** Under the options desk: DTE and Δ after Qty. */
const POS_GRID_OPT = 'minmax(0,2fr) repeat(7,minmax(0,1fr))';
/** With the Last column where it fits (orderModel.ts → orderColumns, lastColumnFits). */
const orderGrid = (clock: Parameters<typeof timeColumn>[0], withLast: boolean) => orderColumns(timeColumn(clock), withLast);
/** Where the Last column's name is in orderHeaders. */
const LAST_HEADER = 4;

/**
 * A list's header over its rows, which scroll on their own: the scrollbar runs beside the rows only.
 * Both keep the same room for it (scrollGutter.ts), so the header's columns stay over the rows'; the
 * header's rule runs on over that room, so the scrollbar starts right under it.
 */
function ScrollList({ header, children }: { header: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <div style={{ flexShrink: 0, overflow: 'hidden', ...stableGutter, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>{header}</div>
      <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto', ...stableGutter }}>{children}</div>
    </>
  );
}

/**
 * The column names above the rows: [label, full name on hover]; `right` marks the numeric columns.
 */
function HeaderRow({ grid, headers, right }: { grid: string; headers: Array<[string, string]>; right: (i: number) => boolean }) {
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

/**
 * Right-aligned number that clips with an ellipsis (full value on hover) instead of overlapping its
 * neighbor. `source`: which of IB's sources the figure shows, after it in the tooltip.
 */
function NumCell({ text, color, cell, source }: { text: string; color?: string; cell?: string; source?: string }) {
  return (
    <div className="ellipsis" data-cell={cell} title={[text, source].filter(Boolean).join('\n') || undefined} style={{ textAlign: 'right', color }}>
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

function HoldingRow({ r, opt }: { r: PositionRow; opt?: OptionCells }) {
  const m = useChartMessages();
  const common = useCommon();
  const sources = usePortfolioMessages().words.sources;
  const source = (s: FigureSource | undefined) => (s ? sources[s] : undefined);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const p = r.position;
  const expiry = opt?.expiry;
  const openChart = () => openRowChart(p.contract);
  // Under the desk an option row selects its expiry in the chain; any other row opens its own chart.
  const onClick = expiry ? () => useDesk.getState().patch({ expiry, tab: 'chain' }) : openChart;
  return (
    <>
      <div
        data-activity="position"
        data-position={r.key}
        data-expiry={expiry}
        onClick={onClick}
        onContextMenu={
          isOption(p.contract)
            ? (e) => {
                e.preventDefault();
                // Under the cell clicked.
                const row = e.currentTarget;
                setMenu([...row.children].find((c): c is HTMLElement => c.contains(e.target as Node)) ?? row);
              }
            : undefined
        }
        title={expiry ? m.openExpiry : common.openChart}
        className="hover-p2"
        style={{
          display: 'grid',
          gridTemplateColumns: opt ? POS_GRID_OPT : POS_GRID,
          gap: 12,
          padding: '0 24px',
          height: 34,
          alignItems: 'center',
          font: '13px/1 var(--num)',
          fontVariantNumeric: 'tabular-nums',
          boxShadow: 'inset 0 -1px 0 var(--ln2)',
          cursor: 'pointer',
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
        <NumCell cell="averageCost" text={px(p.averageCost)} color="var(--mu)" />
        <NumCell cell="value" text={f0(r.value)} source={source(r.valueSource)} />
        <NumCell cell="unrealized" text={signed0(r.unrealized)} color={signColor(r.unrealized)} source={source(r.unrealizedSource)} />
        <NumCell cell="dayPnl" text={signed0(r.dayPnl)} color={signColor(r.dayPnl)} source={r.dayPnl === undefined ? undefined : sources.pnl} />
      </div>
      {/* Beside the row, not in it: a pick would reach the row's click through the portal. */}
      {menu && (
        <Dropdown anchor={menu} width={180} onClose={() => setMenu(null)}>
          <MenuChoice
            label={common.openChart}
            onPick={() => {
              setMenu(null);
              openOptionChart(p.contract);
            }}
          />
        </Dropdown>
      )}
    </>
  );
}

/**
 * Only orders Tape can cancel get Modify / Cancel here (as on Portfolio › Orders: OrderActions).
 * `withLast`: the Last cell after "qty @ price"; without it the last price is in that cell's tooltip.
 */
function OrderRow({ o, fresh, quote, withLast }: { o: WorkingOrder; fresh: boolean; quote: Quote | undefined; withLast: boolean }) {
  const m = useChartMessages();
  const om = useOrdersMessages();
  const common = useCommon();
  const clock = useClock();
  const st = orderStatusText(o, m.status, clock);
  const buy = o.action === 'BUY';
  const last = orderLastPrice(o.contract, quote);
  const distance = distanceText(o, last, om);
  const modify = () => {
    // The order's own contract is selected first (and the chart shown); a floating ticket collapsed to its bar expands.
    modifyOrderInTicket(o);
    useStore.getState().showToast(m.modifyHint(o.orderId));
  };
  return (
    <div
      data-activity="order"
      data-fresh={fresh || undefined}
      // Opens the order's instrument's chart, not on Modify / Cancel / Why?.
      onClick={(e) => !clickForControl(e) && openRowChart(o.contract)}
      title={common.openChart}
      className="hover-p2"
      style={{
        cursor: 'pointer',
        display: 'grid',
        gridTemplateColumns: orderGrid(clock, withLast),
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
      <div
        className="ellipsis"
        style={{ fontFamily: 'var(--num)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
        title={withLast ? undefined : [`${om.last} ${lastPriceText(last)}`, distance].filter(Boolean).join(' · ')}
      >
        {f0(o.totalQuantity)} @ {orderPriceText(o)}
      </div>
      {withLast && (
        <div
          className="ellipsis"
          data-cell="last"
          style={{ fontFamily: 'var(--num)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
          title={lastCellTitle(o, last, quote, om)}
        >
          {lastPriceText(last)}
        </div>
      )}
      <div className="ellipsis" title={o.message ?? o.whyHeld ?? st.text} style={{ color: st.accent ? 'var(--ac)' : 'var(--mu)' }}>
        {st.text}
      </div>
      <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', whiteSpace: 'nowrap', minWidth: 0 }}>
        <OrderActions o={o} onModify={canModifyInTicket(o) ? modify : undefined} />
      </div>
    </div>
  );
}

/**
 * The open orders with their column names; the order a floating panel just placed flashes (for
 * FRESH_MS). Their quotes are held while the list shows (the stock's line is the chart's or the desk's).
 */
function OrderList({ orders, withLast }: { orders: WorkingOrder[]; withLast: boolean }) {
  const m = useChartMessages();
  const clock = useClock();
  const sent = useOrderFeedback((s) => s.sent);
  const now = useNow(5_000).getTime();
  const quotes = useOrderQuotes(SYMBOL_ORDERS_QUOTE_OWNER, orders);
  const headers = withLast ? m.orderHeaders : m.orderHeaders.filter((_, i) => i !== LAST_HEADER);
  return (
    // The actions column has no name.
    <ScrollList header={<HeaderRow grid={orderGrid(clock, withLast)} headers={[...headers, ['', '']]} right={(i) => i === 3 || (withLast && i === LAST_HEADER)} />}>
      {/* orderId is unique per API client only (TWS orders all have 0). */}
      {orders.map((o) => (
        <OrderRow
          key={o.permId ?? `${o.clientId}:${o.orderId}`}
          o={o}
          fresh={isFreshOrder(o, sent.ticket, now) || isFreshOrder(o, sent.strategy, now)}
          quote={quotes[contractKey(o.contract)]}
          withLast={withLast}
        />
      ))}
    </ScrollList>
  );
}

/** The current symbol's positions (stock first, then options by expiry) and working orders (newest first). */
function useSymbolActivity() {
  const symbol = useStore((s) => s.symbol);
  const allPositions = useStore((s) => s.positions);
  const allOrders = useConnectedOrders();
  const sym = symbol.symbol;
  const positions = useMemo(() => allPositions.filter((p) => p.contract.symbol === sym && p.quantity !== 0).sort(byInstrument), [allPositions, sym]);
  const orders = useMemo(
    () => allOrders.filter((o) => isOrderActive(o.status) && o.contract.symbol === sym).sort((a, b) => b.createdAt - a.createdAt),
    [allOrders, sym],
  );
  return { sym, positions, orders };
}

/**
 * The positions as rows with IB's figures (as on the Portfolio page), with the quotes the exposure
 * reads: each position's own and an option's underlying's. Subscribes every position: an option with
 * its model greeks (the options risk watcher already holds those lines in the background, and the
 * chart or the desk the stock's, so this mostly raises their priority).
 */
function useActivityRows(positions: Position[]): { rows: PositionRow[]; quotes: Record<string, Quote> } {
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
  const rows = useMemo(() => positions.map((p) => positionRow(p, quotes[contractKey(p.contract)]?.mark, '')), [positions, quotes]);
  return { rows, quotes };
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
      // Its right padding adds the panel's room for a scrollbar (--sbw), so the expand button is where the collapse button was.
      style={{ height: ACTIVITY_BAR_H, display: 'flex', alignItems: 'center', gap: 16, padding: '0 calc(10px + var(--sbw, 0px)) 0 24px', background: 'var(--p)', color: 'var(--mu)', fontSize: 12, cursor: 'pointer', minWidth: 0 }}
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
  const tab = useChartPrefs((s) => s.activityTab);
  const setTab = useChartPrefs((s) => s.setActivityTab);
  const { sym, positions, orders } = useSymbolActivity();
  const { rows, quotes } = useActivityRows(positions);
  const minute = useMinute();
  // Shown while the symbol's rows hold an option.
  const greeks = useMemo(() => (options ? portfolioGreeks(rows, quotes) : null), [options, rows, quotes]);
  const optionCells = (r: PositionRow): OptionCells => {
    const c = r.position.contract;
    const expiry = isOption(c) && /^\d{8}/.test(c.lastTradeDate ?? '') ? c.lastTradeDate!.slice(0, 8) : undefined;
    return { dte: optionDte(r, new Date(minute)), delta: positionDelta(r, quotes), expiry };
  };
  const posHeaders = options ? [m.posHeaders[0], m.posHeaders[1], m.dteHeader, m.deltaHeader, ...m.posHeaders.slice(2)] : m.posHeaders;
  const clock = useClock();
  const root = useRef<HTMLDivElement>(null);
  const { w } = useSize(root);
  const withLast = lastColumnFits(w, timeColumn(clock));

  return (
    // The tab bar and a list's header stay; rows added or the splitter dragged make only the rows
    // scroll, and their columns keep their width (ScrollList, scrollGutter.ts).
    <div ref={root} data-activity="panel" data-view={options ? 'opt' : 'chart'} style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
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
            <OrderList orders={orders} withLast={withLast} />
          ) : (
            <div style={{ padding: '10px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.noOrders(sym)}</div>
          )
        ) : rows.length ? (
          <ScrollList header={<HeaderRow grid={options ? POS_GRID_OPT : POS_GRID} headers={posHeaders} right={(i) => i > 0} />}>
            {rows.map((r) => (
              <HoldingRow key={r.key} r={r} opt={options ? optionCells(r) : undefined} />
            ))}
          </ScrollList>
        ) : (
          <div style={{ padding: '8px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.noPosition(sym)}</div>
        )}
      </div>
    </div>
  );
}
