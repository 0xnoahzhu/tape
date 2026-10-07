import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { ContractRef, Position, Quote } from '@shared/types';
import { positionRow, type PositionRow } from './calc';
import { COLUMNS, rowId, type CellCtx } from './columns';
import type { GroupBy } from './columnsState';
import { aggregate, chipTargets, groupKey, groupRows, inAccountCurrency, isConcentrated, orderGroups, topShare, type RowGroup } from './groups';

// Tuesday 2026-10-06, 11:00 local.
const NOW = new Date(2026, 9, 6, 11, 0).getTime();
const NET_LIQ = 100_000;

let nextConId = 1000;

/** A position row valued at `px` with net liquidation 100,000 (so 1,000 of value is 1 % NLV). */
function row(contract: ContractRef, quantity: number, px: number, sector: string, over: Partial<Position> = {}, fx: number | null = 1): PositionRow {
  const p: Position = {
    account: 'DU1',
    key: contractKey(contract),
    contract: { conId: nextConId++, ...contract },
    quantity,
    avgPrice: px,
    multiplier: contract.secType === 'OPT' ? 100 : 1,
    updatedAt: 0,
    ...over,
  };
  return positionRow(p, px, NET_LIQ, sector, fx);
}

const ctx = (row: PositionRow, q?: Quote): CellCtx => ({ row, q, now: NOW });

const spx = (expiry: string, strike: number, right: 'C' | 'P'): ContractRef => ({ ...option('SPX', expiry, strike, right), tradingClass: 'SPXW' });
const fop: ContractRef = { secType: 'FOP', symbol: 'ES', lastTradeDate: '20261218', strike: 6000, right: 'C', multiplier: 50, exchange: 'CME', currency: 'USD' };

// NVDA 30,000 (30 % NLV); AAPL 10,000 (10 %) with a short call (−0.5 %) and a put (0.3 %); XOM 5.5 %;
// SPX index options 3.5 %; an ES futures option 0.5 %.
const aapl = row(stock('AAPL'), 40, 250, 'Technology');
const aaplCall = row(option('AAPL', '20261016', 260, 'C'), -1, 5, 'Technology');
const aaplPut = row(option('AAPL', '20261218', 200, 'P'), 2, 1.5, 'Technology');
const nvda = row(stock('NVDA'), 200, 150, 'Technology');
const xom = row(stock('XOM'), 50, 110, 'Energy');
const spxPut = row(spx('20261009', 5800, 'P'), 1, 20, '@etf');
const spxCall = row(spx('20261120', 6200, 'C'), 1, 15, '@etf');
const es = row(fop, 1, 10, '@other', { multiplier: 50 });

const ALL = [nvda, aapl, xom, spxPut, spxCall, es, aaplCall, aaplPut];
const keysOf = (gs: readonly RowGroup[]) => gs.map((g) => [g.key, g.ctxs.map((c) => c.row.position.contract.symbol + ':' + c.row.position.contract.secType)]);

describe('grouping', () => {
  it('groups a stock with its options, index options under their index, a futures option alone', () => {
    const gs = groupRows(ALL.map((r) => ctx(r)), 'underlying');
    expect(keysOf(gs)).toEqual([
      ['u:STK:NVDA', ['NVDA:STK']],
      ['u:STK:AAPL', ['AAPL:STK', 'AAPL:OPT', 'AAPL:OPT']],
      ['u:STK:XOM', ['XOM:STK']],
      ['u:IND:SPX', ['SPX:OPT', 'SPX:OPT']],
      [`u:${contractKey(fop)}`, ['ES:FOP']],
    ]);
    expect(gs[1]).toMatchObject({ kind: 'underlying', label: 'AAPL', underlying: { secType: 'STK', symbol: 'AAPL' } });
    expect(gs[3].label).toBe('SPX');
  });

  it('puts an option on a non-USD stock with that stock', () => {
    const hk = row({ ...stock('700'), currency: 'HKD', primaryExchange: 'SEHK' }, 100, 500, 'Communications', {}, 0.128);
    const hkCall = row({ ...option('700', '20261029', 520, 'C'), currency: 'HKD' }, 1, 10, 'Communications', {}, 0.128);
    expect(keysOf(groupRows([ctx(hk), ctx(hkCall)], 'underlying'))).toEqual([['u:STK:700:HKD', ['700:STK', '700:OPT']]]);
  });

  it('groups by sector, options with their stock’s, and not at all', () => {
    const gs = groupRows(ALL.map((r) => ctx(r)), 'sector');
    expect(gs.map((g) => [g.key, g.label, g.ctxs.length])).toEqual([
      ['s:Technology', 'Technology', 4],
      ['s:Energy', 'Energy', 1],
      ['s:@etf', '@etf', 2],
      ['s:@other', '@other', 1],
    ]);
    const none = groupRows(ALL.map((r) => ctx(r)), 'none');
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ key: '', kind: 'none', label: '' });
    expect(none[0].ctxs.map((c) => c.row)).toEqual(ALL);
    expect(groupKey(aapl, 'none')).toBe(`r:${rowId(aapl)}`);
  });
});

describe('group sums', () => {
  const group = [ctx(aapl), ctx(aaplCall)];

  it('adds up the share of net liquidation and amounts in one currency', () => {
    expect(aggregate(COLUMNS.weight, group)).toBeCloseTo(9.5);
    expect(aggregate(COLUMNS.value, group)).toBe(10_000 - 500);
    expect(aggregate(COLUMNS.unrealized, group)).toBe(0);
    // The unrealized column's percent line is not summed: the group gets the main value only.
    expect(COLUMNS.unrealized.sub).toBeDefined();
  });

  it('adds up an amount across currencies in the account currency', () => {
    const sap = row({ ...stock('SAP'), currency: 'EUR' }, 10, 200, 'Technology', {}, 1.1);
    const mixed = [ctx(aapl), ctx(sap)];
    // 10,000 USD + 2,000 EUR × 1.1.
    expect(aggregate(COLUMNS.value, mixed)).toBeCloseTo(10_000 + 2_200);
    expect(inAccountCurrency(COLUMNS.value, mixed)).toBe(true);
    expect(aggregate(COLUMNS.valueBase, mixed)).toBeCloseTo(10_000 + 2_200);
    expect(inAccountCurrency(COLUMNS.valueBase, mixed)).toBe(false);
    expect(aggregate(COLUMNS.weight, mixed)).toBeCloseTo(12.2);
    // One currency: the rows' own, whatever it is.
    expect(inAccountCurrency(COLUMNS.value, group)).toBe(false);
    expect(aggregate(COLUMNS.value, [ctx(sap), ctx(sap)])).toBe(4_000);
    expect(inAccountCurrency(COLUMNS.value, [ctx(sap), ctx(sap)])).toBe(false);
    // "—" while a rate is unknown.
    const noRate = row({ ...stock('SAP'), currency: 'EUR' }, 10, 200, 'Technology', {}, null);
    expect(aggregate(COLUMNS.value, [ctx(aapl), ctx(noRate)])).toBeUndefined();
  });

  it('sorts a group across currencies by its account-currency sum', () => {
    // Technology: AAPL 10,000 USD and 0700 50,000 HKD (6,400 USD); Energy: XOM 5,500 USD.
    const hk = row({ ...stock('700'), currency: 'HKD' }, 100, 500, 'Technology', {}, 0.128);
    const gs = groupRows([ctx(aapl), ctx(hk), ctx(xom)], 'sector');
    const order = orderGroups(gs, { id: 'value', dir: 'desc' }, 'en', (g) => g.label).map((g) => g.key);
    expect(order).toEqual(['s:Technology', 's:Energy']);
  });

  it('shows "—" while a row’s value is unknown, never a partial sum', () => {
    const unknown = row(stock('MSFT'), 10, 400, 'Technology', {}, null);
    expect(aggregate(COLUMNS.weight, [ctx(aapl), ctx(unknown)])).toBeUndefined();
    expect(aggregate(COLUMNS.value, [ctx(aapl), ctx(unknown)])).toBe(10_000 + 4_000);
  });

  it('adds share equivalents only within one underlying', () => {
    const callQ: Quote = { key: 'k', updatedAt: 0, delta: 0.4, gamma: 0.02 };
    const putQ: Quote = { key: 'k', updatedAt: 0, delta: -0.3, gamma: 0.01 };
    const und = [ctx(aapl), ctx(aaplCall, callQ), ctx(aaplPut, putQ)];
    // 40 shares, −1 × 0.4 × 100, 2 × −0.3 × 100.
    expect(aggregate(COLUMNS.positionDelta, und)).toBeCloseTo(40 - 40 - 60);
    expect(aggregate(COLUMNS.positionGamma, und)).toBeCloseTo(-2 + 2);
    expect(aggregate(COLUMNS.positionDelta, [ctx(aapl), ctx(nvda)])).toBeNull();
  });

  it('leaves a column empty when it does not add up or applies to no row', () => {
    expect(aggregate(COLUMNS.quantity, group)).toBeNull();
    expect(aggregate(COLUMNS.price, group)).toBeNull();
    expect(aggregate(COLUMNS.unrealizedPct, group)).toBeNull();
    expect(aggregate(COLUMNS.positionTheta, [ctx(aapl), ctx(nvda)])).toBeNull();
    expect(aggregate(COLUMNS.value, [])).toBeNull();
  });

  it('highlights a share of net liquidation from 20 %, long or short', () => {
    expect(isConcentrated(20)).toBe(true);
    expect(isConcentrated(19.99)).toBe(false);
    expect(isConcentrated(-25)).toBe(true);
    expect(isConcentrated(undefined)).toBe(false);
    expect(isConcentrated(null)).toBe(false);
  });
});

describe('top share of net liquidation', () => {
  it('adds up the largest groups’ net shares', () => {
    // NVDA 30, AAPL 10 − 0.5 + 0.3 = 9.8, XOM 5.5, SPX 3.5, ES 0.5.
    const u = topShare(ALL, 'underlying')!;
    expect(u.n).toBe(3);
    expect(u.pct).toBeCloseTo(30 + 9.8 + 5.5);
    // Without the put: 9.5 for AAPL.
    expect(topShare([aapl, aaplCall], 'underlying')).toEqual({ n: 1, pct: expect.closeTo(9.5) });
    // Technology 30 + 9.8, Energy 5.5, @etf 3.5.
    expect(topShare(ALL, 'sector')!.pct).toBeCloseTo(39.8 + 5.5 + 3.5);
    // Each position: NVDA 30, AAPL 10, XOM 5.5.
    expect(topShare(ALL, 'none')!.pct).toBeCloseTo(45.5);
  });

  it('counts fewer groups when there are fewer, and none while a share is unknown', () => {
    expect(topShare([nvda, xom], 'underlying')).toEqual({ n: 2, pct: expect.closeTo(35.5) });
    expect(topShare([nvda, row(stock('MSFT'), 10, 400, 'Technology', {}, null)], 'underlying')).toBeUndefined();
    expect(topShare([], 'underlying')).toBeUndefined();
  });
});

describe('group and row order', () => {
  const ctxs = ALL.map((r) => ctx(r));
  const label = (g: RowGroup) => g.label;
  const order = (by: GroupBy, sort: Parameters<typeof orderGroups>[1], labelOf = label) => orderGroups(groupRows(ctxs, by), sort, 'en', labelOf);
  const ids = (...rows: PositionRow[]) => rows.map(rowId);

  it('puts the largest groups first and keeps the rows’ order without a sort', () => {
    expect(order('underlying', null)).toEqual([
      { key: 'u:STK:NVDA', ids: ids(nvda) },
      { key: 'u:STK:AAPL', ids: ids(aapl, aaplCall, aaplPut) },
      { key: 'u:STK:XOM', ids: ids(xom) },
      { key: 'u:IND:SPX', ids: ids(spxPut, spxCall) },
      { key: `u:${contractKey(fop)}`, ids: ids(es) },
    ]);
    expect(order('none', null)).toEqual([{ key: '', ids: ids(...ALL) }]);
  });

  it('sorts groups by their sum on a column that adds up, and the rows within them', () => {
    const asc = order('underlying', { id: 'value', dir: 'asc' });
    expect(asc.map((g) => g.key)).toEqual([`u:${contractKey(fop)}`, 'u:IND:SPX', 'u:STK:XOM', 'u:STK:AAPL', 'u:STK:NVDA']);
    expect(asc.find((g) => g.key === 'u:STK:AAPL')!.ids).toEqual(ids(aaplCall, aaplPut, aapl));
    const desc = order('underlying', { id: 'value', dir: 'desc' });
    expect(desc.map((g) => g.key)).toEqual(['u:STK:NVDA', 'u:STK:AAPL', 'u:STK:XOM', 'u:IND:SPX', `u:${contractKey(fop)}`]);
    expect(desc.find((g) => g.key === 'u:STK:AAPL')!.ids).toEqual(ids(aapl, aaplPut, aaplCall));
  });

  it('sorts groups by their best row on any other column, blanks last', () => {
    const dte = order('underlying', { id: 'daysToExpiry', dir: 'asc' });
    // SPX expires on 10/9, AAPL’s call on 10/16, ES on 12/18; the stocks have no expiry.
    expect(dte.map((g) => g.key)).toEqual(['u:IND:SPX', 'u:STK:AAPL', `u:${contractKey(fop)}`, 'u:STK:NVDA', 'u:STK:XOM']);
    expect(dte[1].ids).toEqual(ids(aaplCall, aaplPut, aapl));
  });

  it('sorts groups by their label on Symbol (a sector by its name in the user’s language)', () => {
    expect(order('underlying', { id: 'symbol', dir: 'asc' }).map((g) => g.key)).toEqual([
      'u:STK:AAPL',
      `u:${contractKey(fop)}`,
      'u:STK:NVDA',
      'u:IND:SPX',
      'u:STK:XOM',
    ]);
    const names: Record<string, string> = { Technology: 'Tech', Energy: 'Oil', '@etf': 'ETF / Index', '@other': 'Zzz' };
    const sectors = order('sector', { id: 'symbol', dir: 'asc' }, (g) => names[g.label]);
    expect(sectors.map((g) => g.key)).toEqual(['s:@etf', 's:Energy', 's:Technology', 's:@other']);
    // Within a group Symbol keeps a stock before its options.
    expect(sectors[2].ids).toEqual(ids(aapl, aaplCall, aaplPut, nvda));
    expect(order('sector', { id: 'symbol', dir: 'desc' }, (g) => names[g.label]).map((g) => g.key)).toEqual(['s:@other', 's:Technology', 's:Energy', 's:@etf']);
  });

  it('breaks ties by group key and conId', () => {
    const a = row(stock('BBB'), 10, 100, 'Energy');
    const b = row(stock('AAA'), 10, 100, 'Energy');
    expect(orderGroups(groupRows([ctx(a), ctx(b)], 'underlying'), null, 'en', label).map((g) => g.key)).toEqual(['u:STK:AAA', 'u:STK:BBB']);
    expect(orderGroups(groupRows([ctx(a), ctx(b)], 'sector'), { id: 'value', dir: 'asc' }, 'en', label)[0].ids).toEqual(ids(a, b));
  });
});

describe('event chips', () => {
  const events = new Map([
    ['STK:AAPL', 'aapl'],
    ['STK:NVDA', 'nvda'],
    ['STK:TSLA', 'tsla'],
  ]);
  const tslaCall = row(option('TSLA', '20261120', 400, 'C'), 1, 10, 'Consumer, Cyclical');
  const tslaPut = row(option('TSLA', '20261120', 300, 'P'), 1, 10, 'Consumer, Cyclical');
  const rows = [nvda, aapl, aaplCall, tslaCall, tslaPut];
  const targets = (by: GroupBy, list = rows) => chipTargets(groupRows(list.map((r) => ctx(r)), by), by, events);

  it('puts an underlying’s chip on its group row, a lone row’s on the row', () => {
    const t = targets('underlying');
    expect([...t.groups]).toEqual([
      ['u:STK:AAPL', 'aapl'],
      ['u:STK:TSLA', 'tsla'],
    ]);
    expect([...t.rows]).toEqual([[rowId(nvda), 'nvda']]);
  });

  it('puts it on the stock row by sector and without grouping, else on each option row', () => {
    for (const by of ['sector', 'none'] as const) {
      const t = targets(by);
      expect(t.groups.size).toBe(0);
      expect(new Map(t.rows)).toEqual(
        new Map([
          [rowId(nvda), 'nvda'],
          [rowId(aapl), 'aapl'],
          [rowId(tslaCall), 'tsla'],
          [rowId(tslaPut), 'tsla'],
        ]),
      );
    }
    // A lone option of an underlying with an event.
    expect([...targets('underlying', [tslaCall]).rows]).toEqual([[rowId(tslaCall), 'tsla']]);
  });

  it('puts none without events', () => {
    const t = chipTargets(groupRows(rows.map((r) => ctx(r)), 'underlying'), 'underlying', new Map());
    expect(t.groups.size + t.rows.size).toBe(0);
  });
});
