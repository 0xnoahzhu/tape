// Flow tab: volume / open interest summary and unusual activity derived from the visible
// chain (per contract; IB does not stream individual option prints through the API).

import { useMemo } from 'react';
import { contractKey, contractLabel, shortExpiry } from '@shared/contract';
import { DASH, f0, f2 } from '@shared/format';
import { useClock } from '../../i18n';
import { chainTotals, flowColumns, unusualActivity, type FlowInput } from './flow';
import { useM } from './messages';
import type { DeskModel } from './model';

export function FlowTab({ model }: { model: DeskModel }) {
  const m = useM();
  const clock = useClock();
  const cols = flowColumns(clock);
  const { quotedRows, quotes, exp, uq } = model;
  const items: FlowInput[] = useMemo(
    () =>
      exp
        ? quotedRows.flatMap((r) => [
            { contract: r.callContract, right: 'C' as const, strike: r.strike, expiry: exp.expiry, multiplier: exp.multiplier, quote: quotes[contractKey(r.callContract)] },
            { contract: r.putContract, right: 'P' as const, strike: r.strike, expiry: exp.expiry, multiplier: exp.multiplier, quote: quotes[contractKey(r.putContract)] },
          ])
        : [],
    [quotedRows, quotes, exp],
  );
  const rows = useMemo(() => unusualActivity(items), [items]);
  const t = chainTotals(items);

  // Day totals of the underlying (ticks 29/30, 27/28) when available, else the visible chain.
  const cv = uq?.callVolume ?? (t.quoted ? t.callVol : undefined);
  const pv = uq?.putVolume ?? (t.quoted ? t.putVol : undefined);
  const coi = uq?.callOpenInterest ?? (t.quoted ? t.callOi : undefined);
  const poi = uq?.putOpenInterest ?? (t.quoted ? t.putOi : undefined);
  const ratio = (a: number | undefined, b: number | undefined) => (a != null && b ? (a / b).toFixed(2) : DASH);
  const cards = [
    { l: m.cvol, v: f0(cv) },
    { l: m.pvol, v: f0(pv) },
    { l: m.pcv, v: ratio(pv, cv) },
    { l: m.pco, v: ratio(poi, coi) },
    { l: m.flagged, v: t.quoted ? f0(rows.length) : DASH },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 'var(--gap)', padding: 'var(--pad)', background: 'var(--gbg)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 'var(--gap)', flexShrink: 0 }}>
        {cards.map((c) => (
          <div key={c.l} style={{ background: 'var(--p)', padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--mu)' }}>{c.l}</div>
            <div style={{ font: '500 20px/1 var(--num)' }}>{c.v}</div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--p)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 24px', display: 'flex', alignItems: 'baseline', gap: 16, minWidth: 0 }}>
          <div style={{ fontWeight: 600, flexShrink: 0 }}>{m.flowT}</div>
          <div className="ellipsis" style={{ fontSize: 12, color: 'var(--dm)' }}>
            {exp ? m.flowNote(shortExpiry(exp.expiry), quotedRows.length) : ''}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '8px 24px', fontSize: 11, color: 'var(--dm)', boxShadow: 'inset 0 -1px 0 var(--ln)' }}>
          <div>{m.time}</div>
          <div>{m.contract}</div>
          <div>{m.side}</div>
          <div style={{ textAlign: 'right' }}>{m.size}</div>
          <div style={{ textAlign: 'right' }}>{m.price}</div>
          <div style={{ textAlign: 'right' }}>{m.prem}</div>
          <div style={{ textAlign: 'right' }}>{m.voi}</div>
          <div>{m.tag}</div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          {!rows.length && <div style={{ padding: '18px 24px', fontSize: 13, color: 'var(--dm)' }}>{m.noFlow}</div>}
          {rows.map((f) => (
            <div
              key={contractKey(f.contract)}
              style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '0 24px', height: 38, alignItems: 'center', boxShadow: 'inset 0 -1px 0 var(--ln2)', font: '12.5px/1 var(--num)' }}
            >
              <div style={{ color: 'var(--dm)', whiteSpace: 'nowrap' }}>{f.time ? clock.time(f.time, { seconds: true }) : DASH}</div>
              <div className="ellipsis" style={{ fontFamily: 'var(--sans)', fontSize: 13, color: f.right === 'C' ? 'var(--up)' : 'var(--dn)' }}>
                {contractLabel(f.contract)}
              </div>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: f.side === 'ask' ? 'var(--up)' : f.side === 'bid' ? 'var(--dn)' : 'var(--mu)' }}>
                {f.side ? m.sides[f.side] : DASH}
              </div>
              <div style={{ textAlign: 'right' }}>{f0(f.volume)}</div>
              <div style={{ textAlign: 'right' }}>{f2(f.price)}</div>
              <div style={{ textAlign: 'right' }}>{f.premium != null ? '$' + f0(f.premium) : DASH}</div>
              <div style={{ textAlign: 'right', color: f.voi != null && f.voi > 0.5 ? 'var(--ac)' : 'var(--tx)' }}>{f.voi == null ? DASH : Number.isFinite(f.voi) ? f.voi.toFixed(2) : '∞'}</div>
              <div className="ellipsis" title={f.tags.map((tg) => m.flowTags[tg]).join(' · ')} style={{ fontSize: 11, color: 'var(--mu)' }}>
                {m.flowTags[f.tags[0]]}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
