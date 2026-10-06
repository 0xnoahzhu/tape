// Chart view of the Trade page (design 3a, top-left cell): instrument header with the
// session-aware price, watchlist star, price-alert bell, intervals and ranges (TimeframeBar), OHLC
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
import { change, compact, f2, signColor } from '@shared/format';
import { nyClock, usEquitySession } from '@shared/session';
import { barSeconds, isSecondsTimeframe } from '@shared/timeframes';
import type { Bar } from '@shared/types';
import { useQuote, useQuoteSubscriptions, useMarketDataAvailable } from '../../hooks/useQuotes';
import { nameOf, useClock, useLang } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { WatchStar } from '../watchlist/WatchStar';
import { barsKey, CHART_SLOT, loadBars, loadOlder, MAX_OLDER_PAGE, olderPageSize, scheduleOlderRetry, useBarsStore } from './barsStore';
import { useChartPrefs } from './chartPrefs';
import { advanceLiveBars, chartTimeZone, isIntraday, MA_PERIODS, priceDecimals, withLiveBars } from './chartMath';
import { useContractInfo } from './contractInfo';
import { exposeChartDebugHandles } from './debug';
import { useChartMessages } from './messages';
import { PRICE_AXIS_W, PriceChart } from './PriceChart';
import { missingBars, rangeLoaded, rangeStartSec } from './ranges';
import { dailyBarsCurrent, etTime, sessionQuote, usesUsEquitySession } from './sessionQuote';
import { TimeframeBar } from './TimeframeBar';
import { useNow } from './useNow';
import { useSize } from './useSize';

const REFRESH_MS = 60_000;
/** Extended hours open at 04:00 New York (the partial first bar of 2 to 4-hour bars). */
const EXT_OPEN_MIN = 240;
/** Header spacing from the design (px): view side padding, gap between price, bell and timeframes. */
const PAD_X = 28;
const HEADER_GAP = 24;
const PRICE_GAP = 14;
/** Width of the header buttons (watchlist star, price-alert bell); the title keeps at least MIN_TITLE_W beside the tools. */
const BELL_W = 30;
/** Gap between the star and the bell (as between the ringed indicator chips). */
const BUTTON_GAP = 6;
/** The star and the bell side by side. */
const BUTTONS_W = 2 * BELL_W + BUTTON_GAP;
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
  const { timeframe, range, mas, showVol, clearRange, toggleMa, toggleVol } = useChartPrefs();

  const contracts = useMemo(() => [symbol], [symbol]);
  useQuoteSubscriptions('chart', contracts, 'basic');
  const quote = useQuote(symbol);
  const info = useContractInfo(symbol);
  const now = useNow(30_000);
  const usSession = usesUsEquitySession(symbol);
  const session = usSession ? usEquitySession(now, info?.liquidHours) : 'regular';

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
  const fit = useMemo(() => (range ? { key: `${range}|${key}`, from: rangeStart ?? null } : null), [range, key, rangeStart]);
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
  useEffect(() => setHoverBar(null), [key]);

  // Today's close after the regular session: IB sends no tick 57 with delayed data, so the
  // latest daily bar stands in, once loaded after the close.
  const dailyKey = barsKey(symbol, '1D');
  const daily = useBarsStore((s) => s.entries[dailyKey]);
  const needsClose = usSession && (session === 'post' || session === 'closed') && !((quote?.lastRthTrade ?? 0) > 0);
  const dailyCurrent = daily?.loadedAt != null && dailyBarsCurrent(daily.loadedAt, now, info?.liquidHours);
  useEffect(() => {
    if (connected && needsClose) void loadBars(symbol, '1D', !dailyCurrent);
    // The key identifies the symbol.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyKey, connected, needsClose, dailyCurrent]);
  const regularClose = needsClose && dailyCurrent ? daily?.bars.at(-1)?.close : undefined;

  // Price header --------------------------------------------------------------
  const sq = sessionQuote(quote, session, regularClose);
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
  const alertLevels = useMemo(() => alertsAll.filter((a) => a.active && sameContract(a.contract, symbol)).map((a) => a.price), [alertsAll, symbol]);

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
  const tools = (
    <div ref={toolsRef} style={{ display: 'flex', alignItems: 'flex-start', gap: HEADER_GAP, flexShrink: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: BUTTON_GAP, flexShrink: 0 }}>
        <WatchStar contract={symbol} name={symbolName || info?.longName || undefined} size={BELL_W} />
        <BellButton title={m.addAlert} active={alertLevels.length > 0} onClick={() => openAlertForm(symbol)} />
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
            {m.session[session]}
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
        timeZone={chartTimeZone(info?.timeZoneId)}
        older={entry?.older}
        onNeedOlder={needOlder}
        onHover={setHoverBar}
        fit={fit}
        onLeaveFit={clearRange}
      />
    </div>
  );
}

/** Unix seconds of today's 04:00 New York (extended hours open) at `now`. */
function sessionOpenSec(now: Date): number {
  const sec = Math.floor(now.getTime() / 1000);
  return sec - (sec % 60) - (nyClock(now).minutes - EXT_OPEN_MIN) * 60;
}
