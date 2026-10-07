// Trade page layout (design 3a): watchlist | view tabs + view content.
// The two views, Chart and Options (tradeViews.ts), share one grid: the view top-left and the
// symbol's positions / open orders under it (SymbolActivityPanel: 150px by default; a splitter
// resizes it and it collapses to a bar like the watchlist, one height and one collapse state for
// both views). On Chart the order ticket takes the right column (340px), with Level 2 as its Book.
// With the ticket floating (features/panels) the right column goes and the chart and the
// positions / orders take the full width; the options desk always does.

import { useRef, useState } from 'react';
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
import { loadFlag, saveFlag } from '../ui/splitGeometry';
import { PopOutButton } from '../features/panels/chrome';
import { isFloating, usePanels } from '../features/panels/panelStore';
import { TRADE_VIEWS } from './tradeViews';

const useM = createMessages({
  en: { chart: 'Chart', options: 'Options' },
  zh: { chart: '图表', options: '期权' },
});

/** Width of the collapsed watchlist's handle (WatchlistPanel). */
const HANDLE_GUTTER = 26;

/** Positions / orders under the view: default height, smallest (header and one row) and the chart's minimum. */
const ACTIVITY = { key: 'tape.trade.activityHeight', collapsedKey: 'tape.trade.activityCollapsed', fallback: 150, min: 76, minAbove: 200 };
/** Under the options desk: its header and tabs (about 120px) and a usable chain stay above the panel. */
const DESK = { ...ACTIVITY, minAbove: 320 };
/** Dragging the splitter this far below the minimum collapses the panel. */
const COLLAPSE_SLACK = 36;

export function TradePage() {
  const m = useM();
  const collapsed = useStore((s) => s.watchlistCollapsed);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const ticketFloating = usePanels(isFloating('ticket'));
  const cm = useChartMessages();
  const options = view === 'opt';
  // The ticket trades on Chart only; the options desk has its strategy builder.
  const ticketDocked = !options && !ticketFloating;

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

  const labels: Record<TradeView, string> = { chart: m.chart, opt: m.options };
  const tabs = TRADE_VIEWS.map((key) => ({ key, label: labels[key] }));

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: `${collapsed ? '0px' : '272px'} minmax(0,1fr)`,
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
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: ticketDocked ? 'minmax(0,1fr) 340px' : 'minmax(0,1fr)',
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
              <Splitter height={split.height} min={ACTIVITY.min} max={split.max} onChange={onSplit} onReset={split.reset} title={cm.resizePanel} />
            )}
          </div>
          {ticketDocked && (
            <ErrorBoundary name="Order ticket" style={{ gridColumn: 2, gridRow: '1 / 3' }}>
              <OrderTicket actions={<PopOutButton id="ticket" />} />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
