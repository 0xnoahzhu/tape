// The Positions tab's toolbar line over the table: Group by (Underlying / Sector / None), the
// largest groups' share of net liquidation ("Top 3 = 41% of net liq", groups.ts → topShare), the
// portfolio greeks while options are held (exposure.ts → portfolioGreeks; a dimmed line while IB has
// not sent every option's model greeks) and the Columns button (ColumnEditor.tsx). The items wrap
// onto a second line when the numbers do not fit beside the switch.

import { f0, f2, sg, signColor } from '@shared/format';
import { Segmented } from '../../ui/primitives';
import { weightLabel, type PositionRow } from './calc';
import { PositionsControls } from './ColumnEditor';
import { GROUP_BYS, type GroupBy } from './columnsState';
import { usePositionColumns } from './columnStore';
import type { PortfolioGreeks } from './exposure';
import { usePortfolioMessages, type GreekId } from './messages';

/** Δ sh · $Δ · Γ · Θ/day · Vega/pt, each with its tooltip. */
function GreeksLine({ g }: { g: PortfolioGreeks }) {
  const m = usePortfolioMessages();
  if (g.pending) {
    return (
      <div data-pos="greeks" data-pending title={m.greeksPendingHint} style={{ color: 'var(--dm)', whiteSpace: 'nowrap' }}>
        {m.greeksPending(g.pending)}
      </div>
    );
  }
  const items: Array<{ id: GreekId; value: string; color?: string }> = [
    { id: 'delta', value: sg(g.delta, f0) },
    { id: 'dollarDelta', value: sg(g.dollarDelta, f0) },
    { id: 'gamma', value: sg(g.gamma, (x) => f2(x, 1)) },
    { id: 'theta', value: sg(g.theta, f0), color: signColor(g.theta) },
    { id: 'vega', value: sg(g.vega, f0) },
  ];
  return (
    <div data-pos="greeks" style={{ display: 'flex', alignItems: 'baseline', gap: 16, whiteSpace: 'nowrap' }}>
      {items.map(({ id, value, color }) => {
        const [label, unit] = m.greeks[id];
        return (
          <span key={id} data-greek={id} title={m.greeksHints[id]} style={{ display: 'flex', alignItems: 'baseline' }}>
            <span style={{ color: 'var(--mu)', marginRight: 5 }}>{label}</span>
            <span className="selectable" style={{ fontFamily: 'var(--num)', fontVariantNumeric: 'tabular-nums', color: color ?? 'var(--tx)' }}>
              {value}
            </span>
            {/* "/day" follows the number; "sh" after a space. */}
            {unit && <span style={{ color: 'var(--mu)', marginLeft: unit.startsWith('/') ? 1 : 4 }}>{unit}</span>}
          </span>
        );
      })}
    </div>
  );
}

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
