// Positioning tab: where the open interest sits and what the dealers' hedging would do about it.
// The scope bar picks the expiries (the selected one, or all within 7 / 30 / 90 days), the strike
// window around the price and the dealers' assumed side of the calls; the scan (positioningData.ts)
// reads those options' open interest, volume and IV. Cards: net GEX and its regime, the zero-gamma
// level, the call and put walls, max pain of the nearest expiry, P/C open interest with its change,
// net DEX with vanna and charm. The by-strike chart shows one measure (GEX with the total GEX by
// price on its own right-hand scale, open interest, its change, volume, DEX, vanna, charm), the
// history charts the stored days' levels and net GEX under today's rules, and the tables the
// unusual volume and the totals by expiry. The math is positioning.ts.

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { daysToExpiry, shortExpiry } from '@shared/contract';
import { DASH, f2, sg } from '@shared/format';
import { tradingDay } from '@shared/session';
import { useClock } from '../../i18n';
import { Segmented } from '../../ui/primitives';
import { stableGutter } from '../../ui/scrollGutter';
import { nearestIndex } from './chain';
import { useDesk } from './deskStore';
import type { DeskModel } from './model';
import { Card, EmptyChart, Key, Plot, Readout, VB_H, VB_W, axisText, guideStroke, halo, legendStyle, line, share } from './plot';
import {
  EXPIRY_SCOPES,
  POS_METRICS,
  STRIKE_SPANS,
  dayLevels,
  positioningView,
  scanContracts,
  scopeExpiries,
  strikeBounds,
  type DayLevels,
  type PosMetric,
  type PosView,
  type StrikeExposure,
} from './positioning';
import { usePositioning } from './positioningData';
import { usePosM } from './posMessages';
import { chartScale, niceTicks, polyPoints, type XLabel } from './svg';

type PosM = ReturnType<typeof usePosM>;

/** Strikes as on the chain: no trailing zeros ("230", "227.5"). */
const strikeText = (v: number | undefined) => (v == null ? DASH : String(Number(v.toFixed(2))));
const dayText = (d: string) => `${d.slice(4, 6)}/${d.slice(6, 8)}`;
/** The price the exposures are computed at: the live one rounded to 0.1 %, so quotes do not recompute them on every tick. */
const refPrice = (s: number) => Number(Math.exp(Math.round(Math.log(s) / 0.001) * 0.001).toPrecision(6));

const CALL = 'var(--up)';
const PUT = 'var(--dn)';
const PROFILE = 'var(--cbBlue)';
const ZERO = 'var(--cbOrange)';

export function PositioningTab({ model }: { model: DeskModel }) {
  const m = usePosM();
  const clock = useClock();
  const { posScope, posSpan, posCallSign, posMetric, patch } = useDesk();
  const expiries = model.chain.expiries;
  const selected = model.exp?.expiry;
  const scopeExp = useMemo(() => scopeExpiries(expiries, posScope, selected), [expiries, posScope, selected]);
  const ref = model.spot != null ? refPrice(model.spot) : undefined;
  // The scan's strike window follows the price in steps of 1 %, not every tick.
  const scanRef = model.spot != null ? Number(Math.exp(Math.round(Math.log(model.spot) / 0.01) * 0.01).toPrecision(6)) : undefined;
  const plan = useMemo(() => {
    if (scanRef == null) return { contracts: [], trimmed: 0 };
    const { lo, hi } = strikeBounds(scanRef, posSpan);
    return scanContracts(model.symbol, scopeExp, scanRef, lo, hi);
  }, [model.symbol, scopeExp, scanRef, posSpan]);
  const scopeKey = `${posScope}|${posSpan}|${scopeExp.map((e) => e.expiry).join(',')}`;
  const data = usePositioning(model.underlying, plan.contracts, scopeKey);
  const snaps = data.snaps;
  const latest = snaps?.[snaps.length - 1];
  const prev = snaps && snaps.length > 1 ? snaps[snaps.length - 2] : undefined;
  const spot = ref ?? latest?.spot;
  const minute = Math.floor(Date.now() / 60_000) * 60_000;

  const view = useMemo(
    () => (latest && spot != null ? positioningView(latest, prev, spot, scopeExp.map((e) => e.expiry), posSpan, posCallSign, minute) : null),
    // `minute` moves time to expiry along without recomputing on every render.
    [latest, prev, spot, posSpan, posCallSign, scopeExp, minute],
  );

  const history = useMemo(() => (snaps ? snaps.map((s) => dayLevels(s, posScope, posSpan, posCallSign, selected)) : []), [snaps, posScope, posSpan, posCallSign, selected]);

  if (model.chain.status !== 'ready') return <Shell>{null}</Shell>;

  const scopeOptions = EXPIRY_SCOPES.map((k) => ({ key: k, label: k === 'sel' ? `${m.sel} ${shortExpiry(selected)}` : m.within(k) }));
  const running = !!data.progress?.running;
  const today = tradingDay(Date.now());

  return (
    <Shell>
      <div style={{ gridColumn: '1 / 3', background: 'var(--p)', padding: '12px 20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 24px' }}>
        <Field label={m.expiries}>
          <Segmented options={scopeOptions} value={posScope} onChange={(k) => patch({ posScope: k })} itemStyle={{ padding: '4px 10px' }} />
        </Field>
        <Field label={m.strikes}>
          <Segmented options={STRIKE_SPANS.map((k) => ({ key: k, label: m.span(Math.round(k * 100)) }))} value={posSpan} onChange={(k) => patch({ posSpan: k })} itemStyle={{ padding: '4px 10px' }} />
        </Field>
        <Field label={m.dealerCalls} title={m.dealerTip}>
          <Segmented
            options={[
              { key: 1 as const, label: m.long, title: m.dealerTip },
              { key: -1 as const, label: m.short, title: m.dealerTip },
            ]}
            value={posCallSign}
            onChange={(k) => patch({ posCallSign: k })}
            itemStyle={{ padding: '4px 10px' }}
          />
        </Field>
        <div style={{ flex: 1 }} />
        <ScanStatus
          m={m}
          running={running}
          done={data.progress?.done ?? 0}
          total={data.progress?.total ?? 0}
          text={
            data.error
              ? data.error
              : latest
                ? `${latest.day !== today ? m.oldScan(dayText(latest.day)) + ' · ' : ''}${m.asOf(clock.time(latest.updatedAt, { date: 'md' }), latest.rows.length)}`
                : snaps
                  ? model.spot == null
                    ? m.waitingSpot
                    : m.toScan(plan.contracts.length)
                  : ''
          }
          error={!!data.error}
          sub={plan.trimmed ? m.trimmed(plan.trimmed) : undefined}
          canScan={plan.contracts.length > 0}
          onScan={data.scan}
          onStop={data.stop}
          hasData={!!latest}
        />
      </div>
      {!latest || !view ? (
        <div style={{ gridColumn: '1 / 3', background: 'var(--p)', padding: '18px 20px', fontSize: 13, color: 'var(--dm)' }}>{snaps && !running ? (model.spot == null && !latest ? m.waitingSpot : m.noScan) : ''}</div>
      ) : (
        <>
          <Cards m={m} view={view} spot={spot!} />
          <StrikeChart m={m} view={view} spot={model.spot ?? spot!} metric={posMetric} onMetric={(k) => patch({ posMetric: k })} symbol={model.symbol} />
          <LevelsHistory m={m} history={history} />
          <GexHistory m={m} history={history} />
          <Unusual m={m} rows={view.unusual} />
          <ByExpiry m={m} rows={view.perExpiry} />
          <div style={{ gridColumn: '1 / 3', background: 'var(--p)', padding: '12px 24px', fontSize: 11, lineHeight: 1.6, color: 'var(--dm)' }}>{m.note}</div>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
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
      {children}
    </div>
  );
}

function Field({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div title={title} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--mu)', whiteSpace: 'nowrap' }}>{label}</div>
      {children}
    </div>
  );
}

function ScanStatus(p: {
  m: PosM;
  running: boolean;
  done: number;
  total: number;
  text: string;
  error: boolean;
  sub?: string;
  canScan: boolean;
  hasData: boolean;
  onScan: () => void;
  onStop: () => void;
}) {
  const { m } = p;
  const link = (text: string, on: () => void, enabled = true) => (
    <div onClick={enabled ? on : undefined} style={{ fontSize: 12, color: enabled ? 'var(--ac)' : 'var(--dm)', cursor: enabled ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
      {text}
    </div>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, alignItems: 'flex-end' }}>
        {p.running ? (
          <>
            <div style={{ font: '12px/1 var(--num)', color: 'var(--mu)' }}>{m.scanning(p.done, p.total)}</div>
            <div style={{ width: 160, height: 3, background: 'var(--p2)' }}>
              <div style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%`, height: '100%', background: 'var(--ac)' }} />
            </div>
          </>
        ) : (
          <div className="ellipsis" style={{ fontSize: 12, color: p.error ? 'var(--r)' : 'var(--dm)' }}>
            {p.text}
          </div>
        )}
        {p.sub && <div style={{ fontSize: 11, color: 'var(--dm)' }}>{p.sub}</div>}
      </div>
      {p.running ? link(m.stop, p.onStop) : link(p.hasData ? m.rescan : m.scan, p.onScan, p.canScan)}
    </div>
  );
}

type View = PosView;

const signedBig = (m: PosM, v: number | undefined) => (v == null ? DASH : sg(v, (x) => m.big(x)));
const pctOf = (v: number) => sg(v * 100, (x) => f2(x, 1)) + '%';

function Cards({ m, view, spot }: { m: PosM; view: View; spot: number }) {
  const t = view.totals;
  // The regime is the sign of the total GEX at the price: above the zero-gamma level is not always the positive side.
  const positive = t.gex >= 0;
  const cards = [
    { l: m.netGex, v: signedBig(m, t.gex), d: positive ? m.posGamma : m.negGamma, title: m.metricTips.gex, color: positive ? CALL : PUT },
    { l: m.zeroGamma, v: view.zero != null ? f2(view.zero) : DASH, d: view.zero != null ? m.fromSpot(pctOf(view.zero / spot - 1)) : m.noFlip, title: m.zeroTip },
    { l: m.walls, v: `${strikeText(view.walls.call)} / ${strikeText(view.walls.put)}`, d: `${m.callWall} / ${m.putWall}`, title: m.wallsTip },
    { l: m.maxPain, v: strikeText(view.maxPain), d: view.first ? m.maxPainSub(shortExpiry(view.first)) : '', title: m.maxPainTip },
    {
      l: m.pcOi,
      v: t.callOi > 0 ? (t.putOi / t.callOi).toFixed(2) : DASH,
      d: view.hasPrev && (t.callOiChg != null || t.putOiChg != null) ? m.oiChgSub(signedBig(m, t.callOiChg ?? 0), signedBig(m, t.putOiChg ?? 0)) : m.noPrev,
    },
    { l: m.netDex, v: signedBig(m, t.dex), d: `${m.vannaCharm}: ${m.vannaCharmSub(signedBig(m, t.vanna), signedBig(m, t.charm))}`, title: `${m.metricTips.dex}\n${m.metricTips.vanna}\n${m.metricTips.charm}` },
  ];
  return (
    <div style={{ gridColumn: '1 / 3', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 'var(--gap)' }}>
      {cards.map((x) => (
        <div key={x.l} title={x.title} style={{ background: 'var(--p)', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--mu)' }}>{x.l}</div>
          <div style={{ font: '500 20px/1 var(--num)', color: x.color }}>{x.v}</div>
          <div className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)', minHeight: 11 }}>
            {x.d}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A bar part of a strike: its value and color; parts stack from zero, positive up and negative down (`side` −1 / 1: half-width, left / right). */
interface BarPart {
  v: number;
  color: string;
  side?: -1 | 1;
}

function partsOf(e: StrikeExposure, metric: PosMetric): BarPart[] {
  switch (metric) {
    case 'gex':
      return [
        { v: e.callGex, color: CALL },
        { v: e.putGex, color: PUT },
      ];
    case 'oi':
      return [
        { v: e.callOi, color: CALL },
        { v: -e.putOi, color: PUT },
      ];
    case 'vol':
      return [
        { v: e.callVol, color: CALL },
        { v: -e.putVol, color: PUT },
      ];
    case 'oiChg':
      return [
        { v: e.callOiChg ?? 0, color: CALL, side: -1 },
        { v: e.putOiChg ?? 0, color: PUT, side: 1 },
      ];
    default: {
      const v = e[metric];
      return [{ v, color: v >= 0 ? CALL : PUT }];
    }
  }
}

/** Each part's [from, to] once stacked. */
function stack(parts: BarPart[]): Array<BarPart & { y0: number; y1: number }> {
  let up = 0;
  let down = 0;
  return parts.map((p) => {
    if (p.side) return { ...p, y0: 0, y1: p.v };
    if (p.v >= 0) {
      const r = { ...p, y0: up, y1: up + p.v };
      up += p.v;
      return r;
    }
    const r = { ...p, y0: down, y1: down + p.v };
    down += p.v;
    return r;
  });
}

function StrikeChart({ m, view, spot, metric, onMetric, symbol }: { m: PosM; view: View; spot: number; metric: PosMetric; onMetric: (k: PosMetric) => void; symbol: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const by = view.by.filter((e) => e.strike >= view.lo && e.strike <= view.hi);
  const bars = by.map((e) => ({ k: e.strike, parts: stack(partsOf(e, metric)) }));
  const ext = bars.flatMap((b) => b.parts.flatMap((p) => [p.y0, p.y1]));
  const maxAbs = Math.max(1e-9, ...ext.map(Math.abs));
  const gex = metric === 'gex';
  const profMax = Math.max(1e-9, ...view.profile.map((p) => Math.abs(p.gex)));
  let body: ReactNode;
  if (!bars.length || maxAbs <= 1e-9) body = <EmptyChart height={260} text={m.noRows} />;
  else {
    const ys = gex ? [-maxAbs, maxAbs] : [...ext, 0];
    const s = chartScale([view.lo, view.hi], ys, VB_W, VB_H, 0.08);
    const ks = bars.map((b) => b.k);
    const gap = ks.length > 1 ? Math.min(...ks.slice(1).map((k, i) => k - ks[i])) : view.hi - view.lo;
    const w = Math.max(0.6, (s.X(view.lo + gap) - s.X(view.lo)) * 0.72);
    // The total GEX by price on its own scale, zero where the bars' zero is.
    const toLeft = (g: number) => (g / profMax) * Math.min(Math.abs(s.y0), Math.abs(s.y1)) * 0.95;
    const curve = gex ? polyPoints(view.profile.map((p) => ({ x: p.x, y: toLeft(p.gex) })), s) : '';
    const yTicks = niceTicks(s.y0, s.y1, Math.max(2, Math.floor(260 / 45)));
    const spotIn = spot >= view.lo && spot <= view.hi;
    const x: XLabel[] = [...(spotIn ? [{ at: s.X(spot) / VB_W, label: f2(spot), strong: true }] : []), ...niceTicks(view.lo, view.hi, 7).map((k) => ({ at: s.X(k) / VB_W, label: strikeText(k) }))];
    const marks: XLabel[] = [
      ...(gex && view.zero != null && view.zero >= view.lo && view.zero <= view.hi ? [{ at: s.X(view.zero) / VB_W, label: `${m.zeroGamma} ${f2(view.zero)}` }] : []),
      ...(gex && view.walls.call != null ? [{ at: s.X(view.walls.call) / VB_W, label: `${m.callWall} ${strikeText(view.walls.call)}` }] : []),
      ...(gex && view.walls.put != null ? [{ at: s.X(view.walls.put) / VB_W, label: `${m.putWall} ${strikeText(view.walls.put)}` }] : []),
      ...(metric === 'oi' && view.maxPain != null ? [{ at: s.X(view.maxPain) / VB_W, label: `${m.maxPain} ${strikeText(view.maxPain)}` }] : []),
    ];
    const at = hover == null ? -1 : nearestIndex(ks.map((k) => s.X(k) / VB_W), hover);
    const hb = by[at];
    const prof = hb && gex ? view.profile[nearestIndex(view.profile.map((p) => p.x), hb.strike)] : undefined;
    const readout = (e: StrikeExposure): Array<[string, string]> => {
      const big = (v: number | undefined) => signedBig(m, v);
      switch (metric) {
        case 'gex':
          return [
            [m.calls, big(e.callGex)],
            [m.puts, big(e.putGex)],
            [m.net, big(e.gex)],
            ...(prof ? [[m.totalGex, big(prof.gex)] as [string, string]] : []),
          ];
        case 'oi':
          return [
            [m.calls, m.big(e.callOi)],
            [m.puts, m.big(e.putOi)],
          ];
        case 'vol':
          return [
            [m.calls, m.big(e.callVol)],
            [m.puts, m.big(e.putVol)],
          ];
        case 'oiChg':
          return [
            [m.calls, e.callOiChg != null ? big(e.callOiChg) : DASH],
            [m.puts, e.putOiChg != null ? big(e.putOiChg) : DASH],
          ];
        default:
          return [[m.net, big(e[metric])]];
      }
    };
    body = (
      <Plot
        scale={s}
        height={260}
        x={x}
        marks={marks}
        onHover={setHover}
        yFormat={(v) => m.big(v)}
        overlay={(pw) => (
          <>
            {gex &&
              yTicks.map((v) => (
                <div key={v} style={{ ...axisText, ...halo, position: 'absolute', right: 4, top: share(s.Y(v), VB_H), transform: 'translateY(-50%)', color: PROFILE }}>
                  {m.big((v / (Math.min(Math.abs(s.y0), Math.abs(s.y1)) * 0.95)) * profMax)}
                </div>
              ))}
            {hb && (
              <Readout
                x={(s.X(hb.strike) / VB_W) * pw}
                width={pw}
                dots={prof ? [{ top: share(s.Y(toLeft(prof.gex)), VB_H), color: PROFILE }] : []}
                rows={[[m.strike, strikeText(hb.strike)], ...readout(hb)]}
              />
            )}
          </>
        )}
      >
        <line x1="0" x2={VB_W} y1={s.Y(0).toFixed(1)} y2={s.Y(0).toFixed(1)} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke' }} />
        {bars.map((b) =>
          b.parts.map((p, i) => {
            // Parts too small to see would only draw a dotted line along the axis.
            if (Math.abs(p.y1 - p.y0) < maxAbs * 0.003) return null;
            const cx = s.X(b.k);
            const bw = p.side ? w / 2 : w;
            const x0 = p.side === -1 ? cx - bw : p.side === 1 ? cx : cx - bw / 2;
            const [ya, yb] = [s.Y(p.y0), s.Y(p.y1)];
            return <rect key={`${b.k}:${i}`} x={x0.toFixed(2)} width={bw.toFixed(2)} y={Math.min(ya, yb).toFixed(2)} height={Math.max(0.5, Math.abs(yb - ya)).toFixed(2)} fill={p.color} opacity={0.85} />;
          }),
        )}
        {spotIn && <line x1={s.X(spot).toFixed(1)} x2={s.X(spot).toFixed(1)} y1="0" y2={VB_H} style={guideStroke} />}
        {marks.map((mk) => (
          <line key={mk.label} x1={(mk.at * VB_W).toFixed(1)} x2={(mk.at * VB_W).toFixed(1)} y1="0" y2={VB_H} style={{ stroke: mk.label.startsWith(m.zeroGamma) ? ZERO : 'var(--ln)', vectorEffect: 'non-scaling-stroke', strokeWidth: mk.label.startsWith(m.zeroGamma) ? 1.5 : 1, strokeDasharray: mk.label.startsWith(m.zeroGamma) ? undefined : '2 3' }} />
        ))}
        {gex && curve && <polyline points={curve} style={{ ...line, stroke: PROFILE, strokeWidth: 1.75 }} />}
      </Plot>
    );
  }
  return (
    <Card span>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
            {m.byStrike} · {symbol}
          </div>
          <Segmented options={POS_METRICS.map((k) => ({ key: k, label: m.metrics[k], title: m.metricTips[k] }))} value={metric} onChange={onMetric} itemStyle={{ padding: '4px 10px' }} />
        </div>
        <div style={legendStyle}>
          {metric === 'dex' || metric === 'vanna' || metric === 'charm' ? (
            <Key text={m.net} color={CALL} />
          ) : (
            <>
              <Key text={m.calls} color={CALL} />
              <Key text={m.puts} color={PUT} />
            </>
          )}
          {gex && <Key text={m.totalGex} color={PROFILE} />}
          {gex && <Key text={m.zeroGamma} color={ZERO} />}
        </div>
      </div>
      <div title={m.metricTips[metric]} style={{ fontSize: 11, color: 'var(--dm)' }}>
        {m.metricTips[metric]}
      </div>
      {body}
    </Card>
  );
}

/** Days of the history with a price, oldest first. */
const pricedDays = (history: DayLevels[]) => history.filter((d) => d.spot != null);

function dayLabels(days: DayLevels[]): XLabel[] {
  const n = days.length;
  return days.map((d, i) => ({ at: n > 1 ? i / (n - 1) : 0.5, label: dayText(d.day), strong: i === n - 1 }));
}

function LevelsHistory({ m, history }: { m: PosM; history: DayLevels[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = pricedDays(history);
  const series: Array<{ key: keyof DayLevels; label: string; color: string; dashed?: boolean }> = [
    { key: 'spot', label: m.price, color: 'var(--tx)' },
    { key: 'zeroGamma', label: m.zeroGamma, color: ZERO },
    { key: 'callWall', label: m.callWall, color: CALL },
    { key: 'putWall', label: m.putWall, color: PUT },
    { key: 'maxPain', label: m.maxPain, color: 'var(--mu)', dashed: true },
  ];
  let body: ReactNode;
  if (days.length < 2) body = <EmptyChart height={200} text={m.needDays(days.length)} />;
  else {
    const n = days.length;
    const vals = days.flatMap((d) => series.map((sr) => d[sr.key] as number | undefined)).filter((v): v is number => v != null);
    const s = chartScale([0, n - 1], vals, VB_W, VB_H);
    const at = hover == null ? -1 : Math.max(0, Math.min(n - 1, Math.round(hover * (n - 1))));
    const d = days[at];
    body = (
      <Plot
        scale={s}
        height={200}
        x={dayLabels(days)}
        onHover={setHover}
        yFormat={(v) => strikeText(v)}
        overlay={(pw) =>
          d && (
            <Readout
              x={(at / (n - 1)) * pw}
              width={pw}
              dots={series.flatMap((sr) => (d[sr.key] != null ? [{ top: share(s.Y(d[sr.key] as number), VB_H), color: sr.color }] : []))}
              rows={[['', dayText(d.day)], ...series.map((sr) => [sr.label, d[sr.key] != null ? (sr.key === 'spot' || sr.key === 'zeroGamma' ? f2(d[sr.key] as number) : strikeText(d[sr.key] as number)) : DASH] as [string, string])]}
            />
          )
        }
      >
        {series.map((sr) => (
          <polyline
            key={sr.key}
            points={polyPoints(
              days.map((x, i) => ({ x: i, y: x[sr.key] as number | undefined })),
              s,
            )}
            style={{ ...line, stroke: sr.color, strokeWidth: sr.key === 'spot' ? 1.5 : 1.25, strokeDasharray: sr.dashed ? '3 3' : undefined }}
          />
        ))}
      </Plot>
    );
  }
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{m.levels}</div>
        <div style={{ ...legendStyle, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {series.map((sr) => (
            <Key key={sr.key} text={sr.label} color={sr.color} dashed={sr.dashed} />
          ))}
        </div>
      </div>
      {body}
    </Card>
  );
}

function GexHistory({ m, history }: { m: PosM; history: DayLevels[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = pricedDays(history);
  let body: ReactNode;
  if (days.length < 2) body = <EmptyChart height={200} text={m.needDays(days.length)} />;
  else {
    const n = days.length;
    const s = chartScale([-0.5, n - 0.5], [0, ...days.map((d) => d.gex)], VB_W, VB_H);
    const w = (s.X(1) - s.X(0)) * 0.6;
    const at = hover == null ? -1 : Math.max(0, Math.min(n - 1, Math.round(hover * n - 0.5)));
    const d = days[at];
    body = (
      <Plot
        scale={s}
        height={200}
        x={days.map((x, i) => ({ at: s.X(i) / VB_W, label: dayText(x.day), strong: i === n - 1 }))}
        onHover={setHover}
        yFormat={(v) => m.big(v)}
        overlay={(pw) => d && <Readout x={(s.X(at) / VB_W) * pw} width={pw} dots={[]} rows={[['', dayText(d.day)], [m.netGex, signedBig(m, d.gex)]]} />}
      >
        <line x1="0" x2={VB_W} y1={s.Y(0).toFixed(1)} y2={s.Y(0).toFixed(1)} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke' }} />
        {days.map((x, i) => {
          const [ya, yb] = [s.Y(0), s.Y(x.gex)];
          return <rect key={x.day} x={(s.X(i) - w / 2).toFixed(2)} width={w.toFixed(2)} y={Math.min(ya, yb).toFixed(2)} height={Math.max(0.5, Math.abs(yb - ya)).toFixed(2)} fill={x.gex >= 0 ? CALL : PUT} opacity={0.85} />;
        })}
      </Plot>
    );
  }
  return (
    <Card>
      <div style={{ fontWeight: 600 }}>{m.gexHist}</div>
      {body}
    </Card>
  );
}

const th = { fontSize: 11, color: 'var(--dm)', padding: '0 0 8px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
const td = { font: '12px/1 var(--num)', fontVariantNumeric: 'tabular-nums' as const, padding: '7px 0', textAlign: 'right' as const, whiteSpace: 'nowrap' as const, boxShadow: 'inset 0 1px 0 var(--ln2)' };

function Table({ cols, rows }: { cols: Array<{ l: string; left?: boolean }>; rows: Array<Array<{ v: ReactNode; color?: string }>> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `minmax(0,1.4fr) repeat(${cols.length - 1}, minmax(0,1fr))`, columnGap: 12 }}>
      {cols.map((c, i) => (
        <div key={c.l} style={{ ...th, textAlign: i === 0 || c.left ? 'left' : 'right' }}>
          {c.l}
        </div>
      ))}
      {rows.map((r, ri) => (
        <Fragment key={ri}>
          {r.map((c, i) => (
            <div key={i} style={{ ...td, textAlign: i === 0 ? 'left' : 'right', color: c.color }}>
              {c.v}
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function Unusual({ m, rows }: { m: PosM; rows: View['unusual'] }) {
  return (
    <Card>
      <div title={m.unusualTip} style={{ fontWeight: 600 }}>
        {m.unusual}
      </div>
      {rows.length ? (
        <Table
          cols={[{ l: m.colContract }, { l: m.colVol }, { l: m.colOi }, { l: m.colRatio }]}
          rows={rows.map((u) => [
            { v: `${shortExpiry(u.expiry)} ${strikeText(u.strike)} ${u.right}`, color: u.right === 'C' ? CALL : PUT },
            { v: m.big(u.volume) },
            { v: m.big(u.oi) },
            { v: Number.isFinite(u.ratio) ? u.ratio.toFixed(1) + '×' : DASH },
          ])}
        />
      ) : (
        <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.noUnusual}</div>
      )}
    </Card>
  );
}

function ByExpiry({ m, rows }: { m: PosM; rows: View['perExpiry'] }) {
  return (
    <Card>
      <div style={{ fontWeight: 600 }}>{m.byExpiry}</div>
      <Table
        cols={[{ l: m.colExp }, { l: m.colDte }, { l: m.colCallOi }, { l: m.colPutOi }, { l: m.colPc }, { l: m.colMaxPain }, { l: m.colGex }]}
        rows={rows.map((e) => [
          { v: shortExpiry(e.expiry) },
          { v: String(daysToExpiry(e.expiry)) },
          { v: m.big(e.callOi) },
          { v: m.big(e.putOi) },
          { v: e.callOi > 0 ? (e.putOi / e.callOi).toFixed(2) : DASH },
          { v: strikeText(e.maxPain) },
          { v: signedBig(m, e.gex), color: e.gex >= 0 ? CALL : PUT },
        ])}
      />
    </Card>
  );
}
