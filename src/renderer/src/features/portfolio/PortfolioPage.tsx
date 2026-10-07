// Portfolio page (design v6, "acct"): sticky account header with tabs, then the Dashboard
// (customizable widget grid, dashboard/), Positions (columns chosen in ColumnEditor.tsx) or Account.
// Each tab fills the page height, so no bare page background shows under short content.

import { useMemo, type ReactNode } from 'react';
import { DASH, f0, f2, sg, signColor, usd } from '@shared/format';
import type { AccountSummary } from '@shared/types';
import { useAccountId } from '../../lib/account';
import { useStore } from '../../state/store';
import { TabItems } from '../../ui/primitives';
import { accountTotals, todaysExecutions, type AccountTotals, type PositionRow } from './calc';
import { Dashboard, DashboardControls } from './dashboard/Dashboard';
import { useNyDayStart } from './dashboard/data';
import { AccountView } from './AccountView';
import { PositionsControls } from './ColumnEditor';
import { usePortfolioMessages } from './messages';
import { PositionsTable } from './PositionsTable';
import { usePortfolioUi, type PortfolioTab } from './uiState';
import { usePositionRows } from './usePositionRows';

function Stat({ label, children, color, big, title }: { label: string; children: ReactNode; color?: string; big?: boolean; title?: string }) {
  return (
    <div title={title} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, color: 'var(--mu)', whiteSpace: 'nowrap' }}>{label}</div>
      <div
        className="selectable"
        style={{ font: big ? '600 36px/1 var(--num)' : '500 22px/1 var(--num)', fontVariantNumeric: 'tabular-nums', color, whiteSpace: 'nowrap' }}
      >
        {children}
      </div>
    </div>
  );
}

/** Net liquidation in the account currency: "$1,284,530.42", or "1,284,530.42 EUR". */
function money(v: number | undefined, currency: string | undefined): string {
  if (v == null || !currency || currency === 'USD') return usd(v);
  return `${f2(v)} ${currency}`;
}

function Header({ account, totals, rows }: { account: AccountSummary | null; totals: AccountTotals; rows: readonly PositionRow[] }) {
  const m = usePortfolioMessages();
  const accountId = useAccountId();
  const tab = usePortfolioUi((s) => s.tab);
  const setTab = usePortfolioUi((s) => s.setTab);
  const a = account;
  const { dayPnl, unrealized, marketValue, realized } = totals;

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--p)', boxShadow: '0 1px 0 var(--ln)', flexShrink: 0 }}>
      <div style={{ padding: '24px 32px 20px', display: 'flex', alignItems: 'flex-end', gap: '24px 44px', flexWrap: 'wrap' }}>
        <Stat label={accountId === DASH ? m.netLiq : `${m.netLiq} · ${accountId}`} big>
          {money(a?.netLiquidation, a?.currency)}
        </Stat>
        <Stat label={m.dayPnl} color={signColor(dayPnl)}>
          {sg(dayPnl)}
        </Stat>
        <Stat label={m.unrealizedPnl} color={signColor(unrealized)}>
          {sg(unrealized)}
        </Stat>
        <Stat label={m.buyingPower}>{f0(a?.buyingPower)}</Stat>
        <Stat label={m.cash}>{f0(a?.totalCashValue)}</Stat>
        <Stat label={m.marketValue} title={m.marketValueHint}>
          {f0(marketValue)}
        </Stat>
        <Stat label={m.realizedToday} title={m.realizedTodayHint} color={signColor(realized)}>
          {sg(realized, f0)}
        </Stat>
        <Stat label={m.excessLiquidityHd} title={m.excessLiquidityHint}>
          {f0(a?.excessLiquidity)}
        </Stat>
      </div>
      <div style={{ height: 46, display: 'flex', alignItems: 'stretch', gap: 28, padding: '0 32px' }}>
        <TabItems<PortfolioTab>
          tabs={[
            { key: 'dash', label: m.tabDash },
            { key: 'pos', label: m.tabPos },
            { key: 'account', label: m.tabAccount },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div style={{ flex: 1 }} />
        {tab === 'dash' && <DashboardControls />}
        {tab === 'pos' && <PositionsControls rows={rows} />}
      </div>
    </div>
  );
}

export function PortfolioPage() {
  const tab = usePortfolioUi((s) => s.tab);
  const account = useStore((s) => s.account);
  const rows = usePositionRows();
  const executions = useStore((s) => s.executions);
  const dayStart = useNyDayStart();
  const totals = useMemo(() => accountTotals(account, rows, todaysExecutions(executions, dayStart)), [account, rows, executions, dayStart]);
  const symbol = !account?.currency || account.currency === 'USD' ? '$' : '';

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', background: 'var(--gbg)' }}>
      <Header account={account} totals={totals} rows={rows} />
      {tab === 'dash' && <Dashboard rows={rows} account={account} totals={totals} symbol={symbol} />}
      {tab === 'pos' && <PositionsTable rows={rows} />}
      {tab === 'account' && <AccountView account={account} totals={totals} />}
    </div>
  );
}
