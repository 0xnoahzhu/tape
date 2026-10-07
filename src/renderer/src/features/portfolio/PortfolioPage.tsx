// Portfolio page (design v6, "acct"): sticky two-tier account header with tabs, then Positions
// (grouped, with the toolbar line: PositionsView.tsx), Orders (the working orders) or Trades
// (today's executions); the last two are the orders feature's tables. ⌘1 opens Positions, ⌘3 and
// the menu's Orders open Orders (uiState.ts → showPortfolio). Each tab fills the page height, so no
// bare page background shows under short content.

import { useMemo, type ReactNode } from 'react';
import { DASH, f0, f2, sg, signColor, usd } from '@shared/format';
import type { AccountSummary } from '@shared/types';
import { useAccountId } from '../../lib/account';
import { useStore } from '../../state/store';
import { TabItems } from '../../ui/primitives';
import { newestExecutions, workingOrders } from '../orders/model';
import { TradesTable } from '../orders/TradesTable';
import { WorkingTable } from '../orders/WorkingTable';
import {
  MARGIN_CALL_CUSHION,
  accountTotals,
  leverage,
  leverageLabel,
  marginCushion,
  todaysExecutions,
  weightLabel,
  type AccountTotals,
} from './calc';
import { useNyDayStart } from './data';
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

/** Under Excess Liquidity: a 3px bar with the 10% tick (red below it) and "18.4% cushion". */
function CushionFoot({ account }: { account: AccountSummary | null }) {
  const m = usePortfolioMessages();
  const c = marginCushion(account?.excessLiquidity, account?.netLiquidation);
  if (!c) return null;
  // The design's red (#d9534f) is the theme's --r.
  const tone = c.warn ? 'var(--r)' : 'var(--ac)';
  return (
    <div title={m.cushionHint} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ height: 3, background: 'var(--p2)', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${c.fill}%`, background: tone }} />
        <div style={{ position: 'absolute', left: `${MARGIN_CALL_CUSHION}%`, top: -2, bottom: -2, width: 1, background: 'var(--mu)' }} />
      </div>
      <div style={{ font: '11px/1 var(--sans)', color: c.warn ? 'var(--r)' : 'var(--mu)' }}>{m.cushion(weightLabel(c.pct))}</div>
    </div>
  );
}

/**
 * Tier 2: the balances and margin in one 13px line (Cash reads Margin loan when negative). Items
 * wrap whole in a narrow window.
 */
function AccountStrip({ account, totals }: { account: AccountSummary | null; totals: AccountTotals }) {
  const m = usePortfolioMessages();
  const a = account;
  const cash = a?.totalCashValue;
  const loan = cash != null && cash < 0;
  const items: Array<{ label: string; value: string; title?: string }> = [
    loan ? { label: m.marginLoan, value: f0(-cash), title: m.marginLoanHint } : { label: m.cash, value: f0(cash) },
    { label: m.stocks, value: f0(totals.stockValue), title: m.stocksHint(f2(a?.stockMarketValue)) },
    { label: m.options, value: sg(totals.optionValue, f0), title: m.optionsHint(f2(a?.optionMarketValue)) },
    { label: m.initMargin, value: f0(a?.initMarginReq) },
    { label: m.maintMargin, value: f0(a?.maintMarginReq) },
    { label: m.leverage, value: leverageLabel(leverage(totals.gross, a?.netLiquidation)), title: m.leverageHint },
    { label: m.accruedDiv, value: f0(a?.accruedDividend) },
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

function Header({ account, totals, counts }: { account: AccountSummary | null; totals: AccountTotals; counts: Counts }) {
  const m = usePortfolioMessages();
  const accountId = useAccountId();
  const tab = usePortfolioUi((s) => s.tab);
  const setTab = usePortfolioUi((s) => s.setTab);
  const a = account;
  const { dayPnl, unrealized, realized } = totals;

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--p)', boxShadow: '0 1px 0 var(--ln)', flexShrink: 0 }}>
      {/* Tier 1. The bottom padding holds the cushion under Excess Liquidity. */}
      <div style={{ padding: '24px 32px 32px', display: 'flex', alignItems: 'last baseline', gap: '24px 44px', flexWrap: 'wrap' }}>
        <Stat label={accountId === DASH ? m.netLiq : `${m.netLiq} · ${accountId}`} big>
          {money(a?.netLiquidation, a?.currency)}
        </Stat>
        <Stat label={m.dayPnl} color={signColor(dayPnl)}>
          {sg(dayPnl)}
        </Stat>
        <Stat label={m.unrealizedPnl} color={signColor(unrealized)}>
          {sg(unrealized)}
        </Stat>
        <Stat label={m.realizedToday} title={m.realizedTodayHint} color={signColor(realized)}>
          {sg(realized, f0)}
        </Stat>
        <Stat label={m.buyingPower}>{f0(a?.buyingPower)}</Stat>
        {/* Last, so that when the row wraps its foot is on the last line, over the padding. */}
        <Stat label={m.excessLiquidityHd} title={m.excessLiquidityHint} foot={<CushionFoot account={a} />}>
          {f0(a?.excessLiquidity)}
        </Stat>
      </div>
      <AccountStrip account={a} totals={totals} />
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
      </div>
    </div>
  );
}

/** The card of the Orders and Trades tabs: the table scrolls inside it under its sticky header. */
const TABLE_CARD = { background: 'var(--p)', margin: 'var(--gap) var(--pad) var(--pad)', flex: '1 1 0', minHeight: 240, display: 'flex', flexDirection: 'column' } as const;

export function PortfolioPage() {
  const tab = usePortfolioUi((s) => s.tab);
  const account = useStore((s) => s.account);
  const rows = usePositionRows();
  const orders = useStore((s) => s.orders);
  const executions = useStore((s) => s.executions);
  const dayStart = useNyDayStart();
  const totals = useMemo(() => accountTotals(account, rows, todaysExecutions(executions, dayStart)), [account, rows, executions, dayStart]);
  const working = useMemo(() => workingOrders(orders), [orders]);
  const trades = useMemo(() => newestExecutions(executions), [executions]);

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', background: 'var(--gbg)' }}>
      <Header account={account} totals={totals} counts={{ positions: rows.length, orders: working.length, trades: trades.length }} />
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
  );
}
