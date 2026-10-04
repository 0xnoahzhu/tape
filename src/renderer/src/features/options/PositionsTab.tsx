// Positions tab: the account's option positions on this underlying with live greeks
// (design "positions" mode: exposure row + table).

import { useMemo } from 'react';
import { contractKey, contractLabel, daysToExpiry } from '@shared/contract';
import { DASH, f0, f2, MINUS, sg, signColor } from '@shared/format';
import type { Position } from '@shared/types';
import { useQuoteSubscriptions } from '../../hooks/useQuotes';
import { useStore } from '../../state/store';
import { fixed, markOf, optionData } from './chain';
import { useDesk } from './deskStore';
import { yearsToExpiry } from './math';
import { useM } from './messages';
import type { DeskModel } from './model';
import { quotableContract } from './risk';

const COLS = 'minmax(0,2.4fr) repeat(10,minmax(0,1fr))';

export function useOptionPositions(symbol: string): Position[] {
  const positions = useStore((s) => s.positions);
  return useMemo(() => positions.filter((p) => p.contract.secType === 'OPT' && p.contract.symbol === symbol && p.quantity !== 0), [positions, symbol]);
}

export function PositionsTab({ model }: { model: DeskModel }) {
  const m = useM();
  const positions = useOptionPositions(model.symbol);
  const patch = useDesk((s) => s.patch);
  const contracts = useMemo(() => positions.map((p) => quotableContract(p.contract)), [positions]);
  useQuoteSubscriptions('options-positions', contracts, 'option');
  const quotes = model.quotes;
  const spot = model.spot;

  const E = { d: 0, dd: 0, g: 0, th: 0, vg: 0 };
  let complete = true;
  const rows = positions.map((p) => {
    const c = p.contract;
    const mult = p.multiplier || 100;
    const q = quotes[contractKey(c)];
    const d = optionData(q, c.strike ?? 0, c.right ?? 'C', spot, yearsToExpiry(c.lastTradeDate ?? ''));
    const k = p.quantity * mult;
    const mark = markOf(q) ?? p.marketPrice;
    const pl = p.unrealizedPnL ?? (mark != null ? (mark - p.avgPrice) * k : undefined);
    if (d.delta != null && d.gamma != null && d.theta != null && d.vega != null) {
      E.d += d.delta * k;
      E.dd += d.delta * k * (spot ?? 0);
      E.g += d.gamma * k;
      E.th += d.theta * k;
      E.vg += d.vega * k;
    } else complete = false;
    const dte = c.lastTradeDate ? daysToExpiry(c.lastTradeDate) : undefined;
    return {
      key: p.key,
      expiry: c.lastTradeDate,
      c: contractLabel(c),
      q: (p.quantity < 0 ? MINUS : '') + Math.abs(p.quantity),
      qCol: p.quantity < 0 ? 'var(--dn)' : 'var(--tx)',
      dte: dte != null ? `${dte}${m.dUnit}` : DASH,
      avg: f2(p.avgPrice),
      mark: f2(mark),
      pl: sg(pl, f0),
      plCol: signColor(pl),
      d: d.delta != null ? fixed(d.delta * k, 0) : DASH,
      g: d.gamma != null ? fixed(d.gamma * k, 1) : DASH,
      th: d.theta != null ? sg(d.theta * k) : DASH,
      vg: d.vega != null ? sg(d.vega * k) : DASH,
      itm: d.itm != null ? (d.itm * 100).toFixed(0) + '%' : DASH,
    };
  });

  const has = positions.length > 0 && complete;
  const expo = [
    { l: m.delta, v: has ? fixed(E.d, 0) : DASH },
    { l: m.ddol, v: has && spot != null ? sg(E.dd, f0) : DASH },
    { l: m.gamma, v: has ? fixed(E.g, 1) : DASH },
    { l: m.theta, v: has ? sg(E.th) : DASH },
    { l: m.vega, v: has ? sg(E.vg) : DASH },
  ];

  const right = { textAlign: 'right' } as const;
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--p)', paddingTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 40, padding: '4px 32px 18px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--mu)' }}>
          {m.expo} · {model.symbol}
        </div>
        {expo.map((x) => (
          <div key={x.l} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--dm)' }}>{x.l}</div>
            <div style={{ font: '500 18px/1 var(--num)' }}>{x.v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '10px 32px 8px', fontSize: 11, color: 'var(--dm)', boxShadow: 'inset 0 -1px 0 var(--ln)' }}>
        <div>{m.contract}</div>
        <div style={right}>{m.qty}</div>
        <div style={right}>{m.dte}</div>
        <div style={right}>{m.avg}</div>
        <div style={right}>{m.mark}</div>
        <div style={right}>{m.pl}</div>
        <div style={right}>Δ</div>
        <div style={right}>Γ</div>
        <div style={right}>Θ</div>
        <div style={right}>Vega</div>
        <div style={right}>{m.itm}</div>
      </div>
      {!rows.length && <div style={{ padding: '18px 32px', fontSize: 13, color: 'var(--dm)' }}>{m.noPositions(model.symbol)}</div>}
      <div style={{ fontVariantNumeric: 'tabular-nums' }}>
        {rows.map((r) => (
          <div
            key={r.key}
            onClick={() => r.expiry && patch({ expiry: r.expiry, tab: 'chain' })}
            className="hover-p2"
            style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '0 32px', height: 44, alignItems: 'center', boxShadow: 'inset 0 -1px 0 var(--ln2)', font: '12.5px/1 var(--num)', cursor: 'pointer' }}
          >
            <div className="ellipsis" style={{ fontFamily: 'var(--sans)', fontSize: 13 }}>
              {r.c}
            </div>
            <div style={{ ...right, color: r.qCol }}>{r.q}</div>
            <div style={right}>{r.dte}</div>
            <div style={{ ...right, color: 'var(--mu)' }}>{r.avg}</div>
            <div style={right}>{r.mark}</div>
            <div style={{ ...right, color: r.plCol }}>{r.pl}</div>
            <div style={right}>{r.d}</div>
            <div style={{ ...right, color: 'var(--mu)' }}>{r.g}</div>
            <div style={right}>{r.th}</div>
            <div style={{ ...right, color: 'var(--mu)' }}>{r.vg}</div>
            <div style={right}>{r.itm}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
