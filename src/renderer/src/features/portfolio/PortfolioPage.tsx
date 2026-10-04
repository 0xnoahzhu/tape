// Portfolio page (design 3a, "acct"): sticky account header with tabs, then
// Dashboard (equity curve + sector allocation and account overview), Positions or Performance.
// Each tab fills the page height, so no bare page background shows under short content.

import { useMemo, type ReactNode } from 'react';
import { DASH, f0, f2, sg, signColor, usd } from '@shared/format';
import type { AccountSummary } from '@shared/types';
import { useAccountId } from '../../lib/account';
import { useStore } from '../../state/store';
import { TabItems } from '../../ui/primitives';
import { AccountCard } from './AccountCard';
import { accountTotals, type AccountTotals } from './calc';
import { AllocationCard } from './AllocationCard';
import { EquityCard, useNavSeries } from './EquityCard';
import { usePortfolioMessages } from './messages';
import { PerformanceView } from './PerformanceView';
import { PositionsTable } from './PositionsTable';
import { usePortfolioUi, type PortfolioTab } from './uiState';
import { usePositionRows } from './usePositionRows';

function Stat({ label, children, color, big }: { label: string; children: ReactNode; color?: string; big?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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

function Header({ account, totals }: { account: AccountSummary | null; totals: AccountTotals }) {
  const m = usePortfolioMessages();
  const accountId = useAccountId();
  const tab = usePortfolioUi((s) => s.tab);
  const setTab = usePortfolioUi((s) => s.setTab);
  const a = account;
  const { dayPnl, unrealized } = totals;

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--p)', boxShadow: '0 1px 0 var(--ln)', flexShrink: 0 }}>
      <div style={{ padding: '24px 32px 20px', display: 'flex', alignItems: 'flex-end', gap: 56, flexWrap: 'wrap' }}>
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
      </div>
      <div style={{ height: 46, display: 'flex', alignItems: 'stretch', gap: 28, padding: '0 32px' }}>
        <TabItems<PortfolioTab>
          tabs={[
            { key: 'dash', label: m.tabDash },
            { key: 'pos', label: m.tabPos },
            { key: 'perf', label: m.tabPerf },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
    </div>
  );
}

export function PortfolioPage() {
  const tab = usePortfolioUi((s) => s.tab);
  const account = useStore((s) => s.account);
  const rows = usePositionRows();
  const totals = useMemo(() => accountTotals(account, rows), [account, rows]);
  const series = useNavSeries();
  const symbol = !account?.currency || account.currency === 'USD' ? '$' : '';

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', background: 'var(--gbg)' }}>
      <Header account={account} totals={totals} />
      {tab === 'dash' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) 380px',
            gap: 'var(--gap)',
            padding: 'var(--pad)',
            marginTop: 'var(--gap)',
            flex: '1 0 auto',
          }}
        >
          <EquityCard series={series} symbol={symbol} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)', minWidth: 0 }}>
            <AllocationCard rows={rows} cash={account?.totalCashValue} netLiq={account?.netLiquidation} symbol={symbol} />
            <AccountCard account={account} totals={totals} />
          </div>
        </div>
      )}
      {tab === 'pos' && <PositionsTable rows={rows} />}
      {tab === 'perf' && <PerformanceView series={series} account={account} totals={totals} />}
    </div>
  );
}
