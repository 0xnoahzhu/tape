import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { ContractRef, Quote, WorkingOrder } from '@shared/types';
import { distanceFromLast, distanceText, lastCellTitle, lastPriceText, orderLastPrice, orderQuoteContract, orderQuoteContracts, orderReferencePrice } from './lastPrice';
import { useOrdersMessages } from './messages';

const en = useOrdersMessages.for('en');
const zh = useOrdersMessages.for('zh');

function order(p: Partial<WorkingOrder> = {}): WorkingOrder {
  return {
    orderId: 4008,
    clientId: 151,
    key: 'STK:AAPL',
    contract: stock('AAPL'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 100,
    limitPrice: 226.5,
    tif: 'DAY',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 100,
    avgFillPrice: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...p,
  };
}

const quote = (p: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...p }) as Quote;

const call = option('AAPL', '20261016', 230, 'C');
const combo: ContractRef = {
  symbol: 'AAPL',
  secType: 'BAG',
  exchange: 'SMART',
  currency: 'USD',
  comboLegs: [
    { conId: 1001, ratio: 1, action: 'BUY', exchange: 'SMART' },
    { conId: 1002, ratio: 1, action: 'SELL', exchange: 'SMART' },
  ],
};
const eurusd: ContractRef = { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' };

describe('orderQuoteContract', () => {
  it('quotes the order’s own instrument', () => {
    expect(orderQuoteContract(stock('AAPL'))).toEqual(stock('AAPL'));
    expect(orderQuoteContract(call)).toEqual(call);
    expect(orderQuoteContract(combo)).toEqual(combo);
    expect(orderQuoteContract(eurusd)).toEqual(eurusd);
  });

  it('fills in a missing exchange and currency', () => {
    expect(orderQuoteContract({ ...call, exchange: '', currency: '' })).toEqual(call);
    expect(orderQuoteContract({ ...eurusd, exchange: '' })).toEqual(eurusd);
  });

  it('leaves out what cannot be quoted', () => {
    expect(orderQuoteContract({ ...combo, comboLegs: [] })).toBeNull();
    expect(orderQuoteContract({ ...combo, comboLegs: undefined })).toBeNull();
    expect(orderQuoteContract({ ...stock(''), symbol: '' })).toBeNull();
  });
});

describe('orderQuoteContracts', () => {
  it('needs no quote without orders', () => {
    expect(orderQuoteContracts([])).toEqual([]);
  });

  it('lists each instrument once, in list order', () => {
    const orders = [
      order({ orderId: 1 }),
      order({ orderId: 2, contract: call, key: contractKey(call) }),
      // A bracket's children and a second order on the stock share its line.
      order({ orderId: 3, parentId: 1, action: 'SELL', orderType: 'STP', auxPrice: 220 }),
      order({ orderId: 4, contract: { ...stock('AAPL'), conId: 265598 } }),
      order({ orderId: 5, contract: combo, key: contractKey(combo) }),
      order({ orderId: 6, contract: eurusd, key: contractKey(eurusd) }),
      order({ orderId: 7, contract: call, key: contractKey(call) }),
      order({ orderId: 8, contract: { ...combo, comboLegs: [] } }),
    ];
    expect(orderQuoteContracts(orders).map(contractKey)).toEqual(['STK:AAPL', contractKey(call), contractKey(combo), 'CASH:EUR']);
  });

  it('tells combos with other legs and options with other strikes apart', () => {
    const other: ContractRef = { ...combo, comboLegs: [combo.comboLegs![0], { ...combo.comboLegs![1], conId: 1003 }] };
    const put = option('AAPL', '20261016', 230, 'P');
    expect(orderQuoteContracts([order({ contract: combo }), order({ contract: other }), order({ contract: call }), order({ contract: put })])).toHaveLength(4);
  });
});

describe('orderLastPrice', () => {
  it('takes the last trade of a stock or currency pair, else the midpoint', () => {
    expect(orderLastPrice(stock('AAPL'), quote({ last: 227.48, bid: 227.47, ask: 227.49 }))).toBe(227.48);
    expect(orderLastPrice(stock('AAPL'), quote({ bid: 227.4, ask: 227.6 }))).toBeCloseTo(227.5);
    expect(orderLastPrice(eurusd, quote({ bid: 1.0823, ask: 1.0825 }))).toBeCloseTo(1.0824);
  });

  it('values an option as the Portfolio does: mark, else midpoint, else its last trade', () => {
    expect(orderLastPrice(call, quote({ last: 4.1, mark: 4.32, bid: 4.3, ask: 4.36 }))).toBe(4.32);
    expect(orderLastPrice(call, quote({ last: 4.1, bid: 4.3, ask: 4.36 }))).toBeCloseTo(4.33);
    expect(orderLastPrice(call, quote({ last: 4.1 }))).toBe(4.1);
  });

  it('takes a combo’s net midpoint, which may be negative, else its last', () => {
    expect(orderLastPrice(combo, quote({ bid: -0.4, ask: -0.3 }))).toBeCloseTo(-0.35);
    expect(orderLastPrice(combo, quote({ bid: 0, ask: 0.1 }))).toBeCloseTo(0.05);
    expect(orderLastPrice(combo, quote({ last: 1.85 }))).toBe(1.85);
    expect(orderLastPrice(combo, quote({ bid: 1.8 }))).toBeUndefined();
  });

  it('has none without a quote', () => {
    expect(orderLastPrice(stock('AAPL'), undefined)).toBeUndefined();
    expect(orderLastPrice(combo, quote({}))).toBeUndefined();
  });
});

describe('lastPriceText', () => {
  it('writes the price as the order price column does', () => {
    expect(lastPriceText(227.48)).toBe('227.48');
    expect(lastPriceText(12345.6)).toBe('12,345.60');
    expect(lastPriceText(0.4512)).toBe('0.4512');
    expect(lastPriceText(-0.35)).toBe('−0.35');
    expect(lastPriceText(undefined)).toBe('—');
  });
});

describe('orderReferencePrice', () => {
  it('compares limit orders by their limit', () => {
    expect(orderReferencePrice(order())).toEqual({ kind: 'limit', price: 226.5 });
    expect(orderReferencePrice(order({ orderType: 'LOC' }))).toEqual({ kind: 'limit', price: 226.5 });
  });

  it('compares stop, if-touched and trailing orders by their trigger', () => {
    expect(orderReferencePrice(order({ orderType: 'STP', limitPrice: undefined, auxPrice: 220 }))).toEqual({ kind: 'trigger', price: 220 });
    expect(orderReferencePrice(order({ orderType: 'STP LMT', limitPrice: 219.5, auxPrice: 220 }))).toEqual({ kind: 'trigger', price: 220 });
    expect(orderReferencePrice(order({ orderType: 'LIT', limitPrice: 230.5, auxPrice: 230 }))).toEqual({ kind: 'trigger', price: 230 });
    expect(orderReferencePrice(order({ orderType: 'TRAIL', limitPrice: undefined, trailStopPrice: 219.8 }))).toEqual({ kind: 'trigger', price: 219.8 });
    expect(orderReferencePrice(order({ orderType: 'TRAIL LIMIT', limitPrice: undefined, trailStopPrice: 219.8 }))).toEqual({ kind: 'trigger', price: 219.8 });
  });

  it('has none for market and offset-priced orders, or without the price', () => {
    for (const orderType of ['MKT', 'MOC', 'REL', 'PEG MID', 'SNAP MID', 'MIDPRICE']) expect(orderReferencePrice(order({ orderType }))).toBeNull();
    expect(orderReferencePrice(order({ limitPrice: undefined }))).toBeNull();
    // IB's Double.MAX_VALUE for an unset price.
    expect(orderReferencePrice(order({ orderType: 'STP', auxPrice: Number.MAX_VALUE }))).toBeNull();
    expect(orderReferencePrice(order({ orderType: 'TRAIL', trailStopPrice: undefined }))).toBeNull();
  });
});

describe('distanceFromLast', () => {
  it('is the order price’s distance from the last, in percent of the last', () => {
    expect(distanceFromLast(order(), 227.48)?.pct).toBeCloseTo(-0.4308, 4);
    expect(distanceFromLast(order({ action: 'SELL', orderType: 'STP', limitPrice: undefined, auxPrice: 230 }), 200)).toEqual({ kind: 'trigger', pct: 15 });
  });

  it('has none without a last, an order price, or a positive pair', () => {
    expect(distanceFromLast(order(), undefined)).toBeNull();
    expect(distanceFromLast(order({ orderType: 'MKT' }), 227.48)).toBeNull();
    expect(distanceFromLast(order({ contract: combo, limitPrice: -0.35 }), -0.3)).toBeNull();
    expect(distanceFromLast(order({ contract: combo, limitPrice: 1.85 }), 0)).toBeNull();
  });
});

describe('distanceText', () => {
  it('names the compared price', () => {
    expect(distanceText(order(), 227.48, en)).toBe('Limit −0.43% from last');
    expect(distanceText(order({ orderType: 'STP', limitPrice: undefined, auxPrice: 230 }), 200, en)).toBe('Trigger +15.00% from last');
    expect(distanceText(order(), 227.48, zh)).toBe('限价距现价 −0.43%');
    expect(distanceText(order({ orderType: 'TRAIL', limitPrice: undefined, trailStopPrice: 219.8 }), 227.48, zh)).toBe('触发价距现价 −3.38%');
  });

  it('is empty without a distance', () => {
    expect(distanceText(order({ orderType: 'MOC' }), 227.48, en)).toBe('');
    expect(distanceText(order(), undefined, zh)).toBe('');
  });
});

describe('lastCellTitle', () => {
  it('has the price in full, which a narrow cell cuts, and the distance from it', () => {
    expect(lastCellTitle(order({ limitPrice: 22_913.25 }), 23_012.25, quote({ last: 23_012.25 }), en)).toBe('23,012.25 · Limit −0.43% from last');
    expect(lastCellTitle(order({ orderType: 'MKT', limitPrice: undefined }), 720_512, quote({ last: 720_512 }), zh)).toBe('720,512.00');
  });

  it('has the line’s error without a price', () => {
    expect(lastCellTitle(order(), undefined, quote({ error: { code: 354, message: 'Requested market data is not subscribed.' } }), en)).toBe('Requested market data is not subscribed.');
    expect(lastCellTitle(order(), undefined, undefined, en)).toBeUndefined();
  });
});
