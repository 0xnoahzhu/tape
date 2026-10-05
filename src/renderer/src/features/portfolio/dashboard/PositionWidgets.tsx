// Position widgets (design v6): today's P&L by position and option expirations.

import { useMemo } from 'react';
import { contractLabel } from '@shared/contract';
import { DASH, f0, f2, sg, signColor } from '@shared/format';
import type { Quote } from '@shared/types';
import { useCommon } from '../../../i18n/common';
import { useStore } from '../../../state/store';
import { positionTarget, qtyLabel, type PositionRow } from '../calc';
import { usePortfolioMessages } from '../messages';
import { useDashboardMessages } from './messages';
import { contributions, expirations } from './model';
import { EmptyLine, List, WidgetCard } from './WidgetCard';

const ROW_RULE = 'inset 0 -1px 0 var(--ln2)';

/** Opens a position the way the positions table does: the option chain or the chart of its underlying. */
function useOpenPosition(): (row: PositionRow) => void {
  const openSymbol = useStore((s) => s.openSymbol);
  return (row) => {
    const t = positionTarget(row.position.contract);
    openSymbol(t.contract, t.view);
  };
}

// ---------------------------------------------------------------------------
// Today's P&L by position

/**
 * Label, diverging bar and value. The design's 200px and 110px columns may shrink when the widget
 * is one column wide; the bar keeps at least 40px.
 */
const CONTRIB_COLUMNS = 'minmax(0,200px) minmax(40px,1fr) minmax(0,110px)';

export function ContribWidget({ rows }: { rows: readonly PositionRow[] }) {
  const m = useDashboardMessages();
  const pm = usePortfolioMessages();
  const common = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');
  const open = useOpenPosition();
  const list = useMemo(() => contributions(rows), [rows]);
  const empty = !connected ? common.notConnected : rows.length ? m.noDayPnl : pm.noPositions;

  return (
    <WidgetCard title={m.contribTitle} sub={m.contribSub}>
      <List>
        {list.map(({ row, pnl, frac }) => {
          const color = signColor(pnl);
          const width = `${(frac * 100).toFixed(1)}%`;
          const label = contractLabel(row.position.contract);
          return (
            <div
              key={row.key}
              onClick={() => open(row)}
              className="hover-p2"
              style={{ display: 'grid', gridTemplateColumns: CONTRIB_COLUMNS, alignItems: 'center', gap: 16, height: 36, cursor: 'pointer', boxShadow: ROW_RULE }}
            >
              <div className="ellipsis" title={label} style={{ fontSize: 13 }}>
                {label}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', boxShadow: 'inset -1px 0 0 var(--ln)' }}>
                  <div style={{ width: pnl < 0 ? width : '0%', background: color }} />
                </div>
                <div style={{ display: 'flex' }}>
                  <div style={{ width: pnl >= 0 ? width : '0%', background: color }} />
                </div>
              </div>
              <div className="selectable" style={{ textAlign: 'right', font: '13px/1 var(--num)', color, whiteSpace: 'nowrap' }}>
                {sg(pnl, f0)}
              </div>
            </div>
          );
        })}
        {!list.length && <EmptyLine>{empty}</EmptyLine>}
      </List>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Option expirations

export function ExpiryWidget({ rows, quotes }: { rows: readonly PositionRow[]; quotes: Readonly<Record<string, Quote>> }) {
  const m = useDashboardMessages();
  const common = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');
  const open = useOpenPosition();
  // Days to expiry count calendar days; a re-render on the next quote picks up a new day.
  const list = useMemo(() => expirations(rows, quotes, new Date()), [rows, quotes]);

  return (
    <WidgetCard title={m.expiryTitle} sub={m.expirySub}>
      <List>
        {list.map(({ row, dte, soon, moneyness }) => {
          const label = contractLabel(row.position.contract);
          return (
            <div
              key={row.key}
              onClick={() => open(row)}
              className="hover-p2"
              style={{ display: 'flex', alignItems: 'center', gap: 12, height: 44, cursor: 'pointer', boxShadow: ROW_RULE }}
            >
              <div style={{ width: 48, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ font: '600 15px/1 var(--num)', color: soon ? 'var(--ac)' : 'var(--tx)' }}>{dte}</div>
                <div style={{ fontSize: 10, color: 'var(--dm)' }}>{m.dte}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="ellipsis" title={label} style={{ fontSize: 13 }}>
                  {label}
                </div>
                <div className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)' }}>
                  {m.expirySubline(qtyLabel(row.position.quantity), f0(row.value))}
                </div>
              </div>
              <div style={{ font: '12px/1 var(--num)', color: moneyness ? (moneyness.itm ? 'var(--tx)' : 'var(--mu)') : 'var(--dm)', whiteSpace: 'nowrap' }}>
                {moneyness ? `${moneyness.itm ? m.itm : m.otm} ${f2(moneyness.pct, 1)}%` : DASH}
              </div>
            </div>
          );
        })}
        {!list.length && <EmptyLine>{connected || rows.length ? m.noOptions : common.notConnected}</EmptyLine>}
      </List>
    </WidgetCard>
  );
}
