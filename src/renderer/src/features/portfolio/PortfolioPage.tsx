// Portfolio page (design v6, "acct"): fixed two-tier account header with tabs, then Positions
// (grouped, with the toolbar line: PositionsView.tsx), Orders (the working orders) or Trades
// (today's executions); the last two are the orders feature's tables. ⌘1 opens Positions, ⌘3 and
// the menu's Orders open Orders (uiState.ts → showPortfolio). Each tab fills the page height, so no
// bare page background shows under short content. The Orders tab's bar holds "Cancel all…" (IB's
// global cancel, confirmed in its own dialog: layout/Dialogs.tsx → CancelAllDialog). The header's
// figures are IB's own, as sent (calc.ts → headerFigures: reqPnL, the account summary's tags and
// the account updates' values); Tape computes none of them. While they are not live (disconnected,
// connecting, another account's summary) the header dims them and says since when they are the
// last IB sent (calc.ts → headerStale).

import { useMemo, type ReactNode } from 'react';
import { DASH, f0, f2, sg, signColor, usd } from '@shared/format';
import type { AccountSummary } from '@shared/types';
import { useClock } from '../../i18n';
import { useAccountId } from '../../lib/account';
import { cancelAllOrders } from '../../lib/orders';
import { useCommon } from '../../i18n/common';
import { useConnectedExecutions, useConnectedOrders } from '../../state/connectedLists';
import { openCancelAll } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { TabItems } from '../../ui/primitives';
import { newestExecutions, workingOrders } from '../orders/model';
import { TradesTable } from '../orders/TradesTable';
import { WorkingTable } from '../orders/WorkingTable';
import { MARGIN_CALL_CUSHION, asOfText, cushionBar, headerFigures, headerStale, leverageLabel, pctLabel, type HeaderFigures } from './calc';
import { usePortfolioMessages } from './messages';
import { PositionsView } from './PositionsView';
import { usePortfolioUi, type PortfolioTab } from './uiState';
import { usePositionRows } from './usePositionRows';

/**
 * A tier-1 figure. `foot` hangs under it out of the flow (the margin cushion), so the value stays
 * the last baseline and the row's `alignItems: last baseline` lines the 36 and 22px values up; the
 * row's bottom padding makes room for it.
 */
function Stat({ label, children, color, big, title, foot }: { label: string; children: ReactNode; color?: string; big?: boolean; title?: string; foot?: ReactNode }) {
  return (
    <div title={title} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, color: 'var(--mu)', whiteSpace: 'nowrap' }}>{label}</div>
      <div
        className="selectable"
        style={{ font: big ? '600 36px/1 var(--num)' : '500 22px/1 var(--num)', fontVariantNumeric: 'tabular-nums', color, whiteSpace: 'nowrap' }}
      >
        {children}
      </div>
      {foot && <div style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 8px)', whiteSpace: 'nowrap' }}>{foot}</div>}
    </div>
  );
}

/** Under Excess Liquidity: IB's cushion as a 3px bar with the 10% tick (red below it) and "18.4% cushion". */
function CushionFoot({ pct }: { pct: number | undefined }) {
  const m = usePortfolioMessages();
  const c = cushionBar(pct);
  if (!c) return null;
  // The design's red (#d9534f) is the theme's --r.
  const tone = c.warn ? 'var(--r)' : 'var(--ac)';
  return (
    <div title={m.cushionHint} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ height: 3, background: 'var(--p2)', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${c.fill}%`, background: tone }} />
        <div style={{ position: 'absolute', left: `${MARGIN_CALL_CUSHION}%`, top: -2, bottom: -2, width: 1, background: 'var(--mu)' }} />
      </div>
      <div style={{ font: '11px/1 var(--sans)', color: c.warn ? 'var(--r)' : 'var(--mu)' }}>{m.cushion(pctLabel(pct))}</div>
    </div>
  );
}

/**
 * Tier 2: the balances and margin in one 13px line (Cash reads Margin loan when negative). Items
 * wrap whole in a narrow window.
 */
function AccountStrip({ account, figures }: { account: AccountSummary | null; figures: HeaderFigures }) {
  const m = usePortfolioMessages();
  const a = account;
  const cash = a?.totalCashValue;
  const loan = cash != null && cash < 0;
  const items: Array<{ label: string; value: string; title?: string }> = [
    loan ? { label: m.marginLoan, value: f2(-cash), title: m.marginLoanHint } : { label: m.cash, value: f2(cash) },
    { label: m.stocks, value: f2(figures.stockValue), title: m.stocksHint },
    { label: m.options, value: sg(figures.optionValue), title: m.optionsHint },
    { label: m.initMargin, value: f2(a?.initMarginReq) },
    { label: m.maintMargin, value: f2(a?.maintMarginReq) },
    { label: m.leverage, value: leverageLabel(figures.leverage, figures.leverageC), title: figures.leverageC === undefined ? m.leverageHint : `${m.leverageHint}\n${m.leverageCHint}` },
    { label: m.accruedDiv, value: f2(a?.accruedDividend) },
  ];
  return (
    <div style={{ padding: '0 32px 16px', display: 'flex', flexWrap: 'wrap', gap: '6px 24px', fontSize: 13 }}>
      {items.map((i) => (
        <div key={i.label} title={i.title} style={{ display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--mu)' }}>{i.label}</span>
          <span className="selectable" style={{ fontFamily: 'var(--num)', fontVariantNumeric: 'tabular-nums', color: 'var(--tx)' }}>
            {i.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Net liquidation in the account currency: "$1,284,530.42", or "1,284,530.42 EUR". */
function money(v: number | undefined, currency: string | undefined): string {
  if (v == null || !currency || currency === 'USD') return usd(v);
  return `${f2(v)} ${currency}`;
}

interface Counts {
  positions: number;
  orders: number;
  trades: number;
}

/**
 * "Cancel all…" on the Orders tab's bar: opens the Cancel all dialog, while connected and an order
 * IB still reports works (whichever app placed it: only IB's global cancel reaches them all).
 */
function CancelAllButton() {
  const m = useCommon();
  const orders = useConnectedOrders();
  const accounts = useStore((s) => s.connection.accounts);
  const connected = useStore((s) => s.connection.status === 'connected');
  const enabled = connected && cancelAllOrders(orders, accounts).length > 0;
  return (
    <div
      role="button"
      aria-disabled={!enabled || undefined}
      title={m.cancelAllHint}
      onClick={enabled ? openCancelAll : undefined}
      className={enabled ? 'hover-p2' : undefined}
      style={{
        alignSelf: 'center',
        marginLeft: 'auto',
        padding: '6px 10px',
        fontSize: 13,
        whiteSpace: 'nowrap',
        color: enabled ? 'var(--r)' : 'var(--dm)',
        cursor: enabled ? 'pointer' : 'not-allowed',
        opacity: enabled ? 1 : 0.6,
      }}
    >
      {m.cancelAll}
    </div>
  );
}

/** "Disconnected · as of 09:41 AM" over the header while its figures are not live. */
function StaleNote({ account }: { account: AccountSummary | null }) {
  const m = usePortfolioMessages();
  const clock = useClock();
  const stale = useStore((s) => headerStale(s.connection.status, account, s.connection.account));
  if (!stale || !account) return null;
  return (
    <div data-pos="stale" title={m.staleHint} style={{ padding: '16px 32px 0', marginBottom: -12, fontSize: 12, fontWeight: 600, color: 'var(--mu)' }}>
      {m.stale[stale](asOfText(account.updatedAt, Date.now(), clock))}
    </div>
  );
}

function Header({ account, figures, counts }: { account: AccountSummary | null; figures: HeaderFigures; counts: Counts }) {
  const m = usePortfolioMessages();
  const accountId = useAccountId();
  const tab = usePortfolioUi((s) => s.tab);
  const setTab = usePortfolioUi((s) => s.setTab);
  // The last account's figures stay while Tape is not connected to it: dimmed, never shown as live.
  const stale = useStore((s) => headerStale(s.connection.status, account, s.connection.account) != null);
  const a = account;
  const { dayPnl, unrealized, realized } = figures;
  const dim = stale ? { opacity: 0.5 } : undefined;

  return (
    <div style={{ position: 'relative', zIndex: 3, background: 'var(--p)', boxShadow: '0 1px 0 var(--ln)', flexShrink: 0 }}>
      <StaleNote account={account} />
      {/* Tier 1. The bottom padding holds the cushion under Excess Liquidity. */}
      <div style={{ padding: '24px 32px 32px', display: 'flex', alignItems: 'last baseline', gap: '24px 44px', flexWrap: 'wrap', ...dim }}>
        <Stat label={accountId === DASH ? m.netLiq : `${m.netLiq} · ${accountId}`} big>
          {money(a?.netLiquidation, a?.currency)}
        </Stat>
        <Stat label={m.dayPnl} title={m.pnlHint} color={signColor(dayPnl)}>
          {sg(dayPnl)}
        </Stat>
        <Stat label={m.unrealizedPnl} title={m.pnlHint} color={signColor(unrealized)}>
          {sg(unrealized)}
        </Stat>
        <Stat label={m.realizedToday} title={m.realizedTodayHint} color={signColor(realized)}>
          {sg(realized)}
        </Stat>
        <Stat label={m.buyingPower}>{f2(a?.buyingPower)}</Stat>
        {/* Last, so that when the row wraps its foot is on the last line, over the padding. */}
        <Stat label={m.excessLiquidityHd} title={m.excessLiquidityHint} foot={<CushionFoot pct={figures.cushionPct} />}>
          {f2(a?.excessLiquidity)}
        </Stat>
      </div>
      <div style={dim}>
        <AccountStrip account={a} figures={figures} />
      </div>
      <div data-pos="tabs" style={{ height: 46, display: 'flex', alignItems: 'stretch', gap: 28, padding: '0 32px' }}>
        <TabItems<PortfolioTab>
          tabs={[
            { key: 'pos', label: m.tabPos, count: String(counts.positions) },
            { key: 'ord', label: m.tabOrders, count: String(counts.orders) },
            { key: 'fill', label: m.tabTrades, count: String(counts.trades) },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'ord' && <CancelAllButton />}
      </div>
    </div>
  );
}

/** The card of the Orders and Trades tabs: the rows scroll inside it under their header (orders/table.tsx → TableBody). */
const TABLE_CARD = { background: 'var(--p)', margin: 'var(--gap) var(--pad) var(--pad)', flex: '1 1 0', minHeight: 240, display: 'flex', flexDirection: 'column' } as const;

export function PortfolioPage() {
  const tab = usePortfolioUi((s) => s.tab);
  const account = useStore((s) => s.account);
  const rows = usePositionRows();
  // Only the connected login's: another account's never show as this one's (connectedLists.ts).
  const orders = useConnectedOrders();
  const executions = useConnectedExecutions();
  const figures = useMemo(() => headerFigures(account), [account]);
  const working = useMemo(() => workingOrders(orders), [orders]);
  const trades = useMemo(() => newestExecutions(executions), [executions]);

  // The account header stays; what is under it scrolls only when zoomed in with a small window, its
  // scrollbar beside the cards, not beside the header. No stable gutter there: the cards keep their
  // own (scrollGutter.ts); a second one would leave an empty strip beside their scrollbars.
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--gbg)' }}>
      <Header account={account} figures={figures} counts={{ positions: rows.length, orders: working.length, trades: trades.length }} />
      <div data-pos="page-body" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {tab === 'pos' && <PositionsView rows={rows} />}
        {tab === 'ord' && (
          <div data-pos="orders" style={TABLE_CARD}>
            <WorkingTable orders={working} />
          </div>
        )}
        {tab === 'fill' && (
          <div data-pos="trades" style={TABLE_CARD}>
            <TradesTable executions={trades} />
          </div>
        )}
      </div>
    </div>
  );
}
