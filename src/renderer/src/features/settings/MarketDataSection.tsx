// Settings › Market data: a calm status view of what IB sends this account. Tape always asks for the
// best data IB offers (live where subscribed, else delayed), so there is nothing to set: per market a
// tag and a short note (logic.ts → rowState), muted for delayed or unsubscribed markets, which are
// normal; red only for a competing session (10197), the one state the user has to act on, with a
// panel saying what to do. Under the rows, at most two hints (a paper account without shared data, no
// free line) and the subscriptions link; then the Level 2 switch, the technical details (IB's own
// answers, the quote field sources) behind a disclosure, and the local cache (LocalCacheBlock). Tags
// come from what IB answered: the active check (main/market/marketCheck.ts; started by the section
// itself, logic.ts → autoCheckPlan, and by "Check now") and the quotes received in this session,
// never from assumed subscriptions. The rows' tooltips hold IB's answers for those who want them.

import { useEffect, useMemo, useRef } from 'react';
import type { Clock } from '@shared/timeFormat';
import type { MarketCheckItem, MarketCheckProbe, Settings } from '@shared/types';
import { useClock } from '../../i18n';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Button, Toggle } from '../../ui/primitives';
import { useNow } from '../chart/useNow';
import { LocalCacheBlock } from './LocalCacheBlock';
import {
  autoCheckPlan,
  checkAge,
  checkAttention,
  checkItems,
  checkReasons,
  checkTag,
  COMPETING,
  DETAIL_ROWS,
  depthNote,
  depthSwitchPatch,
  observeMarkets,
  probesOf,
  rowState,
  STATUS_ROWS,
  type CheckReason,
  type MarketRow,
  type Observation,
  type RowState,
} from './logic';
import { useSettingsMessages, type SettingsMessages } from './messages';
import { Disclosure, LabelBlock, ObservedTagBox, SectionHeader, SubHeader, saveSettings } from './parts';

const PRICING_URL = 'https://www.interactivebrokers.com/en/pricing/market-data-pricing.php';

type Observations = Record<MarketRow, Observation> | null;
type Items = Partial<Record<MarketRow, MarketCheckItem>>;
type Issue = { code: number; message: string } | undefined;

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

/** IB's answer on one line: "SPX CBOE: delayed (marketDataType 3) · 10167 Requested market data is not subscribed…". */
function probeLine(item: MarketCheckItem, p: MarketCheckProbe, m: SettingsMessages): string {
  const head = `${item.instrument} ${p.exchange}: ${m.stWord[p.status]}${p.marketDataType ? ` (marketDataType ${p.marketDataType})` : ''}`;
  return p.message ? `${head} · ${p.code !== undefined && p.code >= 0 ? `${p.code} ` : ''}${p.message}` : head;
}

/** Tooltip of a market row: what its tag and note mean, then IB's answers and when, or this session's quotes. */
function rowTip(
  row: MarketRow,
  item: MarketCheckItem | undefined,
  state: RowState,
  obs: Observation | undefined,
  issue: Issue,
  m: SettingsMessages,
  clock: Clock,
): string | undefined {
  const lines: string[] = [];
  if (state.tip === 'paused') {
    lines.push(m.rowTip.paused);
    if (issue) lines.push(`${issue.code} · ${issue.message}`);
  } else {
    if (item?.via) lines.push(m.viaTip(item.via));
    if (state.tip) lines.push(m.rowTip[state.tip]);
  }
  if (item) {
    for (const p of probesOf(item)) lines.push(probeLine(item, p, m));
    if (item.fallback?.length) lines.push(m.fallbackInUse(item.fallback));
    lines.push(m.checkedAt(clock.time(item.checkedAt, { date: 'md' })));
  } else if (observedAny(obs)) {
    lines.push(m.inSession(observedText(row, obs, m)));
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** Tooltip of the Level 2 tag: where the book comes from, IB's answer, the exchanges missing, when. */
function depthTip(item: MarketCheckItem, reasons: CheckReason[], m: SettingsMessages, clock: Clock): string {
  const lines: string[] = [];
  if (item.via) lines.push(m.depthViaTip(item.via));
  for (const p of probesOf(item)) lines.push(probeLine(item, p, m));
  const partial = reasons.find((r) => r.kind === 'depthPartial');
  if (partial) lines.push(m.depthPartialText(partial.missing));
  lines.push(m.checkedAt(clock.time(item.checkedAt, { date: 'md' })));
  return lines.join('\n');
}

/** Technical details: how Tape asks, then IB's answer on every line of the check, the fallback and the connection's issue. */
function answerLines(items: Items, issue: Issue, checkedAt: number | undefined, m: SettingsMessages, clock: Clock): string[] {
  const lines = [m.dRequest];
  for (const row of DETAIL_ROWS) {
    const item = items[row];
    if (!item) lines.push(`${m.markets[row].l} · ${m.notCheckedYet}`);
    else for (const p of probesOf(item)) lines.push(`${m.markets[row].l} · ${probeLine(item, p, m)}`);
  }
  if (items.stk?.fallback?.length) lines.push(m.fallbackInUse(items.stk.fallback));
  if (issue) lines.push(`${issue.code} · ${issue.message}`);
  if (checkedAt !== undefined) lines.push(m.checkedAt(clock.time(checkedAt, { date: 'md', seconds: true })));
  return lines;
}

function depthNoteText(item: MarketCheckItem | undefined, features: Settings['features'], m: SettingsMessages): string {
  const note = depthNote(item, features);
  return note.kind === 'partial' ? m.depthNote.partial(note.depth) : m.depthNote[note.kind];
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
  const openSettings = useStore((s) => s.openSettings);
  const now = useNow(30_000).getTime();
  const items = checkItems(check.result, account);
  const shown = Object.keys(items).length ? check.result : null;
  const reasons = checkReasons(shown);
  // While disconnected the last result stays, muted: it is not what IB delivers now.
  const offline = status !== 'connected';
  const issueCode = issue?.code;
  const competingNow = !offline && issueCode === COMPETING;
  const resultAt = check.result?.checkedAt;

  // Opening the section (or connecting, a competing session ending, or a check ending with a new
  // result, while it is open) checks by itself when logic.ts → autoCheckPlan says so: an old result,
  // no Level 2 answer for this account, or a result that a competing session spoiled. Main joins a
  // running check and queues a Level 2 one behind a quiet one; a full book turns the switch on unless
  // the user has set it. A check that fails leaves the result as it was, so it is not retried here.
  const recheckedFor = useRef<number | undefined>(undefined);
  useEffect(() => {
    const st = useStore.getState().marketDataCheck;
    const plan = autoCheckPlan(st, { status, account }, issueCode, Date.now(), recheckedFor.current);
    if (!plan) return;
    if (st.result) recheckedFor.current = st.result.checkedAt;
    window.tape.checkMarketData({ auto: true, depth: plan.depth }).catch(() => undefined);
  }, [status, account, issueCode, resultAt]);

  const runCheck = () => {
    window.tape.checkMarketData({ depth: true }).catch((err: unknown) => showToast(m.checkFailed(errorText(err)), 'error'));
  };
  const ago = shown ? m.checkedAgo(checkAge(shown.checkedAt, now), clock.time(shown.checkedAt, { date: 'md' })) : null;
  const checkedLine = check.running ? m.checking : ago ? (offline ? m.checkedOffline(ago) : ago) : offline ? m.connectToCheck : m.notCheckedYet;
  const rows = STATUS_ROWS.map((row) => {
    const item = items[row];
    const o = obs?.[row];
    return { row, item, o, state: rowState(item, o, competingNow) };
  });
  // The panel follows the rows: raised only while a market row shows the pause.
  const attention = checkAttention(reasons, paper, rows.some(({ state }) => state.alert));
  const depthItem = items.depth;

  return (
    <>
      <SectionHeader title={m.nav.data} desc={m.dataDesc} />
      {!offline && attention.alert && (
        <div
          data-md="alert"
          role="status"
          title={issue ? `${issue.code} · ${issue.message}` : `IB ${COMPETING}`}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', background: 'var(--p2)' }}
        >
          <div style={{ width: 7, height: 7, marginTop: 5, flexShrink: 0, background: 'var(--r)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 13, color: 'var(--tx)' }}>{m.competing.t}</div>
            <div style={{ fontSize: 12, color: 'var(--mu)', lineHeight: 1.6, textWrap: 'pretty' }}>{m.competing.d}</div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          data-md="check"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '0 0 12px', boxShadow: 'inset 0 -1px 0 var(--ln)' }}
        >
          <div data-md="checked" title={shown ? clock.time(shown.checkedAt, { date: 'md', seconds: true }) : undefined} style={{ fontSize: 13, color: 'var(--mu)' }}>
            {checkedLine}
          </div>
          <span title={offline ? m.connectToCheck : m.checkNowTip} style={{ display: 'flex', flexShrink: 0 }}>
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
        {rows.map(({ row, item, o, state }) => (
          <div
            key={row}
            data-md-row={row}
            title={rowTip(row, item, state, o, issue, m, clock)}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) auto 128px',
              gap: 12,
              minHeight: 60,
              padding: '10px 0',
              alignItems: 'center',
              boxShadow: 'inset 0 -1px 0 var(--ln2)',
            }}
          >
            <LabelBlock label={m.markets[row].l} desc={m.markets[row].d} />
            <div style={{ fontSize: 13, whiteSpace: 'nowrap', textAlign: 'right', color: offline ? 'var(--dm)' : 'var(--mu)' }}>{state.note ? m.rowNote[state.note] : ''}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <ObservedTagBox tag={state.tag} via={state.via} muted={offline && !!item} alert={state.alert} />
            </div>
          </div>
        ))}
        {!offline &&
          attention.hints.map((kind) => (
            <div key={kind} data-md="hint" data-kind={kind} style={{ paddingTop: 12, fontSize: 12, color: 'var(--mu)', lineHeight: 1.6, textWrap: 'pretty' }}>
              {m.hint[kind]}
            </div>
          ))}
        <a
          href={PRICING_URL}
          onClick={(e) => {
            e.preventDefault();
            void window.tape.openExternal(PRICING_URL).catch(() => undefined);
          }}
          style={{ paddingTop: 12, fontSize: 13, color: 'var(--ac)', textDecoration: 'none', alignSelf: 'flex-start', cursor: 'pointer' }}
        >
          {m.link}
        </a>
      </div>
      <SubHeader title={m.depthTitle} desc={m.depthDesc} />
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: -14 }}>
        {/* The switch is the user's choice once set here (depthSwitchPatch); until then a check that finds a full book turns it on (marketCheck.ts → turnsDepthOn). */}
        <div
          data-md="depth-switch"
          role="switch"
          aria-checked={features.depth}
          onClick={() => saveSettings(depthSwitchPatch(!features.depth))}
          style={{ minHeight: 60, display: 'flex', alignItems: 'center', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)', cursor: 'pointer' }}
        >
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0' }}>
            <div>{m.depthSwitch}</div>
            <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.6, textWrap: 'pretty' }}>
              {check.running && check.depth ? m.depthTesting : depthNoteText(depthItem, features, m)}
            </div>
          </div>
          <ObservedTagBox
            tag={depthItem ? checkTag(depthItem) : (obs?.depth.tag ?? 'none')}
            via={depthItem?.via}
            muted={offline}
            title={depthItem ? depthTip(depthItem, reasons, m, clock) : observedText('depth', obs?.depth, m)}
          />
          <Toggle on={features.depth} />
        </div>
      </div>
      <div data-md="details">
        <Disclosure label={m.details}>
          <div style={{ fontSize: 12, color: 'var(--mu)' }}>{m.dAnswers}</div>
          <div data-md="answers" className="selectable" style={{ font: '12px/1.7 var(--mono)', color: 'var(--mu)', overflowWrap: 'anywhere' }}>
            {answerLines(items, issue, shown?.checkedAt, m, clock).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {rows.some(({ state }) => state.note === 'delay' || state.note === 'notSubscribed') && (
            <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.6, textWrap: 'pretty' }}>{m.dAck}</div>
          )}
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--mu)' }}>{m.fieldsT}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {m.fields(clock).map((x) => (
              <div key={x.tick} style={{ display: 'grid', gridTemplateColumns: '150px 170px minmax(0,1fr)', gap: 12, fontSize: 13, alignItems: 'baseline' }}>
                <div>{x.l}</div>
                <div style={{ font: '12px/1 var(--mono)', color: 'var(--ac)' }}>{x.tick}</div>
                <div style={{ fontSize: 12, color: 'var(--dm)' }}>{x.d}</div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => openSettings('log')}
            style={{ border: 'none', background: 'none', padding: 0, fontSize: 13, color: 'var(--ac)', cursor: 'pointer', alignSelf: 'flex-start' }}
          >
            {m.viewAll}
          </button>
        </Disclosure>
      </div>
      <LocalCacheBlock />
    </>
  );
}
