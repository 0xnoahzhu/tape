// Settings › Market data: request type, what each market actually delivers, the Level 2 switch,
// quote field sources, the local cache (LocalCacheBlock). Tags come from what IB answered: the
// active check (main/market/marketCheck.ts; run when the section opens with a result older than
// STALE_CHECK_MS, and by "Check now") and the quotes received in this session, never from
// assumed subscriptions.

import { useEffect, useMemo } from 'react';
import type { Clock } from '@shared/timeFormat';
import type { MarketCheckItem, Settings } from '@shared/types';
import { useClock } from '../../i18n';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Button, Toggle } from '../../ui/primitives';
import { useNow } from '../chart/useNow';
import { IssueNote } from './ConnectionSection';
import { LocalCacheBlock } from './LocalCacheBlock';
import {
  checkAge,
  checkItems,
  checkNeeded,
  checkReasons,
  checkTag,
  depthNote,
  depthSwitchPatch,
  MARKET_ROWS,
  observeMarkets,
  type CheckReason,
  type MarketRow,
  type Observation,
} from './logic';
import { useSettingsMessages, type SettingsMessages } from './messages';
import { LabelBlock, ObservedTagBox, SectionHeader, SubHeader, saveSettings } from './parts';

const PRICING_URL = 'https://www.interactivebrokers.com/en/pricing/market-data-pricing.php';
const GRID = 'minmax(0,1.3fr) minmax(0,1.3fr) 128px';

type Observations = Record<MarketRow, Observation> | null;

/**
 * Observations as a string so the section only re-renders when the summary changes,
 * not on every quote tick. null while disconnected (cached quotes are not current).
 */
function useObservations(): Observations {
  const sig = useStore((s) => (s.connection.status === 'connected' ? JSON.stringify(observeMarkets(s.quotes, s.depth, s.connection.marketDataIssue)) : ''));
  return useMemo(() => (sig ? (JSON.parse(sig) as Record<MarketRow, Observation>) : null), [sig]);
}

/** True when the quotes of this session say anything about the market. */
function observedAny(o: Observation | undefined): boolean {
  return !!o && (o.live > 0 || o.frozen > 0 || o.delayed > 0 || o.errors > 0 || !!o.depthSymbol);
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

/** The checked status of one market: "Live", "Live · NASDAQ only", "No data". */
function checkedText(item: MarketCheckItem, m: SettingsMessages): string {
  return item.via ? m.via(item.via, item.status === 'frozen') : m.st[item.status];
}

/** The line under the status: the instrument and what decided it (the SMART / exchange split, IB's code). */
function checkedDetail(item: MarketCheckItem, m: SettingsMessages): string {
  const parts = [item.instrument];
  const p = item.probe;
  if (item.primary && item.primary.status !== p.status) parts.push(m.split(m.stWord[p.status], item.primary.exchange, m.stWord[item.primary.status]));
  else if (p.code !== undefined && p.code >= 0) parts.push(m.ibCode(p.code));
  return parts.join(' · ');
}

/** Tooltip of a checked market: the fallback's meaning, else IB's own words. */
function checkedTip(item: MarketCheckItem, m: SettingsMessages, clock: Clock): string {
  const lines: string[] = [];
  if (item.via) lines.push(item.market === 'depth' ? m.depthViaTip(item.via) : m.viaTip(item.via));
  for (const p of item.primary ? [item.probe, item.primary] : [item.probe]) {
    const head = `${item.instrument} ${p.exchange}: ${m.stWord[p.status]}${p.marketDataType ? ` (marketDataType ${p.marketDataType})` : ''}`;
    lines.push(p.message ? `${head} · ${p.code !== undefined && p.code >= 0 ? `${p.code} ` : ''}${p.message}` : head);
  }
  if (item.fallback?.length) lines.push(m.fallbackInUse(item.fallback));
  lines.push(m.checkedAt(clock.time(item.checkedAt, { date: 'md' })));
  return lines.join('\n');
}

function depthNoteText(item: MarketCheckItem | undefined, features: Settings['features'], m: SettingsMessages): string {
  const note = depthNote(item, features);
  return note.kind === 'partial' ? m.depthNote.partial(note.depth) : m.depthNote[note.kind];
}

function reasonText(r: CheckReason, m: SettingsMessages, paper: boolean): { t: string; d: string } {
  switch (r.kind) {
    case 'notSubscribed':
      return { t: m.notSubscribedTitle(r.markets), d: m.notSubscribedText(r.codes, r.markets, paper, r.othersLive) };
    case 'fallback':
      return { t: m.fallbackTitle(r), d: m.fallbackText(r) };
    case 'depthPartial':
      return { t: m.depthPartialTitle(r.depth), d: m.depthPartialText(r.missing) };
    default:
      return m.reasons[r.kind];
  }
}

export function MarketDataSection() {
  const m = useSettingsMessages();
  const clock = useClock();
  const obs = useObservations();
  const features = useStore((s) => s.settings.features);
  const issue = useStore((s) => (s.connection.status === 'connected' ? s.connection.marketDataIssue : undefined));
  const status = useStore((s) => s.connection.status);
  const account = useStore((s) => s.connection.account ?? s.connection.accounts[0]);
  const paper = useStore((s) => s.connection.isPaper);
  const check = useStore((s) => s.marketDataCheck);
  const showToast = useStore((s) => s.showToast);
  const now = useNow(30_000).getTime();
  const items = checkItems(check.result, account);
  const shown = Object.keys(items).length ? check.result : null;
  const reasons = checkReasons(shown);

  // Opening the section (or connecting while it is open) checks again when the last result is old.
  useEffect(() => {
    if (!checkNeeded(useStore.getState().marketDataCheck, { status, account }, Date.now())) return;
    window.tape.checkMarketData({ auto: true }).catch(() => undefined);
  }, [status, account]);

  const runCheck = () => {
    window.tape.checkMarketData({ depth: true }).catch((err: unknown) => showToast(m.checkFailed(errorText(err)), 'error'));
  };
  // While disconnected the last result stays, muted: it is not what IB delivers now.
  const offline = status !== 'connected';
  const ago = shown ? m.checkedAgo(checkAge(shown.checkedAt, now), clock.time(shown.checkedAt, { date: 'md' })) : null;
  const checkedLine = check.running ? m.checking : ago ? (offline ? m.checkedOffline(ago) : ago) : m.notCheckedYet;
  const depthItem = items.depth;

  return (
    <>
      <SectionHeader title={m.nav.data} desc={m.dataDesc} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px', background: 'var(--p2)' }}>
        <div style={{ fontSize: 13 }}>{m.reqL}</div>
        <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.6, textWrap: 'pretty' }}>{m.reqD}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div data-md="check" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 0 14px' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div data-md="checked" title={shown ? clock.time(shown.checkedAt, { date: 'md', seconds: true }) : undefined} style={{ fontSize: 13 }}>
              {checkedLine}
            </div>
            <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.6, textWrap: 'pretty' }}>{m.checkDesc}</div>
          </div>
          <span title={offline ? m.connectToCheck : undefined} style={{ display: 'flex', flexShrink: 0 }}>
            <Button
              kind="secondary"
              height={32}
              disabled={check.running || offline}
              onClick={runCheck}
              style={{ padding: '0 14px', fontSize: 13, flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              <span data-md="check-now">{check.running ? m.checking : m.checkNow}</span>
            </Button>
          </span>
        </div>
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
          const item = items[row];
          const session = observedAny(o) ? observedText(row, o, m) : null;
          let main: string;
          let sub: string | null = null;
          if (item) {
            main = checkedText(item, m);
            sub = checkedDetail(item, m);
          } else if (check.running && (row !== 'depth' || check.depth)) {
            main = m.checking;
          } else if (row === 'depth' && status === 'connected') {
            main = m.depthNotChecked;
          } else if (session) {
            main = session;
          } else {
            main = status === 'connected' ? m.rowNotChecked : m.obsDisconnected;
          }
          const tag = item ? checkTag(item) : (o?.tag ?? 'none');
          return (
            <div
              key={row}
              data-md-row={row}
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, minHeight: 60, padding: '10px 0', alignItems: 'center', boxShadow: 'inset 0 -1px 0 var(--ln2)' }}
            >
              <LabelBlock label={m.markets[row].l} desc={m.markets[row].d} />
              <div title={item ? checkedTip(item, m, clock) : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <div className="ellipsis" style={{ fontSize: 13, color: item && !offline ? 'var(--tx)' : 'var(--mu)' }}>
                  {main}
                </div>
                {item && offline && <div style={{ fontSize: 12, color: 'var(--mu)' }}>{m.lastCheckOffline}</div>}
                {sub && (
                  <div className="ellipsis" style={{ fontSize: 12, color: 'var(--dm)' }}>
                    {sub}
                  </div>
                )}
                {item?.fallback?.length ? (
                  <div style={{ fontSize: 12, color: 'var(--dm)', textWrap: 'pretty' }}>{m.fallbackInUse(item.fallback)}</div>
                ) : null}
                {item && session && (
                  <div className="ellipsis" style={{ fontSize: 12, color: 'var(--dm)' }}>
                    {m.inSession(session)}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <ObservedTagBox tag={tag} via={item?.via} muted={!!item && offline} title={item ? checkedTip(item, m, clock) : undefined} />
              </div>
            </div>
          );
        })}
        {reasons.length > 0 && (
          <div data-md="reasons" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 14 }}>
            {reasons.map((r) => {
              const { t, d } = reasonText(r, m, paper);
              return (
                <div key={r.kind} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.6 }}>
                  <div style={{ fontSize: 13, color: 'var(--tx)' }}>{t}</div>
                  <div style={{ color: 'var(--dm)', textWrap: 'pretty' }}>{d}</div>
                </div>
              );
            })}
          </div>
        )}
        {issue && !reasons.some((r) => r.kind === 'competing') && (
          <div style={{ paddingTop: 12 }}>
            <IssueNote code={issue.code} message={issue.message} />
          </div>
        )}
      </div>
      <SubHeader title={m.depthTitle} desc={m.depthDesc} />
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: -14 }}>
        {/* Setting the switch here is the user's choice: a check no longer turns it on (marketCheck.ts). */}
        <div
          data-md="depth-switch"
          role="switch"
          aria-checked={features.depth}
          onClick={() => saveSettings(depthSwitchPatch(!features.depth))}
          style={{ minHeight: 60, display: 'flex', alignItems: 'center', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)', cursor: 'pointer' }}
        >
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0' }}>
            <div>{m.depthSwitch}</div>
            <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.6, textWrap: 'pretty' }}>{depthNoteText(depthItem, features, m)}</div>
          </div>
          {depthItem ? (
            <ObservedTagBox tag={checkTag(depthItem)} via={depthItem.via} muted={offline} title={checkedTip(depthItem, m, clock)} />
          ) : (
            <ObservedTagBox tag={obs?.depth.tag ?? 'none'} title={observedText('depth', obs?.depth, m)} />
          )}
          <Toggle on={features.depth} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 600 }}>{m.fieldsT}</div>
        {m.fields(clock).map((x) => (
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
      <LocalCacheBlock />
    </>
  );
}
