// Settings › Market data: request type, what each market actually delivers, feature switches,
// quote field sources. Tags are derived from received quotes, never from assumed subscriptions.

import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import { IssueNote } from './ConnectionSection';
import { MARKET_ROWS, observeMarkets, type MarketRow, type Observation } from './logic';
import { useSettingsMessages, type SettingsMessages } from './messages';
import { LabelBlock, ObservedTagBox, SectionHeader, SubHeader, saveSettings } from './parts';

const PRICING_URL = 'https://www.interactivebrokers.com/en/pricing/market-data-pricing.php';
const GRID = 'minmax(0,1.6fr) minmax(0,1fr) 110px';

type Observations = Record<MarketRow, Observation> | null;

/**
 * Observations as a string so the section only re-renders when the summary changes,
 * not on every quote tick. null while disconnected (cached quotes are not current).
 */
function useObservations(): Observations {
  const sig = useStore((s) => (s.connection.status === 'connected' ? JSON.stringify(observeMarkets(s.quotes, s.depth, s.connection.marketDataIssue)) : ''));
  return useMemo(() => (sig ? (JSON.parse(sig) as Record<MarketRow, Observation>) : null), [sig]);
}

function observedText(row: MarketRow, o: Observation | undefined, m: SettingsMessages): string {
  if (!o) return m.obsDisconnected;
  if (row === 'depth') {
    if (o.errors) return m.obsError(o.errorCode, 1);
    if (o.depthSymbol) return m.obsDepth(o.depthSymbol, o.depthLevels ?? 0);
    return o.tag === 'nodata' ? m.obsError(o.errorCode, 1) : m.obsDepthNone;
  }
  const parts: string[] = [];
  if (o.live) parts.push(m.obsLive(o.live));
  if (o.frozen) parts.push(m.obsFrozen(o.frozen));
  if (o.delayed) parts.push(m.obsDelayed(o.delayed));
  if (o.errors) parts.push(m.obsError(o.errorCode, o.errors));
  if (!parts.length && o.tag === 'nodata') parts.push(m.obsError(o.errorCode, 1));
  return parts.length ? parts.join(' · ') : m.obsNone;
}

export function MarketDataSection() {
  const m = useSettingsMessages();
  const obs = useObservations();
  const features = useStore((s) => s.settings.features);
  const issue = useStore((s) => (s.connection.status === 'connected' ? s.connection.marketDataIssue : undefined));

  const featureRows: Array<{ key: keyof typeof features; obs: MarketRow }> = [
    { key: 'depth', obs: 'depth' },
    { key: 'options', obs: 'opt' },
    { key: 'flow', obs: 'opt' },
  ];

  return (
    <>
      <SectionHeader title={m.nav.data} desc={m.dataDesc} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px', background: 'var(--p2)' }}>
        <div style={{ fontSize: 13 }}>{m.reqL}</div>
        <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.6, textWrap: 'pretty' }}>{m.reqD}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID,
            gap: 12,
            padding: '8px 0',
            fontSize: 12,
            color: 'var(--dm)',
            boxShadow: 'inset 0 -1px 0 var(--ln)',
          }}
        >
          <div>{m.hSrc}</div>
          <div>{m.hObs}</div>
          <div style={{ textAlign: 'right' }}>{m.hNow}</div>
        </div>
        {MARKET_ROWS.map((row) => {
          const o = obs?.[row];
          return (
            <div
              key={row}
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, height: 52, alignItems: 'center', boxShadow: 'inset 0 -1px 0 var(--ln2)' }}
            >
              <LabelBlock label={m.markets[row].l} desc={m.markets[row].d} />
              <div className="ellipsis" style={{ fontSize: 13, color: 'var(--mu)' }}>
                {observedText(row, o, m)}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <ObservedTagBox tag={o?.tag ?? 'none'} />
              </div>
            </div>
          );
        })}
        {issue && (
          <div style={{ paddingTop: 12 }}>
            <IssueNote code={issue.code} message={issue.message} />
          </div>
        )}
      </div>
      <SubHeader title={m.ftTitle} desc={m.ftDesc} />
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: -14 }}>
        {featureRows.map(({ key, obs: row }) => {
          const on = features[key];
          return (
            <div
              key={key}
              role="switch"
              aria-checked={on}
              onClick={() => saveSettings({ features: { [key]: !on } })}
              style={{ minHeight: 60, display: 'flex', alignItems: 'center', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)', cursor: 'pointer' }}
            >
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0' }}>
                <div>{m.features[key].l}</div>
                <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.features[key].d}</div>
              </div>
              <ObservedTagBox tag={obs?.[row].tag ?? 'none'} title={observedText(row, obs?.[row], m)} />
              <Toggle on={on} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 600 }}>{m.fieldsT}</div>
        {m.fields.map((x) => (
          <div key={x.tick} style={{ display: 'grid', gridTemplateColumns: '150px 170px minmax(0,1fr)', gap: 12, fontSize: 13, alignItems: 'baseline' }}>
            <div>{x.l}</div>
            <div style={{ font: '12px/1 var(--mono)', color: 'var(--ac)' }}>{x.tick}</div>
            <div style={{ fontSize: 12, color: 'var(--dm)' }}>{x.d}</div>
          </div>
        ))}
      </div>
      <a
        href={PRICING_URL}
        onClick={(e) => {
          e.preventDefault();
          void window.tape.openExternal(PRICING_URL).catch(() => undefined);
        }}
        style={{ fontSize: 13, color: 'var(--ac)', textDecoration: 'none', alignSelf: 'flex-start', cursor: 'pointer' }}
      >
        {m.link}
      </a>
    </>
  );
}
