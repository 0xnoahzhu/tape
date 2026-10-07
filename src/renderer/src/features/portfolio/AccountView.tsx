// Account tab: balances, margin and today's P&L from IB's account summary and the position rows.

import { f2, sg, signColor } from '@shared/format';
import type { AccountSummary } from '@shared/types';
import { leverage, leverageLabel, type AccountTotals } from './calc';
import { usePortfolioMessages } from './messages';
import { ValueRows, type ValueRow } from './ValueRows';

function Group({ title, rows }: { title: string; rows: ValueRow[] }) {
  return (
    <div style={{ background: 'var(--p)', padding: '8px 0 12px' }}>
      <div style={{ padding: '14px 28px 6px', fontWeight: 600 }}>{title}</div>
      <ValueRows rows={rows} />
    </div>
  );
}

export function AccountView({ account, totals }: { account: AccountSummary | null; totals: AccountTotals }) {
  const m = usePortfolioMessages();

  const a = account;
  const lev = leverage(totals.gross, a?.netLiquidation);

  const groups: Array<{ title: string; rows: ValueRow[] }> = [
    {
      title: m.balances,
      rows: [
        { label: m.cash, value: f2(a?.totalCashValue) },
        { label: m.stockValue, value: f2(totals.stockValue) },
        { label: m.optionValue, value: sg(totals.optionValue) },
        { label: m.accruedDividends, value: f2(a?.accruedDividend) },
      ],
    },
    {
      title: m.margin,
      rows: [
        { label: m.initMargin, value: f2(a?.initMarginReq) },
        { label: m.maintMargin, value: f2(a?.maintMarginReq) },
        { label: m.excessLiquidity, value: f2(a?.excessLiquidity) },
        { label: m.leverage, value: leverageLabel(lev) },
      ],
    },
    {
      title: m.pnl,
      rows: [
        { label: m.today, value: sg(totals.dayPnl), color: signColor(totals.dayPnl) },
        { label: m.unrealized, value: sg(totals.unrealized), color: signColor(totals.unrealized) },
        // The header's Realized Today: reqPnL, else today's executions.
        { label: m.realized, value: sg(totals.realized), color: signColor(totals.realized) },
      ],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)', padding: 'var(--pad)', marginTop: 'var(--gap)', flex: '1 0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 'var(--gap)', flex: 1 }}>
        {groups.map((g) => (
          <Group key={g.title} title={g.title} rows={g.rows} />
        ))}
      </div>
    </div>
  );
}
