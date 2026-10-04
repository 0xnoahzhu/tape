import { describe, expect, it } from 'vitest';
import { defaultWatchlists } from '@shared/defaults';
import { index, stock } from '@shared/contract';
import type { Position, SymbolMatch } from '@shared/types';
import { resolveSymbol } from './resolveSymbol';

const match = (contract: SymbolMatch['contract'], description: string): SymbolMatch => ({ contract, description, derivativeSecTypes: [] });
const none = { matches: [], watchlists: [], positions: [] };

describe('resolveSymbol', () => {
  it('prefers the US stock among exact search matches', () => {
    const matches = [
      match({ ...stock('AAPL'), currency: 'MXN', exchange: 'MEXI' }, 'APPLE INC'),
      match({ ...stock('AAPL', 'NASDAQ'), conId: 265598 }, 'APPLE INC'),
      match(stock('AAPLX'), 'Other'),
    ];
    expect(resolveSymbol('AAPL', { ...none, matches })).toEqual({ contract: { ...stock('AAPL', 'NASDAQ'), conId: 265598 }, name: 'APPLE INC' });
  });

  it('keeps indices from search or watchlists', () => {
    expect(resolveSymbol('SPX', { ...none, matches: [match(index('SPX', 'CBOE'), 'S&P 500 Stock Index')] }).contract.secType).toBe('IND');
    expect(resolveSymbol('SPX', { ...none, watchlists: defaultWatchlists() })).toEqual({ contract: index('SPX', 'CBOE'), name: { en: 'S&P 500', zh: '标普 500' } });
  });

  it('falls back to positions, then to a SMART stock', () => {
    const pos = { contract: { ...stock('IBKR'), conId: 43645865 } } as Position;
    expect(resolveSymbol('IBKR', { ...none, positions: [pos] }).contract.conId).toBe(43645865);
    expect(resolveSymbol('ZZZ', none)).toEqual({ contract: stock('ZZZ') });
  });
});
