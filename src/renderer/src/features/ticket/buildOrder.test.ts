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
  sessions: { regular: 'Regular hours', extended: 'Extended hours', overnight: 'Overnight', overnightDay: 'Overnight + Day' },
  extras: { bracket: ' · with bracket', conditional: ' · conditional', iceberg: ' · iceberg', goodAfter: (t) => ` · GAT ${t}` },
};

function ok(r: BuildResult): OrderRequest {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.request;
}
const build = (patch: Partial<TicketState>, market: TicketMarket = mkt, contract = AAPL) => buildOrderRequest({ contract, ticket: ticket(patch), market });

describe('buildOrderRequest: order types', () => {
  it('LMT buy at the ask', () => {
    expect(ok(build({}))).toEqual({ contract: AAPL, action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 227.49, tif: 'DAY', outsideRth: false, session: 'regular' });
  });

  it('LMT rounds a typed price to the tick', () => {
    expect(ok(build({ limitPrice: 227.333 })).limitPrice).toBe(227.33);
    expect(ok(build({ limitPrice: 4.33 }, { ...mkt, minTick: 0.05 })).limitPrice).toBe(4.35);
  });

  it('MKT sends no prices', () => {
    const r = ok(build({ orderType: 'MKT', side: 'SELL', tif: 'IOC' }));
    expect(r).toEqual({ contract: AAPL, action: 'SELL', orderType: 'MKT', quantity: 100, tif: 'IOC', outsideRth: false, session: 'regular' });
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

  it('sends the session with its outsideRth flag', () => {
    expect(ok(build({ session: 'extended' }))).toMatchObject({ session: 'extended', outsideRth: true });
    expect(ok(build({ session: 'overnight' }))).toMatchObject({ session: 'overnight', outsideRth: false });
    // IB turns outside RTH on by itself for overnight + day; sending it keeps modifications equal.
    expect(ok(build({ session: 'overnightDay' }))).toMatchObject({ session: 'overnightDay', outsideRth: true });
  });
});

describe('buildOrderRequest: time in force and session', () => {
  // 2026-10-05 is a Monday; 14:00 UTC = 10:00 New York (EDT).
  const monday10 = Date.UTC(2026, 9, 5, 14, 0);
  const at = (patch: Partial<TicketState>, now = monday10, contract = AAPL, hours?: { liquidHours?: string; timeZoneId?: string }) =>
    buildOrderRequest({ contract, ticket: ticket(patch), market: mkt, now, hours });
  const OPT = option('AAPL', '20261016', 230, 'C');

  it('GTD defaults to the close of the current or next session, in New York time', () => {
    expect(ok(at({ tif: 'GTD' })).goodTillDate).toBe('20261005 16:00:00 US/Eastern');
    // After the close: the next weekday; Friday evening: Monday.
    expect(ok(at({ tif: 'GTD' }, Date.UTC(2026, 9, 5, 21, 0))).goodTillDate).toBe('20261006 16:00:00 US/Eastern');
    expect(ok(at({ tif: 'GTD' }, Date.UTC(2026, 9, 9, 22, 0))).goodTillDate).toBe('20261012 16:00:00 US/Eastern');
    // IB's liquid hours know early closes and holidays.
    const hours = { liquidHours: '20261005:0930-20261005:1300;20261006:CLOSED;20261007:0930-20261007:1600', timeZoneId: 'US/Eastern' };
    expect(ok(at({ tif: 'GTD' }, monday10, AAPL, hours)).goodTillDate).toBe('20261005 13:00:00 US/Eastern');
    expect(ok(at({ tif: 'GTD' }, Date.UTC(2026, 9, 5, 18, 0), AAPL, hours)).goodTillDate).toBe('20261007 16:00:00 US/Eastern');
  });

  it('GTD sends the typed expiry and refuses one in the past', () => {
    expect(ok(at({ tif: 'GTD', goodTill: '2026-10-09T15:30' })).goodTillDate).toBe('20261009 15:30:00 US/Eastern');
    expect(at({ tif: 'GTD', goodTill: '2026-10-05T09:59' })).toEqual({ ok: false, error: 'gtdTime' });
    expect(at({ tif: 'GTD', goodTill: '' })).toEqual({ ok: false, error: 'gtdTime' });
    // Other TIFs ignore a leftover expiry.
    expect(ok(at({ tif: 'DAY', goodTill: '2026-10-01T16:00' }))).not.toHaveProperty('goodTillDate');
  });

  it('takes FOK for options only and OPG as market / limit on open for stocks', () => {
    expect(at({ tif: 'FOK' })).toEqual({ ok: false, error: 'fokInstrument' });
    expect(ok(at({ tif: 'FOK', limitPrice: 4.25 }, monday10, OPT)).tif).toBe('FOK');
    expect(ok(at({ tif: 'OPG' })).tif).toBe('OPG');
    expect(ok(at({ tif: 'OPG', orderType: 'MKT' })).tif).toBe('OPG');
    expect(at({ tif: 'OPG', orderType: 'STP' })).toEqual({ ok: false, error: 'opgType' });
    expect(at({ tif: 'OPG', limitPrice: 4.25 }, monday10, OPT)).toEqual({ ok: false, error: 'opgInstrument' });
  });

  it('keeps IOC, FOK and OPG in regular hours', () => {
    expect(at({ tif: 'IOC', session: 'extended' })).toEqual({ ok: false, error: 'regularHoursTif' });
    expect(at({ tif: 'OPG', session: 'extended' })).toEqual({ ok: false, error: 'regularHoursTif' });
    expect(ok(at({ tif: 'IOC' })).tif).toBe('IOC');
  });

  it('keeps IOC, FOK and OPG off brackets, whose children take the same TIF', () => {
    expect(at({ tif: 'IOC', bracket: true })).toEqual({ ok: false, error: 'bracketTif' });
    expect(at({ tif: 'OPG', bracket: true })).toEqual({ ok: false, error: 'bracketTif' });
    expect(ok(at({ tif: 'GTC', bracket: true })).bracket).toBeDefined();
    expect(ok(at({ tif: 'IOC', bracket: true, modifyingOrderId: 12 })).tif).toBe('IOC');
  });

  it('takes DAY limit orders on US stocks in the overnight sessions', () => {
    for (const session of ['overnight', 'overnightDay'] as const) {
      expect(ok(at({ session })).session).toBe(session);
      expect(at({ session, orderType: 'MKT' })).toEqual({ ok: false, error: 'overnightType' });
      expect(at({ session, tif: 'GTC' })).toEqual({ ok: false, error: 'overnightTif' });
      expect(at({ session, tif: 'IOC' })).toEqual({ ok: false, error: 'overnightTif' });
      expect(at({ session, bracket: true })).toEqual({ ok: false, error: 'overnightBracket' });
      expect(at({ session, iceberg: true, iceQty: '50' })).toEqual({ ok: false, error: 'overnightIceberg' });
      expect(at({ session, condition: true })).toEqual({ ok: false, error: 'overnightCondition' });
      expect(at({ session, goodAfter: true })).toEqual({ ok: false, error: 'overnightGoodAfter' });
      expect(at({ session, limitPrice: 4.25 }, monday10, OPT)).toEqual({ ok: false, error: 'overnightInstrument' });
      expect(at({ session }, monday10, { ...stock('SAP'), exchange: 'IBIS', currency: 'EUR' })).toEqual({ ok: false, error: 'overnightInstrument' });
    }
    // Modifying drops the bracket, so it does not count.
    expect(ok(at({ session: 'overnightDay', bracket: true, modifyingOrderId: 12 })).bracket).toBeUndefined();
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
    const r = build({ side: 'SELL', limitPrice: 100, session: 'extended', bracket: true, condition: true, condPx: '235', iceberg: true, iceQty: '10', goodAfter: true, tif: 'GTC', modifyingOrderId: 41 });
    if (!r.ok) throw new Error(r.error);
    const p = pendingOrder(r.request, r.model, labels, mkt, 41);
    expect(p.modifyOrderId).toBe(41);
    const byLabel = Object.fromEntries(p.rows.map((x) => [x.label, x]));
    expect(byLabel['Side']).toEqual({ label: 'Side', value: 'Sell', color: 'var(--dn)' });
    expect(byLabel['TIF'].value).toBe('GTC · Extended hours · conditional · iceberg · GAT 09:35');
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

  it('shows the GTD expiry and the overnight sessions', () => {
    const tif = (patch: Partial<TicketState>) => {
      const r = buildOrderRequest({ contract: AAPL, ticket: ticket(patch), market: mkt, now: Date.UTC(2026, 9, 5, 14) });
      if (!r.ok) throw new Error(r.error);
      return pendingOrder(r.request, r.model, labels, mkt).rows.find((x) => x.label === 'TIF')?.value;
    };
    expect(tif({ tif: 'GTD', goodTill: '2026-10-09T16:00' })).toBe('GTD 10/09 16:00 ET');
    expect(tif({ tif: 'GTD', goodTill: '2026-10-09T16:00', session: 'extended' })).toBe('GTD 10/09 16:00 ET · Extended hours');
    expect(tif({ session: 'overnightDay' })).toBe('DAY · Overnight + Day');
    expect(tif({ session: 'overnight' })).toBe('DAY · Overnight');
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
