// Candlestick chart with moving averages (MA5 … MA200) and their legend, volume, last-price
// and price-alert lines, a right price axis, a bottom time axis and a hover crosshair.
// Coordinates follow the design: the price SVG uses an 800×300 viewBox and the volume SVG
// 800×56, both stretched (preserveAspectRatio none) with non-scaling strokes.
//
// The chart is explorable: drag (or scroll sideways / shift+wheel) pans, the wheel or a
// trackpad pinch zooms around the pointer, ← / → and + / − do the same while the chart is
// hovered, and a double-click returns to the latest bars at the automatic zoom. Only the bars
// in view are drawn, as one path per kind and direction, and pointer input is applied once per
// animation frame. The moving averages are computed over the full series once per change of
// the bars (not per frame) and drawn for the bars in view, one path each, behind the candles;
// they never widen the price range. Coming within a screen of the oldest loaded bar asks for
// older bars (onNeedOlder), and asks again when a refused or empty page's wait is over, also
// while the view stays put at the oldest bar; the view is anchored to bar times, so bars added
// in front do not move it. A range (`fit`) shows the bars from its start to the newest until the
// user pans, zooms or returns to the latest bars (onLeaveFit), which start from the fitted view.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Bar, Timeframe } from '@shared/types';
import { useClock } from '../../i18n';
import { useStore } from '../../state/store';
import { scheduleOlderRetry, type OlderState } from './barsStore';
import {
  axisPrice,
  buildChart,
  clearOfTag,
  fitView,
  formatBarTime,
  labelWidth,
  LAST_TAG_H,
  latestButtonSpot,
  latestInView,
  LATEST_VIEW,
  LEGEND_GAP,
  LEGEND_H,
  LEGEND_LEFT,
  LEGEND_PAD_X,
  LEGEND_TOP,
  legendBox,
  legendClearance,
  legendItem,
  legendItemWidths,
  legendLines,
  maReadings,
  movingAverages,
  nearOldest,
  NY_ZONE,
  panView,
  placeExtreme,
  resolveView,
  SMALL_TAG_H,
  spreadAlertTags,
  timeAxisLabels,
  timeStepSpacing,
  VB_H,
  VB_W,
  VOL_VB_H,
  visibleBarCount,
  zoomView,
  type ChartView,
  type MaPeriod,
} from './chartMath';
import { useChartMessages } from './messages';
import { useSize } from './useSize';

export type ChartStatus = 'idle' | 'loading' | 'ready' | 'error';

interface Props {
  bars: Bar[];
  timeframe: Timeframe;
  /** Identifies the series (symbol + timeframe): a change returns the view to the latest bars. */
  seriesKey: string;
  /** Text shown over an empty chart (loading, error, not connected, no data). */
  message?: string;
  lastPrice?: number;
  /** Active price-alert levels for this instrument. */
  alerts: number[];
  /** Moving averages to draw (MA_PERIODS order); their colors are the --ma<period> tokens. */
  mas: readonly MaPeriod[];
  showVol: boolean;
  minTick?: number;
  /** IANA time zone of intraday bars on the time axis and in the hover label (chartTimeZone of the instrument). */
  timeZone?: string;
  /** Paging of older bars: loading indicator and refusal / empty-page notes at the left edge. */
  older?: OlderState;
  /** The view is within a screen of the oldest loaded bar (called again when older.retryAt passes). */
  onNeedOlder?(): void;
  /** Hovered bar, or null when the pointer leaves. */
  onHover(bar: Bar | null): void;
  /**
   * A range: the view shows the bars from `from` (unix s; null: all) to the newest, whatever
   * the pan / zoom state, until onLeaveFit. `key` identifies the range and series.
   */
  fit?: { key: string; from: number | null } | null;
  /** The user panned, zoomed or reset the view while a range was fitted. */
  onLeaveFit?(): void;
}

interface Point {
  x: number;
  y: number;
}

/** Wheel zoom per pixel of deltaY (mouse wheel, trackpad scroll) and per pixel of a pinch (ctrlKey wheel). */
const WHEEL_ZOOM = 0.0015;
const PINCH_ZOOM = 0.01;
/** Keyboard steps: a tenth of the screen per ← / →, 25 % per + / −. */
const KEY_PAN = 0.1;
const KEY_ZOOM = 1.25;
const LINE_PX = 16;

const line = (extra: CSSProperties): CSSProperties => ({ vectorEffect: 'non-scaling-stroke', ...extra });
const gridStroke = line({ stroke: 'var(--ln)', strokeDasharray: '1 3' });
const axisTag: CSSProperties = { position: 'absolute', left: 4, right: 8, transform: 'translateY(-50%)', whiteSpace: 'nowrap' };
/** Crosshair labels: muted solid chips, distinct from outlined alert tags and the accent last-price tag. */
const crossTag: CSSProperties = { background: 'var(--mu)', color: 'var(--p)', padding: '3px 6px', font: '11px/1 var(--num)', pointerEvents: 'none' };
/** Small notes over the plot (older bars loading / refused / not returned yet). */
const plotNote: CSSProperties = {
  position: 'absolute',
  top: 6,
  left: 8,
  maxWidth: '60%',
  padding: '3px 6px',
  background: 'var(--p)',
  font: '11px/1.2 var(--sans)',
  color: 'var(--dm)',
  pointerEvents: 'none',
};
const PULSE_CSS = '@keyframes tape-chart-pulse { 0%, 100% { opacity: 0.2 } 50% { opacity: 0.9 } }';
/** Moving average lines: solid, the long MA200 a little lighter than the short ones. */
const maStroke = (period: MaPeriod): CSSProperties => line({ fill: 'none', stroke: `var(--ma${period})`, strokeWidth: period === 200 ? 1 : 1.25, strokeLinejoin: 'round' });
/**
 * MA legend (chartMath's LEGEND_* and legendLines give its box): values in each line's color on a
 * panel pad, so lines behind do not cut through, on as many lines as the plot's width needs.
 */
const legendStyle: CSSProperties = {
  position: 'absolute',
  top: LEGEND_TOP,
  left: LEGEND_LEFT,
  maxWidth: `calc(100% - ${2 * LEGEND_LEFT}px)`,
  boxSizing: 'border-box',
  padding: `0 ${LEGEND_PAD_X}px`,
  background: 'var(--p)',
  color: 'var(--mu)',
  font: `11px/${LEGEND_H}px var(--num)`,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};
/** One legend line; an item too wide for the plot on its own is cut with an ellipsis. */
const legendLine: CSSProperties = { height: LEGEND_H, overflow: 'hidden', textOverflow: 'ellipsis' };
/** Highest / lowest price in view: muted text on the panel color, so lines behind it do not cut through. */
const extremeTag: CSSProperties = {
  position: 'absolute',
  transform: 'translateY(-50%)',
  padding: '1px 3px',
  background: 'var(--p)',
  font: '11px/1 var(--num)',
  color: 'var(--mu)',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};
/** Volume pane height and its gap below the price pane; the time axis row under both (px). */
const VOL_H = 52;
const VOL_GAP = 6;
const TIME_AXIS_H = 20;
/** Width of the price axis right of the plot (px). */
export const PRICE_AXIS_W = 76;
/** Horizontal padding of the crosshair chips (crossTag). */
const CHIP_PAD = 6;
/** Space kept between the crosshair's time chip and the time labels beside it. */
const CHIP_CLEAR = 6;

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export const PriceChart = memo(function PriceChart({
  bars,
  timeframe,
  seriesKey,
  message,
  lastPrice,
  alerts,
  mas,
  showVol,
  minTick,
  timeZone = NY_ZONE,
  older,
  onNeedOlder,
  onHover,
  fit,
  onLeaveFit,
}: Props) {
  const clock = useClock();
  const m = useChartMessages();
  const areaRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const size = useSize(areaRef);
  const count = visibleBarCount(size.w);

  const [view, setView] = useState<ChartView>(LATEST_VIEW);
  const [pt, setPt] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);

  // Input is applied to refs right away and committed to state once per animation frame.
  const viewRef = useRef(view);
  const ptRef = useRef(pt);
  const frameRef = useRef(0);
  const live = useRef({ bars, count, w: size.w });
  // The fitted view of a range, while one is shown (the view state is not used meanwhile).
  const fitKey = fit?.key;
  const fitFrom = fit?.from;
  const fitted = useMemo(() => (fitKey !== undefined ? fitView(bars, fitFrom ?? null) : null), [fitKey, fitFrom, bars]);
  const fitRef = useRef<{ view: ChartView | null; leave?: () => void }>({ view: null });
  const rectRef = useRef<DOMRect | null>(null);
  const dragRef = useRef<{ id: number; x: number } | null>(null);
  const hoverRef = useRef(false);
  useLayoutEffect(() => {
    live.current = { bars, count, w: size.w };
    fitRef.current = { view: fitted, leave: onLeaveFit };
  });
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);
  useLayoutEffect(() => {
    rectRef.current = null;
  }, [size.w, size.h]);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // A new series (symbol or timeframe) starts at its latest bars.
  const [shownKey, setShownKey] = useState(seriesKey);
  if (shownKey !== seriesKey) {
    setShownKey(seriesKey);
    setView(LATEST_VIEW);
    setPt(null);
  }

  const commit = () => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setView(viewRef.current);
      setPt(ptRef.current);
    });
  };
  const update = (fn: (v: ChartView, bars: Bar[], count: number) => ChartView) => {
    const { bars: b, count: c } = live.current;
    if (!b.length) return;
    const fit = fitRef.current;
    if (fit.view) {
      // Leaving a range: the gesture starts from the fitted view, which becomes the view now
      // (in the same render as the range ends, so nothing jumps).
      viewRef.current = fn(fit.view, b, c);
      fitRef.current = { view: null };
      setView(viewRef.current);
      fit.leave?.();
      return;
    }
    viewRef.current = fn(viewRef.current, b, c);
    commit();
  };
  /** Pans by `px` screen pixels (positive: towards newer bars). */
  const panPx = (px: number) =>
    update((v, b, c) => {
      const w = live.current.w;
      return w > 0 ? panView(v, b, c, (px / w) * resolveView(v, b, c).span) : v;
    });
  const zoomAt = (factor: number, fx: number) => update((v, b, c) => zoomView(v, b, c, factor, fx));
  const reset = (keepZoom: boolean) => update((v) => (keepZoom ? { span: v.span, end: null } : LATEST_VIEW));

  const plotRect = () => (rectRef.current ??= areaRef.current?.getBoundingClientRect() ?? null);
  const track = (clientX: number, clientY: number) => {
    const r = plotRect();
    if (!r) return;
    const x = clientX - r.left;
    ptRef.current = x >= 0 && x <= r.width ? { x, y: clientY - r.top } : null;
    commit();
  };
  const pointerFx = () => {
    const p = ptRef.current;
    const w = live.current.w;
    return p && w > 0 ? p.x / w : 1;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !bars.length) return;
    rectRef.current = null;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (synthetic events): the drag works while the pointer stays over the chart.
    }
    dragRef.current = { id: e.pointerId, x: e.clientX };
    setDragging(true);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (!hoverRef.current) {
      ptRef.current = null;
      commit();
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Also covers a pointer that was already over the chart when it mounted (no enter event).
    hoverRef.current = true;
    track(e.clientX, e.clientY);
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    // The button was released where no pointerup reached us (e.g. the window lost focus).
    if (!(e.buttons & 1)) {
      endDrag(e);
      return;
    }
    const dx = e.clientX - drag.x;
    drag.x = e.clientX;
    // Dragging right reveals older bars.
    if (dx) panPx(-dx);
  };

  // Wheel: React's wheel listeners are passive, so preventDefault needs a native one.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!live.current.bars.length) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? live.current.w || 800 : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      // Shift+wheel scrolls sideways (macOS already turns it into deltaX).
      if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
      track(e.clientX, e.clientY);
      if (e.ctrlKey) zoomAt(Math.exp(dy * PINCH_ZOOM), pointerFx());
      else if (Math.abs(dx) > Math.abs(dy)) panPx(dx);
      else if (dy) zoomAt(Math.exp(dy * WHEEL_ZOOM), pointerFx());
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // The handlers read everything through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard while hovered: ← / → pan, + / − zoom. Text fields, dialogs and modified keys are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoverRef.current || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (isEditable(e.target)) return;
      const s = useStore.getState();
      if (s.page !== 'trade' || s.bellOpen || s.pendingOrder || s.confirm || s.alertForm) return;
      const w = live.current.w;
      switch (e.key) {
        case 'ArrowLeft':
          panPx(-w * KEY_PAN);
          break;
        case 'ArrowRight':
          panPx(w * KEY_PAN);
          break;
        case '+':
        case '=':
          zoomAt(1 / KEY_ZOOM, pointerFx());
          break;
        case '-':
        case '_':
          zoomAt(KEY_ZOOM, pointerFx());
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Moving averages over the full series once per change of the bars (a page of older bars, a new
  // bar, the live price), not per frame: panning and zooming only slice them.
  const maSeries = useMemo(() => movingAverages(bars, mas), [bars, mas]);
  // MA legend lines: items packed by the widest value each can show in this series, so hovering
  // and panning never move items between lines. While the legend shows, the range keeps room
  // above the highest price for it and the high marker.
  const maLabels = useMemo(() => mas.map((p) => m.ma(p)), [mas, m]);
  const legendWidths = useMemo(() => legendItemWidths(bars, maLabels, minTick), [bars, maLabels, minTick]);
  const legendRows = useMemo(() => (size.w > 0 ? legendLines(legendWidths, size.w) : []), [legendWidths, size.w]);
  const topClear = legendRows.length > 0 && size.h > 0 ? Math.min(0.4, legendClearance(legendRows.length) / size.h) : 0;
  // Time axis step spacing: per series, not per live price update of the forming bar.
  const firstTime = bars[0]?.time;
  const lastTime = bars[bars.length - 1]?.time;
  const timeSpacing = useMemo(
    () => timeStepSpacing(bars, timeframe, timeZone),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeframe, timeZone, bars.length, firstTime, lastTime],
  );
  const shownView = fitted ?? view;
  const geo = useMemo(
    () => buildChart(bars, { count, view: shownView, mas: maSeries, include: [lastPrice], topClear }),
    [bars, count, shownView, maSeries, lastPrice, topClear],
  );
  const win = geo?.window;

  // Older bars when the view nears the oldest loaded one (the store ignores repeats). After a
  // refused, empty or superseded page the store waits until retryAt; the view may not move at the
  // oldest bar (it is clamped there), so a timer asks again then.
  const near = !!win && nearOldest(win);
  const retryAt = older?.retryAt;
  useEffect(() => {
    if (!near || !onNeedOlder) return;
    onNeedOlder();
    return scheduleOlderRetry(retryAt, onNeedOlder);
  }, [near, win?.start, bars.length, older?.status, retryAt, onNeedOlder]);

  const hovered = geo && pt && size.w > 0 ? geo.indexAt(pt.x / size.w) : null;
  const hoveredBar = hovered != null ? bars[hovered] : null;
  useEffect(() => onHover(hoveredBar), [hoveredBar, onHover]);

  const inRange = (p: number) => !!geo && p > geo.lo && p < geo.hi;
  const alertLevels = geo ? alerts.filter(inRange) : [];
  // Scrolled back in time, the last price stays off the range (and hidden) unless it falls inside it.
  const lastY = geo && lastPrice != null && lastPrice > 0 && inRange(lastPrice) ? geo.y(lastPrice) : null;

  // Crosshair: vertical line snaps to the hovered bar, horizontal follows the pointer.
  const crossX = geo && hovered != null ? geo.centerX(hovered) : null;
  const crossY = geo && pt && size.h > 0 && pt.y >= 0 && pt.y <= size.h ? pt.y / size.h : null;

  // Right axis in px: alert tags step aside from the last-price tag, and axis labels near any tag hide.
  const toPx = (vbY: number) => (vbY / VB_H) * size.h;
  const lastTagY = lastY != null ? toPx(lastY) : null;
  const alertTagYs = geo ? spreadAlertTags(alertLevels.map((p) => toPx(geo.y(p))), lastTagY, size.h) : [];
  const tags = [
    ...(lastTagY != null ? [{ y: lastTagY, h: LAST_TAG_H }] : []),
    ...alertTagYs.map((y) => ({ y, h: SMALL_TAG_H })),
    ...(crossY != null ? [{ y: crossY * size.h, h: SMALL_TAG_H }] : []),
  ];
  const axisLabels = (geo?.axis ?? []).filter((a) => tags.every((t) => clearOfTag(a.frac * size.h, t.y, t.h)));
  // Time axis: labels at their bars' centers, with faint vertical grid lines above them in both panes;
  // the crosshair's time chip sits in the axis row and hides the labels it would touch.
  const timeLabels = win && size.w > 0 ? timeAxisLabels(bars, timeframe, win, size.w, clock, timeZone, timeSpacing) : [];
  const timeText = crossX != null && hoveredBar ? formatBarTime(hoveredBar.time, timeframe, clock, timeZone) : '';
  const timeHalf = labelWidth(timeText) / 2 + CHIP_PAD;
  const timeLeft = crossX != null ? Math.min(Math.max((crossX / VB_W) * size.w, timeHalf), Math.max(timeHalf, size.w - timeHalf)) : 0;
  const shownTimeLabels = timeText
    ? timeLabels.filter((l) => Math.abs(l.x - timeLeft) >= timeHalf + labelWidth(l.label) / 2 + CHIP_CLEAR)
    : timeLabels;
  const crossStroke = line({ stroke: 'var(--dm)', strokeDasharray: '2 3' });
  const paths = geo?.paths;

  // MA legend: the values at the hovered bar, else at the newest bar in view.
  const readings = geo && maSeries.length ? maReadings(maSeries, hovered ?? latestInView(geo.window, bars.length)) : [];
  const legendItems = readings.map((r, i) => legendItem(maLabels[i], r.value, minTick));
  const legend = legendItems.length > 0 && legendRows.length > 0 ? legendBox(legendItems, legendRows, size.w) : null;

  // Highest high and lowest low of the bars in view, marked with a leader and their price (clear of the legend).
  const extremes =
    geo && size.w > 0 && size.h > 0
      ? (['high', 'low'] as const).map((kind) => {
          const e = geo.extremes[kind];
          const text = axisPrice(e.price, minTick);
          return { kind, text, ...placeExtreme((geo.centerX(e.index) / VB_W) * size.w, toPx(geo.y(e.price)), size.w, size.h, kind, text, legend) };
        })
      : [];
  // The "Latest" button keeps out of the way of the markers (the lowest low may sit in the bottom-right corner).
  const showLatest = !!win && !win.latest;
  const latestRef = useRef<HTMLDivElement>(null);
  const [latestSize, setLatestSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = latestRef.current;
    if (!el) return;
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    setLatestSize((s) => (s.w === w && s.h === h ? s : { w, h }));
  }, [showLatest, m.latest]);
  const latestSpot = latestButtonSpot(extremes.map((e) => e.box), size.w, size.h, latestSize.w, latestSize.h);

  const olderLoading = older?.status === 'loading';
  const olderError = older?.status === 'error' && near ? m.olderError(older.error ?? '') : undefined;
  const olderEmpty = older?.status === 'empty' && near;
  const olderLimited = older?.status === 'done' && older.limited === true && near;
  // The notes sit at the top-left too: below the legend while it shows.
  const note: CSSProperties = legend ? { ...plotNote, top: legend.bottom + 4 } : plotNote;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', marginTop: 14 }}>
      <div
        ref={plotRef}
        data-chart="plot"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          cursor: geo ? (dragging ? 'grabbing' : 'grab') : undefined,
          touchAction: 'none',
        }}
        onPointerEnter={() => {
          hoverRef.current = true;
          rectRef.current = null;
        }}
        onPointerLeave={() => {
          hoverRef.current = false;
          if (dragRef.current) return;
          ptRef.current = null;
          commit();
        }}
        onPointerDown={geo ? onPointerDown : undefined}
        onPointerMove={geo ? onPointerMove : undefined}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={geo ? () => reset(false) : undefined}
      >
        <div ref={areaRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            {[75, 150, 225].map((y) => (
              <line key={y} x1={0} x2={VB_W} y1={y} y2={y} style={gridStroke} />
            ))}
            {timeLabels.map((l) => (
              <line key={bars[l.index].time} x1={(l.x / size.w) * VB_W} x2={(l.x / size.w) * VB_W} y1={0} y2={VB_H} style={gridStroke} />
            ))}
            {geo?.mas.map((l) => (l.d ? <path key={l.period} data-ma={l.period} d={l.d} style={maStroke(l.period)} /> : null))}
            {paths && (
              <>
                <path d={paths.upWicks} style={line({ stroke: 'var(--up)', fill: 'none' })} />
                <path d={paths.upBodies} style={{ fill: 'var(--up)' }} />
                <path d={paths.dnWicks} style={line({ stroke: 'var(--dn)', fill: 'none' })} />
                <path d={paths.dnBodies} style={{ fill: 'var(--dn)' }} />
              </>
            )}
            {lastY != null && (
              <line x1={0} x2={VB_W} y1={lastY} y2={lastY} style={line({ stroke: 'var(--ac)', strokeDasharray: '2 3', filter: 'drop-shadow(0 0 3px var(--ac))' })} />
            )}
            {geo &&
              alertLevels.map((p, i) => (
                <line key={i} x1={0} x2={VB_W} y1={geo.y(p)} y2={geo.y(p)} style={line({ stroke: 'var(--mu)', strokeDasharray: '5 4' })} />
              ))}
            {crossX != null && <line x1={crossX} x2={crossX} y1={0} y2={VB_H} style={crossStroke} />}
            {crossY != null && <line x1={0} x2={VB_W} y1={crossY * VB_H} y2={crossY * VB_H} style={crossStroke} />}
          </svg>
          {extremes.length > 0 && (
            <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
              {extremes.map((e) => (
                <polyline key={e.kind} points={e.points} style={{ fill: 'none', stroke: 'var(--dm)', strokeWidth: 1 }} />
              ))}
            </svg>
          )}
          {extremes.map((e) => (
            <div
              key={e.kind}
              data-extreme={e.kind}
              style={{ ...extremeTag, top: e.y, ...(e.dir === 1 ? { left: e.x } : { right: size.w - e.x }) }}
            >
              {e.text}
            </div>
          ))}
          {legend && (
            <div data-chart="ma-legend" style={legendStyle}>
              {legendRows.map((row) => (
                <div key={row[0]} style={legendLine}>
                  {row.map((i, k) => (
                    <span key={readings[i].period} style={{ color: `var(--ma${readings[i].period})`, marginLeft: k ? LEGEND_GAP : 0 }}>
                      {legendItems[i]}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
          {!geo && message && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 32px',
                textAlign: 'center',
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--dm)',
              }}
            >
              {/* Panel background keeps the dashed grid from running through the text. */}
              <div style={{ background: 'var(--p)', padding: '0 10px' }}>{message}</div>
            </div>
          )}
          {geo && olderLoading && (
            <>
              <style>{PULSE_CSS}</style>
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'linear-gradient(to bottom, transparent, var(--ac), transparent)',
                  animation: 'tape-chart-pulse 1.2s ease-in-out infinite',
                  pointerEvents: 'none',
                }}
              />
              <div style={note}>{m.olderLoading}</div>
            </>
          )}
          {geo && !olderLoading && olderError && (
            <div className="ellipsis" title={olderError} style={{ ...note, color: 'var(--mu)', boxShadow: 'inset 0 0 0 1px var(--ln)' }}>
              {olderError}
            </div>
          )}
          {geo && olderEmpty && <div style={note}>{m.olderEmpty}</div>}
          {geo && olderLimited && (
            <div data-chart="older-limited" style={{ ...note, color: 'var(--mu)', boxShadow: 'inset 0 0 0 1px var(--ln)' }}>
              {m.olderLimited}
            </div>
          )}
          {showLatest && (
            <div
              ref={latestRef}
              role="button"
              title={m.latestHint}
              className="hover-p2 hover-tx"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => reset(true)}
              style={{
                position: 'absolute',
                right: latestSpot.right,
                bottom: latestSpot.bottom,
                padding: '4px 8px',
                font: '11px/1 var(--sans)',
                color: 'var(--mu)',
                background: 'var(--p)',
                boxShadow: 'inset 0 0 0 1px var(--ln)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {m.latest}
            </div>
          )}
        </div>
        {showVol && (
          <div style={{ height: VOL_H, flexShrink: 0, position: 'relative', marginTop: VOL_GAP }}>
            <svg viewBox={`0 0 ${VB_W} ${VOL_VB_H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              {timeLabels.map((l) => (
                <line key={bars[l.index].time} x1={(l.x / size.w) * VB_W} x2={(l.x / size.w) * VB_W} y1={0} y2={VOL_VB_H} style={gridStroke} />
              ))}
              {paths && (
                <>
                  <path d={paths.upVolume} style={{ fill: 'var(--up)', opacity: 0.35 }} />
                  <path d={paths.dnVolume} style={{ fill: 'var(--dn)', opacity: 0.35 }} />
                </>
              )}
              {crossX != null && <line x1={crossX} x2={crossX} y1={0} y2={VOL_VB_H} style={crossStroke} />}
            </svg>
          </div>
        )}
        <div
          data-chart="time-axis"
          style={{
            height: TIME_AXIS_H,
            flexShrink: 0,
            position: 'relative',
            borderTop: '1px solid var(--ln2)',
            font: '11px/1 var(--num)',
            color: 'var(--dm)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {shownTimeLabels.map((l) => (
            <div key={bars[l.index].time} style={{ position: 'absolute', left: l.x, top: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
              {l.label}
            </div>
          ))}
          {timeText && (
            <div style={{ ...crossTag, position: 'absolute', left: timeLeft, top: '50%', transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap' }}>{timeText}</div>
          )}
        </div>
      </div>
      <div
        style={{
          width: PRICE_AXIS_W,
          position: 'relative',
          font: '12px/1 var(--num)',
          color: 'var(--dm)',
          fontVariantNumeric: 'tabular-nums',
          marginBottom: (showVol ? VOL_H + VOL_GAP : 0) + TIME_AXIS_H,
        }}
      >
        {axisLabels.map((a) => (
          <div key={a.frac} style={{ position: 'absolute', left: 12, top: `${a.frac * 100}%`, transform: 'translateY(-50%)', whiteSpace: 'nowrap' }}>
            {axisPrice(a.value, minTick)}
          </div>
        ))}
        {geo &&
          alertLevels.map((p, i) => (
            <div
              key={i}
              style={{
                ...axisTag,
                top: alertTagYs[i],
                background: 'var(--p2)',
                color: 'var(--mu)',
                padding: '3px 6px',
                fontSize: 11,
                boxShadow: 'inset 0 0 0 1px var(--ln)',
              }}
            >
              {axisPrice(p, minTick)}
            </div>
          ))}
        {lastY != null && lastPrice != null && (
          <div style={{ ...axisTag, top: `${(lastY / VB_H) * 100}%`, background: 'var(--ac)', color: 'var(--acI)', padding: '4px 6px', fontWeight: 600 }}>
            {axisPrice(lastPrice, minTick)}
          </div>
        )}
        {geo && crossY != null && <div style={{ ...axisTag, ...crossTag, top: `${crossY * 100}%` }}>{axisPrice(geo.priceAt(crossY), minTick)}</div>}
      </div>
    </div>
  );
});
