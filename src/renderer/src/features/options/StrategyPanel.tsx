// Strategy builder (right column of the chain tab): templates, legs, payoff chart,
// statistics, optional trigger condition, net greeks and the send button. Its parts and state
// (useStrategy) are shared with the floating builder (features/panels/StrategyFloat).

import { useCommon } from '../../i18n/common';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { DASH, f0, f2, sg, usd } from '@shared/format';
import { isPanelSending } from '../../state/orderFeedback';
import { useStore } from '../../state/store';
import type { PanelId } from '../panels/model';
import { TextInput, Toggle } from '../../ui/primitives';
import { fixed } from './chain';
import { useDesk } from './deskStore';
import { buildListed, dropUnlisted } from './listing';
import { payoffCurve } from './math';
import { useM, type DeskMessages } from './messages';
import type { DeskModel } from './model';
import { defaultTrigger } from './orders';
import { sendStrategy } from './sendStrategy';
import { buildStrategy, hasStockLeg, legContract, NO_STRATEGY_ICON, STRATEGIES, type StrategyKey } from './strategies';
import { orderPrice, strategyView, withNetPrice, type StrategyView } from './strategyModel';

/**
 * The strategy builder's state and actions, shared by the docked panel and the floating one
 * (features/panels/StrategyFloat): the legs' view at the order's price (the floating panel's
 * − / + may set it), the template picker and the send flow. `origin`: the floating panel the
 * order is sent from (its status strip reports it instead of toasts).
 */
export function useStrategy(model: DeskModel, origin?: PanelId) {
  const desk = useDesk();
  const { legs, tmpl, tmplOpen, netPrice } = desk;
  const [sending, setSending] = useState(false);
  const { underlying, spot } = model;

  const view = useMemo(
    () => (underlying ? withNetPrice(strategyView(legs, underlying, spot, model.uq, model.quotes, model.ivAtm), netPrice) : null),
    [legs, underlying, spot, model.uq, model.quotes, model.ivAtm, netPrice],
  );

  const isIndex = underlying?.secType === 'IND';
  const current = STRATEGIES.find((s) => s.key === tmpl) ?? (legs.length ? STRATEGIES[STRATEGIES.length - 1] : null);
  const open = tmplOpen || !legs.length;
  const pickTemplate = (key: StrategyKey) => {
    if (isIndex && hasStockLeg(key)) return;
    const { centerStrike: center, expIndex } = model;
    const expiries = model.chain.expiries;
    if (center == null || !underlying) return desk.setLegs([], key);
    desk.setLegs(buildStrategy(key, expiries, expIndex, center), key);
    if (useStore.getState().demo) return;
    // The back month of a calendar and strikes outside the quoted window may not be listed in
    // their expiry: check the legs with IB and rebuild unless the user has changed them meanwhile.
    const shown = useDesk.getState().legs;
    const build = (unlisted: ReadonlySet<string>) => buildStrategy(key, dropUnlisted(expiries, unlisted), expIndex, center);
    void buildListed(build, (l) => legContract(l, underlying)).then((listed) => {
      const st = useDesk.getState();
      if (st.legs === shown && listed.some((l, i) => l.strike !== shown[i]?.strike)) st.setLegs(listed, key);
    });
  };
  const send = async () => {
    if (!underlying || sending || !view || isPanelSending(origin)) return;
    setSending(true);
    try {
      const st = useDesk.getState();
      await sendStrategy({
        view,
        underlying,
        tmpl: st.tmpl,
        cond: { on: st.cond, op: st.condOp, px: st.condPx ?? (spot != null ? defaultTrigger(spot, st.condOp) : '') },
        order: { type: st.ordType, tif: st.tif, nonGuaranteed: st.nonGuaranteed },
        origin,
      });
    } finally {
      setSending(false);
    }
  };
  return { desk, legs, tmpl, view, sending, send, isIndex, current, open, pickTemplate, model };
}

export type StrategyCtl = ReturnType<typeof useStrategy>;

/**
 * The docked builder (right column of the chain tab). `actions` goes at the end of its title row
 * (the pop-out button); `header` replaces the title row and `footer` the send button (the floating
 * builder in its narrow layout). With a `header`, it stays put above the scrolling builder (it is
 * the floating panel's drag handle and controls), and `heading` titles the row that keeps Clear.
 */
export function StrategyPanel({
  model,
  actions,
  header,
  heading,
  footer,
  origin,
}: {
  model: DeskModel;
  actions?: ReactNode;
  header?: ReactNode;
  heading?: string;
  footer?: (ctl: StrategyCtl) => ReactNode;
  origin?: PanelId;
}) {
  const m = useM();
  const ctl = useStrategy(model, origin);
  const { desk, legs, view, sending, send } = ctl;
  const { spot } = model;

  const clear = (
    <div onClick={desk.clearLegs} className="hover-tx" style={{ fontSize: 12, color: 'var(--dm)', cursor: 'pointer' }}>
      {m.clear}
    </div>
  );
  const body = (
    <>
      <TemplatePicker ctl={ctl} />
      {!legs.length && <div style={{ margin: '0 20px', padding: 18, background: 'var(--p2)', fontSize: 12, color: 'var(--dm)', textAlign: 'center' }}>{m.empty}</div>}
      {view && <LegList view={view} />}
      {view && legs.length > 0 && (
        <>
          <Payoff view={view} spot={spot} m={m} />
          <Stats view={view} m={m} />
          <Condition symbol={model.symbol} spot={spot} combo={legs.length > 1} />
          <OrderChoices combo={legs.length > 1} />
          <div style={{ padding: '14px 20px 6px', fontSize: 12, color: 'var(--mu)' }}>{m.netGreeks}</div>
          <NetGreeks view={view} m={m} />
          <div style={{ padding: '16px 20px 20px', marginTop: 'auto' }}>{footer ? footer(ctl) : <SendButton view={view} busy={sending} onSend={() => void send()} />}</div>
        </>
      )}
    </>
  );
  if (header) {
    return (
      <div style={{ flex: 1, minHeight: 0, background: 'var(--p)', display: 'flex', flexDirection: 'column' }}>
        {header}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 20px 10px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--mu)' }}>{heading}</div>
            {clear}
          </div>
          {body}
        </div>
      </div>
    );
  }
  return (
    <div style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
      <div style={{ padding: '16px 20px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 600 }}>{m.strategy}</div>
        {actions ? (
          // The 26px button does not make the row taller than its text.
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '-5px 0' }}>
            {clear}
            {actions}
          </div>
        ) : (
          clear
        )}
      </div>
      {body}
    </div>
  );
}

/** The template button and, open, the grid of strategies. */
export function TemplatePicker({ ctl, style }: { ctl: StrategyCtl; style?: CSSProperties }) {
  const m = useM();
  const { desk, tmpl, current, open, isIndex, pickTemplate } = ctl;
  return (
    <div style={{ padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      <div
        onClick={() => desk.patch({ tmplOpen: !desk.tmplOpen })}
        className="hover-p2"
        style={{ height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', cursor: 'pointer', boxShadow: 'inset 0 0 0 1px var(--ln)' }}
      >
        <Icon d={current?.icon ?? NO_STRATEGY_ICON} stroke="var(--ac)" />
        <div style={{ flex: 1, fontSize: 13 }}>{current ? m.strategies[current.key] : m.chooseStrategy}</div>
        <div style={{ fontSize: 9, color: 'var(--dm)' }}>{open ? '▲' : '▼'}</div>
      </div>
      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 4 }}>
          {STRATEGIES.map((s) => {
            const on = tmpl === s.key;
            const disabled = isIndex && hasStockLeg(s.key);
            return (
              <div
                key={s.key}
                onClick={() => pickTemplate(s.key)}
                className={disabled ? undefined : 'hover-tx'}
                title={disabled ? m.noStockOnIndex : undefined}
                style={{
                  height: 36,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 10px',
                  fontSize: 12,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  background: 'var(--p2)',
                  boxShadow: `inset 0 0 0 1px ${on ? 'var(--ac)' : 'transparent'}`,
                  color: on ? 'var(--tx)' : 'var(--mu)',
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                <Icon d={s.icon} stroke="currentColor" />
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.strategies[s.key]}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Icon({ d, stroke }: { d: string; stroke: string }) {
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" style={{ display: 'block', flexShrink: 0 }}>
      <path d={d} style={{ fill: 'none', stroke, strokeWidth: 1.5, strokeLinejoin: 'miter' }} />
    </svg>
  );
}

export function LegList({ view }: { view: StrategyView }) {
  const m = useM();
  const common = useCommon();
  const { updateLeg, removeLeg } = useDesk();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '0 20px' }}>
      {view.legs.map(({ leg, desc, mark }) => {
        const col = leg.side === 'BUY' ? 'var(--up)' : 'var(--dn)';
        return (
          <div key={leg.id} style={{ height: 38, display: 'flex', alignItems: 'center', gap: 10, boxShadow: 'inset 0 -1px 0 var(--ln2)', font: '12.5px/1 var(--num)' }}>
            <div
              onClick={() => updateLeg(leg.id, (l) => ({ ...l, side: l.side === 'BUY' ? 'SELL' : 'BUY' }))}
              style={{ width: 40, padding: '5px 0', textAlign: 'center', font: '600 11px/1 var(--sans)', cursor: 'pointer', color: col, boxShadow: `inset 0 0 0 1px ${col}` }}
            >
              {leg.side === 'BUY' ? m.buy : m.sell}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div onClick={() => updateLeg(leg.id, (l) => ({ ...l, qty: Math.max(1, l.qty - 1) }))} className="hover-tx" style={{ cursor: 'pointer', color: 'var(--dm)', padding: '0 2px' }}>
                −
              </div>
              <div style={{ minWidth: 16, textAlign: 'center' }}>{leg.qty}</div>
              <div onClick={() => updateLeg(leg.id, (l) => ({ ...l, qty: l.qty + 1 }))} className="hover-tx" style={{ cursor: 'pointer', color: 'var(--dm)', padding: '0 2px' }}>
                +
              </div>
            </div>
            <div className="ellipsis" style={{ flex: 1, fontFamily: 'var(--sans)' }}>
              {desc}
            </div>
            <div style={{ color: 'var(--mu)' }}>{f2(mark)}</div>
            <div onClick={() => removeLeg(leg.id)} title={common.delete} className="hover-r" style={{ cursor: 'pointer', color: 'var(--dm)', padding: '0 2px' }}>
              ×
            </div>
          </div>
        );
      })}
    </div>
  );
}

const W = 332;

/** `grow`: the chart takes the height its column leaves (the floating panel) instead of 150px. */
export function Payoff({ view, spot, m, grow = false }: { view: StrategyView; spot: number | undefined; m: DeskMessages; grow?: boolean }) {
  const chart = useMemo(() => {
    if (!view.payoff || !view.analysis || spot == null) return null;
    const ks = view.payoff.filter((l) => l.kind !== 'S').map((l) => l.strike);
    const lo = Math.min(spot * 0.85, ...ks.map((k) => k * 0.95));
    const hi = Math.max(spot * 1.15, ...ks.map((k) => k * 1.05));
    const pe = payoffCurve(view.payoff, lo, hi, 100, view.analysis.horizon);
    const pn = payoffCurve(view.payoff, lo, hi, 100, 0);
    const nowOk = pn.every((p) => Number.isFinite(p.y));
    const ys = [0, ...pe.map((p) => p.y), ...(nowOk ? pn.map((p) => p.y) : [])];
    let ymax = Math.max(...ys);
    let ymin = Math.min(...ys);
    const pad = (ymax - ymin) * 0.08 || 1;
    ymax += pad;
    ymin -= pad;
    const X = (x: number) => (((x - lo) / (hi - lo)) * W).toFixed(1);
    const Y = (p: number) => (8 + ((ymax - p) / (ymax - ymin)) * 134).toFixed(1);
    const pts = (arr: Array<{ x: number; y: number }>, fn: (v: number) => number = (v) => v) => arr.map((p) => `${X(p.x)},${Y(fn(p.y))}`).join(' ');
    const zy = Y(0);
    return {
      pos: `0,${zy} ${pts(pe, (v) => Math.max(v, 0))} ${W},${zy}`,
      neg: `0,${zy} ${pts(pe, (v) => Math.min(v, 0))} ${W},${zy}`,
      line: pts(pe),
      now: nowOk ? pts(pn) : '',
      zy,
      sx: X(spot),
      yTop: sg(ymax, f0),
      yBot: sg(ymin, f0),
      lo: f2(lo),
      hi: f2(hi),
      s: f2(spot),
    };
  }, [view, spot]);

  return (
    <>
      <div style={{ padding: '14px 20px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--mu)' }}>{m.payoff}</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--dm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 12, height: 2, background: 'var(--ac)' }} />
            {m.atExp}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 12, height: 0, borderTop: '1px dashed var(--mu)' }} />
            {m.today}
          </div>
        </div>
      </div>
      <div style={{ margin: '8px 20px 0', position: 'relative', ...(grow ? { flex: 1, minHeight: 200 } : { height: 150, flexShrink: 0 }) }}>
        {chart ? (
          <>
            <svg viewBox={`0 0 ${W} 150`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              <polygon points={chart.pos} style={{ fill: 'var(--up)', opacity: 0.14 }} />
              <polygon points={chart.neg} style={{ fill: 'var(--dn)', opacity: 0.14 }} />
              <line x1="0" x2={W} y1={chart.zy} y2={chart.zy} style={{ stroke: 'var(--ln)', vectorEffect: 'non-scaling-stroke' }} />
              <line x1={chart.sx} x2={chart.sx} y1="0" y2="150" style={{ stroke: 'var(--mu)', vectorEffect: 'non-scaling-stroke', strokeDasharray: '2 3' }} />
              {chart.now && <polyline points={chart.now} style={{ fill: 'none', stroke: 'var(--mu)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke', strokeDasharray: '3 3' }} />}
              <polyline points={chart.line} style={{ fill: 'none', stroke: 'var(--ac)', strokeWidth: 1.75, vectorEffect: 'non-scaling-stroke' }} />
            </svg>
            <div style={{ position: 'absolute', left: 4, top: 2, font: '10px/1 var(--num)', color: 'var(--up)' }}>{chart.yTop}</div>
            <div style={{ position: 'absolute', left: 4, bottom: 2, font: '10px/1 var(--num)', color: 'var(--dn)' }}>{chart.yBot}</div>
          </>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--p2)', fontSize: 12, color: 'var(--dm)' }}>
            {m.waitingQuotes}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 20px 0', font: '10px/1 var(--num)', color: 'var(--dm)', minHeight: 14 }}>
        <div>{chart?.lo}</div>
        <div style={{ color: 'var(--mu)' }}>{chart?.s}</div>
        <div>{chart?.hi}</div>
      </div>
    </>
  );
}

export function Stats({ view, m }: { view: StrategyView; m: DeskMessages }) {
  const a = view.analysis;
  const cost = a?.cost ?? view.orderCost;
  const debit = cost == null || cost >= 0;
  const stats: Array<{ l: string; v: string; col: string; wrap?: boolean }> = [
    { l: debit ? m.netDebit : m.netCredit, v: cost == null ? DASH : '$' + f2(Math.abs(cost)), col: debit ? 'var(--tx)' : 'var(--up)' },
    { l: m.pop, v: a?.pop != null ? (a.pop * 100).toFixed(0) + '%' : DASH, col: 'var(--tx)' },
    { l: m.maxProfit, v: !a ? DASH : a.profitUnlimited ? m.unl : usd(a.maxProfit, 0), col: 'var(--up)' },
    { l: m.maxLoss, v: !a ? DASH : a.lossUnlimited ? m.unl : usd(Math.max(0, -a.maxLoss), 0), col: 'var(--dn)' },
    { l: m.be, v: a?.breakevens.length ? a.breakevens.map((x) => f2(x)).join(' / ') : DASH, col: 'var(--tx)', wrap: true },
    { l: m.margin, v: a ? usd(a.margin, 0) : DASH, col: 'var(--tx)' },
    { l: m.dteL, v: `${view.minDte} ${m.dUnit}`, col: 'var(--tx)' },
    { l: m.rr, v: !a || a.profitUnlimited || a.lossUnlimited ? DASH : (a.maxProfit / Math.max(1, Math.abs(a.maxLoss))).toFixed(2), col: 'var(--tx)' },
  ];
  return (
    // Hairlines between rows only: the design's gray grid background also showed through the
    // 12px column gaps as vertical bars.
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', columnGap: 12, margin: '14px 20px 0', fontVariantNumeric: 'tabular-nums' }}>
      {stats.map((s, i) => (
        <div
          key={s.l}
          style={{
            padding: '9px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            minWidth: 0,
            boxShadow: i < Math.ceil(stats.length / 3) * 3 - 3 ? 'inset 0 -1px 0 var(--ln2)' : undefined,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{s.l}</div>
          {s.wrap ? (
            <div style={{ font: '500 13px/1.3 var(--num)', color: s.col }}>{s.v}</div>
          ) : (
            <div className="ellipsis" title={s.v} style={{ font: '500 13px/1 var(--num)', color: s.col }}>
              {s.v}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Condition({ symbol, spot, combo }: { symbol: string; spot: number | undefined; combo: boolean }) {
  const m = useM();
  const { cond, condOp, condPx, patch } = useDesk();
  const px = condPx ?? (spot != null ? defaultTrigger(spot, condOp) : '');
  const op = condOp === '>=' ? '≥' : '≤';
  return (
    <div style={{ margin: '14px 20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div onClick={() => patch({ cond: !cond })} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontSize: 13 }}>{m.condL}</div>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.condD}</div>
        </div>
        <Toggle on={cond} />
      </div>
      {cond && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
            <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', boxShadow: 'inset 0 0 0 1px var(--ln)', fontSize: 12 }}>
              <div style={{ color: 'var(--dm)' }}>{m.refL}</div>
              <div style={{ font: '600 12px/1 var(--mono)' }}>{symbol}</div>
            </div>
            <div style={{ display: 'flex', padding: 2, boxShadow: 'inset 0 0 0 1px var(--ln)' }}>
              {(['>=', '<='] as const).map((k) => (
                <div
                  key={k}
                  onClick={() => patch({ condOp: k, condPx: null })}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    font: '600 13px/1 var(--num)',
                    cursor: 'pointer',
                    background: condOp === k ? 'var(--p2)' : 'transparent',
                    color: condOp === k ? 'var(--tx)' : 'var(--dm)',
                  }}
                >
                  {k === '>=' ? '≥' : '≤'}
                </div>
              ))}
            </div>
            <TextInput value={px} onChange={(v) => patch({ condPx: v })} align="right" mono />
          </div>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.condHint(symbol, op, px, combo)}</div>
        </>
      )}
    </div>
  );
}

/** Order type (net limit or market), TIF and, for combos, non-guaranteed routing. */
export function OrderChoices({ combo }: { combo: boolean }) {
  const m = useM();
  const { ordType, tif, nonGuaranteed, patch } = useDesk();
  const seg = (on: boolean) => ({
    flex: 1,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    cursor: 'pointer',
    background: on ? 'var(--p2)' : 'transparent',
    color: on ? 'var(--tx)' : 'var(--dm)',
  });
  return (
    <div style={{ margin: '14px 20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div style={{ display: 'flex', padding: 2, boxShadow: 'inset 0 0 0 1px var(--ln)' }} role="radiogroup" aria-label={m.orderL}>
          {(['LMT', 'MKT'] as const).map((k) => (
            <div key={k} role="radio" aria-checked={ordType === k} onClick={() => patch({ ordType: k })} style={seg(ordType === k)}>
              {k === 'LMT' ? m.limit : m.market}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', padding: 2, boxShadow: 'inset 0 0 0 1px var(--ln)' }} role="radiogroup">
          {(['DAY', 'GTC'] as const).map((k) => (
            <div key={k} role="radio" aria-checked={tif === k} onClick={() => patch({ tif: k })} style={seg(tif === k)}>
              {k}
            </div>
          ))}
        </div>
      </div>
      {ordType === 'MKT' && <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--dm)' }}>{m.mktHint}</div>}
      {combo && (
        <div onClick={() => patch({ nonGuaranteed: !nonGuaranteed })} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontSize: 13 }}>{m.nonGuaranteed}</div>
            <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--dm)' }}>{m.nonGuaranteedD}</div>
          </div>
          <Toggle on={nonGuaranteed} />
        </div>
      )}
    </div>
  );
}

export function NetGreeks({ view, m }: { view: StrategyView; m: DeskMessages }) {
  const g = view.greeks;
  const items = [
    { l: m.delta, v: g ? fixed(g.delta, 1) : DASH },
    { l: m.gamma, v: g ? fixed(g.gamma, 2) : DASH },
    { l: m.theta, v: g ? `${sg(g.theta)} / ${sg(g.theta * 7, f0)}w` : DASH },
    { l: m.vega, v: g ? sg(g.vega) : DASH },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,auto)', gap: 1, background: 'var(--ln2)', margin: '0 20px', fontVariantNumeric: 'tabular-nums' }}>
      {items.map((x) => (
        <div key={x.l} style={{ background: 'var(--p2)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{x.l}</div>
          <div className="ellipsis" style={{ font: '500 13px/1 var(--num)' }}>
            {x.v}
          </div>
        </div>
      ))}
    </div>
  );
}

/** `label` replaces the text (the floating panel: "Submitting…" until IB answers); `height` the 44px. */
export function SendButton({ view, busy, onSend, label: text, height = 44 }: { view: StrategyView; busy: boolean; onSend: () => void; label?: string; height?: number }) {
  const m = useM();
  const market = useDesk((s) => s.ordType) === 'MKT';
  const n = view.legs.length;
  const price = orderPrice(view);
  const debit = view.orderCost == null ? (view.analysis?.cost ?? 0) >= 0 : view.orderCost >= 0;
  // A market order has no net price to show.
  const label = text ?? (busy ? m.resolving : market ? m.sendMarket(n) : price != null ? m.send(n, debit ? m.netDebit : m.netCredit, f2(price)) : m.sendNoPrice(n));
  return (
    <button
      onClick={onSend}
      disabled={busy}
      style={{
        width: '100%',
        height,
        border: 'none',
        background: debit ? 'var(--up)' : 'var(--dn)',
        color: 'var(--btnTx)',
        font: '600 14px/1 var(--sans)',
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.7 : 1,
      }}
    >
      {label}
    </button>
  );
}
