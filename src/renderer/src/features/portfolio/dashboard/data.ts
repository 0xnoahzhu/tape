// Data hooks of the dashboard widgets: the quotes they read beyond the positions' own (option
// underlyings, the holdings' dividends) and the holdings' earnings. Each hook subscribes only
// while its widget is on the layout (`active`), under its own quote owner, so the main process
// unions it with the portfolio's lines:
//   dashboard-und    option underlyings (moneyness, dollar delta) — basic
//   dashboard-div    the holdings' stocks — 'dividends' (generic tick 456, live lines only)

import { useEffect, useMemo, useState } from 'react';
import { contractKey } from '@shared/contract';
import { nyDayStart } from '@shared/session';
import type { ContractRef, CorporateEarnings, Quote, QuoteDividends } from '@shared/types';
import { useMarketDataAvailable, useQuoteSubscriptions, useQuotesByKey } from '../../../hooks/useQuotes';
import { underlyingOf, type PositionRow } from '../calc';
import { holdingUnderlyings } from './model';

const NONE: ContractRef[] = [];
const HOUR = 3_600_000;
/** How soon earnings are asked again while main's scanner is still looking dates up. */
const PENDING_POLL_MS = 3000;
const UNAVAILABLE: CorporateEarnings = { status: 'unavailable', events: [] };

/**
 * New York midnight of the current New York day (unix ms), re-checked every minute so the
 * "today" of the fills follows the day while the app runs.
 */
export function useNyDayStart(): number {
  const [start, setStart] = useState(() => nyDayStart(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setStart(nyDayStart(Date.now())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return start;
}

const isOptionRow = (r: PositionRow) => r.position.contract.secType === 'OPT' || r.position.contract.secType === 'FOP';

export function useHoldingUnderlyings(rows: readonly PositionRow[]): Map<string, ContractRef> {
  const sig = rows.map((r) => r.key).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => holdingUnderlyings(rows), [sig]);
}

/**
 * Quotes of the option positions (greeks, model underlying price; already subscribed by the
 * portfolio) and of their underlyings, which this hook subscribes while `active`.
 */
export function useOptionQuotes(rows: readonly PositionRow[], active = true): Record<string, Quote> {
  const sig = rows.map((r) => r.key).join(',');
  const { underlyings, keys } = useMemo(() => {
    const und = new Map<string, ContractRef>();
    const k = new Set<string>();
    for (const r of rows) {
      if (!isOptionRow(r)) continue;
      const own = contractKey(r.position.contract);
      k.add(own);
      const u = underlyingOf(r.position.contract);
      const uk = contractKey(u);
      // A futures option has no underlying of its own here (underlyingOf returns it).
      if (uk === own) continue;
      k.add(uk);
      und.set(uk, u);
    }
    return { underlyings: [...und.values()], keys: [...k] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useQuoteSubscriptions('dashboard-und', active ? underlyings : NONE, 'basic');
  return useQuotesByKey(keys);
}

/**
 * IB's dividend summary of the holdings' stocks by contract key, subscribed while `active`.
 * Undefined for a stock IB has sent none for (delayed lines carry none).
 */
export function useHoldingDividends(underlyings: ReadonlyMap<string, ContractRef>, active = true): Record<string, QuoteDividends | undefined> {
  const stocks = useMemo(() => [...underlyings.values()].filter((c) => c.secType === 'STK'), [underlyings]);
  const keys = useMemo(() => stocks.map(contractKey), [stocks]);
  useQuoteSubscriptions('dashboard-div', active ? stocks : NONE, 'dividends');
  const quotes = useQuotesByKey(keys);
  return useMemo(() => Object.fromEntries(keys.map((k) => [k, quotes[k]?.dividends])), [keys, quotes]);
}

/**
 * Upcoming earnings of the holdings' stocks (Wall Street Horizon, else estimated from IB's market
 * scanner), asked when the holdings or the connection change and every hour (main keeps the
 * answers for the day), every few seconds while the scanner is still looking dates up
 * (`pending`) and when a stock is due to be searched again (`retryInMs`). `unsubscribed` when IB
 * refuses both; `unavailable` while not connected.
 */
export function useEarnings(underlyings: ReadonlyMap<string, ContractRef>, active = true): CorporateEarnings | undefined {
  const available = useMarketDataAvailable();
  const stocks = useMemo(() => [...underlyings.values()].filter((c) => c.secType === 'STK'), [underlyings]);
  const sig = stocks.map(contractKey).sort().join(',');
  const [state, setState] = useState<{ sig: string; value: CorporateEarnings } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), HOUR);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || !available) return;
    let live = true;
    window.tape.getEarnings(stocks).then(
      (value) => live && setState({ sig, value }),
      () => live && setState({ sig, value: UNAVAILABLE }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, available, active, tick]);

  // Main answers at once with what the scanner knows so far; ask again until it is done, and
  // when a stock it could not search yet is due again.
  useEffect(() => {
    if (!active || !available || state?.sig !== sig) return;
    const { pending, retryInMs } = state.value;
    const delay = pending ? PENDING_POLL_MS : typeof retryInMs === 'number' && Number.isFinite(retryInMs) ? Math.max(PENDING_POLL_MS, retryInMs) : undefined;
    if (delay === undefined) return;
    const timer = setTimeout(() => setTick((t) => t + 1), delay);
    return () => clearTimeout(timer);
  }, [active, available, sig, state]);

  if (!available) return UNAVAILABLE;
  // Answers for a former set of holdings still apply to the stocks that remain.
  return state?.value;
}
