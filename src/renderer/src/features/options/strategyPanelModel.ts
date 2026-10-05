// The desk model for the floating strategy builder (features/panels). The panel lives outside
// the desk (it is drawn over the page, and its bar stays while the desk switches tabs), so it
// cannot use the desk's model (DeskFull): this hook computes the part StrategyPanel reads — the
// underlying and its quote, the chain's expiries, the ATM strike and IV, the legs' quotes — with
// quote owners of its own. The main process unions owners per contract, so lines shared with the
// desk are not doubled.

import { useEffect, useMemo } from 'react';
import { contractKey, daysToExpiry } from '@shared/contract';
import { lastPrice, useQuote, useQuoteSubscriptions, useQuotesByKey } from '../../hooks/useQuotes';
import { useStore } from '../../state/store';
import { atmIv, chainContract, nearestIndex } from './chain';
import { underlyingOf, useChain, type ChainData } from './data';
import { useDesk } from './deskStore';
import { dropUnlisted, useUnlisted } from './listing';
import { yearsToExpiry } from './math';
import type { DeskModel } from './model';
import { legContract } from './strategies';

export function useStrategyPanelModel(): DeskModel {
  const symbolRef = useStore((s) => s.symbol);
  const symKey = contractKey(symbolRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const underlying = useMemo(() => underlyingOf(symbolRef), [symKey]);
  const uKey = underlying ? contractKey(underlying) : '';
  const expiry = useDesk((s) => s.expiry);
  const legs = useDesk((s) => s.legs);
  // A new underlying starts a new strategy, as on the desk (idempotent when both run).
  const setUnderlying = useDesk((s) => s.setUnderlying);
  useEffect(() => setUnderlying(uKey), [uKey, setUnderlying]);

  const underlyingList = useMemo(() => (underlying ? [underlying] : []), [underlying]);
  useQuoteSubscriptions('strategy-panel-underlying', underlyingList, 'underlying');
  const uq = useQuote(underlying);
  const spot = lastPrice(uq);

  const rawChain = useChain(underlying);
  const unlisted = useUnlisted();
  const expiries = useMemo(() => dropUnlisted(rawChain.expiries, unlisted), [rawChain.expiries, unlisted]);
  const chain: ChainData = { ...rawChain, expiries };
  const expIndex = Math.max(0, expiries.findIndex((e) => e.expiry === expiry));
  const exp = expiries[expIndex];
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const t = exp ? yearsToExpiry(exp.expiry, minute) : 0;
  const dte = exp ? daysToExpiry(exp.expiry) : 0;
  const symbol = underlying?.symbol ?? symbolRef.symbol;

  // The ATM strike as the desk picks it (nearest to the price, else the middle of the list).
  const strikes = exp?.strikes ?? [];
  const centerIdx = strikes.length ? (spot != null ? nearestIndex(strikes, spot) : Math.floor(strikes.length / 2)) : -1;
  const centerStrike = centerIdx >= 0 ? strikes[centerIdx] : undefined;

  // ATM call and put for the implied volatility the payoff's "today" curve uses.
  const atm = useMemo(
    () => (exp && centerStrike != null && spot != null ? [chainContract(symbol, exp, centerStrike, 'C'), chainContract(symbol, exp, centerStrike, 'P')] : []),
    [exp, centerStrike, symbol, spot != null],
  );
  useQuoteSubscriptions('strategy-panel-atm', atm, 'option');
  const legSubs = useMemo(() => (underlying ? legs.filter((l) => l.right !== 'S').map((l) => legContract(l, underlying)) : []), [legs, underlying]);
  useQuoteSubscriptions('strategy-panel-legs', legSubs, 'option');

  const quoteKeys = useMemo(() => [...atm, ...legSubs].map(contractKey), [atm, legSubs]);
  const quotes = useQuotesByKey(quoteKeys);
  const chainIv = atm.length ? atmIv(quotes[contractKey(atm[0])], quotes[contractKey(atm[1])]) : undefined;
  const ivAtm = chainIv ?? (uq?.impliedVol && uq.impliedVol > 0 ? uq.impliedVol : undefined);

  return {
    underlying,
    symbol,
    uq,
    spot,
    chain,
    exp,
    expIndex,
    t,
    dte,
    rows: [],
    centerRow: 0,
    centerStrike,
    ivAtm,
    ivAtmSource: chainIv != null ? 'chain' : ivAtm != null ? 'underlying' : undefined,
    quotedRows: [],
    term: [],
    quotes,
  };
}
