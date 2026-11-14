// Trade page layout (design 3a): watchlist | view tabs + view content.
// The two views, Chart and Options (tradeViews.ts), share one grid: the view top-left and the
// symbol's positions / open orders under it (SymbolActivityPanel: 150px by default; a splitter
// resizes it and it collapses to a bar like the watchlist, one height and one collapse state for
// both views). On Chart the order ticket takes the right column (340px), with Level 2 as its Book.
// The watchlist (296px) and the docked ticket are as wide as the user drags them (a splitter on the
// watchlist's right edge and on the ticket's left one; a double-click gives the default width back),
// remembered per device, and always leave the view in the middle CENTER_MIN.
// With the ticket floating (features/panels) the right column goes and the chart and the
// positions / orders take the full width; the options desk always does.

import { useRef, useState, type ReactNode } from 'react';
import { isTradable } from '@shared/contract';
import { createMessages } from '../i18n';
import { useStore, type TradeView } from '../state/store';
import { TabItems } from '../ui/primitives';
import { WatchlistPanel } from '../features/watchlist/WatchlistPanel';
import { ChartView } from '../features/chart/ChartView';
import { ACTIVITY_BAR_H, SymbolActivityBar, SymbolActivityPanel } from '../features/chart/SymbolActivityPanel';
import { useChartMessages } from '../features/chart/messages';
import { OrderTicket } from '../features/ticket/OrderTicket';
import { OptionsDesk } from '../features/options/OptionsDesk';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Splitter, useSplitHeight } from '../ui/Splitter';
import { clampPane, loadFlag, loadSplit, saveFlag, saveSplit } from '../ui/splitGeometry';
import { useSize } from '../features/chart/useSize';
import { PopOutButton } from '../features/panels/chrome';
import { isFloating, usePanels } from '../features/panels/panelStore';
import { TRADE_VIEWS } from './tradeViews';

const useM = createMessages({
  en: { chart: 'Chart', options: 'Options', resizeWidth: 'Drag to resize · double-click to reset' },
  zh: { chart: '图表', options: '期权', resizeWidth: '拖动调整宽度 · 双击恢复默认' },
});

/** Width of the collapsed watchlist's handle (WatchlistPanel). */
const HANDLE_GUTTER = 26;

/** Positions / orders under the view: default height, smallest (header and one row) and the chart's minimum. */
const ACTIVITY = { key: 'tape.trade.activityHeight', collapsedKey: 'tape.trade.activityCollapsed', fallback: 150, min: 76, minAbove: 200 };
/** Under the options desk: its header and tabs (about 120px) and a usable chain stay above the panel. */
const DESK = { ...ACTIVITY, minAbove: 320 };
/** Dragging the splitter this far below the minimum collapses the panel. */
const COLLAPSE_SLACK = 36;

/** Side panes' widths: default, limits (the ticket is laid out for 340px: no narrower) and where they are kept. */
// The watchlist's least width fits its four columns at their usual figures (watchlist/model.ts → COL_FIT_W),
// and its default width at their default widths.
const WATCH = { key: 'tape.trade.watchlistWidth', fallback: 296, min: 260, max: 520 };
const TICKET = { key: 'tape.trade.ticketWidth', fallback: 340, min: 340, max: 600 };
/** The view in the middle (chart, options desk) keeps at least this width. */
const CENTER_MIN = 480;

/** A side pane's width as dragged (unclamped), with its setter; persisted under `key` when a gesture ends. */
function usePaneWidth(key: string, fallback: number) {
  const [width, setWidth] = useState(() => loadSplit(key, fallback));
  const set = (w: number, persist: boolean) => {
    setWidth(w);
    if (persist) saveSplit(key, w);
  };
  return { width, set, reset: () => set(fallback, true) };
}

/**
 * A see-through layer over a side pane's grid cell (both rows) that places the pane's width splitter
 * on its edge. The panes place themselves in the grid (WatchlistPanel, OrderTicket), so the splitter
 * goes beside them rather than in a box around them. Absolutely positioned (the grid is positioned),
 * the layer covers the cell without taking part in the grid's placement: the watchlist, placed by
 * its row only, keeps the first column.
 */
function PaneEdge({ column, children }: { column: number; children: ReactNode }) {
  return <div style={{ gridColumn: `${column} / ${column + 1}`, gridRow: '1 / 3', position: 'absolute', inset: 0, pointerEvents: 'none' }}>{children}</div>;
}

export function TradePage() {
  const m = useM();
  const collapsed = useStore((s) => s.watchlistCollapsed);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const ticketFloating = usePanels(isFloating('ticket'));
  const cm = useChartMessages();
  const options = view === 'opt';
  // The ticket trades on Chart only, and not an index (its chart runs the full width); the options
  // desk has its strategy builder.
  const tradable = useStore((s) => isTradable(s.symbol));
  const ticketDocked = !options && !ticketFloating && tradable;

  // Positions / orders under the view: resizable with the splitter, collapsible to a bar. One grid
  // element for both views, so the splitter's measurement (bound once to it) stays current.
  const viewGrid = useRef<HTMLDivElement>(null);
  const split = useSplitHeight(ACTIVITY.key, ACTIVITY.fallback, options ? DESK : ACTIVITY, viewGrid);
  const [activityCollapsed, setActivityCollapsedState] = useState(() => loadFlag(ACTIVITY.collapsedKey));
  const setActivityCollapsed = (on: boolean) => {
    setActivityCollapsedState(on);
    saveFlag(ACTIVITY.collapsedKey, on);
  };
  const onSplit = (h: number, persist: boolean) => {
    // A drag that ends well below the minimum collapses the panel and keeps the last height.
    if (persist && h < ACTIVITY.min - COLLAPSE_SLACK) {
      setActivityCollapsed(true);
      return;
    }
    split.set(h, persist);
  };

  // Side panes: each gets what its limits and the page allow once the other pane and the view's minimum are taken.
  const page = useRef<HTMLDivElement>(null);
  const pageW = useSize(page).w || Infinity;
  const watch = usePaneWidth(WATCH.key, WATCH.fallback);
  const ticket = usePaneWidth(TICKET.key, TICKET.fallback);
  const watchShown = collapsed ? 0 : clampPane(watch.width, WATCH, pageW - CENTER_MIN - (ticketDocked ? TICKET.min : 0));
  const ticketShown = ticketDocked ? clampPane(ticket.width, TICKET, pageW - CENTER_MIN - (collapsed ? HANDLE_GUTTER : watchShown)) : 0;
  const watchMax = Math.max(WATCH.min, Math.min(WATCH.max, pageW - CENTER_MIN - ticketShown));
  const ticketMax = Math.max(TICKET.min, Math.min(TICKET.max, pageW - CENTER_MIN - (collapsed ? HANDLE_GUTTER : watchShown)));
  // A drag stores the width it shows, so the pane follows the pointer back from a limit at once.
  const setWatch = (w: number, persist: boolean) => watch.set(clampPane(w, { min: WATCH.min, max: watchMax }), persist);
  const setTicket = (w: number, persist: boolean) => ticket.set(clampPane(w, { min: TICKET.min, max: ticketMax }), persist);

  const labels: Record<TradeView, string> = { chart: m.chart, opt: m.options };
  const tabs = TRADE_VIEWS.map((key) => ({ key, label: labels[key] }));

  return (
    <div
      ref={page}
      style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: `${watchShown}px minmax(0,1fr)`,
        gridTemplateRows: '46px minmax(0,1fr)',
        columnGap: collapsed ? 0 : 'var(--gap)',
        rowGap: 'var(--gap)',
        padding: 'var(--pad)',
        background: 'var(--gbg)',
      }}
    >
      <ErrorBoundary name="Watchlist" style={{ gridRow: '1 / 3' }}>
        <WatchlistPanel />
      </ErrorBoundary>
      {!collapsed && (
        <PaneEdge column={1}>
          <Splitter edge="right" size={watchShown} min={WATCH.min} max={watchMax} onChange={setWatch} onReset={watch.reset} title={m.resizeWidth} style={{ pointerEvents: 'auto' }} />
        </PaneEdge>
      )}
      <div
        style={{
          gridColumn: 2,
          gridRow: 1,
          background: 'var(--p)',
          display: 'flex',
          alignItems: 'stretch',
          gap: 26,
          padding: `0 28px 0 ${collapsed ? 44 : 28}px`,
          position: 'relative',
        }}
      >
        <TabItems tabs={tabs} value={view} onChange={setView} />
      </div>
      {/* With the watchlist collapsed, its floating handle (26px, left edge) gets a gutter so it covers no content. */}
      <div style={{ gridColumn: 2, gridRow: 2, minHeight: 0, display: 'flex', background: 'var(--p)', paddingLeft: collapsed ? HANDLE_GUTTER : 0 }}>
        <div
          ref={viewGrid}
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: ticketDocked ? `minmax(0,1fr) ${ticketShown}px` : 'minmax(0,1fr)',
            gridTemplateRows: `minmax(0,1fr) ${activityCollapsed ? ACTIVITY_BAR_H : split.height}px`,
            gap: 'var(--gap)',
            background: 'var(--gbg)',
          }}
        >
          {options ? (
            <div key="opt" style={{ gridColumn: 1, gridRow: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <ErrorBoundary name="Options" style={{ flex: 1 }}>
                <OptionsDesk mode="full" />
              </ErrorBoundary>
            </div>
          ) : (
            <ErrorBoundary key="chart" name="Chart">
              <ChartView />
            </ErrorBoundary>
          )}
          {/* One explicit cell for the panel and the splitter on its top edge (an ErrorBoundary's style
              only applies to its fallback, so it cannot place the panel itself). Unkeyed and in the same
              place for both views, so the panel stays mounted when the view changes. */}
          <div style={{ gridColumn: 1, gridRow: 2, position: 'relative', minWidth: 0, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0,1fr)' }}>
            <ErrorBoundary name="Activity">
              {activityCollapsed ? (
                <SymbolActivityBar onExpand={() => setActivityCollapsed(false)} />
              ) : (
                <SymbolActivityPanel options={options} onCollapse={() => setActivityCollapsed(true)} />
              )}
            </ErrorBoundary>
            {!activityCollapsed && (
              <Splitter size={split.height} min={ACTIVITY.min} max={split.max} onChange={onSplit} onReset={split.reset} title={cm.resizePanel} />
            )}
          </div>
          {ticketDocked && (
            <ErrorBoundary name="Order ticket" style={{ gridColumn: 2, gridRow: '1 / 3' }}>
              <OrderTicket actions={<PopOutButton id="ticket" />} />
            </ErrorBoundary>
          )}
          {ticketDocked && (
            <PaneEdge column={2}>
              <Splitter edge="left" size={ticketShown} min={TICKET.min} max={ticketMax} onChange={setTicket} onReset={ticket.reset} title={m.resizeWidth} style={{ pointerEvents: 'auto' }} />
            </PaneEdge>
          )}
        </div>
      </div>
    </div>
  );
}
