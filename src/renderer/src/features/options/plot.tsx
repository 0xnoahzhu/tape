// The desk's small charts (Volatility and Positioning tabs): cards, legends, a plot with its axes
// in a 600 × 200 viewBox stretched to its box, and the pointer's readout.

import { Fragment, useRef, type CSSProperties, type ReactNode } from 'react';
import { stableGutter } from '../../ui/scrollGutter';
import { useSize } from '../chart/useSize';
import { fitLabels, niceTicks, stackLabels, type ChartScale, type XLabel } from './svg';

export function Card({ children, span }: { children: ReactNode; span?: boolean }) {
  return <div style={{ ...(span ? { gridColumn: '1 / 3' } : {}), background: 'var(--p)', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>{children}</div>;
}

export function EmptyChart({ height, text }: { height: number; text: string }) {
  return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--p2)', fontSize: 12, color: 'var(--dm)' }}>{text}</div>;
}

/** A legend entry: a short line (dashed for `dashed`) or a hollow square (`mark`), and its name. */
export function Key({ text, color, dashed, mark }: { text: string; color: string; dashed?: boolean; mark?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      {mark ? (
        <div style={{ width: 7, height: 7, boxShadow: `inset 0 0 0 1.5px ${color}` }} />
      ) : (
        <div style={{ width: 12, height: 0, borderTop: `${dashed ? 1 : 2}px ${dashed ? 'dashed' : 'solid'} ${color}` }} />
      )}
      {text}
    </div>
  );
}

export const legendStyle: CSSProperties = { display: 'flex', gap: 14, fontSize: 11, color: 'var(--dm)', minWidth: 0 };
export const line = { fill: 'none', vectorEffect: 'non-scaling-stroke' } as const;
/** The charts draw in a 600 × 200 viewBox stretched to their box. */
export const VB_W = 600;
export const VB_H = 200;
/** Width of the IV % labels left of a plot (px). */
export const Y_GUTTER = 44;
export const axisText: CSSProperties = { font: '10px/1 var(--num)', color: 'var(--dm)', whiteSpace: 'nowrap', pointerEvents: 'none' };
export const gridStroke = { stroke: 'var(--ln2)', vectorEffect: 'non-scaling-stroke' } as const;
export const guideStroke = { stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' } as const;
/** A halo in the card's color, so a line crossing a value label does not run through its text. */
export const halo: CSSProperties = { textShadow: '0 0 2px var(--p), 0 0 2px var(--p), 0 0 3px var(--p), 0 0 4px var(--p)' };
/**
 * `ys` (vol %) with the values `span` points apart around their middle when they lie closer: a
 * nearly flat curve stays flat on the chart instead of filling it with the quotes' rounding.
 */
export const withSpan = (ys: number[], span: number) => {
  const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
  return hi - lo >= span ? ys : [...ys, (lo + hi) / 2 - span / 2, (lo + hi) / 2 + span / 2];
};
/** A position in the viewBox as a share of the plot's box, for overlays. */
export const share = (v: number, of: number) => ((v / of) * 100).toFixed(2) + '%';

/**
 * A chart with its axes: IV % at round values on the left (with faint gridlines across), `x`
 * labels under it at their places (those that would touch dropped, strong ones kept first). The
 * SVG children draw in the 600 × 200 viewBox of `scale`; `overlay` sits over the plot in its box
 * (given the plot's width in px, as a function). `marks` label lines drawn across the plot, in a
 * row under the axis (stacked when close, kept inside the plot's width). `onHover` gets the
 * pointer's x as a share of the plot's width (null when it leaves).
 */
export function Plot({
  scale,
  height,
  x,
  marks,
  children,
  overlay,
  onHover,
  yFormat = (v) => `${v}%`,
}: {
  scale: ChartScale;
  height: number;
  x: readonly XLabel[];
  marks?: readonly XLabel[];
  children: ReactNode;
  overlay?: ReactNode | ((width: number) => ReactNode);
  onHover?: (at: number | null) => void;
  /** A y-axis label (default: the value as IV %). */
  yFormat?: (v: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { w } = useSize(ref);
  const yTicks = niceTicks(scale.y0, scale.y1, Math.max(2, Math.floor(height / 45)));
  const top = (v: number) => share(scale.Y(v), VB_H);
  const stacked = marks ? stackLabels(marks, w) : [];
  const markRows = stacked.reduce((n, l) => Math.max(n, l.row + 1), 0);
  return (
    <div data-vol="plot" style={{ display: 'grid', gridTemplateColumns: `${Y_GUTTER}px minmax(0,1fr)`, rowGap: 8 }}>
      <div data-vol="y-axis" style={{ position: 'relative', height }}>
        {yTicks.map((v) => (
          <div key={v} style={{ ...axisText, position: 'absolute', right: 8, top: top(v), transform: 'translateY(-50%)' }}>
            {yFormat(v)}
          </div>
        ))}
      </div>
      <div
        ref={ref}
        style={{ position: 'relative', height, minWidth: 0 }}
        onMouseMove={onHover && ((e) => onHover(w > 0 ? (e.clientX - e.currentTarget.getBoundingClientRect().left) / w : null))}
        onMouseLeave={onHover && (() => onHover(null))}
      >
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {yTicks.map((v) => (
            <line key={v} x1="0" x2={VB_W} y1={scale.Y(v).toFixed(1)} y2={scale.Y(v).toFixed(1)} style={gridStroke} />
          ))}
          {children}
        </svg>
        {typeof overlay === 'function' ? overlay(w) : overlay}
      </div>
      <div />
      <div data-vol="x-axis" style={{ position: 'relative', height: 10 }}>
        {fitLabels(x, w).map((l) => (
          <div key={`${l.at}:${l.label}`} style={{ ...axisText, position: 'absolute', left: l.x, transform: 'translateX(-50%)', ...(l.strong ? { color: 'var(--mu)' } : null) }}>
            {l.label}
          </div>
        ))}
      </div>
      {markRows > 0 && (
        <>
          <div />
          <div data-vol="marks" style={{ position: 'relative', height: markRows * 14 - 4 }}>
            {stacked.map((l) => (
              <div key={l.label} style={{ ...axisText, position: 'absolute', top: l.row * 14, left: l.left }}>
                {l.label}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The pointer's readout over a plot `width` px wide: a line at `x` (px), a dot on each value (`dots`, tops as shares) and their values beside it. */
export function Readout({ x, width, dots, rows }: { x: number; width: number; dots: Array<{ top: string; color: string }>; rows: Array<[string, string]> }) {
  // Beside the pointer, on the side with more room.
  const side = x < width / 2 ? { left: x + 10 } : { right: width - x + 10 };
  return (
    <>
      <div style={{ position: 'absolute', left: x, top: 0, bottom: 0, borderLeft: '1px solid var(--ln)', pointerEvents: 'none' }} />
      {dots.map((d, i) => (
        <div key={i} style={{ position: 'absolute', left: x, top: d.top, transform: 'translate(-50%,-50%)', width: 6, height: 6, background: d.color, pointerEvents: 'none' }} />
      ))}
      <div
        data-vol="readout"
        style={{
          position: 'absolute',
          top: 4,
          ...side,
          display: 'grid',
          gridTemplateColumns: 'auto auto',
          columnGap: 12,
          padding: '6px 8px',
          background: 'var(--p)',
          boxShadow: '0 0 0 1px var(--ln)',
          font: '11px/1.6 var(--num)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {rows.map(([l, v]) => (
          <Fragment key={l}>
            <div style={{ color: 'var(--dm)' }}>{l}</div>
            <div style={{ color: 'var(--tx)', textAlign: 'right' }}>{v}</div>
          </Fragment>
        ))}
      </div>
    </>
  );
}


/**
 * A tab's scrolling two-column grid of cards. The gap color shows only between the cards (and under
 * the last row); the room below them, when they are shorter than the tab, is the panel's color.
 */
export function TabGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', ...stableGutter, background: 'var(--p)', padding: 'var(--pad) max(0px, var(--pad) - var(--sbw, 0px)) var(--pad) var(--pad)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
          gridAutoRows: 'min-content',
          gap: 'var(--gap)',
          paddingBottom: 'var(--gap)',
          background: 'var(--gbg)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
