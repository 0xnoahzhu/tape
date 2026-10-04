// Account overview (dashboard, right column under the allocation): margin usage bar and the
// funds and margin figures of the account summary. Buying power is in the page header.

import { f2 } from '@shared/format';
import type { AccountSummary } from '@shared/types';
import { leverage, leverageLabel, marginUsage, weightLabel, type AccountTotals } from './calc';
import { usePortfolioMessages } from './messages';
import { ValueRows } from './ValueRows';

export function AccountCard({ account, totals }: { account: AccountSummary | null; totals: AccountTotals }) {
  const m = usePortfolioMessages();
  const a = account;
  const usage = marginUsage(a?.initMarginReq, a?.netLiquidation);
  const tone = usage?.warn ? 'var(--r)' : 'var(--ac)';

  return (
    <div style={{ background: 'var(--p)', flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '22px 28px 4px', fontWeight: 600 }}>{m.accountOverview}</div>
      <div title={m.marginUsageHint} style={{ padding: '12px 28px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, fontSize: 13 }}>
          <div style={{ color: 'var(--mu)', whiteSpace: 'nowrap' }}>{m.marginUsage}</div>
          <div className="selectable" style={{ fontFamily: 'var(--num)', color: usage?.warn ? 'var(--r)' : 'var(--tx)' }}>
            {weightLabel(usage?.pct)}
          </div>
        </div>
        <div style={{ height: 4, background: 'var(--p2)' }}>
          <div style={{ width: `${usage?.fill ?? 0}%`, height: '100%', background: tone }} />
        </div>
      </div>
      <ValueRows
        rows={[
          { label: m.availableFunds, value: f2(a?.availableFunds) },
          { label: m.excessLiquidity, value: f2(a?.excessLiquidity) },
          { label: m.initMargin, value: f2(a?.initMarginReq) },
          { label: m.maintMargin, value: f2(a?.maintMarginReq) },
          { label: m.leverage, value: leverageLabel(leverage(totals.gross, a?.netLiquidation)) },
        ]}
      />
    </div>
  );
}
