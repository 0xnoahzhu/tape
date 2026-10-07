// The Positions tab: one card with the toolbar line (PositionsToolbar.tsx) over the table
// (PositionsTable.tsx). It reads what both need beyond the rows (data.ts): the options'
// underlyings' quotes (the option lines and the portfolio greeks), the holdings' dividends and
// earnings (the event chips, and the table's earnings columns: one request for both) and the
// current minute. The earnings footer says only what the chips cannot: why dates are missing or
// still coming, and only while a stock is held.

import { useMemo } from 'react';
import { useStore } from '../../state/store';
import type { PositionRow } from './calc';
import { usePositionColumns } from './columnStore';
import { useEarnings, useHoldingDividends, useHoldingUnderlyings, useMinute, useUnderlyingQuotes } from './data';
import { earningsState, nextEvents, type EarningsState } from './events';
import { portfolioGreeks } from './exposure';
import { topShare } from './groups';
import { usePortfolioMessages } from './messages';
import { PositionsTable } from './PositionsTable';
import { PositionsToolbar } from './PositionsToolbar';

export function PositionsView({ rows }: { rows: PositionRow[] }) {
  const m = usePortfolioMessages();
  const connected = useStore((s) => s.connection.status === 'connected');
  const groupBy = usePositionColumns((s) => s.groupBy);
  const now = useMinute();
  const quotes = useUnderlyingQuotes(rows);
  const greeks = useMemo(() => portfolioGreeks(rows, quotes), [rows, quotes]);
  const underlyings = useHoldingUnderlyings(rows);
  const dividends = useHoldingDividends(underlyings);
  const earnings = useEarnings(underlyings);
  const events = useMemo(() => nextEvents(underlyings, dividends, earnings, new Date(now)), [underlyings, dividends, earnings, now]);
  const top = useMemo(() => topShare(rows, groupBy), [rows, groupBy]);

  // The source is picked automatically (WSH, else the scanner; "Est." marks scanner dates), so the
  // note only says why earnings dates are missing or still coming.
  const notes: Partial<Record<EarningsState, string>> = {
    searching: m.eventsNoteSearching,
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
      <PositionsToolbar rows={rows} greeks={greeks} top={top} groupBy={groupBy} />
      <PositionsTable rows={rows} optionQuotes={quotes} events={events} earnings={earnings} note={note} now={now} />
    </div>
  );
}
