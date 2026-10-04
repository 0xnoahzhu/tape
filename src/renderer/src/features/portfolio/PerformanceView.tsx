// Performance tab: returns per range from the recorded NAV history, and account balances,
// margin and P&L from the account summary.

import { useMemo } from 'react';
import { DASH, f0, f2, pct, sg, signColor } from '@shared/format';
import type { AccountSummary, NavPoint } from '@shared/types';
import { RANGES, leverage, leverageLabel, rangeReturn, sliceRange, type AccountTotals } from './calc';
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

export function PerformanceView({ series, account, totals }: { series: NavPoint[]; account: AccountSummary | null; totals: AccountTotals }) {
  const m = usePortfolioMessages();

  const returns = useMemo(() => {
    const now = Date.now();
    return RANGES.map((k) => {
      const slice = sliceRange(series, k, now);
      return { key: k, ret: slice.covered ? rangeReturn(slice.points) : null };
    });
  }, [series]);

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
        { label: m.realized, value: sg(a?.realizedPnL), color: signColor(a?.realizedPnL) },
      ],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)', padding: 'var(--pad)', marginTop: 'var(--gap)', flex: '1 0 auto' }}>
      <div style={{ background: 'var(--p)', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontWeight: 600 }}>{m.returns}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: 1, background: 'var(--ln2)' }}>
          {returns.map(({ key, ret }) => {
            const col = signColor(ret?.change);
            return (
              <div key={key} style={{ background: 'var(--p)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ font: '12px/1 var(--num)', color: 'var(--dm)' }}>{key}</div>
                <div className="selectable" style={{ font: '500 18px/1 var(--num)', color: col }}>
                  {ret ? pct(ret.pct) : DASH}
                </div>
                <div style={{ font: '12px/1 var(--num)', color: col }}>{ret ? sg(ret.change, f0) : '\u00a0'}</div>
                <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.maxDrawdown(ret ? `${f2(ret.maxDrawdown, 1)}%` : DASH)}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 'var(--gap)', flex: 1 }}>
        {groups.map((g) => (
          <Group key={g.title} title={g.title} rows={g.rows} />
        ))}
      </div>
    </div>
  );
}
