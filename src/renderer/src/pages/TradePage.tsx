// Trade page layout (design 3a): watchlist | view tabs + view content.
// Chart and depth views share the same grid: content top-left, the symbol's
// positions/orders bottom-left (150px by default; a splitter resizes it and it collapses to a
// bar like the watchlist) and the order ticket on the right (340px).
// With the ticket floating (features/panels) the right column goes and the view and the
// positions/orders take the full width.

import { useRef, useState } from 'react';
import { createMessages } from '../i18n';
import { useStore, type TradeView } from '../state/store';
import { TabItems } from '../ui/primitives';
import { WatchlistPanel } from '../features/watchlist/WatchlistPanel';
import { ChartView } from '../features/chart/ChartView';
import { DepthView } from '../features/chart/DepthView';
import { ACTIVITY_BAR_H, SymbolActivityBar, SymbolActivityPanel } from '../features/chart/SymbolActivityPanel';
import { useChartMessages } from '../features/chart/messages';
import { OrderTicket } from '../features/ticket/OrderTicket';
import { OptionsDesk } from '../features/options/OptionsDesk';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Splitter, useSplitHeight } from '../ui/Splitter';
import { loadFlag, saveFlag } from '../ui/splitGeometry';
import { PopOutButton } from '../features/panels/chrome';
import { isFloating, usePanels } from '../features/panels/panelStore';

const useM = createMessages({
  en: { chart: 'Chart', options: 'Options', depth: 'Depth' },
  zh: { chart: '图表', options: '期权', depth: '盘口' },
});

/** Width of the collapsed watchlist's handle (WatchlistPanel). */
const HANDLE_GUTTER = 26;

/** Positions / orders under the chart: default height, smallest (header and one row) and the chart's minimum. */
const ACTIVITY = { key: 'tape.trade.activityHeight', collapsedKey: 'tape.trade.activityCollapsed', fallback: 150, min: 76, minAbove: 200 };
/** Dragging the splitter this far below the minimum collapses the panel. */
const COLLAPSE_SLACK = 36;

export function TradePage() {
  const m = useM();
  const collapsed = useStore((s) => s.watchlistCollapsed);
  const features = useStore((s) => s.settings.features);
  const rawView = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const ticketFloating = usePanels(isFloating('ticket'));
  const cm = useChartMessages();

  // Positions / orders under the chart: resizable with the splitter, collapsible to a bar.
  const viewGrid = useRef<HTMLDivElement>(null);
  const split = useSplitHeight(ACTIVITY.key, ACTIVITY.fallback, ACTIVITY, viewGrid);
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

  // Views whose feature is switched off fall back to the chart.
  const view: TradeView = (rawView === 'opt' && !features.options) || (rawView === 'depth' && !features.depth) ? 'chart' : rawView;
  const tabs: Array<{ key: TradeView; label: string }> = [
    { key: 'chart', label: m.chart },
    ...(features.options ? [{ key: 'opt' as const, label: m.options }] : []),
    ...(features.depth ? [{ key: 'depth' as const, label: m.depth }] : []),
  ];

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
        {view === 'opt' ? (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ErrorBoundary name="Options" style={{ flex: 1 }}>
              <OptionsDesk mode="full" />
            </ErrorBoundary>
          </div>
        ) : (
          <div
            ref={viewGrid}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'grid',
              gridTemplateColumns: ticketFloating ? 'minmax(0,1fr)' : 'minmax(0,1fr) 340px',
              gridTemplateRows: `minmax(0,1fr) ${activityCollapsed ? ACTIVITY_BAR_H : split.height}px`,
              gap: 'var(--gap)',
              background: 'var(--gbg)',
            }}
          >
            <ErrorBoundary name={view === 'depth' ? 'Depth' : 'Chart'}>{view === 'depth' ? <DepthView /> : <ChartView />}</ErrorBoundary>
            {/* One explicit cell for the panel and the splitter on its top edge (an ErrorBoundary's style
                only applies to its fallback, so it cannot place the panel itself). */}
            <div style={{ gridColumn: 1, gridRow: 2, position: 'relative', minWidth: 0, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0,1fr)' }}>
              <ErrorBoundary name="Positions">
                {activityCollapsed ? (
                  <SymbolActivityBar onExpand={() => setActivityCollapsed(false)} />
                ) : (
                  <SymbolActivityPanel onCollapse={() => setActivityCollapsed(true)} />
                )}
              </ErrorBoundary>
              {!activityCollapsed && (
                <Splitter height={split.height} min={ACTIVITY.min} max={split.max} onChange={onSplit} onReset={split.reset} title={cm.resizePanel} />
              )}
            </div>
            {!ticketFloating && (
              <ErrorBoundary name="Order ticket" style={{ gridColumn: 2, gridRow: '1 / 3' }}>
                <OrderTicket actions={<PopOutButton id="ticket" />} />
              </ErrorBoundary>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
