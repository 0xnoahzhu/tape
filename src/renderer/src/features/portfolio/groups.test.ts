import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import type { ContractRef, Position } from '@shared/types';
import { positionRow, type PositionRow } from './calc';
import { rowId, type CellCtx } from './columns';
import type { GroupBy } from './columnsState';
import * as groupsModule from './groups';
import { chipTargets, groupKey, groupRows, orderGroups, type RowGroup } from './groups';

// Tuesday 2026-10-06, 11:00 local.
const NOW = new Date(2026, 9, 6, 11, 0).getTime();

let nextConId = 1000;

/** A position row whose IB value (reqPnLSingle) is `value`. */
function row(contract: ContractRef, quantity: number, value: number, sector: string, over: Partial<Position> = {}, fx: number | null = 1): PositionRow {
  const p: Position = {
    account: 'DU1',
    key: contractKey(contract),
    contract: { conId: nextConId++, ...contract },
    quantity,
    multiplier: contract.secType === 'OPT' ? 100 : 1,
    pnlValue: value,
    updatedAt: 0,
    ...over,
  };
  return positionRow(p, undefined, sector, fx);
}

const ctx = (row: PositionRow): CellCtx => ({ row, now: NOW });

const spx = (expiry: string, strike: number, right: 'C' | 'P'): ContractRef => ({ ...option('SPX', expiry, strike, right), tradingClass: 'SPXW' });
const fop: ContractRef = { secType: 'FOP', symbol: 'ES', lastTradeDate: '20261218', strike: 6000, right: 'C', multiplier: 50, exchange: 'CME', currency: 'USD' };

// NVDA 30,000; AAPL 10,000 with a short call (−500) and a put (300); XOM 5,500; SPX index options
// 2,000 and 1,500; an ES futures option 500.
const aapl = row(stock('AAPL'), 40, 10_000, 'Technology');
const aaplCall = row(option('AAPL', '20261016', 260, 'C'), -1, -500, 'Technology');
const aaplPut = row(option('AAPL', '20261218', 200, 'P'), 2, 300, 'Technology');
const nvda = row(stock('NVDA'), 200, 30_000, 'Technology');
const xom = row(stock('XOM'), 50, 5_500, 'Energy');
const spxPut = row(spx('20261009', 5800, 'P'), 1, 2_000, '@etf');
const spxCall = row(spx('20261120', 6200, 'C'), 1, 1_500, '@etf');
const es = row(fop, 1, 500, '@other', { multiplier: 50 });

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

describe('group rows', () => {
  it('are structure only: a label, the rows and the underlying, never a figure of their own', () => {
    const [g] = groupRows([ctx(aapl), ctx(aaplCall), ctx(aaplPut)], 'underlying');
    expect(Object.keys(g).sort()).toEqual(['ctxs', 'key', 'kind', 'label', 'underlying']);
    expect(g.ctxs).toHaveLength(3);
    // No sums, shares of net liquidation or other group figures are computed anywhere.
    for (const gone of ['aggregate', 'inAccountCurrency', 'topShare', 'isConcentrated', 'CONCENTRATION_FLAG']) expect(groupsModule, gone).not.toHaveProperty(gone);
  });
});

describe('group and row order', () => {
  const ctxs = ALL.map((r) => ctx(r));
  const label = (g: RowGroup) => g.label;
  const order = (by: GroupBy, sort: Parameters<typeof orderGroups>[1], labelOf = label) => orderGroups(groupRows(ctxs, by), sort, 'en', labelOf);
  const ids = (...rows: PositionRow[]) => rows.map(rowId);

  it('puts the groups with the largest position first and keeps the rows’ order without a sort', () => {
    expect(order('underlying', null)).toEqual([
      { key: 'u:STK:NVDA', ids: ids(nvda) },
      { key: 'u:STK:AAPL', ids: ids(aapl, aaplCall, aaplPut) },
      { key: 'u:STK:XOM', ids: ids(xom) },
      { key: 'u:IND:SPX', ids: ids(spxPut, spxCall) },
      { key: `u:${contractKey(fop)}`, ids: ids(es) },
    ]);
    expect(order('none', null)).toEqual([{ key: '', ids: ids(...ALL) }]);
  });

  it('orders groups by their best row, never by a sum', () => {
    // Energy: two positions of 6,000 (12,000 together); Technology: one of 10,000. By a sum Energy
    // would lead; by its largest position Technology does, without a sort and sorted by Value.
    const cvx = row(stock('CVX'), 10, 6_000, 'Energy');
    const oxy = row(stock('OXY'), 10, 5_900, 'Energy');
    const msft = row(stock('MSFT'), 10, 10_000, 'Technology');
    const gs = groupRows([ctx(msft), ctx(cvx), ctx(oxy)], 'sector');
    expect(orderGroups(gs, null, 'en', label).map((g) => g.key)).toEqual(['s:Technology', 's:Energy']);
    expect(orderGroups(gs, { id: 'value', dir: 'desc' }, 'en', label).map((g) => g.key)).toEqual(['s:Technology', 's:Energy']);
    // Ascending: the group of the smallest value first, its rows smallest first.
    const asc = orderGroups(gs, { id: 'value', dir: 'asc' }, 'en', label);
    expect(asc.map((g) => g.key)).toEqual(['s:Energy', 's:Technology']);
    expect(asc[0].ids).toEqual(ids(oxy, cvx));
  });

  it('compares the groups’ largest positions in the account currency', () => {
    // 50,000 HKD at 0.128 is 6,400: more than XOM's 5,500 USD, less than AAPL's 10,000.
    const hk = row({ ...stock('700'), currency: 'HKD' }, 100, 50_000, 'Communications', {}, 0.128);
    const gs = groupRows([ctx(aapl), ctx(xom), ctx(hk)], 'sector');
    expect(orderGroups(gs, null, 'en', label).map((g) => g.key)).toEqual(['s:Technology', 's:Communications', 's:Energy']);
  });

  it('sorts groups by their best row on any column, and the rows within them; blanks last', () => {
    const asc = order('underlying', { id: 'value', dir: 'asc' });
    expect(asc.map((g) => g.key)).toEqual(['u:STK:AAPL', `u:${contractKey(fop)}`, 'u:IND:SPX', 'u:STK:XOM', 'u:STK:NVDA']);
    expect(asc[0].ids).toEqual(ids(aaplCall, aaplPut, aapl));
    const desc = order('underlying', { id: 'value', dir: 'desc' });
    expect(desc.map((g) => g.key)).toEqual(['u:STK:NVDA', 'u:STK:AAPL', 'u:STK:XOM', 'u:IND:SPX', `u:${contractKey(fop)}`]);
    expect(desc.find((g) => g.key === 'u:STK:AAPL')!.ids).toEqual(ids(aapl, aaplPut, aaplCall));
    const expiry = order('underlying', { id: 'expiry', dir: 'asc' });
    // SPX expires on 10/9, AAPL’s call on 10/16, ES on 12/18; the stocks have no expiry.
    expect(expiry.map((g) => g.key)).toEqual(['u:IND:SPX', 'u:STK:AAPL', `u:${contractKey(fop)}`, 'u:STK:NVDA', 'u:STK:XOM']);
    expect(expiry[1].ids).toEqual(ids(aaplCall, aaplPut, aapl));
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
    const a = row(stock('BBB'), 10, 1_000, 'Energy');
    const b = row(stock('AAA'), 10, 1_000, 'Energy');
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
