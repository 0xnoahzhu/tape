// The Positions tab's toolbar line over the table: Group by (Underlying / Sector / None), the
// largest groups' share of net liquidation ("Top 3 = 41% of net liq", groups.ts → topShare), the
// portfolio greeks while options are held (GreeksLine.tsx, exposure.ts → portfolioGreeks; a dimmed
// line while IB has not sent every option's model greeks) and the Columns button (ColumnEditor.tsx).
// The items wrap onto a second line when the numbers do not fit beside the switch.

import { Segmented } from '../../ui/primitives';
import { weightLabel, type PositionRow } from './calc';
import { PositionsControls } from './ColumnEditor';
import { GROUP_BYS, type GroupBy } from './columnsState';
import { usePositionColumns } from './columnStore';
import type { PortfolioGreeks } from './exposure';
import { GreeksLine } from './GreeksLine';
import { usePortfolioMessages } from './messages';

export function PositionsToolbar({
  rows,
  greeks,
  top,
  groupBy,
}: {
  rows: readonly PositionRow[];
  greeks: PortfolioGreeks;
  /** groups.ts → topShare; undefined while a share is unknown or no position is held. */
  top: { n: number; pct: number } | undefined;
  groupBy: GroupBy;
}) {
  const m = usePortfolioMessages();
  const setGroupBy = usePositionColumns((s) => s.setGroupBy);
  return (
    <div
      data-pos="toolbar"
      // Above the table card (its own stacking context), so the Columns popover opens over the rows.
      style={{
        position: 'relative',
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px 24px',
        padding: '8px 32px',
        minHeight: 46,
        fontSize: 12,
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--mu)', whiteSpace: 'nowrap' }}>{m.groupBy}</span>
        <div data-pos="group-by" data-value={groupBy}>
          <Segmented<GroupBy>
            options={GROUP_BYS.map((key) => ({ key, label: m.groupByOptions[key] }))}
            value={groupBy}
            onChange={setGroupBy}
            itemStyle={{ padding: '5px 10px' }}
          />
        </div>
      </div>
      {top && (
        <div data-pos="top" title={m.topHint[groupBy]} style={{ color: 'var(--mu)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {m.top(top.n, weightLabel(top.pct))}
        </div>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 24px' }}>
        {greeks.options > 0 && <GreeksLine g={greeks} />}
        <PositionsControls rows={rows} />
      </div>
    </div>
  );
}
