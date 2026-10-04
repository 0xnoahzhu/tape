// Chart view of the Trade page (design 3a, top-left cell): instrument header with the
// session-aware price, price-alert bell, timeframes, OHLC row with indicator chips, and
// the candlestick chart fed by IB historical bars plus the live last price.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contractLabel, sameContract } from '@shared/contract';
import { change, compact, f2, signColor } from '@shared/format';
import { usEquitySession } from '@shared/session';
import { useQuote, useQuoteSubscriptions, useMarketDataAvailable } from '../../hooks/useQuotes';
import { nameOf, useLang } from '../../i18n';
import { useCommon } from '../../i18n/common';
import { useStore } from '../../state/store';
import { barsKey, loadBars, useBarsStore } from './barsStore';
import { useChartPrefs } from './chartPrefs';
import { isIntraday, mergeLivePrice, priceDecimals, TIMEFRAMES } from './chartMath';
import { useContractInfo } from './contractInfo';
import { exposeChartDebugHandles } from './debug';
import { useChartMessages } from './messages';
import { PriceChart } from './PriceChart';
import { dailyBarsCurrent, etTime, sessionQuote, usesUsEquitySession } from './sessionQuote';
import { useNow } from './useNow';
import { useSize } from './useSize';

const REFRESH_MS = 60_000;
/** Header spacing from the design (px): view side padding, gap between price, bell and timeframes. */
const PAD_X = 28;
const HEADER_GAP = 24;
const PRICE_GAP = 14;

function BellButton({ title, active, onClick }: { title: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      title={title}
      className="hover-tx hover-p2"
      style={{
        position: 'relative',
        height: 30,
        width: 30,
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
  const symbol = useStore((s) => s.symbol);
  const symbolName = useStore((s) => s.symbolName);
  const connected = useMarketDataAvailable();
  const openAlertForm = useStore((s) => s.openAlertForm);
  const alertsAll = useStore((s) => s.priceAlerts);
  const { timeframe, showMa, showVol, setTimeframe, toggleMa, toggleVol } = useChartPrefs();

  const contracts = useMemo(() => [symbol], [symbol]);
  useQuoteSubscriptions('chart', contracts, 'basic');
  const quote = useQuote(symbol);
  const info = useContractInfo(symbol);
  const now = useNow(30_000);
  const usSession = usesUsEquitySession(symbol);
  const session = usSession ? usEquitySession(now, info?.liquidHours) : 'regular';

  // The bell and timeframes sit beside the price as in the design while price and change fit there
  // on one line. In a narrower view the header stacks: title beside the tools, price below.
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
  useEffect(() => exposeChartDebugHandles(), []);
  useEffect(() => {
    if (connected) void loadBars(symbol, timeframe);
    // The key identifies symbol + timeframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);
  useEffect(() => {
    if (!connected || !isIntraday(timeframe)) return;
    const t = setInterval(() => void loadBars(symbol, timeframe, true), REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);

  const liveLast = quote?.last;
  const bars = useMemo(() => mergeLivePrice(entry?.bars ?? [], liveLast, timeframe, new Date(), session), [entry?.bars, liveLast, timeframe, session]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  useEffect(() => setHoverIndex(null), [key]);

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
      : quote?.error
        ? `${quote.error.message} (${quote.error.code})`
        : !quote
          ? m.waitingQuote
          : sq.refs.length
            ? undefined
            : m.noQuote;
  const dataType = quote?.marketDataType && quote.marketDataType !== 1 ? m.dataType[quote.marketDataType] : undefined;
  const live = session === 'regular';
  const alertLevels = useMemo(() => alertsAll.filter((a) => a.active && sameContract(a.contract, symbol)).map((a) => a.price), [alertsAll, symbol]);

  // OHLC row: hovered bar, else the latest bar (on 1D, today's volume).
  const shown = hoverIndex != null ? bars[hoverIndex] : bars[bars.length - 1];
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
  const tools = (
    <div ref={toolsRef} style={{ display: 'flex', alignItems: 'flex-start', gap: HEADER_GAP, flexShrink: 0 }}>
      <BellButton title={m.addAlert} active={alertLevels.length > 0} onClick={() => openAlertForm(symbol)} />
      <div style={{ display: 'flex', gap: 2 }}>
        {TIMEFRAMES.map((tf) => (
          <div
            key={tf}
            onClick={() => setTimeframe(tf)}
            className={tf === timeframe ? undefined : 'hover-tx'}
            style={{
              padding: '7px 10px',
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: tf === timeframe ? 'var(--p2)' : 'transparent',
              color: tf === timeframe ? 'var(--tx)' : 'var(--dm)',
            }}
          >
            {m.timeframes[tf]}
          </div>
        ))}
      </div>
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
          <div style={{ padding: '3px 6px', font: '600 11px/1 var(--sans)', color: 'var(--mu)', boxShadow: 'inset 0 0 0 1px var(--ln)', whiteSpace: 'nowrap' }}>{dataType}</div>
        )}
        {sq.refs.map((r) => (
          <div key={r.kind} style={{ display: 'flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
            <div>{m.refs[r.kind]}</div>
            <div style={{ fontFamily: 'var(--num)', color: 'var(--tx)' }}>{fmt(r.value)}</div>
            {r.base != null && <div style={{ fontFamily: 'var(--num)', color: signColor(r.value - r.base) }}>{change(r.value, r.base)}</div>}
          </div>
        ))}
        {sq.price != null && quote?.lastTime != null && <div style={{ whiteSpace: 'nowrap' }}>{m.et(etTime(quote.lastTime, now))}</div>}
        {reason && (
          <div className="ellipsis" title={reason} style={{ maxWidth: 420 }}>
            {reason}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
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
        <div style={{ flex: 1 }} />
        {[
          { label: m.ma, on: showMa, toggle: toggleMa },
          { label: m.volume, on: showVol, toggle: toggleVol },
        ].map((c) => (
          <div
            key={c.label}
            onClick={c.toggle}
            style={{
              padding: '4px 8px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              boxShadow: `inset 0 0 0 1px ${c.on ? 'var(--ac)' : 'var(--ln)'}`,
              color: c.on ? 'var(--tx)' : 'var(--dm)',
            }}
          >
            {c.label}
          </div>
        ))}
      </div>
      <PriceChart
        bars={bars}
        timeframe={timeframe}
        message={chartMessage}
        lastPrice={sq.price}
        alerts={alertLevels}
        showMa={showMa}
        showVol={showVol}
        minTick={minTick}
        onHover={setHoverIndex}
      />
    </div>
  );
}
