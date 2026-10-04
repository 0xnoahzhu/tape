// Equity curve (design: portfolio dashboard, left card). Built only from NAV samples that the
// main process recorded plus the live net liquidation; missing history is shown, never filled in.

import { useMemo } from 'react';
import { DASH, f0, pct, sg, signColor, ymd } from '@shared/format';
import type { NavPoint } from '@shared/types';
import { Segmented } from '../../ui/primitives';
import { useStore } from '../../state/store';
import {
  CHART_H,
  CHART_W,
  RANGES,
  axisLabels,
  equityChart,
  navSeries,
  rangeReturn,
  sliceRange,
  tickLabels,
  type RangeKey,
} from './calc';
import { usePortfolioMessages, type PortfolioMessages } from './messages';
import { usePortfolioUi } from './uiState';

const GRID_Y = [60, 150, 240];

function spanLabel(m: PortfolioMessages, range: RangeKey, covered: boolean, first: NavPoint | undefined): string {
  if (range === 'ALL' || !covered) return first ? m.since(ymd(first.t)) : '';
  return { '7D': m.span7D, MTD: m.spanMTD, YTD: m.spanYTD, '1Y': m.span1Y }[range];
}

/** All NAV samples plus the live account value, in time order. */
export function useNavSeries(): NavPoint[] {
  const nav = useStore((s) => s.nav);
  const netLiq = useStore((s) => s.account?.netLiquidation);
  const updatedAt = useStore((s) => s.account?.updatedAt);
  return useMemo(() => navSeries(nav, { netLiq, t: updatedAt ?? Date.now() }), [nav, netLiq, updatedAt]);
}

export function EquityCard({ series, symbol }: { series: NavPoint[]; symbol: string }) {
  const m = usePortfolioMessages();
  const { mode, range, setMode, setRange } = usePortfolioUi();

  const view = useMemo(() => {
    const slice = sliceRange(series, range, Date.now());
    const chart = equityChart(slice.points, mode);
    const ret = rangeReturn(slice.points);
    const labels = chart ? axisLabels(chart.axis.map((a) => a.value), mode, symbol) : [];
    const axis = chart ? chart.axis.map((a, i) => ({ ...a, label: labels[i] })) : [];
    const ticks = chart ? tickLabels(chart.ticks, range) : [];
    return { slice, chart, ret, axis, ticks };
  }, [series, range, mode, symbol]);

  const { slice, chart, ret, axis, ticks } = view;
  const perf = mode === 'perf';
  const col = signColor(ret?.change);
  const chg = ret ? (perf ? pct(ret.pct) : sg(ret.change, f0)) : DASH;
  const chgPct = ret && !perf ? `(${pct(ret.pct)})` : '';
  // A single sample has no curve: show its marker and value only.
  const single = !!chart && !chart.line;
  const note = slice.points.length < 2 ? (series.length ? m.historyNote(ymd(series[0].t)) : m.noHistory) : null;

  return (
    <div style={{ background: 'var(--p)', padding: '22px 28px 18px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{perf ? m.titlePerf : m.titleValue}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            <div className="selectable" style={{ font: '500 18px/1 var(--num)', color: col }}>
              {chg}
            </div>
            {chgPct && <div style={{ font: '13px/1 var(--num)', color: col }}>{chgPct}</div>}
            <div style={{ fontSize: 12, color: 'var(--dm)' }}>{spanLabel(m, range, slice.covered, slice.points[0])}</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Segmented
          options={[
            { key: 'value', label: m.modeValue },
            { key: 'perf', label: m.modePerf },
          ]}
          value={mode}
          onChange={setMode}
        />
        <Segmented options={RANGES.map((k) => ({ key: k, label: k }))} value={range} onChange={setRange} itemStyle={{ font: '12px/1 var(--num)' }} />
      </div>

      <div style={{ display: 'flex', height: CHART_H }}>
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            {GRID_Y.map((y) => (
              <line key={y} x1={0} x2={CHART_W} y1={y} y2={y} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '1 3' }} />
            ))}
            {chart?.area && <polygon points={chart.area} style={{ fill: 'var(--ac)', opacity: 0.1 }} />}
            {chart && !single && (
              <line
                x1={0}
                x2={CHART_W}
                y1={chart.baseY}
                y2={chart.baseY}
                style={{ stroke: 'var(--mu)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '3 4', opacity: 0.6 }}
              />
            )}
            {chart?.line && <polyline points={chart.line} style={{ fill: 'none', stroke: 'var(--ac)', strokeWidth: 1.75, vectorEffect: 'non-scaling-stroke' }} />}
          </svg>
          {chart && (
            <div
              style={{
                position: 'absolute',
                right: -4,
                top: `${(chart.endY / CHART_H) * 100}%`,
                transform: 'translateY(-50%)',
                width: 8,
                height: 8,
                background: 'var(--ac)',
              }}
            />
          )}
          {note && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 40px',
                textAlign: 'center',
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--dm)',
              }}
            >
              <div style={{ background: 'var(--p)', padding: '4px 8px' }}>{note}</div>
            </div>
          )}
        </div>
        <div style={{ width: 84, position: 'relative', font: '11px/1 var(--num)', color: 'var(--dm)' }}>
          {axis
            .filter((a) => !single || a.frac === 0.5)
            .map((a) => (
              <div key={a.frac} style={{ position: 'absolute', left: 14, top: `${a.frac * 100}%`, transform: 'translateY(-50%)', whiteSpace: 'nowrap' }}>
                {a.label}
              </div>
            ))}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', paddingRight: 84, font: '11px/1 var(--num)', color: 'var(--dm)', minHeight: 11 }}>
        {ticks.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}
