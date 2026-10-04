// Turns a typed ticker into a contract, preferring what the app already knows about it.

import { stock } from '@shared/contract';
import type { ContractRef, LocalizedName, Position, SymbolMatch, Watchlist } from '@shared/types';

export interface KnownInstruments {
  /** Search results for exactly this symbol (may be empty). */
  matches: SymbolMatch[];
  watchlists: Watchlist[];
  positions: Position[];
}

export interface ResolvedSymbol {
  contract: ContractRef;
  name?: LocalizedName;
}

/**
 * Order of preference: an exact IB search match (US stock, then index, then anything),
 * a watchlist entry (keeps indices such as SPX as indices), a held stock, else a SMART/USD stock.
 */
export function resolveSymbol(symbol: string, known: KnownInstruments): ResolvedSymbol {
  const exact = known.matches.filter((m) => m.contract.symbol.toUpperCase() === symbol);
  const rank = (m: SymbolMatch) => (m.contract.secType === 'STK' ? (m.contract.currency === 'USD' ? 0 : 2) : m.contract.secType === 'IND' ? 1 : 3);
  const best = exact.slice().sort((a, b) => rank(a) - rank(b))[0];
  if (best) return { contract: best.contract, name: best.description || undefined };

  for (const list of known.watchlists) {
    for (const group of list.groups) {
      const item = group.items.find((i) => i.contract.symbol.toUpperCase() === symbol);
      if (item) return { contract: item.contract, name: item.name };
    }
  }

  const held = known.positions.find((p) => p.contract.secType === 'STK' && p.contract.symbol.toUpperCase() === symbol);
  if (held) return { contract: held.contract };

  return { contract: stock(symbol) };
}
