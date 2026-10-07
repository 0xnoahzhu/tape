import { describe, expect, it } from 'vitest';
import { option, stock } from '@shared/contract';
import { createClock } from '@shared/timeFormat';
import type { ContractInfo, ContractRef, Position, Quote } from '@shared/types';
import { positionRow } from './calc';
import { cellColor, cellText, formatValue, type CellWords } from './cells';
import { COLUMN_GROUPS, COLUMN_IDS, COLUMNS, DEFAULT_COLUMNS, applies, contractOrderKey, rowId, todaysHours, type CellCtx, type ColumnId } from './columns';
import { sortBy } from './columnsState';
import { columnTip, usePortfolioMessages } from './messages';

// Tuesday 2026-10-06, 11:00 local.
const NOW = new Date(2026, 9, 6, 11, 0).getTime();
const clock = createClock('24h', 'en');
const en = usePortfolioMessages.for('en');
const words: CellWords = { ...en.words, kinds: en.kinds };

function position(contract: ContractRef, over: Partial<Position> = {}): Position {
  return { account: 'DU1', key: contract.symbol, contract, quantity: 100, avgPrice: 200, multiplier: contract.secType === 'OPT' ? 100 : 1, updatedAt: 0, ...over };
}

const q = (over: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...over });

function ctx(p: Position, opts: { livePx?: number; fx?: number | null; quote?: Quote; info?: ContractInfo | null; grossBase?: number; netLiq?: number } = {}): CellCtx {
  const fx = opts.fx === undefined ? 1 : opts.fx;
  return { row: positionRow(p, opts.livePx, opts.netLiq ?? 1_000_000, 'Technology', fx), q: opts.quote, info: opts.info, grossBase: opts.grossBase, now: NOW };
}

const value = (id: ColumnId, c: CellCtx) => COLUMNS[id].value(c);
const text = (id: ColumnId, c: CellCtx) => cellText(COLUMNS[id], c, words, clock);

const aaplStock = { ...stock('AAPL', 'NASDAQ'), conId: 265598 };
const aapl = position(aaplStock, {
  averageCost: 200,
  marketPrice: 220,
  marketValue: 22_000,
  unrealizedPnL: 2_000,
  realizedPnL: 0,
  dailyPnL: 150,
  pnlValue: 22_748,
  pnlUnrealized: 2_748,
  pnlRealized: 12.5,
  industry: 'Technology',
  stockType: 'COMMON',
});
const aaplQuote = q({ last: 227.48, bid: 227.45, ask: 227.5, bidSize: 300, askSize: 200, close: 225, volume: 41_200_000, marketDataType: 1, haltCode: 0, lastRthTrade: 227.1 });

const call = { ...option('AAPL', '20261016', 230, 'C'), conId: 7001 };
const aaplCall = position(call, { quantity: 10, avgPrice: 3.1, averageCost: 310 });
const callQuote = q({ bid: 3.1, ask: 3.3, mark: 3.2, iv: 0.27, delta: 0.45, gamma: 0.03, theta: -0.09, vega: 0.2, undPrice: 227.48, optPrice: 3.18, pvDividend: 0.26, openInterest: 5_120 });

describe('column catalog', () => {
  it('lists every column once, each with a definition in its group', () => {
    expect(new Set(COLUMN_IDS).size).toBe(COLUMN_IDS.length);
    expect(Object.keys(COLUMNS).sort()).toEqual([...COLUMN_IDS].sort());
    for (const id of COLUMN_IDS) {
      expect(COLUMNS[id].id).toBe(id);
      expect(COLUMN_GROUPS).toContain(COLUMNS[id].group);
    }
    // The editor lists the groups in catalog order.
    const groups = COLUMN_IDS.map((id) => COLUMNS[id].group);
    expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([...COLUMN_GROUPS]);
  });

  it("defaults to today's eight columns", () => {
    expect(DEFAULT_COLUMNS).toEqual(['symbol', 'quantity', 'avgPrice', 'price', 'value', 'weight', 'unrealized', 'dayPnl']);
  });

  it('names every column and says where its value comes from, in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const m = usePortfolioMessages.for(lang);
      for (const id of COLUMN_IDS) {
        expect(m.columns[id][0], `${lang} ${id}`).toBeTruthy();
        expect(m.columns[id][1], `${lang} ${id}`).toBeTruthy();
        // A calculated column gives its formula; an IB column its source, never both.
        if (COLUMNS[id].kind === 'calc') {
          expect(m.formulas[id], `${lang} formula ${id}`).toBeTruthy();
          expect(m.sources[id], `${lang} source ${id}`).toBeUndefined();
        } else {
          expect(m.sources[id], `${lang} source ${id}`).toBeTruthy();
          expect(m.formulas[id], `${lang} formula ${id}`).toBeUndefined();
        }
      }
    }
  });

  it('starts a tooltip with the source or, for a calculation, "Calculated by Tape:"', () => {
    expect(columnTip(en, 'costBasis')).toBe('Calculated by Tape: Quantity × IB average cost\nCost basis');
    expect(columnTip(en, 'bid').startsWith('IB · tick 1 Bid')).toBe(true);
  });

  it('marks the calculated default columns', () => {
    expect(DEFAULT_COLUMNS.filter((id) => COLUMNS[id].kind === 'calc')).toEqual(['avgPrice', 'price', 'value', 'weight', 'unrealized', 'dayPnl']);
  });
});

describe('column applicability', () => {
  const fut = position({ symbol: 'MES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 5, conId: 9 }, { quantity: 2, multiplier: 5 });
  const cash = position({ symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' });
  const rows = { stk: ctx(aapl).row, opt: ctx(aaplCall).row, fut: ctx(fut).row, cash: ctx(cash).row };
  const on = (id: ColumnId) => Object.entries(rows).flatMap(([k, r]) => (applies(COLUMNS[id], r) ? [k] : []));

  it('limits type-specific columns to their instruments', () => {
    expect(on('quantity')).toEqual(['stk', 'opt', 'fut', 'cash']);
    expect(on('strike')).toEqual(['opt']);
    expect(on('expiry')).toEqual(['opt', 'fut']);
    expect(on('delta')).toEqual(['opt']);
    expect(on('positionDelta')).toEqual(['stk', 'opt', 'fut']);
    expect(on('stockType')).toEqual(['stk']);
    expect(on('lastRthTrade')).toEqual(['stk']);
    // Only option lines ask for the mark.
    expect(on('mark')).toEqual(['opt']);
    // Forex quotes carry no trades.
    expect(on('last')).toEqual(['stk', 'opt', 'fut']);
    expect(on('bid')).toEqual(['stk', 'opt', 'fut', 'cash']);
    // A bond's details carry no name or minimum tick of IB's (only Tape's defaults).
    const bond = ctx(position({ symbol: 'US912810TM08', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 11 })).row;
    expect(applies(COLUMNS.name, bond)).toBe(false);
    expect(applies(COLUMNS.minTick, bond)).toBe(false);
    expect(on('name')).toEqual(['stk', 'opt', 'fut', 'cash']);
  });

  it('shows IB’s own contract fields, never Tape’s stand-ins', () => {
    // updatePortfolio names no exchange; SMART is Tape's placeholder until the position message.
    expect(text('exchange', ctx({ ...fut, contract: { ...fut.contract, exchange: 'SMART' } }))).toBe('—');
    expect(value('exchange', ctx(fut))).toBe('CME');
    // The multiplier as IB sent it: a stock's is 1, an option without IB's is unknown (not 100).
    expect(value('multiplier', ctx(fut))).toBe(5);
    expect(value('multiplier', ctx(aapl))).toBe(1);
    const bare = { ...call, multiplier: undefined };
    expect(text('multiplier', ctx(position(bare)))).toBe('—');
    expect(value('multiplier', ctx(aaplCall))).toBe(100);
  });

  it('writes forex prices to IB’s precision', () => {
    const c = ctx(cash, { livePx: 1.08345, quote: q({ bid: 1.0834, ask: 1.0835, close: 1.0821 }) });
    expect(text('bid', c)).toBe('1.08340');
    expect(text('mid', c)).toBe('1.08345');
    expect(text('spread', c)).toBe('0.00010');
    expect(text('price', c)).toBe('1.08345');
    expect(text('change', c)).toBe('+0.00135');
    const jpy = position({ symbol: 'USD', secType: 'CASH', exchange: 'IDEALPRO', currency: 'JPY' });
    expect(text('ask', ctx(jpy, { livePx: 150.125, quote: q({ bid: 150.12, ask: 150.125 }) }))).toBe('150.125');
    // Others keep the shared price format.
    expect(text('bid', ctx(aapl, { quote: aaplQuote }))).toBe('227.45');
  });

  it('leaves a cell empty when the column does not apply and shows — when IB has not sent the value', () => {
    const c = ctx(aapl, { livePx: 227.48 });
    expect(text('strike', c)).toBe('');
    expect(text('bid', c)).toBe('—');
    expect(text('name', c)).toBe('—');
    expect(text('bid', { ...c, q: aaplQuote })).toBe('227.45');
  });
});

describe('column values', () => {
  it('reads a stock with a live quote', () => {
    const c = ctx(aapl, { livePx: 227.48, quote: aaplQuote, netLiq: 1_284_530 });
    expect(value('quantity', c)).toBe(100);
    expect(value('averageCost', c)).toBe(200);
    expect(value('costBasis', c)).toBe(20_000);
    expect(value('price', c)).toBe(227.48);
    expect(value('value', c)).toBeCloseTo(22_748);
    expect(value('weight', c)).toBeCloseTo((22_748 / 1_284_530) * 100);
    expect(value('unrealized', c)).toBeCloseTo(2_748);
    expect(COLUMNS.unrealized.sub!.value(c)).toBeCloseTo(13.74);
    // IB's own values, as sent.
    expect(value('marketPriceIb', c)).toBe(220);
    expect(value('marketValueIb', c)).toBe(22_000);
    expect(value('unrealizedIb', c)).toBe(2_000);
    expect(value('dailyPnlIb', c)).toBe(150);
    expect(value('unrealizedPnlIb', c)).toBe(2_748);
    expect(value('realizedPnlIb', c)).toBe(12.5);
    expect(value('valuePnlIb', c)).toBe(22_748);
    expect(value('totalPnl', c)).toBeCloseTo(2_760.5);
    // Quote and contract.
    expect(value('mid', c)).toBeCloseTo(227.475);
    expect(value('spread', c)).toBeCloseTo(0.05);
    expect(value('spreadPct', c)).toBeCloseTo((0.05 / 227.475) * 100);
    expect(text('spreadPct', c)).toBe('0.022%');
    expect(value('change', c)).toBeCloseTo(2.48);
    expect(value('changePct', c)).toBeCloseTo((227.48 / 225 - 1) * 100);
    expect(value('exchange', c)).toBe('NASDAQ');
    expect(value('conId', c)).toBe(265598);
    expect(text('conId', c)).toBe('265598');
    expect(value('positionDelta', c)).toBe(100);
    expect(value('deltaDollars', c)).toBeCloseTo(22_748);
    expect(text('halted', c)).toBe('Trading');
    expect(text('dataType', c)).toBe('Live');
    expect(text('dataType', { ...c, q: { ...aaplQuote, marketDataType: 3, source: { kind: 'primary', exchange: 'ARCA' } } })).toBe('Delayed · ARCA');
    expect(text('volume', c)).toBe('41.2M');
  });

  it('does not take the previous close as today’s price', () => {
    const c = ctx(aapl, { quote: q({ close: 225 }) });
    expect(value('change', c)).toBeUndefined();
    expect(value('change', ctx(aapl, { quote: q({ close: 225, bid: 226, ask: 226.2 }) }))).toBeCloseTo(1.1);
  });

  it('reads an option with its model greeks', () => {
    const c = ctx(aaplCall, { livePx: 3.2, quote: callQuote });
    expect(value('price', c)).toBe(3.2);
    expect(value('averageCost', c)).toBe(310);
    expect(value('costBasis', c)).toBe(3_100);
    expect(value('daysToExpiry', c)).toBe(10);
    expect(text('daysToExpiry', c)).toBe('10d');
    expect(text('expiry', c)).toBe('2026-10-16');
    expect(text('right', c)).toBe('Call');
    expect(value('underlying', c)).toBe('AAPL');
    expect(text('optIv', c)).toBe('27.0%');
    expect(value('optModelPrice', c)).toBe(3.18);
    expect(value('pvDividend', c)).toBe(0.26);
    expect(value('moneyness', c)).toBeCloseTo(((227.48 - 230) / 230) * 100);
    expect(value('intrinsic', c)).toBe(0);
    expect(value('extrinsic', c)).toBeCloseTo(3.2);
    expect(value('breakEven', c)).toBeCloseTo(233.1);
    expect(value('positionDelta', c)).toBeCloseTo(450);
    expect(value('deltaDollars', c)).toBeCloseTo(450 * 227.48);
    expect(value('positionGamma', c)).toBeCloseTo(30);
    expect(value('positionTheta', c)).toBeCloseTo(-90);
    expect(value('positionVega', c)).toBeCloseTo(200);
    expect(text('positionTheta', c)).toBe('−90');
    expect(cellColor(COLUMNS.positionTheta, value('positionTheta', c))).toBe('var(--dn)');
    // Greeks wait for IB's model: no partial values.
    expect(value('positionDelta', ctx(aaplCall, { quote: q({ bid: 3.1, ask: 3.3 }) }))).toBeUndefined();
  });

  it('values a short put in the money', () => {
    const put = position({ ...option('SPY', '20261120', 560, 'P'), conId: 7002 }, { quantity: -5, avgPrice: 6.8 });
    const c = ctx(put, { livePx: 12, quote: q({ bid: 11.9, ask: 12.1, undPrice: 550, delta: -0.62 }) });
    expect(value('intrinsic', c)).toBe(10);
    expect(value('extrinsic', c)).toBeCloseTo(2);
    expect(value('moneyness', c)).toBeCloseTo((10 / 560) * 100);
    expect(value('breakEven', c)).toBeCloseTo(553.2);
    expect(value('positionDelta', c)).toBeCloseTo(310);
    expect(text('right', c)).toBe('Put');
  });

  it('converts a foreign-currency position with IB’s exchange rate', () => {
    const sap = position({ symbol: 'SAP', secType: 'STK', exchange: 'SMART', primaryExchange: 'IBIS', currency: 'EUR', conId: 14204 }, { quantity: 50 });
    const c = ctx(sap, { livePx: 220, fx: 1.08, netLiq: 1_000_000 });
    expect(value('currency', c)).toBe('EUR');
    expect(value('fxRate', c)).toBe(1.08);
    expect(value('value', c)).toBe(11_000);
    expect(value('valueBase', c)).toBeCloseTo(11_880);
    expect(value('weight', c)).toBeCloseTo(1.188);
    expect(value('pctGross', { ...c, grossBase: 23_760 })).toBeCloseTo(50);
    // Without the rate the base-currency figures are unknown, never the unconverted value.
    const unknown = ctx(sap, { livePx: 220, fx: null });
    expect(value('valueBase', unknown)).toBeUndefined();
    expect(value('weight', unknown)).toBeUndefined();
    expect(text('fxRate', unknown)).toBe('—');
  });

  it('reads contract details', () => {
    const info: ContractInfo = {
      contract: aaplStock,
      longName: 'APPLE INC',
      industry: 'Technology',
      subcategory: 'Computers',
      minTick: 0.01,
      timeZoneId: 'US/Eastern',
      liquidHours: '20261006:0930-20261006:1600;20261007:0930-20261007:1600',
    };
    // 11:00 in New York (the hours are the instrument's).
    const c = { ...ctx(aapl, { info }), now: Date.UTC(2026, 9, 6, 15, 0) };
    expect(value('name', c)).toBe('APPLE INC');
    expect(value('subcategory', c)).toBe('Computers');
    expect(text('minTick', c)).toBe('0.01');
    expect(value('liquidHours', c)).toBe('0930-1600');
    expect(text('liquidHours', c)).toBe('09:30–16:00');
    expect(COLUMNS.liquidHours.title!(c)).toBe('US/Eastern');
    expect(text('tradingHours', c)).toBe('—');
  });
});

describe("today's trading hours", () => {
  // 11:00 in New York.
  const at = Date.UTC(2026, 9, 6, 15, 0);
  it('takes the sessions ending today in the instrument’s zone', () => {
    expect(todaysHours('20261006:0400-20261006:2000;20261007:0400-20261007:2000', 'US/Eastern', at)).toBe('0400-2000');
    expect(todaysHours('20261006:CLOSED;20261007:0930-20261007:1600', 'US/Eastern', at)).toBe('CLOSED');
    // A futures session from the evening before counts for the day it ends.
    expect(todaysHours('20261005:1700-20261006:1600;20261006:1700-20261007:1600', 'US/Central', at)).toBe('1700-1600');
    // Older servers leave out the end date.
    expect(todaysHours('20261006:0930-1200,1300-1600', 'US/Eastern', at)).toBe('0930-1200,1300-1600');
    expect(todaysHours('20261007:0930-20261007:1600', 'US/Eastern', at)).toBeUndefined();
    expect(todaysHours(undefined, 'US/Eastern', at)).toBeUndefined();
    // An unknown zone falls back to the local date.
    expect(() => todaysHours('20261006:0930-1600', 'Nowhere/Else', at)).not.toThrow();
  });
});

describe('cell formats', () => {
  it('writes IB codes as words', () => {
    expect(formatValue('kind', 'FOP', words, clock, NOW)).toBe('Future option');
    expect(formatValue('halt', 2, words, clock, NOW)).toBe('Volatility halt');
    expect(formatValue('dataType', 4, words, clock, NOW)).toBe('Delayed frozen');
    expect(formatValue('hours', 'CLOSED', words, clock, NOW)).toBe('Closed');
    expect(formatValue('hours', '0930-1200,1300-1600', words, clock, NOW)).toBe('09:30–12:00, 13:00–16:00');
    const zh = usePortfolioMessages.for('zh');
    expect(formatValue('right', 'P', { ...zh.words, kinds: zh.kinds }, clock, NOW)).toBe('看跌');
    expect(formatValue('days', 3, { ...zh.words, kinds: zh.kinds }, clock, NOW)).toBe('3天');
  });

  it('writes numbers with the shared helpers', () => {
    expect(formatValue('pnl', 2_748.4, words, clock, NOW)).toBe('+2,748');
    expect(formatValue('chg', -0.5, words, clock, NOW)).toBe('−0.50');
    expect(formatValue('pctU', 12.94, words, clock, NOW)).toBe('12.9%');
    expect(formatValue('big', 5_120, words, clock, NOW)).toBe('5,120');
    expect(formatValue('dec', 5, words, clock, NOW)).toBe('5');
    expect(formatValue('num4', 1.08, words, clock, NOW)).toBe('1.0800');
    expect(formatValue('greek4', 0.0012, words, clock, NOW)).toBe('0.0012');
    expect(formatValue('px', undefined, words, clock, NOW)).toBe('—');
    expect(formatValue('px', Number.NaN, words, clock, NOW)).toBe('—');
  });

  it('writes the time of day, with the date when it is not today', () => {
    expect(formatValue('time', new Date(2026, 9, 6, 9, 41).getTime(), words, clock, NOW)).toBe('09:41');
    expect(formatValue('time', new Date(2026, 9, 5, 16, 0).getTime(), words, clock, NOW)).toBe('10/05 16:00');
  });
});

describe('symbol order', () => {
  it('puts a stock’s options right after it, by expiry, strike and right', () => {
    const contracts: ContractRef[] = [
      stock('AMZN'),
      option('AAPL', '20261120', 200, 'C'),
      option('AAPL', '20261016', 230, 'P'),
      stock('AAPL'),
      option('AAPL', '20261016', 230, 'C'),
      option('AAPL', '20261016', 95, 'C'),
    ];
    const sorted = sortBy(contracts, contractOrderKey, 'text', 'asc');
    expect(sorted.map((c) => (c.secType === 'STK' ? c.symbol : `${c.symbol} ${c.lastTradeDate} ${c.strike}${c.right}`))).toEqual([
      'AAPL',
      'AAPL 20261016 95C',
      'AAPL 20261016 230C',
      'AAPL 20261016 230P',
      'AAPL 20261120 200C',
      'AMZN',
    ]);
  });

  it('identifies rows by conId, else by key', () => {
    expect(rowId(ctx(aapl).row)).toBe('265598');
    expect(rowId(ctx(position(stock('MSFT'))).row)).toBe('MSFT');
  });
});
