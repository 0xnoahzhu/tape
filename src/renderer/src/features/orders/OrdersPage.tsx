// Orders page (design "pgOrd"): working orders and today's trades.

import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { TabItems } from '../../ui/primitives';
import { useOrdersMessages } from './messages';
import { newestExecutions, workingOrders } from './model';
import { TradesTable } from './TradesTable';
import { WorkingTable } from './WorkingTable';

type OrdersTab = 'work' | 'fill';

// The page remounts on every visit; remember the last tab for the session.
let lastTab: OrdersTab = 'work';

/** Opens the Orders page on today's trades (the dashboard's "All ›"). */
export function showOrderTrades(): void {
  lastTab = 'fill';
  useStore.getState().setPage('ord');
}

export function OrdersPage() {
  const m = useOrdersMessages();
  const orders = useStore((s) => s.orders);
  const executions = useStore((s) => s.executions);
  const [tab, setTab] = useState<OrdersTab>(lastTab);
  const working = useMemo(() => workingOrders(orders), [orders]);
  const trades = useMemo(() => newestExecutions(executions), [executions]);

  const pick = (k: OrdersTab) => {
    lastTab = k;
    setTab(k);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 'var(--pad)', background: 'var(--gbg)' }}>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--p)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 60, display: 'flex', alignItems: 'stretch', gap: 28, padding: '0 32px', boxShadow: 'inset 0 -1px 0 var(--ln2)', flexShrink: 0 }}>
          <TabItems
            tabs={[
              { key: 'work', label: `${m.orders} ${working.length}` },
              { key: 'fill', label: `${m.trades} ${trades.length}` },
            ]}
            value={tab}
            onChange={pick}
          />
          <div style={{ flex: 1 }} />
        </div>
        {tab === 'work' ? <WorkingTable orders={working} /> : <TradesTable executions={trades} />}
      </div>
    </div>
  );
}
