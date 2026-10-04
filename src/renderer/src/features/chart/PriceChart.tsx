// Candlestick chart with MA20, volume, last-price and price-alert lines, a right price
// axis and a hover crosshair. Coordinates follow the design: the price SVG uses an
// 800×300 viewBox and the volume SVG 800×56, both stretched (preserveAspectRatio none)
// with non-scaling strokes.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Bar, Timeframe } from '@shared/types';
import { useLang } from '../../i18n';
import {
  axisPrice,
  buildChart,
  clearOfTag,
  formatBarTime,
  LAST_TAG_H,
  SMALL_TAG_H,
  spreadAlertTags,
  VB_H,
  VB_W,
  VOL_VB_H,
  visibleBarCount,
} from './chartMath';
import { useSize } from './useSize';

export type ChartStatus = 'idle' | 'loading' | 'ready' | 'error';

interface Props {
  bars: Bar[];
  timeframe: Timeframe;
  /** Text shown over an empty chart (loading, error, not connected, no data). */
  message?: string;
  lastPrice?: number;
  /** Active price-alert levels for this instrument. */
  alerts: number[];
  showMa: boolean;
  showVol: boolean;
  minTick?: number;
  /** Hovered bar (index into `bars`), or null when the pointer leaves. */
  onHover(index: number | null): void;
}

const line = (extra: CSSProperties): CSSProperties => ({ vectorEffect: 'non-scaling-stroke', ...extra });
const axisTag: CSSProperties = { position: 'absolute', left: 4, right: 8, transform: 'translateY(-50%)', whiteSpace: 'nowrap' };
/** Crosshair labels: muted solid chips, distinct from outlined alert tags and the accent last-price tag. */
const crossTag: CSSProperties = { background: 'var(--mu)', color: 'var(--p)', padding: '3px 6px', font: '11px/1 var(--num)', pointerEvents: 'none' };

export function PriceChart({ bars, timeframe, message, lastPrice, alerts, showMa, showVol, minTick, onHover }: Props) {
  const lang = useLang();
  const areaRef = useRef<HTMLDivElement>(null);
  const size = useSize(areaRef);
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null);

  const count = visibleBarCount(size.w);
  const geo = useMemo(() => buildChart(bars, { count, showMa, include: [lastPrice] }), [bars, count, showMa, lastPrice]);

  const hovered = geo && pt && size.w > 0 ? geo.indexAt(pt.x / size.w) : null;
  useEffect(() => onHover(hovered), [hovered, onHover]);
  useEffect(() => setPt(null), [timeframe]);

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = areaRef.current?.getBoundingClientRect();
    if (!r) return;
    setPt({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const inRange = (p: number) => !!geo && p > geo.lo && p < geo.hi;
  const alertLevels = geo ? alerts.filter(inRange) : [];
  const lastY = geo && lastPrice != null && lastPrice > 0 ? geo.y(lastPrice) : null;

  // Crosshair: vertical line snaps to the hovered bar, horizontal follows the pointer.
  const crossX = geo && hovered != null ? geo.centerX(hovered) : null;
  const crossY = geo && pt && size.h > 0 && pt.y >= 0 && pt.y <= size.h ? pt.y / size.h : null;

  // Right axis in px: alert tags step aside from the last-price tag, and axis labels near any tag hide.
  const toPx = (vbY: number) => (vbY / VB_H) * size.h;
  const lastTagY = lastY != null ? toPx(lastY) : null;
  const alertTagYs = geo ? spreadAlertTags(alertLevels.map((p) => toPx(geo.y(p))), lastTagY, size.h) : [];
  const tags = [
    ...(lastTagY != null ? [{ y: lastTagY, h: LAST_TAG_H }] : []),
    ...alertTagYs.map((y) => ({ y, h: SMALL_TAG_H })),
    ...(crossY != null ? [{ y: crossY * size.h, h: SMALL_TAG_H }] : []),
  ];
  const axisLabels = (geo?.axis ?? []).filter((a) => tags.every((t) => clearOfTag(a.frac * size.h, t.y, t.h)));
  const timeText = hovered != null ? formatBarTime(bars[hovered].time, timeframe, lang) : '';
  const timeHalf = (timeText.length * 6.6 + 12) / 2;
  const timeLeft = crossX != null ? Math.min(Math.max((crossX / VB_W) * size.w, timeHalf), Math.max(timeHalf, size.w - timeHalf)) : 0;
  const crossStroke = line({ stroke: 'var(--dm)', strokeDasharray: '2 3' });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', marginTop: 14 }}>
      <div
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, cursor: geo ? 'crosshair' : undefined }}
        onMouseMove={geo ? onMove : undefined}
        onMouseLeave={() => setPt(null)}
      >
        <div ref={areaRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            {[75, 150, 225].map((y) => (
              <line key={y} x1={0} x2={VB_W} y1={y} y2={y} style={line({ stroke: 'var(--ln)', strokeDasharray: '1 3' })} />
            ))}
            {geo && showMa && geo.ma && <polyline points={geo.ma} style={line({ fill: 'none', stroke: 'var(--ac)', strokeWidth: 1.25 })} />}
            {geo?.candles.map((c) => {
              const color = c.up ? 'var(--up)' : 'var(--dn)';
              return (
                <g key={c.index}>
                  <line x1={c.cx} x2={c.cx} y1={c.yh} y2={c.yl} style={line({ stroke: color })} />
                  <rect x={c.x} y={c.top} width={c.w} height={c.h} style={{ fill: color }} />
                </g>
              );
            })}
            {lastY != null && (
              <line x1={0} x2={VB_W} y1={lastY} y2={lastY} style={line({ stroke: 'var(--ac)', strokeDasharray: '2 3', filter: 'drop-shadow(0 0 3px var(--ac))' })} />
            )}
            {geo &&
              alertLevels.map((p, i) => (
                <line key={i} x1={0} x2={VB_W} y1={geo.y(p)} y2={geo.y(p)} style={line({ stroke: 'var(--mu)', strokeDasharray: '5 4' })} />
              ))}
            {crossX != null && <line x1={crossX} x2={crossX} y1={0} y2={VB_H} style={crossStroke} />}
            {crossY != null && <line x1={0} x2={VB_W} y1={crossY * VB_H} y2={crossY * VB_H} style={crossStroke} />}
          </svg>
          {!geo && message && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 32px',
                textAlign: 'center',
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--dm)',
              }}
            >
              {/* Panel background keeps the dashed grid from running through the text. */}
              <div style={{ background: 'var(--p)', padding: '0 10px' }}>{message}</div>
            </div>
          )}
          {crossX != null && timeText && (
            <div style={{ ...crossTag, position: 'absolute', bottom: 0, left: timeLeft, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>{timeText}</div>
          )}
        </div>
        {showVol && (
          <div style={{ height: 52, position: 'relative', marginTop: 6 }}>
            <svg viewBox={`0 0 ${VB_W} ${VOL_VB_H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              {geo?.volumes.map((v, i) => (
                <rect key={i} x={v.x} y={v.y} width={v.w} height={v.h} style={{ fill: v.up ? 'var(--up)' : 'var(--dn)', opacity: 0.35 }} />
              ))}
              {crossX != null && <line x1={crossX} x2={crossX} y1={0} y2={VOL_VB_H} style={crossStroke} />}
            </svg>
          </div>
        )}
      </div>
      <div
        style={{
          width: 76,
          position: 'relative',
          font: '12px/1 var(--num)',
          color: 'var(--dm)',
          fontVariantNumeric: 'tabular-nums',
          marginBottom: showVol ? 58 : 0,
        }}
      >
        {axisLabels.map((a) => (
          <div key={a.frac} style={{ position: 'absolute', left: 12, top: `${a.frac * 100}%`, transform: 'translateY(-50%)', whiteSpace: 'nowrap' }}>
            {axisPrice(a.value, minTick)}
          </div>
        ))}
        {geo &&
          alertLevels.map((p, i) => (
            <div
              key={i}
              style={{
                ...axisTag,
                top: alertTagYs[i],
                background: 'var(--p2)',
                color: 'var(--mu)',
                padding: '3px 6px',
                fontSize: 11,
                boxShadow: 'inset 0 0 0 1px var(--ln)',
              }}
            >
              {axisPrice(p, minTick)}
            </div>
          ))}
        {lastY != null && lastPrice != null && (
          <div style={{ ...axisTag, top: `${(lastY / VB_H) * 100}%`, background: 'var(--ac)', color: 'var(--acI)', padding: '4px 6px', fontWeight: 600 }}>
            {axisPrice(lastPrice, minTick)}
          </div>
        )}
        {geo && crossY != null && <div style={{ ...axisTag, ...crossTag, top: `${crossY * 100}%` }}>{axisPrice(geo.priceAt(crossY), minTick)}</div>}
      </div>
    </div>
  );
}
