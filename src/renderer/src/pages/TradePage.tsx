// Trade page layout (design 3a): watchlist | view tabs + view content.
// Chart and depth views share the same grid: content top-left, the symbol's
// positions/orders bottom-left (150px) and the order ticket on the right (340px).

import { createMessages } from '../i18n';
import { useStore, type TradeView } from '../state/store';
import { TabItems } from '../ui/primitives';
import { WatchlistPanel } from '../features/watchlist/WatchlistPanel';
import { ChartView } from '../features/chart/ChartView';
import { DepthView } from '../features/chart/DepthView';
import { SymbolActivityPanel } from '../features/chart/SymbolActivityPanel';
import { OrderTicket } from '../features/ticket/OrderTicket';
import { OptionsDesk } from '../features/options/OptionsDesk';
import { ErrorBoundary } from '../ui/ErrorBoundary';

const useM = createMessages({
  en: { chart: 'Chart', options: 'Options', depth: 'Depth' },
  zh: { chart: '图表', options: '期权', depth: '盘口' },
});

export function TradePage() {
  const m = useM();
  const collapsed = useStore((s) => s.watchlistCollapsed);
  const features = useStore((s) => s.settings.features);
  const rawView = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

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
      {view === 'opt' ? (
        <div style={{ gridColumn: 2, gridRow: 2, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ErrorBoundary name="Options" style={{ flex: 1 }}>
            <OptionsDesk mode="full" />
          </ErrorBoundary>
        </div>
      ) : (
        <div
          style={{
            gridColumn: 2,
            gridRow: 2,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) 340px',
            gridTemplateRows: 'minmax(0,1fr) 150px',
            gap: 'var(--gap)',
            background: 'var(--gbg)',
          }}
        >
          <ErrorBoundary name={view === 'depth' ? 'Depth' : 'Chart'}>{view === 'depth' ? <DepthView /> : <ChartView />}</ErrorBoundary>
          <ErrorBoundary name="Positions">
            <SymbolActivityPanel />
          </ErrorBoundary>
          <ErrorBoundary name="Order ticket" style={{ gridColumn: 2, gridRow: '1 / 3' }}>
            <OrderTicket />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
