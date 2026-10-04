// Sector allocation donut (design: portfolio dashboard, right card, 380px).

import { useMemo } from 'react';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { CASH_KEY, allocation, moneyShort, weightLabel, type PositionRow } from './calc';
import { sectorLabel, usePortfolioMessages } from './messages';

const R = 15.9155; // circumference 100, so dash lengths are percentages

export function AllocationCard({ rows, cash, netLiq, symbol }: { rows: PositionRow[]; cash: number | undefined; netLiq: number | undefined; symbol: string }) {
  const m = usePortfolioMessages();
  const common = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');
  const slices = useMemo(() => allocation(rows.map((r) => ({ sector: r.sector, value: r.value })), cash, netLiq), [rows, cash, netLiq]);

  return (
    <div style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '22px 28px 4px', fontWeight: 600 }}>{m.allocation}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '12px 28px 16px' }}>
        <div style={{ position: 'relative', width: 140, height: 140, flexShrink: 0 }}>
          <svg viewBox="0 0 42 42" width={140} height={140} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
            <circle cx={21} cy={21} r={R} fill="none" style={{ stroke: 'var(--p2)' }} strokeWidth={5} />
            {slices.map((s) => (
              <circle
                key={s.key}
                cx={21}
                cy={21}
                r={R}
                fill="none"
                strokeWidth={5}
                strokeDasharray={`${s.len.toFixed(3)} ${(100 - s.len).toFixed(3)}`}
                strokeDashoffset={s.offset.toFixed(3)}
                style={{ stroke: s.key === CASH_KEY ? 'var(--mu)' : 'var(--ac)', opacity: s.opacity }}
              />
            ))}
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.netLiqShort}</div>
            <div style={{ font: '600 14px/1 var(--num)' }}>{moneyShort(netLiq, symbol)}</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {slices.map((s) => {
            const label = sectorLabel(m, s.key);
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <div style={{ width: 8, height: 8, flexShrink: 0, background: s.key === CASH_KEY ? 'var(--mu)' : 'var(--ac)', opacity: s.opacity }} />
                <div title={label} style={{ flex: 1, minWidth: 0, color: 'var(--mu)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {label}
                </div>
                <div style={{ flexShrink: 0, fontFamily: 'var(--num)', color: 'var(--tx)' }}>{weightLabel(s.pctOfNetLiq)}</div>
              </div>
            );
          })}
          {!slices.length && <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.5 }}>{connected ? m.noAllocation : common.notConnected}</div>}
        </div>
      </div>
    </div>
  );
}
