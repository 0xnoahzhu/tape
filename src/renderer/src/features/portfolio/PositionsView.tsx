// The Positions tab: one card with the toolbar line (PositionsToolbar.tsx) over the table
// (PositionsTable.tsx). It reads what the table needs beyond the rows (data.ts): the holdings'
// dividends and earnings (the event chips, and the table's earnings column: one request for both)
// and the current minute. The earnings footer says only what the chips cannot: why dates are
// missing (no Wall Street Horizon subscription, or IB did not answer), and only while a stock is held.

import { useMemo } from 'react';
import { useStore } from '../../state/store';
import type { PositionRow } from './calc';
import { useEarnings, useHoldingDividends, useHoldingUnderlyings, useMinute } from './data';
import { earningsState, nextEvents, type EarningsState } from './events';
import { usePortfolioMessages } from './messages';
import { PositionsTable } from './PositionsTable';
import { PositionsToolbar } from './PositionsToolbar';

export function PositionsView({ rows }: { rows: PositionRow[] }) {
  const m = usePortfolioMessages();
  const connected = useStore((s) => s.connection.status === 'connected');
  const now = useMinute();
  const underlyings = useHoldingUnderlyings(rows);
  const dividends = useHoldingDividends(underlyings);
  const earnings = useEarnings(underlyings);
  const events = useMemo(() => nextEvents(underlyings, dividends, earnings, new Date(now)), [underlyings, dividends, earnings, now]);

  const notes: Partial<Record<EarningsState, string>> = {
    unsubscribed: m.eventsNoteUnsubscribed,
    unavailable: m.eventsNoteUnavailable,
  };
  const stocks = [...underlyings.values()].some((c) => c.secType === 'STK');
  const note = stocks ? notes[earningsState(earnings, connected)] : undefined;

  return (
    <div
      data-pos="view"
      style={{ background: 'var(--p)', margin: 'var(--gap) var(--pad) var(--pad)', flex: '1 1 0', minHeight: 284, display: 'flex', flexDirection: 'column' }}
    >
      <PositionsToolbar rows={rows} />
      <PositionsTable rows={rows} events={events} earnings={earnings} note={note} now={now} />
    </div>
  );
}
