import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { index, option, stock } from '@shared/contract';
import type { OrderRequest } from '@shared/types';
import { initialTicket, type TicketState } from '../../state/store';
import { buildOrderRequest, normalizeTime, pendingOrder, typePriceText, type BuildResult, type ReviewLabels } from './buildOrder';
import type { TicketMarket } from './ticketModel';

const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...initialTicket(defaultSettings()), ...patch });
const mkt: TicketMarket = { bid: 227.48, ask: 227.49, last: 227.5, refLast: 227.5, minTick: 0.01, multiplier: 1 };
const AAPL = stock('AAPL');

const labels: ReviewLabels = {
  contract: 'Contract',
  side: 'Side',
  qty: 'Qty',
  typePrice: 'Type / Price',
  tif: 'TIF',
  trigger: 'Trigger',
  estAmount: 'Est. amount',
  tpSl: 'Take profit / Stop loss',
  buy: 'Buy',
  sell: 'Sell',
  orderTypes: { LMT: 'Limit', MKT: 'Market', STP: 'Stop', 'STP LMT': 'Stop limit', TRAIL: 'Trail' },
  extras: { outsideRth: ' · outside RTH', bracket: ' · with bracket', conditional: ' · conditional', iceberg: ' · iceberg', goodAfter: (t) => ` · GAT ${t}` },
};

function ok(r: BuildResult): OrderRequest {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.request;
}
const build = (patch: Partial<TicketState>, market: TicketMarket = mkt, contract = AAPL) => buildOrderRequest({ contract, ticket: ticket(patch), market });

describe('buildOrderRequest: order types', () => {
  it('LMT buy at the ask', () => {
    expect(ok(build({}))).toEqual({ contract: AAPL, action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 227.49, tif: 'DAY', outsideRth: false });
  });

  it('LMT rounds a typed price to the tick', () => {
    expect(ok(build({ limitPrice: 227.333 })).limitPrice).toBe(227.33);
    expect(ok(build({ limitPrice: 4.33 }, { ...mkt, minTick: 0.05 })).limitPrice).toBe(4.35);
  });

  it('MKT sends no prices', () => {
    const r = ok(build({ orderType: 'MKT', side: 'SELL', tif: 'IOC' }));
    expect(r).toEqual({ contract: AAPL, action: 'SELL', orderType: 'MKT', quantity: 100, tif: 'IOC', outsideRth: false });
  });

  it('STP sends the trigger', () => {
    const r = ok(build({ orderType: 'STP', side: 'SELL', tif: 'GTC' }));
    expect(r.stopPrice).toBe(225.23);
    expect(r.limitPrice).toBeUndefined();
  });

  it('STP LMT sends trigger and limit', () => {
    const r = ok(build({ orderType: 'STP LMT', stopPrice: 230, limitPrice: 231 }));
    expect(r.stopPrice).toBe(230);
    expect(r.limitPrice).toBe(231);
  });

  it('TRAIL by percent', () => {
    const r = ok(build({ orderType: 'TRAIL', side: 'SELL', trailMode: 'pct', trailAmt: '3' }));
    expect(r.trailingPercent).toBe(3);
    expect(r.trailingAmount).toBeUndefined();
    expect(r.trailStopPrice).toBe(220.67);
  });

  it('TRAIL by amount', () => {
    const r = ok(build({ orderType: 'TRAIL', side: 'SELL', trailMode: 'amt', trailAmt: '2.5' }));
    expect(r.trailingAmount).toBe(2.5);
    expect(r.trailingPercent).toBeUndefined();
    expect(r.trailStopPrice).toBe(225);
  });

  it('TRAIL without market data lets IB compute the initial stop', () => {
    const r = ok(build({ orderType: 'TRAIL', trailAmt: '1' }, { minTick: 0.01, multiplier: 1 }));
    expect(r.trailingPercent).toBe(1);
    expect(r.trailStopPrice).toBeUndefined();
  });

  it('keeps outsideRth', () => {
    expect(ok(build({ outsideRth: true })).outsideRth).toBe(true);
  });
});

describe('buildOrderRequest: validation', () => {
  it('rejects indices', () => {
    expect(build({}, mkt, index('SPX', 'CBOE'))).toEqual({ ok: false, error: 'index' });
  });

  it('rejects bad quantities', () => {
    expect(build({ qty: 0 })).toMatchObject({ error: 'qty' });
    expect(build({ qty: 1.5 })).toMatchObject({ error: 'qty' });
  });

  it('requires prices', () => {
    const none = { minTick: 0.01, multiplier: 1 };
    expect(build({}, none)).toMatchObject({ error: 'limit' });
    expect(build({ orderType: 'STP' }, none)).toMatchObject({ error: 'stop' });
    expect(build({ orderType: 'STP LMT', stopPrice: 230 }, none)).toMatchObject({ ok: true });
    expect(build({ orderType: 'MKT' }, none)).toMatchObject({ ok: true });
  });

  it('rejects invalid trail amounts', () => {
    expect(build({ orderType: 'TRAIL', trailAmt: '0' })).toMatchObject({ error: 'trail' });
    expect(build({ orderType: 'TRAIL', trailAmt: '120' })).toMatchObject({ error: 'trail' });
    expect(build({ orderType: 'TRAIL', trailMode: 'amt', trailAmt: '120' })).toMatchObject({ ok: true });
  });
});

describe('buildOrderRequest: bracket', () => {
  it('uses the defaults around the entry', () => {
    const r = ok(build({ bracket: true, limitPrice: 100 }));
    expect(r.bracket).toEqual({ takeProfit: 103, stopLoss: 98 });
    const s = ok(build({ bracket: true, side: 'SELL', limitPrice: 100 }));
    expect(s.bracket).toEqual({ takeProfit: 97, stopLoss: 102 });
  });

  it('checks take-profit and stop-loss sides', () => {
    expect(build({ bracket: true, limitPrice: 100, takeProfit: '99' })).toMatchObject({ error: 'tpAbove' });
    expect(build({ bracket: true, limitPrice: 100, stopLoss: '101' })).toMatchObject({ error: 'slBelow' });
    expect(build({ bracket: true, side: 'SELL', limitPrice: 100, takeProfit: '101' })).toMatchObject({ error: 'tpBelow' });
    expect(build({ bracket: true, side: 'SELL', limitPrice: 100, stopLoss: '99' })).toMatchObject({ error: 'slAbove' });
    expect(build({ bracket: true, limitPrice: 100, takeProfit: 'abc' })).toMatchObject({ error: 'tp' });
    expect(build({ bracket: true, limitPrice: 100, stopLoss: '' })).toMatchObject({ error: 'sl' });
  });

  it('is dropped when modifying an order', () => {
    expect(ok(build({ bracket: true, limitPrice: 100, modifyingOrderId: 12 })).bracket).toBeUndefined();
  });
});

describe('buildOrderRequest: condition, iceberg, good-after-time', () => {
  it('adds a price condition on the instrument', () => {
    const r = ok(build({ condition: true, condOp: '>=', condPx: '235', condRth: true }));
    expect(r.condition).toEqual({ contract: AAPL, operator: '>=', price: 235, outsideRth: true });
  });

  it('watches the underlying for options', () => {
    const opt = option('AAPL', '20261016', 230, 'C');
    const r = ok(build({ condition: true, condOp: '<=', limitPrice: 4.25 }, { ...mkt, minTick: 0.05, refMinTick: 0.01 }, opt));
    expect(r.condition).toEqual({ contract: AAPL, operator: '<=', price: 220.67, outsideRth: false });
  });

  it('rejects a missing condition price', () => {
    expect(build({ condition: true, condPx: '' })).toMatchObject({ error: 'cond' });
  });

  it('adds the iceberg display size', () => {
    expect(ok(build({ iceberg: true, iceQty: '20' })).displaySize).toBe(20);
    expect(build({ iceberg: true, iceQty: '0' })).toMatchObject({ error: 'ice' });
    expect(build({ iceberg: true, iceQty: '500' })).toMatchObject({ error: 'ice' });
    expect(build({ iceberg: true, iceQty: '2.5' })).toMatchObject({ error: 'ice' });
  });

  it('adds a normalized good-after time', () => {
    expect(ok(build({ goodAfter: true, goodAfterTime: '9:35' })).goodAfterTime).toBe('09:35');
    expect(build({ goodAfter: true, goodAfterTime: '25:00' })).toMatchObject({ error: 'gat' });
    expect(normalizeTime('15:59')).toBe('15:59');
    expect(normalizeTime('9.30')).toBeNull();
  });
});

describe('review rows', () => {
  it('describes a plain limit order like the design', () => {
    const r = build({});
    if (!r.ok) throw new Error();
    const p = pendingOrder(r.request, r.model, labels, mkt);
    expect(p.label).toBe('Buy');
    expect(p.summary).toBe('Buy 100 AAPL');
    expect(p.modifyOrderId).toBeUndefined();
    expect(p.rows).toEqual([
      { label: 'Contract', value: 'AAPL' },
      { label: 'Side', value: 'Buy', color: 'var(--up)' },
      { label: 'Qty', value: '100' },
      { label: 'Type / Price', value: 'Limit 227.49' },
      { label: 'TIF', value: 'DAY' },
      { label: 'Est. amount', value: '$22,749.00' },
    ]);
  });

  it('lists extras, bracket and trigger rows', () => {
    const r = build({ side: 'SELL', limitPrice: 100, outsideRth: true, bracket: true, condition: true, condPx: '235', iceberg: true, iceQty: '10', goodAfter: true, tif: 'GTC', modifyingOrderId: 41 });
    if (!r.ok) throw new Error(r.error);
    const p = pendingOrder(r.request, r.model, labels, mkt, 41);
    expect(p.modifyOrderId).toBe(41);
    const byLabel = Object.fromEntries(p.rows.map((x) => [x.label, x]));
    expect(byLabel['Side']).toEqual({ label: 'Side', value: 'Sell', color: 'var(--dn)' });
    expect(byLabel['TIF'].value).toBe('GTC · outside RTH · conditional · iceberg · GAT 09:35');
    expect(byLabel['Trigger'].value).toBe('AAPL ≥ 235.00');
    expect(byLabel['Take profit / Stop loss']).toBeUndefined();
  });

  it('shows the bracket for new orders', () => {
    const r = build({ limitPrice: 100, bracket: true });
    if (!r.ok) throw new Error(r.error);
    const rows = pendingOrder(r.request, r.model, labels, mkt).rows;
    expect(rows.find((x) => x.label === 'TIF')?.value).toBe('DAY · with bracket');
    expect(rows.find((x) => x.label === 'Take profit / Stop loss')?.value).toBe('103.00 / 98.00');
  });

  it('formats every order type', () => {
    const t = (patch: Partial<TicketState>) => typePriceText(ok(build(patch)), labels, 0.01);
    expect(t({ orderType: 'MKT' })).toBe('Market');
    expect(t({ orderType: 'STP', stopPrice: 230 })).toBe('Stop 230.00');
    expect(t({ orderType: 'STP LMT', stopPrice: 230, limitPrice: 230.5 })).toBe('Stop limit 230.00 / 230.50');
    expect(t({ orderType: 'TRAIL', side: 'SELL', trailAmt: '3' })).toBe('Trail 3% · 220.67');
    expect(t({ orderType: 'TRAIL', side: 'SELL', trailMode: 'amt', trailAmt: '2' })).toBe('Trail $2.00 · 225.50');
  });

  it('uses the multiplier and the option label', () => {
    const opt = option('AAPL', '20261016', 230, 'C');
    const r = buildOrderRequest({ contract: opt, ticket: ticket({ qty: 2, limitPrice: 4.25 }), market: { ...mkt, minTick: 0.05, multiplier: 100 } });
    if (!r.ok) throw new Error(r.error);
    const p = pendingOrder(r.request, r.model, labels, mkt);
    expect(p.summary).toBe('Buy 2 AAPL 10/16 230 Call');
    expect(p.rows.at(-1)?.value).toBe('$850.00');
  });

  it('shows the estimate in the contract currency', () => {
    const sap = { ...stock('SAP'), exchange: 'IBIS', currency: 'EUR' };
    const r = buildOrderRequest({ contract: sap, ticket: ticket({ qty: 200, limitPrice: 231.965 }), market: mkt });
    if (!r.ok) throw new Error(r.error);
    expect(pendingOrder(r.request, r.model, labels, mkt).rows.at(-1)?.value).toBe('46,393.00 EUR');
  });
});
