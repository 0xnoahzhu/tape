// The Positions tab's toolbar line over the table: Group by (Underlying / Sector / None) and the
// Columns button (ColumnEditor.tsx). It shows no figures: the table's rows are IB's, and Tape adds
// none of them up.

import { Segmented } from '../../ui/primitives';
import type { PositionRow } from './calc';
import { PositionsControls } from './ColumnEditor';
import { GROUP_BYS, type GroupBy } from './columnsState';
import { usePositionColumns } from './columnStore';
import { usePortfolioMessages } from './messages';

export function PositionsToolbar({ rows }: { rows: readonly PositionRow[] }) {
  const m = usePortfolioMessages();
  const groupBy = usePositionColumns((s) => s.groupBy);
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
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
        <PositionsControls rows={rows} />
      </div>
    </div>
  );
}
