// Desk header: instrument, price and volatility metrics.

import { contractKey, shortExpiry } from '@shared/contract';
import { DASH, f0, f2, pct, signColor } from '@shared/format';
import type { ContractInfo } from '@shared/types';
import { changePct } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { chainTotals } from './chain';
import { useIvHistory } from './data';
import { useM } from './messages';
import type { DeskModel } from './model';
import { useCachedRequest } from './requests';

export function DeskHeader({ model }: { model: DeskModel }) {
  const m = useM();
  const lang = useLang();
  const { underlying, uq, spot, exp } = model;
  const storeName = useStore((s) => s.symbolName);
  const info = useCachedRequest<ContractInfo | null>(
    underlying && !storeName ? `info:${contractKey(underlying)}` : null,
    () => window.tape.getContractInfo(underlying!),
    3_600_000,
  );
  const name = nameOf(storeName, lang) || info?.data?.longName || '';
  const iv = useIvHistory(underlying, uq?.impliedVol);
  const chg = changePct(uq);
  const expLabel = exp ? shortExpiry(exp.expiry) : '';

  // P/C volume: the underlying's day totals (ticks 29/30), else the quoted rows of the visible
  // chain; its tooltip has the call and put volume. P/C open interest comes only from the
  // underlying's totals (ticks 27/28).
  const chain = chainTotals(
    model.quotedRows.flatMap((r) => [
      { right: 'C' as const, quote: model.quotes[contractKey(r.callContract)] },
      { right: 'P' as const, quote: model.quotes[contractKey(r.putContract)] },
    ]),
  );
  const ratio = (put: number | undefined, call: number | undefined) => (put != null && call ? (put / call).toFixed(2) : DASH);
  const dayVol = uq?.putVolume != null && !!uq.callVolume;
  const pcVol = dayVol ? ratio(uq?.putVolume, uq?.callVolume) : ratio(chain.putVol, chain.callVol);
  const pcOi = ratio(uq?.putOpenInterest, uq?.callOpenInterest);
  // The chain's totals are 0 / 0 before any of its rows has a volume: no tooltip then.
  const vols = dayVol ? { calls: uq?.callVolume, puts: uq?.putVolume } : chain.callVol || chain.putVol ? { calls: chain.callVol, puts: chain.putVol } : null;
  const pcTitle = vols ? m.pcTip(f0(vols.calls), f0(vols.puts)) : undefined;

  const metrics: Array<{ l: string; v: string; sub: string; title?: string }> = [
    { l: m.ivAtm, v: model.ivAtm != null ? (model.ivAtm * 100).toFixed(1) + '%' : DASH, sub: model.ivAtmSource === 'underlying' ? m.days30 : expLabel },
    { l: m.ivRank, v: iv.stats ? (iv.stats.rank * 100).toFixed(0) : DASH, sub: m.w52 },
    { l: m.ivPct, v: iv.stats ? (iv.stats.percentile * 100).toFixed(0) + '%' : DASH, sub: m.w52 },
    { l: m.em, v: model.em != null ? '±' + f2(model.em) : DASH, sub: model.em != null && spot ? '±' + ((model.em / spot) * 100).toFixed(1) + '%' : expLabel },
    { l: m.pc, v: pcVol, sub: dayVol ? m.todayAll : expLabel, title: pcTitle },
    { l: m.pco, v: pcOi, sub: '' },
  ];

  const err = model.dataError;
  // In a narrow desk the error badge gives way first, then the metrics; the instrument, price and
  // change keep their width.
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 28, padding: '14px 24px', background: 'var(--p)', boxShadow: 'inset 0 -1px 0 var(--ln)', flexShrink: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        <div className="ellipsis" style={{ fontSize: 12, color: 'var(--mu)', maxWidth: 220 }}>
          {name || ' '}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ font: '700 20px/1 var(--mono)' }}>{model.symbol}</div>
          <div className="num selectable" style={{ font: '600 20px/1 var(--num)', fontVariantNumeric: 'tabular-nums' }}>
            {f2(spot)}
          </div>
          <div style={{ font: '13px/1 var(--num)', color: signColor(chg) }}>{pct(chg)}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 22, minWidth: 0, overflow: 'hidden' }}>
        {metrics.map((x) => (
          <div key={x.l} title={x.title} style={{ display: 'flex', flexDirection: 'column', gap: 5, whiteSpace: 'nowrap' }}>
            <div style={{ fontSize: 11, color: 'var(--dm)' }}>{x.l}</div>
            <div style={{ font: '500 15px/1 var(--num)', fontVariantNumeric: 'tabular-nums', color: 'var(--tx)' }}>{x.v}</div>
            <div style={{ fontSize: 11, color: 'var(--dm)', minHeight: 11 }}>{x.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      {err && (
        <div
          title={err.message}
          style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 12px', boxShadow: 'inset 0 0 0 1px var(--ln)', whiteSpace: 'nowrap', maxWidth: 280, minWidth: 0, flexShrink: 1000, overflow: 'hidden' }}
        >
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.marketData}</div>
          <div className="ellipsis" style={{ font: '500 13px/1 var(--num)', color: 'var(--r)' }}>
            {err.code} · {err.message}
          </div>
        </div>
      )}
    </div>
  );
}
