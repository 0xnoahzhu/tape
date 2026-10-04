// Positions tab (design: 8-column table). Rows open the underlying on the Trade page.

import { contractLabel } from '@shared/contract';
import { f0, pct, px, sg, signColor } from '@shared/format';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { Empty } from '../../ui/primitives';
import { positionTarget, qtyLabel, weightLabel, type PositionRow } from './calc';
import { sectorLabel, usePortfolioMessages } from './messages';

const COLUMNS = 'minmax(0,2fr) repeat(7,minmax(0,1fr))';

export function PositionsTable({ rows }: { rows: PositionRow[] }) {
  const m = usePortfolioMessages();
  const common = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');
  const openSymbol = useStore((s) => s.openSymbol);

  return (
    <div style={{ background: 'var(--p)', margin: 'var(--gap) var(--pad) var(--pad)', flex: '1 0 auto' }}>
      <div style={{ height: 8 }} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLUMNS,
          gap: 12,
          padding: '8px 32px',
          fontSize: 12,
          color: 'var(--dm)',
          boxShadow: 'inset 0 -1px 0 var(--ln2)',
        }}
      >
        {m.headers.map(([label, full], i) => (
          <div key={i} title={full} className="ellipsis" style={{ textAlign: i ? 'right' : 'left', cursor: 'default' }}>
            {label}
          </div>
        ))}
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums' }}>
        {rows.map((r) => {
          const p = r.position;
          const go = () => {
            const t = positionTarget(p.contract);
            openSymbol(t.contract, t.view);
          };
          return (
            <div
              key={r.key}
              onClick={go}
              className="hover-p2"
              style={{
                display: 'grid',
                gridTemplateColumns: COLUMNS,
                gap: 12,
                padding: '0 32px',
                height: 50,
                alignItems: 'center',
                boxShadow: 'inset 0 -1px 0 var(--ln2)',
                cursor: 'pointer',
                fontFamily: 'var(--num)',
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--sans)', minWidth: 0 }}>
                <div className="ellipsis" style={{ fontSize: 14 }}>
                  {contractLabel(p.contract)}
                </div>
                <div className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)' }}>
                  {m.kinds[p.contract.secType] ?? p.contract.secType} · {sectorLabel(m, r.sector)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>{qtyLabel(p.quantity)}</div>
              <div style={{ textAlign: 'right', color: 'var(--mu)' }}>{px(p.avgPrice)}</div>
              <div style={{ textAlign: 'right' }}>{px(r.last)}</div>
              <div style={{ textAlign: 'right' }}>{f0(r.value)}</div>
              <div style={{ textAlign: 'right', color: 'var(--mu)' }}>{weightLabel(r.weight)}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', color: signColor(r.unrealized) }}>
                <div>{sg(r.unrealized, f0)}</div>
                <div style={{ fontSize: 11 }}>{pct(r.unrealizedPct)}</div>
              </div>
              <div style={{ textAlign: 'right', color: signColor(r.dayPnl) }}>{sg(r.dayPnl, f0)}</div>
            </div>
          );
        })}
      </div>
      {!rows.length && <Empty style={{ padding: '18px 32px 22px' }}>{connected ? m.noPositions : common.notConnected}</Empty>}
    </div>
  );
}
