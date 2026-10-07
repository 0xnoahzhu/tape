// Volatility tab: HV, IV / HV and skew cards, smile of the selected expiry, ATM term structure and
// 52-week IV history (IB OPTION_IMPLIED_VOLATILITY bars). IV Rank is in the desk header.

import type { ReactNode } from 'react';
import { shortExpiry } from '@shared/contract';
import { DASH, f2, sg } from '@shared/format';
import { useIvHistory } from './data';
import { useM } from './messages';
import type { DeskModel } from './model';
import { chartScale, polyPoints } from './svg';

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
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
        gridAutoRows: 'min-content',
        gap: 'var(--gap)',
        padding: 'var(--pad)',
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
      <IvHistory hist={iv.hist} current={iv.current} stats={iv.stats} />
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

function Smile({ model }: { model: DeskModel }) {
  const m = useM();
  const pts = model.quotedRows.filter((r) => r.call.iv != null || r.put.iv != null);
  const exp = model.exp ? shortExpiry(model.exp.expiry) : '';
  let body: ReactNode;
  if (pts.length < 2) body = <EmptyChart height={220} text={m.noSmile} />;
  else {
    const xs = pts.map((r) => r.strike);
    const ys = pts.flatMap((r) => [r.call.iv, r.put.iv]).filter((v): v is number => v != null).map((v) => v * 100);
    const s = chartScale(xs, ys, 600, 200);
    const call = polyPoints(pts.map((r) => ({ x: r.strike, y: r.call.iv != null ? r.call.iv * 100 : undefined })), s);
    const put = polyPoints(pts.map((r) => ({ x: r.strike, y: r.put.iv != null ? r.put.iv * 100 : undefined })), s);
    const spot = model.spot;
    body = (
      <>
        <div style={{ height: 220, position: 'relative' }}>
          <svg viewBox="0 0 600 200" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            {spot != null && spot >= s.x0 && spot <= s.x1 && (
              <line x1={s.X(spot).toFixed(1)} x2={s.X(spot).toFixed(1)} y1="0" y2="200" style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' }} />
            )}
            <polyline points={put} style={{ ...line, stroke: 'var(--mu)', strokeDasharray: '3 3' }} />
            <polyline points={call} style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.75 }} />
          </svg>
          <div style={{ position: 'absolute', left: 0, top: 0, font: '10px/1 var(--num)', color: 'var(--dm)' }}>{s.y1.toFixed(0)}%</div>
          <div style={{ position: 'absolute', left: 0, bottom: 0, font: '10px/1 var(--num)', color: 'var(--dm)' }}>{s.y0.toFixed(0)}%</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', font: '10px/1 var(--num)', color: 'var(--dm)' }}>
          <div>{f2(s.x0)}</div>
          <div style={{ color: 'var(--mu)' }}>{f2(spot)}</div>
          <div>{f2(s.x1)}</div>
        </div>
      </>
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

function Term({ model }: { model: DeskModel }) {
  const m = useM();
  const pts = model.term.filter((p) => p.iv != null);
  let body: ReactNode;
  if (pts.length < 2) body = <EmptyChart height={220} text={m.noTerm} />;
  else {
    const vs = pts.map((p) => p.iv! * 100);
    const s = chartScale(
      pts.map((_, i) => i),
      vs,
      600,
      200,
    );
    const dots = pts.map((p, i) => ({ x: (s.X(i) / 6).toFixed(2) + '%', y: (s.Y(vs[i]) / 2).toFixed(2) + '%', l: shortExpiry(p.expiry), v: vs[i].toFixed(1) + '%' }));
    body = (
      <>
        <div style={{ height: 220, position: 'relative' }}>
          <svg viewBox="0 0 600 200" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <polyline points={polyPoints(vs.map((y, i) => ({ x: i, y })), s)} style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.75 }} />
          </svg>
          {dots.map((d) => (
            <div key={d.l}>
              <div style={{ position: 'absolute', left: d.x, top: d.y, transform: 'translate(-50%,-50%)', width: 7, height: 7, background: 'var(--ac)' }} />
              <div style={{ position: 'absolute', left: d.x, top: d.y, transform: 'translate(-50%,-22px)', font: '10px/1 var(--num)', color: 'var(--mu)', whiteSpace: 'nowrap' }}>{d.v}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', font: '10px/1 var(--num)', color: 'var(--dm)' }}>
          {dots.map((d) => (
            <div key={d.l}>{d.l}</div>
          ))}
        </div>
      </>
    );
  }
  return (
    <Card>
      <div style={{ fontWeight: 600 }}>{m.term} · ATM</div>
      {body}
    </Card>
  );
}

function IvHistory({ hist, current, stats }: { hist: number[] | null; current: number | undefined; stats: ReturnType<typeof useIvHistory>['stats'] }) {
  const m = useM();
  const ok = hist && hist.length > 1 && stats;
  const s = ok ? chartScale(hist.map((_, i) => i), hist.map((v) => v * 100), 600, 200) : null;
  const val = (v: string) => <span style={{ fontFamily: 'var(--num)', color: 'var(--tx)' }}>{v}</span>;
  return (
    <Card span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
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
        <div style={{ height: 200, position: 'relative' }}>
          <svg viewBox="0 0 600 200" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <line x1="0" x2="600" y1={s.Y(stats.max * 100).toFixed(1)} y2={s.Y(stats.max * 100).toFixed(1)} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' }} />
            <line x1="0" x2="600" y1={s.Y(stats.min * 100).toFixed(1)} y2={s.Y(stats.min * 100).toFixed(1)} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' }} />
            <polyline points={polyPoints(hist.map((v, i) => ({ x: i, y: v * 100 })), s)} style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.25 }} />
          </svg>
          {current != null && (
            <div style={{ position: 'absolute', right: -4, top: (s.Y(current * 100) / 2).toFixed(2) + '%', transform: 'translateY(-50%)', width: 8, height: 8, background: 'var(--ac)' }} />
          )}
        </div>
      ) : (
        <EmptyChart height={200} text={m.noHist} />
      )}
    </Card>
  );
}
