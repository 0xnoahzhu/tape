import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { ContractRef, Position, WorkingOrder } from '@shared/types';
import type { SentOrder } from '../../state/orderFeedback';
import { byInstrument, FRESH_MS, isFreshOrder } from './activityModel';

const position = (contract: ContractRef): Position => ({ account: 'DU1', key: contractKey(contract), contract, quantity: 1, avgPrice: 1, multiplier: 1, updatedAt: 0 });

describe('the activity panel’s position order', () => {
  it('puts the stock first, then the options by expiry, strike and right (calls first)', () => {
    const dec = option('AAPL', '20261218', 230, 'C');
    const oct230p = option('AAPL', '20261016', 230, 'P');
    const oct230c = option('AAPL', '20261016', 230, 'C');
    const oct250c = option('AAPL', '20261016', 250, 'C');
    const sorted = [dec, oct250c, oct230p, stock('AAPL'), oct230c].map(position).sort(byInstrument);
    // By label "Dec" would come before "Oct".
    expect(sorted.map((p) => p.contract)).toEqual([stock('AAPL'), oct230c, oct230p, oct250c, dec]);
  });

  it('puts other instruments after the options, by label', () => {
    const fut = (m: string): ContractRef => ({ secType: 'FUT', symbol: 'AAPL', lastTradeDate: m, localSymbol: `AAPL ${m}`, exchange: 'ONE', currency: 'USD' });
    const call = option('AAPL', '20261016', 230, 'C');
    const sorted = [fut('20261218'), call, fut('20261120')].map(position).sort(byInstrument);
    expect(sorted[0].contract).toEqual(call);
    expect(sorted.map((p) => p.contract.secType)).toEqual(['OPT', 'FUT', 'FUT']);
  });
});

describe('the new order’s flash', () => {
  const order = (over: Partial<WorkingOrder> = {}): WorkingOrder => ({
    orderId: 12,
    clientId: 7,
    key: '7:12',
    contract: stock('AAPL'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 100,
    limitPrice: 10,
    tif: 'DAY',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 100,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });
  const sent = (over: Partial<SentOrder> = {}): SentOrder => ({
    seq: 1,
    kind: 'place',
    phase: 'sent',
    summary: 'Buy 100 AAPL',
    side: 'BUY',
    quantity: 100,
    contractKey: 'STK:AAPL',
    positionBefore: 0,
    orderId: 12,
    clientId: 7,
    acceptedAt: 1_000,
    ...over,
  });

  it('flashes the order a floating panel just placed, for 15 s after IB accepted it', () => {
    expect(FRESH_MS).toBe(15_000);
    expect(isFreshOrder(order(), sent(), 1_000 + 5_000)).toBe(true);
    expect(isFreshOrder(order(), sent(), 1_000 + FRESH_MS)).toBe(false);
  });

  it('does not flash a modify, another order or client, an order still sending, or without a panel’s order', () => {
    expect(isFreshOrder(order(), sent({ kind: 'modify' }), 2_000)).toBe(false);
    expect(isFreshOrder(order({ orderId: 13 }), sent(), 2_000)).toBe(false);
    expect(isFreshOrder(order({ clientId: 0 }), sent(), 2_000)).toBe(false);
    expect(isFreshOrder(order(), sent({ phase: 'sending', acceptedAt: undefined }), 2_000)).toBe(false);
    expect(isFreshOrder(order(), undefined, 2_000)).toBe(false);
  });
});
