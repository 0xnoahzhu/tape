// Volatility tab: HV, IV / HV and skew cards, smile of the selected expiry, ATM term structure and
// 52-week IV history (IB OPTION_IMPLIED_VOLATILITY bars). IV Rank is in the desk header. Each chart
// reads IV % at round values on its left (Plot) and its x under it: strikes and the spot price
// (smile), expiries placed by days to expiry (term), months and years (history).

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { shortExpiry } from '@shared/contract';
import { DASH, f2, sg } from '@shared/format';
import { useClock } from '../../i18n';
import { stableGutter } from '../../ui/scrollGutter';
import { pickTimeStep, timeStepSpacing, timeTickGap, timeTicks, type LabelClock } from '../chart/chartMath';
import { useSize } from '../chart/useSize';
import { useIvHistory } from './data';
import { useM } from './messages';
import type { DeskModel } from './model';
import { chartScale, fitLabels, niceTicks, polyPoints, type ChartScale, type XLabel } from './svg';

const pctText = (v: number | undefined, digits = 1) => (v == null ? DASH : (v * 100).toFixed(digits) + '%');

export function VolatilityTab({ model }: { model: DeskModel }) {
  const m = useM();
  const { uq, ivAtm, rows, spot } = model;
  const iv = useIvHistory(model.underlying, uq?.impliedVol);

  // 30-day historical volatility: tick 23, else the real-time one (tick 58, generic tick 411, which the
  // underlying profile asks for since IB refuses 104 in a generic tick list).
  const hvTick = uq?.histVol ?? uq?.rtHistVol;
  const hv = hvTick && hvTick > 0 ? hvTick : undefined;
  const ratio = ivAtm != null && hv != null ? ivAtm / hv : undefined;
  // Skew: OTM put IV two strikes below ATM minus OTM call IV two strikes above (design).
  const c = model.centerRow;
  const skew = spot != null ? diff(rows[c - 2]?.put.iv, rows[c + 2]?.call.iv) : undefined;
  const cards = [
    { l: m.hv, v: pctText(hv), d: m.realized },
    { l: m.ivHv, v: ratio != null ? ratio.toFixed(2) : DASH, d: ratio == null ? '' : ratio > 1.2 ? m.rich : ratio < 0.9 ? m.cheap : m.fair },
    { l: m.skew, v: skew != null ? sg(skew * 100) + '%' : DASH, d: m.skewD },
  ];

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        ...stableGutter,
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
        gridAutoRows: 'min-content',
        gap: 'var(--gap)',
        padding: 'var(--pad) max(0px, var(--pad) - var(--sbw, 0px)) var(--pad) var(--pad)',
        background: 'var(--gbg)',
      }}
    >
      <div style={{ gridColumn: '1 / 3', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 'var(--gap)' }}>
        {cards.map((x) => (
          <div key={x.l} style={{ background: 'var(--p)', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--mu)' }}>{x.l}</div>
            <div style={{ font: '500 20px/1 var(--num)' }}>{x.v}</div>
            <div style={{ fontSize: 11, color: 'var(--dm)', minHeight: 11 }}>{x.d}</div>
          </div>
        ))}
      </div>
      <Smile model={model} />
      <Term model={model} />
      <IvHistory hist={iv.hist} times={iv.times} current={iv.current} stats={iv.stats} />
    </div>
  );
}

function diff(a: number | undefined, b: number | undefined): number | undefined {
  return a != null && b != null ? a - b : undefined;
}

function Card({ children, span }: { children: ReactNode; span?: boolean }) {
  return <div style={{ ...(span ? { gridColumn: '1 / 3' } : {}), background: 'var(--p)', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>{children}</div>;
}

function EmptyChart({ height, text }: { height: number; text: string }) {
  return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--p2)', fontSize: 12, color: 'var(--dm)' }}>{text}</div>;
}

function Legend() {
  const m = useM();
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--dm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <div style={{ width: 12, height: 2, background: 'var(--ac)' }} />
        {m.callIv}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <div style={{ width: 12, height: 0, borderTop: '1px dashed var(--mu)' }} />
        {m.putIv}
      </div>
    </div>
  );
}

const line = { fill: 'none', vectorEffect: 'non-scaling-stroke' } as const;
/** The charts draw in a 600 × 200 viewBox stretched to their box. */
const VB_W = 600;
const VB_H = 200;
/** Width of the IV % labels left of a plot (px). */
const Y_GUTTER = 44;
const axisText: CSSProperties = { font: '10px/1 var(--num)', color: 'var(--dm)', whiteSpace: 'nowrap', pointerEvents: 'none' };
const gridStroke = { stroke: 'var(--ln2)', vectorEffect: 'non-scaling-stroke' } as const;

/**
 * A chart with its axes: IV % at round values on the left (with faint gridlines across), `x`
 * labels under it at their places (those that would touch dropped, strong ones kept first). The
 * SVG children draw in the 600 × 200 viewBox of `scale`; `overlay` sits over the plot in its box
 * (given the plot's width in px, as a function).
 */
function Plot({
  scale,
  height,
  x,
  children,
  overlay,
}: {
  scale: ChartScale;
  height: number;
  x: readonly XLabel[];
  children: ReactNode;
  overlay?: ReactNode | ((width: number) => ReactNode);
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { w } = useSize(ref);
  const yTicks = niceTicks(scale.y0, scale.y1, Math.max(2, Math.floor(height / 45)));
  const top = (v: number) => `${((scale.Y(v) / VB_H) * 100).toFixed(2)}%`;
  return (
    <div data-vol="plot" style={{ display: 'grid', gridTemplateColumns: `${Y_GUTTER}px minmax(0,1fr)`, rowGap: 8 }}>
      <div data-vol="y-axis" style={{ position: 'relative', height }}>
        {yTicks.map((v) => (
          <div key={v} style={{ ...axisText, position: 'absolute', right: 8, top: top(v), transform: 'translateY(-50%)' }}>
            {v}%
          </div>
        ))}
      </div>
      <div ref={ref} style={{ position: 'relative', height, minWidth: 0 }}>
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
    </div>
  );
}

/** Strikes as on the chain: no trailing zeros ("230", "227.5"). */
const strikeText = (v: number) => String(Number(v.toFixed(2)));

function Smile({ model }: { model: DeskModel }) {
  const m = useM();
  const pts = model.quotedRows.filter((r) => r.call.iv != null || r.put.iv != null);
  const exp = model.exp ? shortExpiry(model.exp.expiry) : '';
  let body: ReactNode;
  if (pts.length < 2) body = <EmptyChart height={220} text={m.noSmile} />;
  else {
    const xs = pts.map((r) => r.strike);
    const ys = pts.flatMap((r) => [r.call.iv, r.put.iv]).filter((v): v is number => v != null).map((v) => v * 100);
    const s = chartScale(xs, ys, VB_W, VB_H);
    const call = polyPoints(pts.map((r) => ({ x: r.strike, y: r.call.iv != null ? r.call.iv * 100 : undefined })), s);
    const put = polyPoints(pts.map((r) => ({ x: r.strike, y: r.put.iv != null ? r.put.iv * 100 : undefined })), s);
    const spot = model.spot;
    const spotIn = spot != null && spot >= s.x0 && spot <= s.x1;
    // Strikes at round values, and the spot price under its line.
    const x: XLabel[] = [
      ...(spotIn ? [{ at: s.X(spot) / VB_W, label: f2(spot), strong: true }] : []),
      ...niceTicks(s.x0, s.x1, 6).map((k) => ({ at: s.X(k) / VB_W, label: strikeText(k) })),
    ];
    body = (
      <Plot scale={s} height={220} x={x}>
        {spotIn && <line x1={s.X(spot).toFixed(1)} x2={s.X(spot).toFixed(1)} y1="0" y2={VB_H} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' }} />}
        <polyline points={put} style={{ ...line, stroke: 'var(--mu)', strokeDasharray: '3 3' }} />
        <polyline points={call} style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.75 }} />
      </Plot>
    );
  }
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600 }}>
          {m.smile} · {model.symbol} {exp}
        </div>
        <Legend />
      </div>
      {body}
    </Card>
  );
}

/** Share of the term chart's days kept free at either end, so the first and last points and their values stay inside it. */
const TERM_EDGE = 0.05;

/**
 * ATM IV per monthly expiry, placed by days to expiry, each expiry's date under its point. A
 * point's value shows where its date does: far expiries crowd the near ones together, and the
 * dates are thinned so they never touch.
 */
function Term({ model }: { model: DeskModel }) {
  const m = useM();
  const pts = model.term.filter((p) => p.iv != null);
  let body: ReactNode;
  if (pts.length < 2) body = <EmptyChart height={220} text={m.noTerm} />;
  else {
    const vs = pts.map((p) => p.iv! * 100);
    const dtes = pts.map((p) => p.dte);
    const [d0, d1] = [Math.min(...dtes), Math.max(...dtes)];
    const edge = (d1 - d0) * TERM_EDGE || 1;
    const s = chartScale([d0 - edge, ...dtes, d1 + edge], [vs[0], ...vs, vs[0]], VB_W, VB_H);
    const pct = (v: number, of: number) => ((v / of) * 100).toFixed(2) + '%';
    const dots = pts.map((p, i) => ({ x: pct(s.X(p.dte), VB_W), y: pct(s.Y(vs[i]), VB_H), at: s.X(p.dte) / VB_W, l: shortExpiry(p.expiry), v: vs[i].toFixed(1) + '%' }));
    const dates = dots.map((d) => ({ at: d.at, label: d.l }));
    body = (
      <Plot
        scale={s}
        height={220}
        x={dates}
        overlay={(w) => {
          const shown = new Set(fitLabels(dates, w).map((l) => l.label));
          return dots.map((d) => (
            <div key={d.l}>
              <div style={{ position: 'absolute', left: d.x, top: d.y, transform: 'translate(-50%,-50%)', width: 7, height: 7, background: 'var(--ac)' }} />
              {shown.has(d.l) && (
                <div style={{ position: 'absolute', left: d.x, top: d.y, transform: 'translate(-50%,-22px)', font: '10px/1 var(--num)', color: 'var(--mu)', whiteSpace: 'nowrap' }}>{d.v}</div>
              )}
            </div>
          ));
        }}
      >
        <polyline points={polyPoints(pts.map((p, i) => ({ x: p.dte, y: vs[i] })), s)} style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.75 }} />
      </Plot>
    );
  }
  return (
    <Card>
      <div style={{ fontWeight: 600 }}>{m.term} · ATM</div>
      {body}
    </Card>
  );
}

/** Date labels of the IV history (month and year starts, as on the price chart's daily axis), spread over its points. */
function historyLabels(times: readonly number[], width: number, clock: LabelClock): XLabel[] {
  const n = times.length;
  if (n < 2 || !(width > 0)) return [];
  const bars = times.map((time) => ({ time }));
  const ppb = width / (n - 1);
  const step = pickTimeStep(timeStepSpacing(bars, '1D'), ppb, (st) => timeTickGap('1D', clock, st));
  return timeTicks(bars, '1D', step, 0, n, ppb, clock).map((t) => ({ at: t.index / (n - 1), label: t.label }));
}

function IvHistory({ hist, times, current, stats }: { hist: number[] | null; times: number[] | null; current: number | undefined; stats: ReturnType<typeof useIvHistory>['stats'] }) {
  const m = useM();
  const clock = useClock();
  const widthRef = useRef<HTMLDivElement>(null);
  const { w } = useSize(widthRef);
  const ok = hist && hist.length > 1 && stats;
  const s = ok ? chartScale(hist.map((_, i) => i), hist.map((v) => v * 100), VB_W, VB_H) : null;
  const val = (v: string) => <span style={{ fontFamily: 'var(--num)', color: 'var(--tx)' }}>{v}</span>;
  // The plot is the card's width less the IV % labels.
  const x = times && times.length === hist?.length ? historyLabels(times, Math.max(0, w - Y_GUTTER), clock) : [];
  return (
    <Card span>
      <div ref={widthRef} style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
        <div style={{ fontWeight: 600 }}>{m.hist}</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 24, fontSize: 12, color: 'var(--mu)' }}>
          <div>
            {m.now} <span style={{ fontFamily: 'var(--num)', color: 'var(--ac)' }}>{pctText(current)}</span>
          </div>
          <div>
            {m.hi52} {val(pctText(stats?.max))}
          </div>
          <div>
            {m.lo52} {val(pctText(stats?.min))}
          </div>
        </div>
      </div>
      {s && hist && stats ? (
        <Plot
          scale={s}
          height={200}
          x={x}
          overlay={
            current != null && (
              <div style={{ position: 'absolute', right: -4, top: (s.Y(current * 100) / 2).toFixed(2) + '%', transform: 'translateY(-50%)', width: 8, height: 8, background: 'var(--ac)' }} />
            )
          }
        >
          <line x1="0" x2={VB_W} y1={s.Y(stats.max * 100).toFixed(1)} y2={s.Y(stats.max * 100).toFixed(1)} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' }} />
          <line x1="0" x2={VB_W} y1={s.Y(stats.min * 100).toFixed(1)} y2={s.Y(stats.min * 100).toFixed(1)} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' }} />
          <polyline points={polyPoints(hist.map((v, i) => ({ x: i, y: v * 100 })), s)} style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.25 }} />
        </Plot>
      ) : (
        <EmptyChart height={200} text={m.noHist} />
      )}
    </Card>
  );
}
