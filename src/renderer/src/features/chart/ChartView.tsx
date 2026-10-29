// Chart view of the Trade page (design 3a, top-left cell): instrument header with the
// session-aware price, watchlist star, alert bell, intervals and ranges (TimeframeBar), OHLC
// row with indicator chips (moving averages and volume), and the candlestick chart fed by IB
// historical bars plus the live last price.
//
// Live bars: intraday bars reload every REFRESH_MS (seconds bars too: during a session each reload
// is one of IB's 60 historical requests per 10 minutes, and the history service keeps 20 of them
// for the newest bars); in between, a real-time last price extends the forming bar and starts the
// next ones on the interval's grid (advanceLiveBars). The live bars are kept between quotes until
// a reload reaches them, so a bar keeps what the quotes drew. Delayed quotes (market data type
// 3 / 4, minutes old) never touch intraday bars: they move with the reloads only, and seconds
// charts say so.
//
// Ranges: picking one sets its interval (chartPrefs), pages in the bars back to its start
// (loadOlder sized to what is missing; MAX until IB's head timestamp) and fits the view to them
// until the user pans or zooms (PriceChart's fit). A refused, empty or superseded page is asked
// again once its wait is over.
//
// Header width: the star, the bell and the interval chips (TimeframeBar) get what is left beside a
// title of MIN_TITLE_W; favorites beyond it stay in the picker.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { contractLabel, sameContract } from '@shared/contract';
import { change, compact, f2, pct, sg, signColor } from '@shared/format';
import { sessionOpenSec } from '@shared/liveBars';
import { usEquitySession } from '@shared/session';
import { dailyBarsCurrent, etTime, headerSession, sessionQuote, usesUsEquitySession } from '@shared/sessionQuote';
import { barSeconds, isSecondsTimeframe } from '@shared/timeframes';
import { localZone } from '@shared/timeFormat';
import type { Bar } from '@shared/types';
import { useQuote, useQuoteSubscriptions, useMarketDataAvailable } from '../../hooks/useQuotes';
import { nameOf, useClock, useLang } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { Dropdown, MenuChoice } from '../../ui/select';
import { alertLevel } from '../alerts/model';
import { WatchStar } from '../watchlist/WatchStar';
import { barsKey, CHART_SLOT, loadBars, loadOlder, MAX_OLDER_PAGE, olderPageSize, scheduleOlderRetry, useBarsStore } from './barsStore';
import { useChartPrefs } from './chartPrefs';
import { advanceLiveBars, isIntraday, MA_PERIODS, PATTERN_TOOLS, priceDecimals, shownTimeZone, withLiveBars, type MeasureKind, type PatternTool } from './chartMath';
import { useContractInfo } from './contractInfo';
import { exposeChartDebugHandles } from './debug';
import { useChartMessages } from './messages';
import { PRICE_AXIS_W, PriceChart, type MeasureReadout } from './PriceChart';
import { missingBars, rangeLoaded, rangeStartSec } from './ranges';
import type { Reversal } from './reversals';
import { TimeframeBar } from './TimeframeBar';
import type { Triangle } from './triangles';
import { useNow } from './useNow';
import { useSize } from './useSize';
import type { WaveCount } from './waves';

const REFRESH_MS = 60_000;
/** Header spacing from the design (px): view side padding, gap between price, bell and timeframes. */
const PAD_X = 28;
const HEADER_GAP = 24;
const PRICE_GAP = 14;
/** Width of the header buttons (watchlist star, alert bell); the title keeps at least MIN_TITLE_W beside the tools. */
const BELL_W = 30;
/** Gap between the star, the bell and the measure tools (as between the ringed indicator chips). */
const BUTTON_GAP = 6;
/** The pattern tool's menu part (▾) beside its icon. */
const MENU_W = 14;
/** The star, the bell, the three measure tools and the pattern tool with its menu side by side. */
const BUTTONS_W = 6 * BELL_W + MENU_W + 5 * BUTTON_GAP;
const MIN_TITLE_W = 120;

function BellButton({ title, active, onClick }: { title: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      title={title}
      className="hover-tx hover-p2"
      style={{
        position: 'relative',
        height: 30,
        width: BELL_W,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        color: 'var(--mu)',
        boxShadow: 'inset 0 0 0 1px var(--ln)',
      }}
    >
      <svg viewBox="0 0 16 16" width={14} height={14} style={{ display: 'block' }} aria-hidden>
        <path d="M4.5 11V7a3.5 3.5 0 0 1 7 0v4h1.3 M3.2 11h1.3 M6.6 13.3h2.8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="square" />
      </svg>
      {active && <div style={{ position: 'absolute', top: 6, right: 6, width: 5, height: 5, background: 'var(--ac)', boxShadow: '0 0 0 2px var(--p)' }} />}
    </div>
  );
}

/**
 * The measure tools' icons: the ruler, the price arrow (up from a bar to a bar), the time arrow (right
 * from a bar to a bar); the pattern tools: the triangle (two lines closing in), the waves (a zigzag
 * of five legs), the head and shoulders (three peaks on a neckline).
 */
const MEASURE_ICONS: Record<MeasureKind, string> = {
  ruler: 'M1.7 5.2h12.6v5.6H1.7z M4.7 5.2v2.4 M7.7 5.2v3.2 M10.7 5.2v2.4',
  price: 'M3.2 2.2h9.6 M3.2 13.8h9.6 M8 13.8V5 M4.8 8.2 8 5l3.2 3.2',
  time: 'M2.2 3.2v9.6 M13.8 3.2v9.6 M2.2 8H11 M7.8 4.8 11 8l-3.2 3.2',
  triangle: 'M1.8 2.6 14.2 7.2 M1.8 13.4 14.2 8.8',
  waves: 'M1.5 13 4.5 7.5 6.5 10 10 3 12 6.5 14.5 2.5',
  reversal: 'M1.5 13 4 8 6 10.5 8 3.5 10 10.5 12 8 14.5 13 M2.5 10.5h11',
};
/** Their switches' data-chart names. */
const MEASURE_NAMES: Record<MeasureKind, string> = { ruler: 'ruler', price: 'price-range', time: 'time-range', triangle: 'triangle', waves: 'waves', reversal: 'reversal' };

/**
 * A measure tool (the ruler, the price arrow, the time arrow): on, the next drag on the chart draws it
 * (PriceChart's `measuring`); accent ring while on. Under the one drawn (or on), in a bubble pointing
 * up at it and out of the flow (the header does not move), what the measure reads: its percent change,
 * large, in the up or down color, and the price change and (but for the price arrow) the bars between;
 * while the tool is on and nothing is drawn yet, what to do.
 */
function MeasureButton({
  kind,
  title,
  on,
  onClick,
  onMenu,
  readout,
}: {
  kind: MeasureKind;
  title: string;
  on: boolean;
  onClick: () => void;
  onMenu?: (anchor: HTMLElement) => void;
  readout: ReactNode;
}) {
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <MeasureSwitch kind={kind} title={title} on={on} onClick={onClick} onMenu={onMenu} />
      {readout && (
        <div
          data-chart="measure-readout"
          style={{
            position: 'absolute',
            top: `calc(100% + ${CARET + 4}px)`,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
            padding: '6px 10px',
            background: 'var(--p2)',
            boxShadow: '0 0 0 1px var(--ln), 0 4px 12px var(--ov)',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {/* The caret: a square turned on its corner, its two upper edges ruled, over the bubble's top edge. */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: -CARET / 2 - 1,
              left: '50%',
              width: CARET,
              height: CARET,
              transform: 'translateX(-50%) rotate(45deg)',
              background: 'var(--p2)',
              borderTop: '1px solid var(--ln)',
              borderLeft: '1px solid var(--ln)',
            }}
          />
          <div style={{ position: 'relative' }}>{readout}</div>
        </div>
      )}
    </div>
  );
}

/** The measure tools, in the header's order (then the pattern tool, PATTERN_TOOLS behind its menu). */
const MEASURE_KINDS: readonly MeasureKind[] = ['ruler', 'price', 'time'];

/** The measure bubble's caret (px, the side of the square it is). */
const CARET = 8;

/** A measure tool's switch; with `onMenu`, a ▾ part beside the icon opens the tool's menu. */
function MeasureSwitch({ kind, title, on, onClick, onMenu }: { kind: MeasureKind; title: string; on: boolean; onClick: () => void; onMenu?: (anchor: HTMLElement) => void }) {
  return (
    <div
      role="switch"
      aria-checked={on}
      data-chart={MEASURE_NAMES[kind]}
      onClick={onClick}
      title={title}
      className={on ? undefined : 'hover-tx hover-p2'}
      style={{
        height: 30,
        width: BELL_W + (onMenu ? MENU_W : 0),
        paddingLeft: onMenu ? 4 : 0,
        boxSizing: 'border-box',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        color: on ? 'var(--tx)' : 'var(--mu)',
        boxShadow: `inset 0 0 0 1px ${on ? 'var(--ac)' : 'var(--ln)'}`,
      }}
    >
      <svg viewBox="0 0 16 16" width={14} height={14} style={{ display: 'block' }} aria-hidden>
        <path d={MEASURE_ICONS[kind]} stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="square" />
      </svg>
      {onMenu && (
        <div
          data-chart="pattern-menu"
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e.currentTarget.parentElement!);
          }}
          style={{ width: MENU_W, alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--mu)' }}
        >
          ▾
        </div>
      )}
    </div>
  );
}

/** A pattern tool's verdict: a title (accent when the pattern is there) and lines of detail, left-aligned. */
function Verdict({ title, tone, lines, name }: { title: string; tone: 'yes' | 'other' | 'none'; lines: string[]; name: string }) {
  return (
    <div data-chart={`${name}-readout`} style={{ textAlign: 'left' }}>
      <div style={{ font: '600 14px/1.3 var(--sans)', color: tone === 'yes' ? 'var(--ac)' : tone === 'other' ? 'var(--tx)' : 'var(--dm)' }}>{title}</div>
      {lines.map((l) => (
        <div key={l} style={{ font: '11px/1.5 var(--sans)', color: 'var(--mu)' }}>
          {l}
        </div>
      ))}
    </div>
  );
}

/**
 * The triangle tool's verdict: whether the stretch is a symmetrical (converging) triangle, what it is
 * otherwise, then the touches of each line, how much it narrowed and how near the apex it ends, its
 * volume, and whether a close after it broke out of the lines.
 */
function TriangleReadout({ t }: { t: Triangle | undefined }) {
  const m = useChartMessages().triangle;
  if (!t) return null;
  const yes = t.kind === 'symmetrical';
  const lines: string[] = [];
  if (!t.kind) lines.push(m.why[t.why ?? 'lines']);
  else if (!yes) lines.push(m.kinds[t.kind]);
  if (t.upper && t.lower) lines.push(m.touches(t.upper.touches.length, t.lower.touches.length));
  if (t.kind) {
    const shape = [
      t.narrowing != null && t.narrowing < 0 ? m.narrowed(Math.round(-t.narrowing * 100)) : null,
      t.progress != null && t.narrowing != null && t.narrowing < 0 ? m.toApex(Math.round(t.progress * 100)) : null,
    ].filter(Boolean);
    if (shape.length) lines.push(shape.join(' · '));
    if (t.volume != null) lines.push(m.volume(pct(t.volume * 100)));
    lines.push(t.breakout ? m.breakout[t.breakout.dir] : m.inside);
  }
  return <Verdict name="triangle" title={yes ? m.yes : m.no} tone={yes ? 'yes' : t.kind ? 'other' : 'none'} lines={lines} />;
}

/**
 * The waves tool's verdict: the count read (an impulse, an A-B-C, a full cycle) and its direction, or
 * that none keeps the rules; each rule kept (✓) or broken (✗); the ratios; a larger count it is not.
 */
function WavesReadout({ c }: { c: WaveCount | undefined }) {
  const m = useChartMessages().waves;
  if (!c) return null;
  if (!c.waves) return <Verdict name="waves" title={m.none} tone="none" lines={[m.why[c.why ?? 'none']]} />;
  const r = c.ratios;
  const p = (x: number | undefined) => Math.round((x ?? 0) * 100);
  const x = (v: number | undefined) => (v ?? 0).toFixed(1);
  const title = c.ok ? `${m.title[c.waves]} ${m.dir[c.dir]}${c.waves === 3 && c.correction ? ` · ${m.correction[c.correction]}` : ''}` : m.none;
  const lines = [
    ...(c.ok ? [] : [m.count(c.waves)]),
    ...c.rules.map((rule) => `${rule.ok ? '✓' : '✗'} ${m.rules[rule.id]}`),
    ...(c.waves === 3 ? [] : [m.ratios5(p(r.w2), x(r.w3), p(r.w4), x(r.w5))]),
    ...(c.waves === 5 ? [] : [m.ratios3(p(r.b), x(r.c))]),
    ...(c.rejected ? [m.rejected(c.rejected.waves!, c.rejected.rules.filter((rule) => !rule.ok).map((rule) => m.rules[rule.id]).join('; '))] : []),
  ];
  return <Verdict name="waves" title={title} tone={c.ok ? 'yes' : 'other'} lines={lines} />;
}

/** The reversal tool's verdict: the pattern found, its neckline and height, and whether a close broke the neckline (with the target). */
function ReversalReadout({ r, fmt }: { r: Reversal | undefined; fmt: (v: number) => string }) {
  const m = useChartMessages().reversal;
  if (!r) return null;
  if (!r.kind || !r.neckline) return <Verdict name="reversal" title={m.none} tone="none" lines={r.why === 'short' ? [m.short] : []} />;
  const last = r.points[r.points.length - 1].index;
  const top = r.kind === 'headShouldersTop' || r.kind === 'doubleTop';
  const lines = [
    m.neckline(fmt(r.neckline.price + r.neckline.slope * (last - r.neckline.index)), fmt(r.height ?? 0)),
    r.breakout ? m.broke[top ? 'top' : 'bottom'](fmt(r.breakout.target)) : m.notYet,
  ];
  return <Verdict name="reversal" title={m.kinds[r.kind]} tone="yes" lines={lines} />;
}

/** Indicator toggle (design chip): accent ring when on; a moving average's chip carries a swatch of its line color. */
function Chip({ on, onClick, title, swatch, children }: { on: boolean; onClick: () => void; title?: string; swatch?: string; children: ReactNode }) {
  return (
    <div
      role="switch"
      aria-checked={on}
      onClick={onClick}
      title={title}
      className={on ? undefined : 'hover-tx'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        boxShadow: `inset 0 0 0 1px ${on ? 'var(--ac)' : 'var(--ln)'}`,
        color: on ? 'var(--tx)' : 'var(--dm)',
      }}
    >
      {swatch && <div aria-hidden style={{ width: 8, height: 8, flexShrink: 0, background: swatch }} />}
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ whiteSpace: 'nowrap' }}>
      {label} <span style={{ color: 'var(--mu)', fontFamily: 'var(--num)' }}>{value}</span>
    </div>
  );
}

export function ChartView() {
  const m = useChartMessages();
  const common = useCommon();
  const lang = useLang();
  const clock = useClock();
  const symbol = useStore((s) => s.symbol);
  const symbolName = useStore((s) => s.symbolName);
  const connected = useMarketDataAvailable();
  // 10197: IB sends no market data while the login has a live session elsewhere.
  const feedIssue = useStore((s) => s.connection.marketDataIssue?.code === 10197);
  const openAlertForm = useStore((s) => s.openAlertForm);
  const alertsAll = useStore((s) => s.priceAlerts);
  const { timeframe, range, rangePick, mas, showVol, clearRange, toggleMa, toggleVol } = useChartPrefs();

  const contracts = useMemo(() => [symbol], [symbol]);
  useQuoteSubscriptions('chart', contracts, 'basic');
  const quote = useQuote(symbol);
  const info = useContractInfo(symbol);
  const now = useNow(30_000);
  const usSession = usesUsEquitySession(symbol);
  const session = usSession ? usEquitySession(now, info?.liquidHours) : 'regular';
  // The price header also knows a US stock's overnight session (its live price, not the close).
  const priceSession = headerSession(symbol, now, info?.liquidHours);

  // The star, bell and timeframes sit beside the price as in the design while price and change fit
  // there on one line. In a narrower view the header stacks: title beside the tools, price below.
  const rootRef = useRef<HTMLDivElement>(null);
  const priceRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const { w: viewWidth } = useSize(rootRef);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const price = priceRef.current;
    const tools = toolsRef.current;
    if (!price || !tools || viewWidth === 0) return;
    const parts = [...price.children];
    const priceWidth = parts.reduce((sum, el) => sum + el.getBoundingClientRect().width, PRICE_GAP * (parts.length - 1));
    // Beside the tools the price column is separated by two gaps (around the design's spacer).
    setStacked(priceWidth + 2 * HEADER_GAP + tools.getBoundingClientRect().width > viewWidth - 2 * PAD_X);
  });

  // Historical bars ---------------------------------------------------------
  const key = barsKey(symbol, timeframe);
  const entry = useBarsStore((s) => s.entries[key]);
  const missing = !entry;
  useEffect(() => exposeChartDebugHandles(), []);
  useEffect(() => {
    // Also when the entry went away (a request superseded before it loaded, or evicted).
    if (connected) void loadBars(symbol, timeframe, false, CHART_SLOT);
    // The key identifies symbol + timeframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected, missing]);
  useEffect(() => {
    if (!connected || !isIntraday(timeframe)) return;
    const t = setInterval(() => void loadBars(symbol, timeframe, true, CHART_SLOT), REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);
  // A range pages in the bars back to its start (MAX: until IB has nothing older), a page sized
  // to what is missing each time; the store keeps one page in flight and waits after a refusal.
  // Meanwhile the chart's own paging (a screen ahead of the view) waits, so its smaller page does
  // not go first.
  const rangeStart = range ? rangeStartSec(range, now.getTime(), timeframe) : undefined;
  const oldest = entry?.status === 'ready' ? entry.bars[0]?.time : undefined;
  const older = entry?.older;
  const rangeDone = older?.status === 'done';
  const rangeReady = range != null && rangeLoaded(rangeStart ?? null, entry?.bars ?? [], rangeDone);
  const rangeLoading = range != null && !rangeReady;
  const needOlder = useCallback(() => {
    if (connected && !rangeLoading) void loadOlder(symbol, timeframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected, rangeLoading]);
  // Every pick of a range (the active one again too) is a new fit: it also fits the prices again.
  const fit = useMemo(() => (range ? { key: `${range}|${key}|${rangePick}`, from: rangeStart ?? null } : null), [range, key, rangePick, rangeStart]);
  /** Bumped when a refused page's wait is over, so the range asks again. */
  const [rangeRetry, setRangeRetry] = useState(0);
  useEffect(() => {
    if (!connected || !range || rangeReady || oldest === undefined || older?.status === 'loading' || older?.status === 'done') return;
    const wait = scheduleOlderRetry(older?.retryAt, () => setRangeRetry((n) => n + 1));
    if (wait) return wait;
    const lacking = rangeStart == null ? MAX_OLDER_PAGE : missingBars(timeframe, rangeStart, oldest);
    void loadOlder(symbol, timeframe, Math.min(MAX_OLDER_PAGE, Math.max(olderPageSize(timeframe), lacking)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected, range, rangeReady, rangeStart, oldest, older?.status, older?.retryAt, rangeRetry]);

  // The live price extends the forming bar wherever the chart is scrolled, and starts the next
  // bars on the interval's grid; the chart's view is anchored to bar times, so it only moves
  // along when it shows the latest bars. Delayed quotes leave intraday bars to the reloads.
  const liveLast = quote?.last;
  const liveData = quote?.marketDataType == null || quote.marketDataType === 1;
  const barSec = barSeconds(timeframe);
  // Live intraday bars roll over on their own grid: a clock at the bar length (at least a second).
  const tick = useNow(barSec != null && liveData && connected ? Math.min(30_000, Math.max(1000, barSec * 1000)) : 3_600_000);
  const sessionOpen = usSession ? sessionOpenSec(tick) : undefined;
  /** The live bars beyond the stored ones (advanceLiveBars), kept between quotes for this series. */
  const liveRef = useRef<{ key: string; bars: Bar[] }>({ key: '', bars: [] });
  const bars = useMemo(
    () => {
      const stored = entry?.bars ?? [];
      const prev = liveRef.current.key === key ? liveRef.current.bars : [];
      // Advancing again with the same price and time changes nothing, so a repeated render is harmless.
      const live = advanceLiveBars(stored, prev, liveLast, timeframe, new Date(), session, { live: liveData, sessionOpen });
      liveRef.current = { key, bars: live };
      return withLiveBars(stored, live);
    },
    // `tick` re-runs the merge when a new bar is due without a new price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, entry?.bars, liveLast, timeframe, session, liveData, sessionOpen, tick],
  );
  const [hoverBar, setHoverBar] = useState<Bar | null>(null);
  // The time axis and crosshair read in Settings › General › Chart time zone.
  const chartZone = useStore((s) => s.settings.appearance.chartZone);
  // The measure tool on: the next drag on the chart draws it; it turns off once one is drawn (or on Esc).
  const [measuring, setMeasuring] = useState<MeasureKind | null>(null);
  const endMeasuring = useCallback(() => setMeasuring(null), []);
  // The pattern tool on the header (the last one picked from its menu), and its menu's anchor while open.
  const [patternTool, setPatternTool] = useState<PatternTool>('triangle');
  const [patternMenu, setPatternMenu] = useState<HTMLElement | null>(null);
  // The measure drawn on the chart: its figures go under its tool, not over the bars.
  const [measured, setMeasured] = useState<MeasureReadout | null>(null);
  useEffect(() => setHoverBar(null), [key]);

  // Today's close after the regular session: IB sends no tick 57 with delayed data, so the
  // latest daily bar stands in, once loaded after the close.
  const dailyKey = barsKey(symbol, '1D');
  const daily = useBarsStore((s) => s.entries[dailyKey]);
  const needsClose = usSession && (priceSession === 'post' || priceSession === 'closed' || priceSession === 'overnight') && !((quote?.lastRthTrade ?? 0) > 0);
  const dailyCurrent = daily?.loadedAt != null && dailyBarsCurrent(daily.loadedAt, now, info?.liquidHours);
  useEffect(() => {
    if (connected && needsClose) void loadBars(symbol, '1D', !dailyCurrent);
    // The key identifies the symbol.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyKey, connected, needsClose, dailyCurrent]);
  const regularClose = needsClose && dailyCurrent ? daily?.bars.at(-1)?.close : undefined;

  // Price header --------------------------------------------------------------
  const sq = sessionQuote(quote, priceSession, regularClose);
  const minTick = info?.minTick;
  const fmt = (v: number) => f2(v, priceDecimals(minTick, v));
  const name = nameOf(symbolName, lang) || info?.longName;
  const exchange = info?.contract.primaryExchange || symbol.primaryExchange || (symbol.secType === 'IND' ? symbol.exchange : '');
  const title = [contractLabel(symbol), name, exchange].filter(Boolean).join(' · ');
  // A known previous close is shown as a ref even without a live price (e.g. FX on a weekend).
  const reason = !connected
    ? common.notConnected
    : sq.price != null
      ? undefined
      : quote?.error?.code === 10197 || (feedIssue && !quote?.error)
        ? m.competingSession
        : quote?.error
          ? `${quote.error.message} (${quote.error.code})`
          : !quote
            ? m.waitingQuote
            : sq.refs.length
              ? undefined
              : m.noQuote;
  const via = quote?.source?.kind === 'primary' ? quote.source.exchange : undefined;
  const dataType = via
    ? m.via(via, quote?.marketDataType)
    : quote?.marketDataType && quote.marketDataType !== 1
      ? m.dataType[quote.marketDataType]
      : undefined;
  // Seconds bars do not move with delayed quotes: only the reloads bring them.
  const delayedSeconds = isSecondsTimeframe(timeframe) && (quote?.marketDataType === 3 || quote?.marketDataType === 4);
  const live = session === 'regular';
  // Lines for the price-level alerts (price, bid, ask); the bell lights up for any active alert of the symbol.
  const symbolAlerts = useMemo(() => alertsAll.filter((a) => a.active && !a.unsupported && sameContract(a.contract, symbol)), [alertsAll, symbol]);
  const alertLevels = useMemo(() => symbolAlerts.flatMap((a) => alertLevel(a)?.price ?? []), [symbolAlerts]);

  // OHLC row: hovered bar, else the latest bar (on 1D, today's volume).
  const shown = hoverBar ?? bars[bars.length - 1];
  const volume = shown?.volume;

  // Chart message when there is nothing to draw.
  const status = entry?.status;
  const chartMessage =
    bars.length > 0
      ? undefined
      : status === 'error'
        ? m.historyError(entry?.error ?? '')
        : status === 'loading' || (connected && !entry)
          ? m.loading
          : !connected
            ? common.notConnected
            : m.noHistory;

  const titleRow = (
    <div className="ellipsis" style={{ fontSize: 13, color: 'var(--mu)' }}>
      {title}
    </div>
  );
  const priceRow = (
    <div ref={priceRef} style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: PRICE_GAP, rowGap: 8 }}>
      <div className="num selectable" style={{ font: '600 30px/1 var(--num)', fontVariantNumeric: 'tabular-nums' }}>
        {sq.price != null ? fmt(sq.price) : '—'}
      </div>
      {sq.price != null && sq.ref != null && (
        <div style={{ font: '15px/1 var(--num)', color: signColor(sq.price - sq.ref), whiteSpace: 'nowrap' }}>{change(sq.price, sq.ref)}</div>
      )}
    </div>
  );
  // What the interval chips may take: the view less its padding, a title of MIN_TITLE_W and the star and bell.
  const barWidth = viewWidth > 0 ? Math.max(0, viewWidth - 2 * PAD_X - MIN_TITLE_W - 2 * HEADER_GAP - BUTTONS_W) : 0;
  // The plot: the view less its left padding and the price axis (the chart runs to the right edge).
  const plotWidth = viewWidth > 0 ? Math.max(0, viewWidth - PAD_X - PRICE_AXIS_W) : undefined;
  /** What a measure tool's bubble reads: the measure drawn with it, else (while it is on) what to do. */
  const readoutOf = (kind: MeasureKind): ReactNode => {
    if (measured && kind === measured.kind && (!measuring || measuring === kind)) {
      if (kind === 'triangle') return <TriangleReadout t={measured.triangle} />;
      if (kind === 'waves') return <WavesReadout c={measured.waves} />;
      if (kind === 'reversal') return <ReversalReadout r={measured.reversal} fmt={fmt} />;
      return (
        <>
          <div style={{ font: '600 15px/1.2 var(--num)', color: measured.change >= 0 ? 'var(--up)' : 'var(--dn)' }}>
            {measured.pct == null ? '—' : pct(measured.pct * 100)}
          </div>
          <div style={{ font: '11px/1.4 var(--num)', color: 'var(--mu)' }}>
            {sg(measured.change, fmt)}
            {kind !== 'price' && ` · ${m.measureBars(Math.abs(measured.bars))}`}
          </div>
        </>
      );
    }
    return measuring === kind ? <div style={{ font: '11px/1.4 var(--sans)', color: 'var(--dm)' }}>{m.measureDrags[kind]}</div> : null;
  };
  const tools = (
    <div ref={toolsRef} style={{ display: 'flex', alignItems: 'flex-start', gap: HEADER_GAP, flexShrink: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: BUTTON_GAP, flexShrink: 0 }}>
        <WatchStar contract={symbol} name={symbolName || info?.longName || undefined} size={BELL_W} />
        <BellButton title={symbolAlerts.length ? m.alertsOn(symbolAlerts.length) : m.addAlert} active={symbolAlerts.length > 0} onClick={() => openAlertForm(symbol)} />
        {MEASURE_KINDS.map((kind) => (
          <MeasureButton
            key={kind}
            kind={kind}
            title={m.measureHints[kind]}
            on={measuring === kind}
            onClick={() => setMeasuring((on) => (on === kind ? null : kind))}
            readout={readoutOf(kind)}
          />
        ))}
        <MeasureButton
          kind={patternTool}
          title={m.measureHints[patternTool]}
          on={measuring === patternTool}
          onClick={() => setMeasuring((on) => (on === patternTool ? null : patternTool))}
          onMenu={setPatternMenu}
          readout={readoutOf(patternTool)}
        />
        {patternMenu && (
          <Dropdown anchor={patternMenu} onClose={() => setPatternMenu(null)} width={280}>
            {PATTERN_TOOLS.map((k) => (
              <MenuChoice
                key={k}
                label={m.patternTools[k]}
                hint={m.patternToolHints[k]}
                active={k === patternTool}
                onPick={() => {
                  setPatternTool(k);
                  setMeasuring(k);
                  setPatternMenu(null);
                }}
              />
            ))}
          </Dropdown>
        )}
      </div>
      <TimeframeBar maxWidth={barWidth} plotWidth={plotWidth} />
    </div>
  );

  return (
    <div ref={rootRef} style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, padding: `22px 0 14px ${PAD_X}px` }}>
      {stacked ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: HEADER_GAP, paddingRight: PAD_X }}>
            <div style={{ flex: 1, minWidth: 0 }}>{titleRow}</div>
            {tools}
          </div>
          <div style={{ marginTop: 10, paddingRight: PAD_X }}>{priceRow}</div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: HEADER_GAP, paddingRight: PAD_X }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {titleRow}
            {priceRow}
          </div>
          <div style={{ flex: 1 }} />
          {tools}
        </div>
      )}
      {/* Session refs span the full width (below the tools) so they wrap less in a narrow window. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          columnGap: 14,
          rowGap: 8,
          marginTop: 10,
          paddingRight: 28,
          fontSize: 12,
          color: 'var(--dm)',
          fontVariantNumeric: 'tabular-nums',
          flexWrap: 'wrap',
        }}
      >
        {usSession && (
          <div
            style={{
              padding: '3px 6px',
              font: '600 11px/1 var(--sans)',
              color: live ? 'var(--ac)' : 'var(--mu)',
              boxShadow: `inset 0 0 0 1px ${live ? 'var(--ac)' : 'var(--ln)'}`,
              whiteSpace: 'nowrap',
            }}
          >
            {m.session[priceSession]}
          </div>
        )}
        {dataType && (
          <div
            data-chart="data-type"
            title={via ? m.viaTip(via, contractLabel(symbol), quote?.marketDataType) : undefined}
            style={{ padding: '3px 6px', font: '600 11px/1 var(--sans)', color: 'var(--mu)', boxShadow: 'inset 0 0 0 1px var(--ln)', whiteSpace: 'nowrap' }}
          >
            {dataType}
          </div>
        )}
        {delayedSeconds && (
          <div data-chart="delayed-note" style={{ whiteSpace: 'nowrap' }}>
            {m.delayedSeconds}
          </div>
        )}
        {sq.refs.map((r) => (
          <div key={r.kind} style={{ display: 'flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
            <div>{m.refs[r.kind]}</div>
            <div style={{ fontFamily: 'var(--num)', color: 'var(--tx)' }}>{fmt(r.value)}</div>
            {r.base != null && <div style={{ fontFamily: 'var(--num)', color: signColor(r.value - r.base) }}>{change(r.value, r.base)}</div>}
          </div>
        ))}
        {sq.price != null && quote?.lastTime != null && <div style={{ whiteSpace: 'nowrap' }}>{m.et(etTime(quote.lastTime, now, clock))}</div>}
        {reason && (
          <div className="ellipsis" title={reason} style={{ maxWidth: 420 }}>
            {reason}
          </div>
        )}
      </div>
      {/* OHLC stats and indicator chips; in a narrow view the chips wrap onto their own line, right-aligned. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          columnGap: 18,
          rowGap: 8,
          marginTop: 14,
          paddingRight: 28,
          fontSize: 12,
          color: 'var(--dm)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <div style={{ display: 'flex', gap: 18, minWidth: 0, overflow: 'hidden' }}>
          <Stat label={m.open} value={shown ? fmt(shown.open) : '—'} />
          <Stat label={m.high} value={shown ? fmt(shown.high) : '—'} />
          <Stat label={m.low} value={shown ? fmt(shown.low) : '—'} />
          <Stat label={m.vol} value={volume ? compact(volume) : '—'} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {MA_PERIODS.map((p) => (
            <Chip key={p} on={mas.includes(p)} onClick={() => toggleMa(p)} title={m.maHint(p)} swatch={`var(--ma${p})`}>
              {m.ma(p)}
            </Chip>
          ))}
          <Chip on={showVol} onClick={toggleVol}>
            {m.volume}
          </Chip>
        </div>
      </div>
      <PriceChart
        bars={bars}
        timeframe={timeframe}
        seriesKey={key}
        message={chartMessage}
        lastPrice={sq.price}
        alerts={alertLevels}
        mas={mas}
        showVol={showVol}
        minTick={minTick}
        timeZone={shownTimeZone(chartZone, info?.timeZoneId, localZone())}
        // An option's bars come in its regular hours only (IB's tradingHours add a pre-open from 07:30).
        tradingHours={(symbol.secType === 'OPT' ? info?.liquidHours : undefined) ?? info?.tradingHours}
        exchangeTimeZone={info?.timeZoneId}
        older={entry?.older}
        onNeedOlder={needOlder}
        onHover={setHoverBar}
        fit={fit}
        onLeaveFit={clearRange}
        measuring={measuring}
        onMeasured={endMeasuring}
        onMeasure={setMeasured}
      />
    </div>
  );
}
