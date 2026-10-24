// Candlestick chart with moving averages (MA5 … MA200) and their legend, volume, last-price
// and price-level alert lines, a right price axis, a bottom time axis and a hover crosshair.
// Coordinates follow the design: the price SVG uses an 800×300 viewBox and the volume SVG
// 800×56, both stretched (preserveAspectRatio none) with non-scaling strokes.
//
// The chart is explorable: drag (or scroll sideways / shift+wheel) pans, the wheel or a
// trackpad pinch zooms around the pointer, ← / → and + / − do the same while the chart is
// hovered, and a double-click returns to the latest bars at the automatic zoom and fitted prices.
// Panning past the newest bar shows empty future slots, their times projected on the time axis
// and in the crosshair (chartMath.ts → futureTimes), and the view keeps them as new bars come;
// nothing comes before the first bar. The price axis fits the bars in view until the user moves
// it: dragging or scrolling on the axis zooms the prices, and a drag that starts up or down moves
// them with the bars (one that starts sideways stays sideways, so a pan never loses the fit; once
// moved, every drag goes both ways). Every bar in view stays whole on the plot: the prices zoom in
// no further than they fit the bars, and once zoomed out they move only until a bar reaches the top
// or the bottom (chartMath.ts → keepBarsInRange); back at the fit, they fit the bars again. The Auto chip under the axis, a double-click on it, or picking
// a range fits the prices again; moving them keeps a range. Only the bars
// in view are drawn, as one path per kind and direction, and pointer input is applied once per
// animation frame. The moving averages are computed over the full series once per change of
// the bars (not per frame) and drawn for the bars in view, one path each, behind the candles;
// they never widen the price range. Coming within a screen of the oldest loaded bar asks for
// older bars (onNeedOlder), and asks again when a refused or empty page's wait is over, also
// while the view stays put at the oldest bar; the view is anchored to bar times, so bars added
// in front do not move it. Fewer bars than the screen holds (a contract listed days ago) start at
// the left edge. A range (`fit`) shows the bars from its start to the newest until the
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
  futureTimes,
  keepBarsInRange,
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
  panPrice,
  panView,
  placeExtreme,
  resolveView,
  SMALL_TAG_H,
  spreadAlertTags,
  timeAxisLabels,
  timeStepSpacing,
  tradingCalendar,
  VB_H,
  VB_W,
  VOL_VB_H,
  visibleBarCount,
  zoomPrice,
  zoomView,
  type ChartView,
  type MaPeriod,
  type PriceRange,
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
  /** Levels of the instrument's active price-level alerts (price, bid, ask; alerts/model.ts → alertLevel). */
  alerts: number[];
  /** Moving averages to draw (MA_PERIODS order); their colors are the --ma<period> tokens. */
  mas: readonly MaPeriod[];
  showVol: boolean;
  minTick?: number;
  /** IANA time zone of intraday bars on the time axis and in the hover label (chartTimeZone of the instrument). */
  timeZone?: string;
  /** IB's trading hours of the instrument and the time zone it gives them in (contract details), for the future slots' times. */
  tradingHours?: string;
  exchangeTimeZone?: string;
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
/** Price axis zoom per pixel dragged on the axis (down shows more prices). */
const PRICE_DRAG_ZOOM = 0.006;
/** A drag moves this far (px) before it is known to start sideways or up / down. */
const AXIS_LOCK_PX = 5;
/** Future slot times are worked out in steps of this many slots (a pan does not redo them every frame). */
const FUTURE_STEP = 64;
/** Height of the Auto chip, in the time axis row under the price axis (px). */
const AUTO_H = 18;

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
  tradingHours,
  exchangeTimeZone,
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
  // The price axis's range once the user moved or zoomed it; null fits it to the bars in view.
  const [price, setPrice] = useState<PriceRange | null>(null);

  // Input is applied to refs right away and committed to state once per animation frame.
  const viewRef = useRef(view);
  const ptRef = useRef(pt);
  const priceRef = useRef(price);
  // The range the plot shows now (fitted or the user's), where moving or zooming the prices starts,
  // and the range fitted to the bars in view, which a moved or zoomed one always holds.
  const shownRangeRef = useRef<PriceRange | null>(null);
  const fittedRef = useRef<PriceRange | null>(null);
  const frameRef = useRef(0);
  const live = useRef({ bars, count, w: size.w, h: size.h });
  // The fitted view of a range, while one is shown (the view state is not used meanwhile).
  const fitKey = fit?.key;
  const fitFrom = fit?.from;
  const fitted = useMemo(() => (fitKey !== undefined ? fitView(bars, fitFrom ?? null) : null), [fitKey, fitFrom, bars]);
  const fitRef = useRef<{ view: ChartView | null; leave?: () => void }>({ view: null });
  const rectRef = useRef<DOMRect | null>(null);
  // A drag over the plot: `axis` is null until it has moved AXIS_LOCK_PX, then 'x' (sideways only) or 'xy'.
  const dragRef = useRef<{ id: number; x: number; y: number; ox: number; oy: number; axis: 'x' | 'xy' | null } | null>(null);
  const axisDragRef = useRef<{ id: number; y: number } | null>(null);
  const hoverRef = useRef(false);
  useLayoutEffect(() => {
    live.current = { bars, count, w: size.w, h: size.h };
    fitRef.current = { view: fitted, leave: onLeaveFit };
  });
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);
  useLayoutEffect(() => {
    priceRef.current = price;
  }, [price]);
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
    setPrice(null);
  }
  // A range picked (on the same interval too: YTD and 1Y are both daily) fits the prices again.
  const [shownFit, setShownFit] = useState(fitKey);
  if (shownFit !== fitKey) {
    setShownFit(fitKey);
    if (fitKey !== undefined) setPrice(null);
  }

  const commit = () => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setView(viewRef.current);
      setPt(ptRef.current);
      setPrice(priceRef.current);
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
  /**
   * Moves or zooms the price axis from the range shown now, holding the fitted range so every bar in
   * view stays whole on the plot (keepBarsInRange); back at the fitted range, the prices fit again.
   */
  const updatePrice = (fn: (r: PriceRange) => PriceRange) => {
    const fit = fittedRef.current;
    const keep = (r: PriceRange) => (fit ? keepBarsInRange(r, fit) : r);
    const r = priceRef.current ? keep(priceRef.current) : shownRangeRef.current;
    if (!r || !(live.current.h > 0)) return;
    const next = keep(fn(r));
    const fitted = !!fit && Math.abs(next.hi - fit.hi) + Math.abs(next.lo - fit.lo) <= (fit.hi - fit.lo) * 1e-9;
    priceRef.current = fitted ? null : next;
    commit();
  };
  /** Moves the prices with a drag of `dy` px (down: the bars follow it down). */
  const panPricePx = (dy: number) => updatePrice((r) => panPrice(r, dy / live.current.h));
  const zoomPriceBy = (factor: number) => {
    const fit = fittedRef.current;
    updatePrice((r) => zoomPrice(r, factor, fit ? Math.max(Math.abs(fit.hi), Math.abs(fit.lo)) : undefined));
  };
  const fitPrices = () => {
    priceRef.current = null;
    commit();
  };

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
    // With the prices already moved, every drag goes both ways.
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, axis: priceRef.current ? 'xy' : null };
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
    if (drag.axis === null) {
      const tx = e.clientX - drag.ox;
      const ty = e.clientY - drag.oy;
      if (Math.max(Math.abs(tx), Math.abs(ty)) < AXIS_LOCK_PX) return;
      // Started up or down: the prices move with the bars from now on; started sideways: only sideways.
      drag.axis = Math.abs(ty) > Math.abs(tx) ? 'xy' : 'x';
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    // Dragging right reveals older bars, left the future.
    if (dx) panPx(-dx);
    if (dy && drag.axis === 'xy') panPricePx(dy);
  };

  // The price axis: a drag up or down zooms the prices, a double-click fits them again.
  const onAxisPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !bars.length) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (synthetic events).
    }
    axisDragRef.current = { id: e.pointerId, y: e.clientY };
  };
  const endAxisDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (axisDragRef.current?.id === e.pointerId) axisDragRef.current = null;
  };
  const onAxisPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = axisDragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    if (!(e.buttons & 1)) {
      axisDragRef.current = null;
      return;
    }
    const dy = e.clientY - drag.y;
    drag.y = e.clientY;
    if (dy) zoomPriceBy(Math.exp(dy * PRICE_DRAG_ZOOM));
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
  // Wheel on the price axis: zooms the prices (down shows more of them).
  const axisRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!live.current.bars.length) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? live.current.h || 300 : 1;
      const dy = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit;
      if (dy) zoomPriceBy(Math.exp(dy * (e.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
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
    () => buildChart(bars, { count, view: shownView, mas: maSeries, include: [lastPrice], topClear, price }),
    [bars, count, shownView, maSeries, lastPrice, topClear, price],
  );
  const win = geo?.window;
  useLayoutEffect(() => {
    shownRangeRef.current = geo ? { hi: geo.hi, lo: geo.lo } : null;
    fittedRef.current = geo ? geo.fit : null;
  });

  // Empty future slots in view (panned past the newest bar) and their projected times, for the time
  // axis and the crosshair; worked out for the slots in view plus a screen (the axis reads ahead).
  const futureInView = win ? Math.max(0, Math.ceil(win.start + win.span) - bars.length) : 0;
  const futureNeed = futureInView > 0 && win ? Math.ceil((futureInView + win.span) / FUTURE_STEP) * FUTURE_STEP : 0;
  // The instrument's sessions (IB's trading hours) place the future slots.
  const calendar = useMemo(() => tradingCalendar(tradingHours, exchangeTimeZone), [tradingHours, exchangeTimeZone]);
  const futures = useMemo(
    () => (futureNeed ? futureTimes(bars, timeframe, futureNeed, calendar) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [futureNeed, timeframe, calendar, bars.length, lastTime],
  );
  const axisBars = useMemo(() => (futures.length ? [...bars, ...futures.map((time) => ({ time }))] : bars), [bars, futures]);

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

  // The slot under the pointer: a bar, or an empty future slot (no bar, but its time and the crosshair).
  const slot = geo && pt && size.w > 0 ? geo.slotAt(pt.x / size.w) : null;
  const hovered = slot != null && slot < bars.length ? slot : null;
  const hoveredBar = hovered != null ? bars[hovered] : null;
  const slotTime = slot == null ? undefined : hoveredBar ? hoveredBar.time : futures[slot - bars.length];
  useEffect(() => onHover(hoveredBar), [hoveredBar, onHover]);

  const inRange = (p: number) => !!geo && p > geo.lo && p < geo.hi;
  const alertLevels = geo ? alerts.filter(inRange) : [];
  // Scrolled back in time, the last price stays off the range (and hidden) unless it falls inside it.
  const lastY = geo && lastPrice != null && lastPrice > 0 && inRange(lastPrice) ? geo.y(lastPrice) : null;

  // Crosshair: vertical line snaps to the hovered bar (or future slot), horizontal follows the pointer.
  const crossX = geo && slot != null && slotTime != null ? geo.centerX(slot) : null;
  const crossY = geo && pt && size.h > 0 && pt.y >= 0 && pt.y <= size.h ? pt.y / size.h : null;

  // Right axis in px: alert tags step aside from the last-price tag, and axis labels near any tag hide.
  const toPx = (vbY: number) => (vbY / VB_H) * size.h;
  // Tags stay whole within the plot's height (the line may run at its very edge), clear of the Auto chip under it.
  const inPlot = (y: number, h: number) => Math.min(Math.max(y, h / 2), Math.max(h / 2, size.h - h / 2));
  const lastTagY = lastY != null ? inPlot(toPx(lastY), LAST_TAG_H) : null;
  const crossTagY = crossY != null ? inPlot(crossY * size.h, SMALL_TAG_H) : null;
  const alertTagYs = geo ? spreadAlertTags(alertLevels.map((p) => toPx(geo.y(p))), lastTagY, size.h) : [];
  const tags = [
    ...(lastTagY != null ? [{ y: lastTagY, h: LAST_TAG_H }] : []),
    ...alertTagYs.map((y) => ({ y, h: SMALL_TAG_H })),
    ...(crossTagY != null ? [{ y: crossTagY, h: SMALL_TAG_H }] : []),
  ];
  const axisLabels = (geo?.axis ?? []).filter((a) => tags.every((t) => clearOfTag(a.frac * size.h, t.y, t.h)));
  // Time axis: labels at their bars' centers, with faint vertical grid lines above them in both panes;
  // the crosshair's time chip sits in the axis row and hides the labels it would touch.
  const timeLabels = win && size.w > 0 ? timeAxisLabels(axisBars, timeframe, win, size.w, clock, timeZone, timeSpacing) : [];
  const timeText = crossX != null && slotTime != null ? formatBarTime(slotTime, timeframe, clock, timeZone) : '';
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

  // Highest high and lowest low of the bars in view, marked with a leader and their price (clear of the
  // legend); with the prices moved, only those within the plot.
  const extremes =
    geo && size.w > 0 && size.h > 0
      ? (['high', 'low'] as const).flatMap((kind) => {
          const e = geo.extremes[kind];
          if (!(e.price >= geo.lo && e.price <= geo.hi)) return [];
          const text = axisPrice(e.price, minTick);
          return [{ kind, text, ...placeExtreme((geo.centerX(e.index) / VB_W) * size.w, toPx(geo.y(e.price)), size.w, size.h, kind, text, legend) }];
        })
      : [];
  // The "Latest" button keeps out of the way of the markers (the lowest low may sit in the bottom-right corner).
  // Back among the bars, or ahead of the newest one: the button brings it back to the right edge.
  const showLatest = !!win && (!win.latest || (shownView.ahead ?? 0) > 0);
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
        onDoubleClick={
          geo
            ? () => {
                reset(false);
                fitPrices();
              }
            : undefined
        }
      >
        <div ref={areaRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            {[75, 150, 225].map((y) => (
              <line key={y} x1={0} x2={VB_W} y1={y} y2={y} style={gridStroke} />
            ))}
            {timeLabels.map((l) => (
              <line key={axisBars[l.index].time} x1={(l.x / size.w) * VB_W} x2={(l.x / size.w) * VB_W} y1={0} y2={VB_H} style={gridStroke} />
            ))}
            {geo?.mas.map((l) => (l.d ? <path key={l.period} data-ma={l.period} d={l.d} style={maStroke(l.period)} /> : null))}
            {paths && (
              <>
                <path d={paths.upWicks} style={line({ stroke: 'var(--up)', fill: 'none' })} />
                <path d={paths.upBodies} style={line({ fill: 'var(--upBody)', stroke: 'var(--upEdge)' })} />
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
                <line key={axisBars[l.index].time} x1={(l.x / size.w) * VB_W} x2={(l.x / size.w) * VB_W} y1={0} y2={VOL_VB_H} style={gridStroke} />
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
            <div key={axisBars[l.index].time} style={{ position: 'absolute', left: l.x, top: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
              {l.label}
            </div>
          ))}
          {timeText && (
            <div style={{ ...crossTag, position: 'absolute', left: timeLeft, top: '50%', transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap' }}>{timeText}</div>
          )}
        </div>
      </div>
      <div
        ref={axisRef}
        data-chart="price-axis"
        title={geo ? m.priceAxisHint : undefined}
        onPointerDown={geo ? onAxisPointerDown : undefined}
        onPointerMove={geo ? onAxisPointerMove : undefined}
        onPointerUp={endAxisDrag}
        onPointerCancel={endAxisDrag}
        onLostPointerCapture={endAxisDrag}
        onDoubleClick={geo ? fitPrices : undefined}
        style={{
          width: PRICE_AXIS_W,
          position: 'relative',
          font: '12px/1 var(--num)',
          color: 'var(--dm)',
          fontVariantNumeric: 'tabular-nums',
          marginBottom: (showVol ? VOL_H + VOL_GAP : 0) + TIME_AXIS_H,
          cursor: geo ? 'ns-resize' : undefined,
          touchAction: 'none',
          userSelect: 'none',
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
          <div style={{ ...axisTag, top: lastTagY ?? 0, background: 'var(--ac)', color: 'var(--acI)', padding: '4px 6px', fontWeight: 600 }}>
            {axisPrice(lastPrice, minTick)}
          </div>
        )}
        {geo && crossY != null && <div style={{ ...axisTag, ...crossTag, top: crossTagY ?? 0 }}>{axisPrice(geo.priceAt(crossY), minTick)}</div>}
        {geo && price && (
          <div
            role="button"
            data-chart="auto-scale"
            title={m.autoScaleHint}
            className="hover-p2 hover-tx"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={fitPrices}
            style={{
              position: 'absolute',
              left: 4,
              right: 8,
              // Below the axis, in the time axis row: clear of the price tags.
              top: `calc(100% + ${(showVol ? VOL_H + VOL_GAP : 0) + (TIME_AXIS_H - AUTO_H) / 2}px)`,
              height: AUTO_H,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              font: '11px/1 var(--sans)',
              color: 'var(--mu)',
              background: 'var(--p)',
              boxShadow: 'inset 0 0 0 1px var(--ln)',
              cursor: 'pointer',
            }}
          >
            {m.autoScale}
          </div>
        )}
      </div>
    </div>
  );
});
