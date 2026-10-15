// Data hooks of the Positions tab beyond the position rows: the current minute and what the tab
// reads besides the rows (PositionsView.tsx): the holdings' dividends and earnings (the event chips,
// and the earnings column). The dividends line subscribes while the tab is mounted, under its own
// quote owner, so the main process unions it with the portfolio's lines (both background):
//   positions-div    the holdings' stocks — 'dividends' (generic tick 456, live lines only)

import { useEffect, useMemo, useState } from 'react';
import { contractKey } from '@shared/contract';
import type { ContractRef, CorporateEarnings, QuoteDividends } from '@shared/types';
import { useMarketDataAvailable, useQuoteSubscriptions, useQuotesByKey } from '../../hooks/useQuotes';
import type { PositionRow } from './calc';
import { holdingUnderlyings } from './events';

const HOUR = 3_600_000;
const UNAVAILABLE: CorporateEarnings = { status: 'unavailable', events: [] };

/** Unix ms of the current minute, so days to expiry, the event window and today's hours follow the clock. */
export function useMinute(): number {
  const [t, setT] = useState(() => Date.now() - (Date.now() % 60_000));
  useEffect(() => {
    const id = setInterval(() => setT(Date.now() - (Date.now() % 60_000)), 15_000);
    return () => clearInterval(id);
  }, []);
  return t;
}

/** The holdings' underlyings by contract key (events.ts → holdingUnderlyings), kept while the positions are. */
export function useHoldingUnderlyings(rows: readonly PositionRow[]): Map<string, ContractRef> {
  const sig = rows.map((r) => r.key).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => holdingUnderlyings(rows), [sig]);
}

/**
 * IB's dividend summary of the holdings' stocks by contract key ('positions-div'). Undefined for a
 * stock IB has sent none for (delayed lines carry none).
 */
export function useHoldingDividends(underlyings: ReadonlyMap<string, ContractRef>): Record<string, QuoteDividends | undefined> {
  const stocks = useMemo(() => [...underlyings.values()].filter((c) => c.secType === 'STK'), [underlyings]);
  const keys = useMemo(() => stocks.map(contractKey), [stocks]);
  useQuoteSubscriptions('positions-div', stocks, 'dividends');
  const quotes = useQuotesByKey(keys);
  return useMemo(() => Object.fromEntries(keys.map((k) => [k, quotes[k]?.dividends])), [keys, quotes]);
}

/**
 * Upcoming earnings of the holdings' stocks (Wall Street Horizon), asked when the holdings or the
 * connection change and every hour (main keeps the answers for the day). `unsubscribed` when IB
 * refuses WSH; `unavailable` while not connected.
 */
export function useEarnings(underlyings: ReadonlyMap<string, ContractRef>): CorporateEarnings | undefined {
  const available = useMarketDataAvailable();
  const stocks = useMemo(() => [...underlyings.values()].filter((c) => c.secType === 'STK'), [underlyings]);
  const sig = stocks.map(contractKey).sort().join(',');
  const [state, setState] = useState<{ sig: string; value: CorporateEarnings } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), HOUR);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!available) return;
    let live = true;
    window.tape.getEarnings(stocks).then(
      (value) => live && setState({ sig, value }),
      () => live && setState({ sig, value: UNAVAILABLE }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, available, tick]);

  if (!available) return UNAVAILABLE;
  // Answers for a former set of holdings still apply to the stocks that remain.
  return state?.value;
}
