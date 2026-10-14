import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import type { ContractRef, OrderRequest, Position, Quote } from '@shared/types';
import { accountPosition, accountRiskContext, marketDataOf, orderRisks, rateTo, strategyRisks, worseData, type RiskContext } from './orderRisk';

const AAPL = stock('AAPL');
const EURUSD: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };
const ES: ContractRef = { symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 50 };
const order = (patch: Partial<OrderRequest> = {}): OrderRequest => ({ contract: AAPL, action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 227.49, tif: 'DAY', outsideRth: false, ...patch });
const ctx = (patch: Partial<RiskContext> = {}): RiskContext => ({ position: 0, bid: 227.48, ask: 227.49, last: 227.5, netLiq: 1_000_000, buyingPower: 2_000_000, accountCurrency: 'USD', rate: 1, marketData: 'live', ...patch });
const kinds = (req: OrderRequest, est: number | undefined, c: RiskContext) => orderRisks(req, est, c).map((r) => r.kind);

describe('market data quality', () => {
  const q = (p: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...p });

  it('follows IB’s market data type, and is none without a price', () => {
    expect(marketDataOf(q({ bid: 1, ask: 1.1, marketDataType: 1 }))).toBe('live');
    // Not reported (yet): the quote counts as live, as the chart does.
    expect(marketDataOf(q({ last: 1 }))).toBe('live');
    expect(marketDataOf(q({ last: 1, marketDataType: 2 }))).toBe('frozen');
    expect(marketDataOf(q({ last: 1, marketDataType: 3 }))).toBe('delayed');
    expect(marketDataOf(q({ last: 1, marketDataType: 4 }))).toBe('delayed');
    // Only yesterday's close is no market at all.
    expect(marketDataOf(q({ close: 1, marketDataType: 1 }))).toBe('none');
    expect(marketDataOf(undefined)).toBe('none');
  });

  it('a combo is as current as its stalest leg', () => {
    expect(worseData('live', 'delayed')).toBe('delayed');
    expect(worseData('frozen', 'delayed')).toBe('frozen');
    expect(worseData('none', 'live')).toBe('none');
  });
});

describe('orderRisks', () => {
  it('finds nothing in an ordinary order', () => {
    expect(orderRisks(order(), 22_749, ctx())).toEqual([]);
  });

  it('a sell without a position opens a short; with one held short it adds to it', () => {
    expect(orderRisks(order({ action: 'SELL', limitPrice: 227.48 }), 22_748, ctx())).toEqual([{ kind: 'opensShort', before: 0, after: -100 }]);
    expect(kinds(order({ action: 'SELL', limitPrice: 227.48 }), 22_748, ctx({ position: -50 }))).toEqual(['opensShort']);
    // Selling what is held is closing it.
    expect(kinds(order({ action: 'SELL', limitPrice: 227.48 }), 22_748, ctx({ position: 100 }))).toEqual([]);
    // Buying never opens a short (options bought to open included).
    expect(kinds(order({ contract: option('AAPL', '20261016', 230, 'C'), limitPrice: 4.2 }), 42_000, ctx({ bid: 4.1, ask: 4.2 }))).toEqual([]);
  });

  it('a position that turns from long to short, or short to long', () => {
    expect(orderRisks(order({ action: 'SELL', quantity: 500, limitPrice: 227.48 }), 113_740, ctx({ position: 100 }))).toEqual([{ kind: 'flips', before: 100, after: -400 }]);
    expect(orderRisks(order({ quantity: 300 }), 68_247, ctx({ position: -100 }))).toEqual([{ kind: 'flips', before: -100, after: 200 }]);
  });

  it('a modify counts the position only when its quantity grows, and what has filled is in the position already', () => {
    const sell = order({ action: 'SELL', quantity: 100, limitPrice: 227.48 });
    expect(kinds(sell, 22_748, ctx({ modified: { quantity: 100, filled: 0 } }))).toEqual([]);
    expect(orderRisks({ ...sell, quantity: 150 }, 34_122, ctx({ position: -30, modified: { quantity: 100, filled: 30 } }))).toEqual([{ kind: 'opensShort', before: -30, after: -150 }]);
  });

  it('an order worth more than a quarter of net liquidation, in the account currency', () => {
    expect(orderRisks(order(), 300_000, ctx())).toEqual([{ kind: 'largeNotional', amount: 300_000, netLiq: 1_000_000, currency: 'USD' }]);
    expect(kinds(order(), 250_000, ctx())).toEqual([]);
    // A EUR order on a USD account converts; without a rate nothing is compared, and the review says so.
    const sap = order({ contract: { ...stock('SAP'), currency: 'EUR' } });
    expect(orderRisks(sap, 240_000, ctx({ rate: 1.1 }))).toEqual([{ kind: 'largeNotional', amount: 264_000, netLiq: 1_000_000, currency: 'USD' }]);
    expect(orderRisks(sap, 240_000, ctx({ rate: undefined }))).toEqual([{ kind: 'unchecked', missing: ['rate'], currency: 'EUR', accountCurrency: 'USD' }]);
  });

  it('says which checks could not run: positions not listed yet, no account values', () => {
    // Right after a switch: neither the positions nor the summary of the new account are in.
    const early = ctx({ positionsKnown: false, netLiq: undefined, buyingPower: undefined, accountCurrency: undefined, rate: undefined });
    expect(orderRisks(order({ quantity: 300 }), 68_247, early)).toEqual([{ kind: 'unchecked', missing: ['positions', 'account'] }]);
    // The positions alone: a 0 would only mean "not listed yet", so nothing is compared with it.
    expect(orderRisks(order({ action: 'SELL', limitPrice: 227.48 }), 22_748, ctx({ positionsKnown: false }))).toEqual([{ kind: 'unchecked', missing: ['positions'] }]);
    // Listed: the short covered and turned long is found again.
    expect(kinds(order({ quantity: 300 }), 68_247, ctx({ position: -100, positionsKnown: true }))).toEqual(['flips']);
    // A forex order compares no position; one without an amount has no size to check.
    expect(kinds(order({ contract: EURUSD, limitPrice: 1.08 }), 108, ctx({ positionsKnown: false }))).toEqual([]);
    expect(kinds(order({ orderType: 'MKT', limitPrice: undefined }), undefined, ctx({ netLiq: undefined, buyingPower: undefined }))).toEqual([]);
  });

  it('what the order opens beyond the buying power; closing needs none', () => {
    expect(orderRisks(order(), 22_749, ctx({ buyingPower: 10_000, netLiq: 100_000 }))).toEqual([{ kind: 'overBuyingPower', amount: 22_749, buyingPower: 10_000, currency: 'USD' }]);
    // Covering a short of 100 opens nothing.
    expect(kinds(order(), 22_749, ctx({ position: -100, buyingPower: 0, netLiq: 100_000 }))).toEqual([]);
    // A short sale of stock needs it; a written option's premium says nothing about its margin.
    expect(kinds(order({ action: 'SELL', limitPrice: 227.48 }), 22_748, ctx({ position: 0, buyingPower: 10_000, netLiq: 100_000 }))).toEqual(['opensShort', 'overBuyingPower']);
    const call = order({ contract: option('AAPL', '20261016', 230, 'C'), action: 'SELL', quantity: 1, limitPrice: 4.1 });
    expect(kinds(call, 410, ctx({ bid: 4.1, ask: 4.2, buyingPower: 0, netLiq: 100_000 }))).toEqual(['opensShort']);
  });

  it('a future ties up its margin, not its notional: no buying power row, the size against net liquidation stays', () => {
    // 1 ES at 6,000 × 50 is worth $300,000 and needs about $20,000 of margin (IB's what-if shows it).
    const es = order({ contract: ES, quantity: 1, limitPrice: 6_000 });
    expect(orderRisks(es, 300_000, ctx({ bid: 5_999.75, ask: 6_000, netLiq: 150_000, buyingPower: 150_000 }))).toEqual([
      { kind: 'largeNotional', amount: 300_000, netLiq: 150_000, currency: 'USD' },
    ]);
  });

  it('a forex order sized by an amount: the whole amount is checked', () => {
    const cash = order({ contract: EURUSD, orderType: 'MKT', limitPrice: undefined, quantity: 0, cashQty: 500_000 });
    expect(orderRisks(cash, 500_000, ctx({ netLiq: 50_000, buyingPower: 200_000 }))).toEqual([
      { kind: 'largeNotional', amount: 500_000, netLiq: 50_000, currency: 'USD' },
      { kind: 'overBuyingPower', amount: 500_000, buyingPower: 200_000, currency: 'USD' },
    ]);
    expect(kinds(cash, 20_000, ctx({ netLiq: 1_000_000, buyingPower: 200_000 }))).toEqual([]);
  });

  it('a limit far through the market: 5% past the ask or bid, 20% for options, the last price when the side is missing', () => {
    expect(orderRisks(order({ limitPrice: 240 }), 24_000, ctx())).toEqual([{ kind: 'farThroughMarket', side: 'BUY', limit: 240, market: 227.49, ref: 'ask', pct: expect.closeTo(5.5, 1) }]);
    expect(kinds(order({ limitPrice: 238 }), 23_800, ctx())).toEqual([]);
    expect(kinds(order({ action: 'SELL', limitPrice: 215 }), 21_500, ctx({ position: 100 }))).toEqual(['farThroughMarket']);
    expect(orderRisks(order({ limitPrice: 240 }), 24_000, ctx({ ask: undefined }))[0]).toMatchObject({ ref: 'last', market: 227.5 });
    // A passive limit (below the ask for a buy) is not through the market.
    expect(kinds(order({ limitPrice: 200 }), 20_000, ctx())).toEqual([]);
    const call = option('AAPL', '20261016', 230, 'C');
    expect(kinds(order({ contract: call, quantity: 1, limitPrice: 4.9 }), 490, ctx({ bid: 4.1, ask: 4.2 }))).toEqual([]);
    expect(kinds(order({ contract: call, quantity: 1, limitPrice: 5.1 }), 510, ctx({ bid: 4.1, ask: 4.2 }))).toEqual(['farThroughMarket']);
    // Stops trigger beyond the market on purpose.
    expect(kinds(order({ orderType: 'STP', limitPrice: undefined, stopPrice: 240 }), 24_000, ctx())).toEqual([]);
  });

  it('a market order, or a price taken from the bid / ask, on prices that are not live', () => {
    expect(orderRisks(order({ orderType: 'MKT', limitPrice: undefined }), 22_749, ctx({ marketData: 'delayed' }))).toEqual([{ kind: 'marketOnStaleData', data: 'delayed', market: true }]);
    expect(orderRisks(order(), 22_749, ctx({ marketData: 'frozen', priceFromQuote: true }))).toEqual([{ kind: 'marketOnStaleData', data: 'frozen', market: false }]);
    // A typed limit on delayed data is the user's price: the review shows the data row only.
    expect(kinds(order(), 22_749, ctx({ marketData: 'delayed' }))).toEqual([]);
    expect(kinds(order({ orderType: 'MKT', limitPrice: undefined }), 22_749, ctx())).toEqual([]);
  });
});

describe('strategyRisks', () => {
  const base = { netLiq: 10_000, buyingPower: 1_000, accountCurrency: 'USD', rate: 1, marketData: 'live' as const };

  it('a combo’s size against the account, the buying power for a debit only', () => {
    expect(strategyRisks(false, 140, base)).toEqual([]);
    expect(strategyRisks(false, 3_000, base).map((r) => r.kind)).toEqual(['largeNotional', 'overBuyingPower']);
    // A credit is received.
    expect(strategyRisks(false, -3_000, base).map((r) => r.kind)).toEqual(['largeNotional']);
  });

  it('says when the size could not be checked', () => {
    expect(strategyRisks(false, 140, { ...base, netLiq: undefined, buyingPower: undefined, accountCurrency: undefined, rate: undefined }, 'USD')).toEqual([
      { kind: 'unchecked', missing: ['account'] },
    ]);
    expect(strategyRisks(false, -140, { ...base, rate: undefined }, 'EUR')).toEqual([{ kind: 'unchecked', missing: ['rate'], currency: 'EUR', accountCurrency: 'USD' }]);
    // No price: no amount to check.
    expect(strategyRisks(false, undefined, { ...base, netLiq: undefined, buyingPower: undefined })).toEqual([]);
  });

  it('a net price from legs that are not live', () => {
    expect(strategyRisks(true, 140, { ...base, marketData: 'delayed' })).toEqual([{ kind: 'marketOnStaleData', data: 'delayed', market: true }]);
    expect(strategyRisks(false, 140, { ...base, marketData: 'none' })).toEqual([{ kind: 'marketOnStaleData', data: 'none', market: false }]);
  });
});

describe('the account side', () => {
  const pos = (account: string, quantity: number, contract = AAPL): Position => ({ account, key: account, contract, quantity, avgPrice: 1, multiplier: 1, updatedAt: 0 });

  it('reads the connected account’s position and values only', () => {
    const s = {
      connection: { account: 'U1' } as never,
      positions: [pos('U1', 100), pos('U1', 50), pos('U2', -500), pos('U1', 3, stock('MSFT'))],
      positionsLoaded: true,
      account: { account: 'U1', currency: 'USD', netLiquidation: 50_000, buyingPower: 80_000, updatedAt: 0 },
    };
    expect(accountRiskContext(s, AAPL)).toEqual({ position: 150, positionsKnown: true, netLiq: 50_000, buyingPower: 80_000, accountCurrency: 'USD', rate: 1 });
    // Before IB has listed the positions, the 150 may be incomplete.
    expect(accountRiskContext({ ...s, positionsLoaded: false }, AAPL)).toMatchObject({ positionsKnown: false });
    // Another account's summary (not yet replaced) is not this one's.
    expect(accountRiskContext({ ...s, account: { ...s.account, account: 'U2' } }, AAPL)).toMatchObject({ position: 150, netLiq: undefined, rate: undefined });
  });

  it('checks a modify against the modified order’s account, not the connected one', () => {
    const s = {
      connection: { account: 'U1' } as never,
      positions: [pos('U1', 100), pos('U2', 3)],
      positionsLoaded: true,
      account: { account: 'U1', currency: 'USD', netLiquidation: 50_000, buyingPower: 80_000, updatedAt: 0 },
    };
    expect(accountPosition(s, AAPL, 'U2')).toBe(3);
    // U1's position and summary are not U2's: they are left out rather than checked against the wrong
    // account (Tape lists the connected account's positions only, so U2's counts as not known).
    expect(accountRiskContext(s, AAPL, 'U2')).toEqual({ position: 3, positionsKnown: false, netLiq: undefined, buyingPower: undefined, accountCurrency: undefined, rate: undefined });
    expect(accountRiskContext(s, AAPL, 'U1')).toMatchObject({ position: 100, positionsKnown: true, netLiq: 50_000 });
  });

  it('converts with IB’s rates', () => {
    const acct = { currency: 'USD', exchangeRates: { EUR: 1.08 } };
    expect(rateTo('USD', acct)).toBe(1);
    expect(rateTo('EUR', acct)).toBe(1.08);
    expect(rateTo('JPY', acct)).toBeUndefined();
    expect(rateTo('USD', null)).toBeUndefined();
  });
});
