// Volatility tab: cards (HV 30 from the daily closes, IV30 / HV30 against this stock's own year, the
// 25Δ skew, the implied against the realized daily move), the selected expiry's OTM smile, the ATM
// term structure with the ex-dividend and earnings dates, the expected move by expiry (forward
// vols, IV30/60/90 and the event move the term structure prices) and the 52-week IV history
// against HV with IV rank over 13 / 26 / 52 weeks. IV is IB's (option ticks, OPTION_IMPLIED_VOLATILITY
// bars); HV is computed from the daily TRADES bars (vol.ts). IV Rank (52w) is also in the desk
// header. Each chart reads IV % at round values on its left (Plot) and its x under it: strikes and
// the spot price (smile), expiries placed by days to expiry (term), months and years (history);
// the smile and the history read out the values under the pointer.

import { Fragment, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { daysToExpiry, shortExpiry } from '@shared/contract';
import { DASH, f2, sg } from '@shared/format';
import { nyClock } from '@shared/session';
import type { EarningsEvent, QuoteDividends } from '@shared/types';
import { useClock } from '../../i18n';
import { stableGutter } from '../../ui/scrollGutter';
import { pickTimeStep, timeStepSpacing, timeTickGap, timeTicks, type LabelClock } from '../chart/chartMath';
import { useSize } from '../chart/useSize';
import { fixed, nearestIndex, type OptionData } from './chain';
import { useDailyCloses, useIvHistory, useNextEarnings } from './data';
import { useM } from './messages';
import { Card, EmptyChart, Key, Plot, Readout, VB_H, VB_W, Y_GUTTER, axisText, guideStroke, halo, legendStyle, line, share, withSpan } from './plot';
import type { ChainRow, DeskModel, TermPoint } from './model';
import { chartScale, fitLabels, niceTicks, polyPoints, type XLabel } from './svg';
import {
  barDate,
  dailyMove,
  eventMove,
  eventVariance,
  findEvent,
  firstExpiryAfter,
  forwardVariance,
  HV_DAYS,
  hvOnDates,
  ivAt,
  ivChange,
  ivHvRatios,
  ivRanks,
  percentileOf,
  realizedVol,
  skew25,
  skewPoints,
  termShape,
  UNDATED_EVENT_HORIZON,
  type Skew25,
  type TermVol,
} from './vol';

const pctText = (v: number | undefined, digits = 1) => (v == null ? DASH : (v * 100).toFixed(digits) + '%');
/** A difference of vols, in points ("+4.2%"); one that rounds to zero has no sign. */
const ptsText = (v: number | undefined) => (v == null ? DASH : Math.abs(v * 100) < 0.05 ? '0.0%' : sg(v * 100, (x) => x.toFixed(1)) + '%');

type IvTermPoint = TermPoint & { iv: number };

export function VolatilityTab({ model }: { model: DeskModel }) {
  const m = useM();
  const { uq, spot } = model;
  const iv = useIvHistory(model.underlying, uq?.impliedVol);
  const daily = useDailyCloses(model.underlying);
  const earnings = useNextEarnings(model.underlying);

  // Realized volatility of the daily closes; without them IB's 30-day HV (tick 58, which IB stops
  // sending outside regular hours, else tick 23).
  const realized = useMemo(() => {
    const c = daily.closes;
    return c ? { hv10: realizedVol(c, 10), hv20: realizedVol(c, 20), hv30: realizedVol(c, HV_DAYS), hv60: realizedVol(c, 60) } : null;
  }, [daily.closes]);
  const hv = realized?.hv30 ?? [uq?.rtHistVol, uq?.histVol].find((v) => v != null && v > 0);

  const term = model.term.filter((p): p is IvTermPoint => p.iv != null && p.t > 0);
  const vols: TermVol[] = term.map((p) => ({ t: p.t, iv: p.iv }));
  // IV30: the underlying's 30-day IV (tick 24, else its last daily IV bar: the history's "now"),
  // else the term structure's at 30 days. Over HV 30, whatever expiry is selected; rich or cheap by
  // where the ratio sits among the past year's.
  const iv30 = iv.current ?? ivAt(vols, 30 / 365);
  const ratio = iv30 != null && hv != null ? iv30 / hv : undefined;
  const hvHist = useMemo(() => (iv.times && daily.times && daily.closes ? hvOnDates(iv.times, daily.times, daily.closes) : null), [iv.times, daily.times, daily.closes]);
  const ratioPct = ratio != null && realized?.hv30 != null && iv.hist && hvHist ? percentileOf(ivHvRatios(iv.hist, hvHist), ratio) : undefined;
  const rich = ratio != null && (ratioPct != null ? ratioPct >= 0.8 : ratio > 1.2);
  const cheap = ratio != null && (ratioPct != null ? ratioPct <= 0.2 : ratio < 0.9);
  const verdict = ratio == null ? '' : rich ? m.rich : cheap ? m.cheap : m.fair;

  const skew = spot != null ? skewOf(model, spot) : undefined;
  const move = (v: number | undefined) => (spot != null && v != null ? '±' + f2(dailyMove(spot, v)) : DASH);

  const cards = [
    { l: m.hv, v: pctText(hv), d: realized?.hv30 != null ? m.hvSub(pctText(realized.hv10), pctText(realized.hv60)) : m.realized, title: realized?.hv30 != null ? m.hvTip : undefined },
    { l: m.ivHv, v: ratio != null ? ratio.toFixed(2) : DASH, d: ratioPct != null ? `${verdict} · ${m.yearPctl(pctText(ratioPct, 0))}` : verdict, title: ratioPct != null ? m.ivHvTip : m.ivHvTipFixed },
    { l: m.skew, v: ptsText(skew?.skew), d: skew ? m.skewSub(ptsText(skew.fly)) : m.skewNone, title: m.skewTip },
    { l: m.dayMove, v: move(iv30), d: m.dayMoveSub(move(realized?.hv10), move(realized?.hv20)), title: m.dayMoveTip },
  ];

  // The event the term structure prices: before the first expiry after the next earnings (Wall
  // Street Horizon), else where its forward vols show one in the near weeks (vol.ts → findEvent).
  const dated = earnings ? firstExpiryAfter(term.map((p) => p.expiry), earnings.date, earnings.time) : -1;
  const eventAt = earnings ? (dated >= 0 ? dated : undefined) : findEvent(vols, UNDATED_EVENT_HORIZON);
  const div = uq?.dividends?.nextDate ? uq.dividends : undefined;
  const markers = [...(div?.nextDate ? [{ date: div.nextDate, label: m.exDiv }] : []), ...(earnings ? [{ date: earnings.date, label: m.earnings }] : [])];

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
      <div style={{ gridColumn: '1 / 3', display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 'var(--gap)' }}>
        {cards.map((x) => (
          <div key={x.l} title={x.title} style={{ background: 'var(--p)', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--mu)' }}>{x.l}</div>
            <div style={{ font: '500 20px/1 var(--num)' }}>{x.v}</div>
            <div className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)', minHeight: 11 }}>
              {x.d}
            </div>
          </div>
        ))}
      </div>
      <Smile model={model} skew={skew} />
      <Term model={model} term={term} markers={markers} />
      <TermTable model={model} term={term} vols={vols} eventAt={eventAt} earnings={earnings} div={div} />
      <IvHistory iv={iv} hvHist={hvHist} hv={hv} />
    </div>
  );
}

/** The selected expiry's 25Δ skew, from the quoted rows and the 25Δ wings beyond them (model.ts). */
function skewOf(model: DeskModel, spot: number): Skew25 | undefined {
  const { puts, calls } = skewPoints(
    [
      ...model.quotedRows.flatMap((r) => [
        { ...r.call, strike: r.strike, right: 'C' as const },
        { ...r.put, strike: r.strike, right: 'P' as const },
      ]),
      ...model.wings.map((w) => ({ ...w.data, strike: w.strike, right: w.right })),
    ],
    spot,
  );
  return skew25(puts, calls, model.ivAtm);
}

/** Strikes as on the chain: no trailing zeros ("230", "227.5"). */
const strikeText = (v: number) => String(Number(v.toFixed(2)));

/** A smile point's IV and delta ("24.1% · Δ −0.31"). */
const ivDelta = (iv: number | undefined, delta: number | undefined) => `${pctText(iv)} · Δ ${fixed(delta, 2)}`;

/** A strike of the smile: its OTM IV, and the call's and put's data where quoted (a 25Δ wing has one). */
interface SmilePoint {
  strike: number;
  iv: number;
  call?: OptionData;
  put?: OptionData;
}

function Smile({ model, skew }: { model: DeskModel; skew: Skew25 | undefined }) {
  const m = useM();
  const [hover, setHover] = useState<number | null>(null);
  const spot = model.spot;
  // Out of the money: puts below the price, calls above (the in-the-money sides are thin and
  // noisy); the quoted rows and the 25Δ wings beyond them.
  const otm = (r: ChainRow) => (spot == null ? (r.call.iv ?? r.put.iv) : r.strike < spot ? r.put.iv : r.call.iv);
  const pts: SmilePoint[] = [
    ...model.quotedRows.flatMap((r) => {
      const iv = otm(r);
      return iv != null ? [{ strike: r.strike, iv, call: r.call, put: r.put }] : [];
    }),
    ...model.wings.flatMap((w) =>
      w.data.iv != null && (spot == null || (w.right === 'P' ? w.strike < spot : w.strike >= spot)) ? [{ strike: w.strike, iv: w.data.iv, [w.right === 'C' ? 'call' : 'put']: w.data }] : [],
    ),
  ].sort((a, b) => a.strike - b.strike);
  const exp = model.exp ? shortExpiry(model.exp.expiry) : '';
  let body: ReactNode;
  if (pts.length < 2) body = <EmptyChart height={220} text={m.noSmile} />;
  else {
    const xs = pts.map((r) => r.strike);
    const s = chartScale(
      xs,
      withSpan(
        pts.map((p) => p.iv * 100),
        2,
      ),
      VB_W,
      VB_H,
    );
    const curve = polyPoints(
      pts.map((p) => ({ x: p.strike, y: p.iv * 100 })),
      s,
    );
    const spotIn = spot != null && spot >= s.x0 && spot <= s.x1;
    // Strikes at round values, and the spot price under its line.
    const x: XLabel[] = [
      ...(spotIn ? [{ at: s.X(spot) / VB_W, label: f2(spot), strong: true }] : []),
      ...niceTicks(s.x0, s.x1, 6).map((k) => ({ at: s.X(k) / VB_W, label: strikeText(k) })),
    ];
    const wings = skew
      ? [
          { k: skew.putStrike, iv: skew.put },
          { k: skew.callStrike, iv: skew.call },
        ].filter((p) => p.k >= s.x0 && p.k <= s.x1)
      : [];
    // The strike nearest the pointer.
    const at = hover == null ? -1 : nearestIndex(xs.map((k) => s.X(k) / VB_W), hover);
    const r = pts[at];
    body = (
      <Plot
        scale={s}
        height={220}
        x={x}
        onHover={setHover}
        overlay={(w) => (
          <>
            {wings.map((p) => (
              <Fragment key={p.k}>
                <div style={{ position: 'absolute', left: share(s.X(p.k), VB_W), top: share(s.Y(p.iv * 100), VB_H), transform: 'translate(-50%,-50%)', width: 7, height: 7, background: 'var(--p)', boxShadow: 'inset 0 0 0 1.5px var(--ac)' }} />
                <div style={{ ...axisText, ...halo, position: 'absolute', left: share(s.X(p.k), VB_W), top: share(s.Y(p.iv * 100), VB_H), transform: 'translate(-50%,-20px)', color: 'var(--mu)' }}>25Δ</div>
              </Fragment>
            ))}
            {r && (
              <Readout
                x={(s.X(r.strike) / VB_W) * w}
                width={w}
                dots={[{ top: share(s.Y(r.iv * 100), VB_H), color: 'var(--ac)' }]}
                rows={[
                  [m.strike, strikeText(r.strike)],
                  [m.callIv, r.call ? ivDelta(r.call.iv, r.call.delta) : DASH],
                  [m.putIv, r.put ? ivDelta(r.put.iv, r.put.delta) : DASH],
                ]}
              />
            )}
          </>
        )}
      >
        {spotIn && <line x1={s.X(spot).toFixed(1)} x2={s.X(spot).toFixed(1)} y1="0" y2={VB_H} style={guideStroke} />}
        <polyline points={curve} style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.75 }} />
      </Plot>
    );
  }
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
          {m.smile} · {model.symbol} {exp}
        </div>
        <div style={legendStyle}>
          <Key text={m.otmIv} color="var(--ac)" />
          <Key text="25Δ" color="var(--ac)" mark />
        </div>
      </div>
      {body}
    </Card>
  );
}

/** Share of the term chart's days kept free at either end, so the first and last points and their values stay inside it. */
const TERM_EDGE = 0.05;

/**
 * ATM IV per sampled expiry (the selected one ringed), placed by days to expiry, each expiry's
 * date under its point, and the ex-dividend and earnings dates as lines (labelled under the axis). A point's value shows
 * where its date does: far expiries crowd the near ones together, and the dates are thinned so
 * they never touch.
 */
function Term({ model, term, markers }: { model: DeskModel; term: IvTermPoint[]; markers: Array<{ date: string; label: string }> }) {
  const m = useM();
  let body: ReactNode;
  if (term.length < 2) body = <EmptyChart height={220} text={m.noTerm} />;
  else {
    const vs = term.map((p) => p.iv * 100);
    const dtes = term.map((p) => p.dte);
    const [d0, d1] = [Math.min(...dtes), Math.max(...dtes)];
    const edge = (d1 - d0) * TERM_EDGE || 1;
    const s = chartScale([d0 - edge, ...dtes, d1 + edge], withSpan(vs, 1), VB_W, VB_H);
    const dots = term.map((p, i) => ({ x: share(s.X(p.dte), VB_W), y: share(s.Y(vs[i]), VB_H), at: s.X(p.dte) / VB_W, l: shortExpiry(p.expiry), v: vs[i].toFixed(1) + '%', sel: p.expiry === model.exp?.expiry }));
    const dates = dots.map((d) => ({ at: d.at, label: d.l }));
    const lines = markers.map((k) => ({ ...k, dte: daysToExpiry(k.date) })).filter((k) => k.dte >= s.x0 && k.dte <= s.x1);
    body = (
      <Plot
        scale={s}
        height={220}
        x={dates}
        marks={lines.map((k) => ({ at: s.X(k.dte) / VB_W, label: `${k.label} ${shortExpiry(k.date)}` }))}
        overlay={(w) => {
          const shown = new Set(fitLabels(dates, w).map((l) => l.label));
          return (
            <>
              {dots.map((d) => (
                <div key={d.l}>
                  <div
                    style={{
                      position: 'absolute',
                      left: d.x,
                      top: d.y,
                      transform: 'translate(-50%,-50%)',
                      width: 7,
                      height: 7,
                      background: 'var(--ac)',
                      ...(d.sel ? { boxShadow: '0 0 0 2px var(--p), 0 0 0 3px var(--ac)' } : null),
                    }}
                  />
                  {shown.has(d.l) && (
                    <div style={{ ...halo, position: 'absolute', left: d.x, top: d.y, transform: 'translate(-50%,-22px)', font: '10px/1 var(--num)', color: 'var(--mu)', whiteSpace: 'nowrap' }}>{d.v}</div>
                  )}
                </div>
              ))}
            </>
          );
        }}
      >
        {lines.map((k) => (
          <line key={k.label} x1={s.X(k.dte).toFixed(1)} x2={s.X(k.dte).toFixed(1)} y1="0" y2={VB_H} style={guideStroke} />
        ))}
        <polyline
          points={polyPoints(
            term.map((p, i) => ({ x: p.dte, y: vs[i] })),
            s,
          )}
          style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.75 }}
        />
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

const cellText: CSSProperties = { font: '12px/1 var(--num)', fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' };

/**
 * The expected move by sampled expiry: ATM strike and IV, the forward vol from the previous
 * expiry, the 1σ move in price and percent with its range, and the ATM straddle; the selected
 * expiry shaded. Above it the ATM IV at 30, 60 and 90 days (total variance interpolated between the
 * expiries) and the curve's shape, the event move (vol.ts → eventMove) and the next ex-dividend date.
 */
function TermTable({
  model,
  term,
  vols,
  eventAt,
  earnings,
  div,
}: {
  model: DeskModel;
  term: IvTermPoint[];
  vols: TermVol[];
  eventAt: number | undefined;
  earnings: EarningsEvent | undefined;
  div: QuoteDividends | undefined;
}) {
  const m = useM();
  const spot = model.spot;
  const [iv30, iv60, iv90] = [30, 60, 90].map((d) => ivAt(vols, d / 365));
  const shape = iv30 != null && iv90 != null ? termShape(iv30, iv90) : undefined;
  // The event's move; with an earnings date and none, "no extra move priced yet" only when it was
  // measured (an expiry after the date and a base around it), else the date alone.
  const measured = eventAt != null ? eventVariance(vols, eventAt) : undefined;
  const ev = eventAt != null ? eventMove(vols, eventAt) : undefined;
  const dated = earnings ? m.earningsOn(shortExpiry(earnings.date), earnings.time) : '';
  const event =
    eventAt != null && ev != null
      ? `${m.eventMove(spot != null ? f2(spot * ev) : DASH, pctText(ev), shortExpiry(term[eventAt].expiry))} · ${dated || m.eventFromTerm}`
      : measured
        ? `${dated} · ${m.noEventMove}`
        : dated;
  const cols: Array<{ l: string; title?: string }> = [
    { l: m.colExp },
    { l: m.colDte },
    { l: m.colStrike },
    { l: m.colIv },
    { l: m.colFwd, title: m.fwdTip },
    { l: m.colMove },
    { l: m.colMovePct },
    { l: m.colRange },
    { l: m.colStraddle, title: m.straddleTip },
  ];
  // The 1σ range ("5,602.31 – 5,809.59") gets the wide column.
  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(84px,1.2fr) repeat(6,minmax(0,1fr)) minmax(150px,2fr) minmax(0,1fr)', columnGap: 12, alignItems: 'center' };
  return (
    <Card span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
        <div style={{ fontWeight: 600 }}>{m.termTable}</div>
        <div style={{ flex: 1 }} />
        <div data-vol="term-stats" style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--mu)', whiteSpace: 'nowrap' }}>
          {[30, 60, 90].map((d, i) => (
            <div key={d}>
              {m.atmDays(d)} <span style={{ fontFamily: 'var(--num)', color: 'var(--tx)' }}>{pctText([iv30, iv60, iv90][i])}</span>
            </div>
          ))}
          {shape && <div>{m.shape[shape]}</div>}
        </div>
      </div>
      {(event || div?.nextDate) && (
        <div style={{ display: 'flex', gap: 24, fontSize: 12, color: 'var(--mu)' }}>
          {event && (
            <div data-vol="event" title={ev != null ? m.eventTip : undefined}>
              {event}
            </div>
          )}
          {div?.nextDate && <div>{m.exDivOn(shortExpiry(div.nextDate), f2(div.nextAmount))}</div>}
        </div>
      )}
      {term.length ? (
        <div data-vol="term-table">
          <div style={{ ...grid, height: 26, fontSize: 11, color: 'var(--dm)', boxShadow: 'inset 0 -1px 0 var(--ln)' }}>
            {cols.map((c, i) => (
              <div key={c.l} title={c.title} style={{ textAlign: i ? 'right' : 'left', whiteSpace: 'nowrap' }}>
                {c.l}
              </div>
            ))}
          </div>
          {term.map((p, i) => {
            const fv = i > 0 ? forwardVariance(vols[i - 1], vols[i]) : undefined;
            const sd = p.iv * Math.sqrt(p.t);
            const em = spot != null ? spot * sd : undefined;
            const straddle = p.callMark != null && p.putMark != null ? p.callMark + p.putMark : undefined;
            const sel = p.expiry === model.exp?.expiry;
            return (
              <div key={p.expiry} style={{ ...grid, height: 28, boxShadow: 'inset 0 -1px 0 var(--ln2)', ...(sel ? { background: 'var(--p2)' } : null) }}>
                <div style={{ ...cellText, textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center' }}>
                  {shortExpiry(p.expiry)}
                  {i === eventAt && ev != null && <span style={{ fontSize: 10, color: 'var(--ac)' }}>{m.event}</span>}
                </div>
                <div style={cellText}>{p.dte}</div>
                <div style={cellText}>{strikeText(p.strike)}</div>
                <div style={{ ...cellText, color: 'var(--tx)' }}>{pctText(p.iv)}</div>
                <div style={{ ...cellText, ...(fv != null && fv <= 0 ? { color: 'var(--r)' } : null) }} title={fv != null && fv <= 0 ? m.fwdNegTip : undefined}>
                  {fv == null ? DASH : fv > 0 ? pctText(Math.sqrt(fv)) : '<0'}
                </div>
                <div style={{ ...cellText, color: 'var(--tx)' }}>{em != null ? '±' + f2(em) : DASH}</div>
                <div style={cellText}>±{pctText(sd)}</div>
                <div style={cellText}>{em != null ? `${f2(spot! - em)} – ${f2(spot! + em)}` : DASH}</div>
                <div style={cellText}>{f2(straddle)}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyChart height={60} text={m.noTerm} />
      )}
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

/** "2026-03-14" of a daily bar. */
const dayText = (time: number) => barDate(time).replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3');

/**
 * 52 weeks of IB's 30-day IV against HV 30 (from the daily closes, vol.ts → hvOnDates), the 52-week
 * high and low dashed. Above: IV now with its change since the last session, HV now, IV − HV, the
 * 52-week range, and IV rank and percentile over 13, 26 and 52 weeks.
 */
function IvHistory({ iv, hvHist, hv }: { iv: ReturnType<typeof useIvHistory>; hvHist: Array<number | undefined> | null; hv: number | undefined }) {
  const m = useM();
  const clock = useClock();
  const widthRef = useRef<HTMLDivElement>(null);
  const { w } = useSize(widthRef);
  const [hover, setHover] = useState<number | null>(null);
  const { hist, times, current, stats } = iv;
  const hvs = hist && hvHist && hvHist.length === hist.length ? hvHist : null;
  const ok = hist && hist.length > 1 && stats;
  const s = ok
    ? chartScale(
        hist.map((_, i) => i),
        [...hist, ...(hvs ?? []).filter((v): v is number => v != null)].map((v) => v * 100),
        VB_W,
        VB_H,
      )
    : null;
  const change = hist && times ? ivChange(times, hist, current, nyClock().ymd) : undefined;
  const ranks = hist ? ivRanks(hist, current) : [];
  const val = (v: string) => <span style={{ fontFamily: 'var(--num)', color: 'var(--tx)' }}>{v}</span>;
  // The plot is the card's width less the IV % labels.
  const x = times && times.length === hist?.length ? historyLabels(times, Math.max(0, w - Y_GUTTER), clock) : [];
  const n = hist?.length ?? 0;
  const at = hover != null && n > 1 ? Math.max(0, Math.min(n - 1, Math.round(hover * (n - 1)))) : -1;
  return (
    <Card span>
      <div ref={widthRef} style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
        <div style={{ fontWeight: 600 }}>{m.hist}</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 24, fontSize: 12, color: 'var(--mu)', whiteSpace: 'nowrap' }}>
          <div>
            {m.now} <span style={{ fontFamily: 'var(--num)', color: 'var(--ac)' }}>{pctText(current)}</span>
            {change != null && <span style={{ fontFamily: 'var(--num)', marginLeft: 6 }}>{m.ivToday(ptsText(change))}</span>}
          </div>
          <div>
            {m.histHv} {val(pctText(hv))}
          </div>
          <div>
            {m.ivMinusHv} {val(ptsText(current != null && hv != null ? current - hv : undefined))}
          </div>
          <div>
            {m.hi52} {val(pctText(stats?.max))}
          </div>
          <div>
            {m.lo52} {val(pctText(stats?.min))}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={legendStyle}>
          <Key text={m.histIv} color="var(--ac)" />
          {hvs && <Key text={m.histHv} color="var(--mu)" dashed />}
        </div>
        <div style={{ flex: 1 }} />
        <div data-vol="ranks" style={{ display: 'flex', gap: 24, fontSize: 12, color: 'var(--mu)', whiteSpace: 'nowrap' }}>
          {[
            { l: m.ivRank, v: ranks.map((r) => (r.stats ? (r.stats.rank * 100).toFixed(0) : DASH)) },
            { l: m.ivPct, v: ranks.map((r) => (r.stats ? (r.stats.percentile * 100).toFixed(0) + '%' : DASH)) },
          ].map((row) => (
            <div key={row.l} style={{ display: 'flex', gap: 10 }}>
              {row.l}
              {ranks.map((r, i) => (
                <span key={r.weeks}>
                  {m.weeks(r.weeks)} {val(row.v[i])}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      {s && hist && stats ? (
        <Plot
          scale={s}
          height={200}
          x={x}
          onHover={setHover}
          overlay={(pw) => (
            <>
              {current != null && (
                <div style={{ position: 'absolute', right: -4, top: share(s.Y(current * 100), VB_H), transform: 'translateY(-50%)', width: 8, height: 8, background: 'var(--ac)' }} />
              )}
              {at >= 0 && (
                <Readout
                  x={(at / (n - 1)) * pw}
                  width={pw}
                  dots={[
                    { top: share(s.Y(hist[at] * 100), VB_H), color: 'var(--ac)' },
                    ...(hvs?.[at] != null ? [{ top: share(s.Y(hvs[at]! * 100), VB_H), color: 'var(--mu)' }] : []),
                  ]}
                  rows={[
                    ...(times ? [['', dayText(times[at])] as [string, string]] : []),
                    [m.histIv, pctText(hist[at])],
                    [m.histHv, pctText(hvs?.[at])],
                  ]}
                />
              )}
            </>
          )}
        >
          <line x1="0" x2={VB_W} y1={s.Y(stats.max * 100).toFixed(1)} y2={s.Y(stats.max * 100).toFixed(1)} style={guideStroke} />
          <line x1="0" x2={VB_W} y1={s.Y(stats.min * 100).toFixed(1)} y2={s.Y(stats.min * 100).toFixed(1)} style={guideStroke} />
          {hvs && (
            <polyline
              points={polyPoints(
                hvs.map((v, i) => ({ x: i, y: v != null ? v * 100 : undefined })),
                s,
              )}
              style={{ ...line, stroke: 'var(--mu)', strokeWidth: 1.25, strokeDasharray: '3 3' }}
            />
          )}
          <polyline
            points={polyPoints(
              hist.map((v, i) => ({ x: i, y: v * 100 })),
              s,
            )}
            style={{ ...line, stroke: 'var(--ac)', strokeWidth: 1.25 }}
          />
        </Plot>
      ) : (
        <EmptyChart height={200} text={m.noHist} />
      )}
    </Card>
  );
}
