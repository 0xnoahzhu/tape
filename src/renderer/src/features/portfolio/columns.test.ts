import { describe, expect, it } from 'vitest';
import { contractKey, option, stock } from '@shared/contract';
import { ADD_ON_TICKS } from '@shared/quoteProfiles';
import { createClock } from '@shared/timeFormat';
import type { ContractInfo, ContractRef, EarningsEvent, Position, Quote, SecType } from '@shared/types';
import { positionRow, quoteContract } from './calc';
import { cellColor, cellText, formatValue, type CellWords } from './cells';
import {
  COLUMN_GROUPS,
  COLUMN_IDS,
  COLUMNS,
  DEFAULT_COLUMNS,
  addOnSubscriptions,
  applies,
  contractOrderKey,
  rowId,
  todaysHours,
  zonedInstant,
  type CellCtx,
  type ColumnId,
} from './columns';
import { sortBy } from './columnsState';
import { columnTip, usePortfolioMessages } from './messages';

// Tuesday 2026-10-06, 11:00 local.
const NOW = new Date(2026, 9, 6, 11, 0).getTime();
/** The same morning in New York, where days to a date are counted (whatever the machine's zone). */
const NY_MORNING = Date.UTC(2026, 9, 6, 15, 0);
const clock = createClock('24h', 'en');
const en = usePortfolioMessages.for('en');
const words: CellWords = { ...en.words, kinds: en.kinds };

function position(contract: ContractRef, over: Partial<Position> = {}): Position {
  return { account: 'DU1', key: contract.symbol, contract, quantity: 100, avgPrice: 200, multiplier: contract.secType === 'OPT' ? 100 : 1, updatedAt: 0, ...over };
}

const q = (over: Partial<Quote>): Quote => ({ key: 'k', updatedAt: 0, ...over });

function ctx(
  p: Position,
  opts: { livePx?: number; fx?: number | null; quote?: Quote; info?: ContractInfo | null; grossBase?: number; netLiq?: number; earnings?: EarningsEvent } = {},
): CellCtx {
  const fx = opts.fx === undefined ? 1 : opts.fx;
  return { row: positionRow(p, opts.livePx, opts.netLiq ?? 1_000_000, 'Technology', fx), q: opts.quote, info: opts.info, grossBase: opts.grossBase, earnings: opts.earnings, now: NOW };
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
    // The editor lists the groups in catalog order, each contiguous.
    const groups = COLUMN_IDS.map((id) => COLUMNS[id].group);
    expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([...COLUMN_GROUPS]);
    expect(COLUMN_GROUPS).toEqual(['position', 'ibPnl', 'contract', 'quote', 'stats', 'short', 'income', 'options', 'other']);
    expect(COLUMN_IDS).toHaveLength(145);
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

  it('says why an unverified column is not verified yet, in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const m = usePortfolioMessages.for(lang);
      for (const id of COLUMN_IDS) {
        if (COLUMNS[id].unverified) expect(m.unverified[id], `${lang} ${id}`).toBeTruthy();
        else expect(m.unverified[id], `${lang} ${id}`).toBeUndefined();
      }
    }
    expect(columnTip(en, 'borrowFee').split('\n')).toEqual([
      'IB · tick 111 SLB rate – fee (generic tick 499), as sent',
      'Borrow fee rate',
      'Not yet verified: the unit: read as an annual rate (0.0025 = 0.25 %), not yet compared with TWS',
    ]);
    expect(columnTip(usePortfolioMessages.for('zh'), 'vwap').split('\n').at(-1)).toBe('尚未核实： 常规时段以外 IB 未发送 RTVolume');
    expect(columnTip(en, 'shortable').split('\n')).toHaveLength(2);
  });

  it('asks for extra ticks only on types the profile has ticks for, and never for a default column', () => {
    for (const id of COLUMN_IDS) {
      const { profile, types, needs } = COLUMNS[id];
      if (!profile) continue;
      expect(needs, id).toBe('quote');
      const allowed = profile === 'dividends' ? ['STK'] : Object.keys(ADD_ON_TICKS[profile]);
      expect(types, id).toBeDefined();
      for (const t of types!) expect(allowed, `${id} ${t}`).toContain(t);
    }
    expect(DEFAULT_COLUMNS.filter((id) => COLUMNS[id].profile)).toEqual([]);
  });

  it('marks the calculated default columns', () => {
    expect(DEFAULT_COLUMNS.filter((id) => COLUMNS[id].kind === 'calc')).toEqual(['avgPrice', 'price', 'value', 'weight', 'unrealized', 'dayPnl']);
  });

  it('adds up on a group row only the columns where a sum means something', () => {
    expect(Object.fromEntries(COLUMN_IDS.filter((id) => COLUMNS[id].agg).map((id) => [id, COLUMNS[id].agg]))).toEqual({
      // A share of net liquidation, or an amount in the account currency.
      weight: 'sum',
      valueBase: 'sum',
      pctGross: 'sum',
      // An amount in the contract's currency.
      value: 'money',
      costBasis: 'money',
      unrealized: 'money',
      dayPnl: 'money',
      marketValueIb: 'money',
      unrealizedIb: 'money',
      realizedIb: 'money',
      dailyPnlIb: 'money',
      unrealizedPnlIb: 'money',
      realizedPnlIb: 'money',
      valuePnlIb: 'money',
      totalPnl: 'money',
      annualDividends: 'money',
      deltaDollars: 'money',
      positionTheta: 'money',
      positionVega: 'money',
      // Share equivalents of one underlying.
      positionDelta: 'units',
      positionGamma: 'units',
    });
    // Every summed column is a number.
    for (const id of COLUMN_IDS) if (COLUMNS[id].agg) expect(COLUMNS[id].sort, id).toBe('num');
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
    // Option lines carry the mark; the others ask for it while the column is shown.
    expect(on('mark')).toEqual(['stk', 'opt', 'fut', 'cash']);
    // Forex quotes carry no trades.
    expect(on('last')).toEqual(['stk', 'opt', 'fut']);
    expect(on('bid')).toEqual(['stk', 'opt', 'fut', 'cash']);
    // A bond's details arrive whole: IB's name and minimum tick.
    const bond = ctx(position({ symbol: 'US912810TM08', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 11 })).row;
    expect(applies(COLUMNS.name, bond)).toBe(true);
    expect(applies(COLUMNS.minTick, bond)).toBe(true);
    expect(applies(COLUMNS.cusip, bond)).toBe(true);
    expect(on('name')).toEqual(['stk', 'opt', 'fut', 'cash']);
    expect(on('underlying')).toEqual(['opt', 'fut']);
    expect(on('contractMonth')).toEqual(['opt', 'fut']);
    expect(on('high52w')).toEqual(['stk']);
    expect(on('impliedVol30')).toEqual(['stk', 'fut']);
    expect(on('futuresOpenInterest')).toEqual(['fut']);
    expect(on('nextEarnings')).toEqual(['stk', 'opt']);
    expect(on('cusip')).toEqual([]);
    // ETF columns: stocks IB types as exchange-traded only.
    expect(on('etfNav')).toEqual([]);
    const spy = ctx(position({ ...stock('SPY', 'ARCA'), conId: 756733 }, { stockType: 'ETF' })).row;
    expect(applies(COLUMNS.etfNav, spy)).toBe(true);
    expect(applies(COLUMNS.navPremium, spy)).toBe(true);
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
    expect(value('daysToExpiry', { ...c, now: NY_MORNING })).toBe(10);
    expect(text('daysToExpiry', { ...c, now: NY_MORNING })).toBe('10d');
    // Thursday 10/15 13:00 in New York (Friday 01:00 in Shanghai): the Friday expiry is a day away.
    expect(value('daysToExpiry', { ...c, now: Date.UTC(2026, 9, 15, 17, 0) })).toBe(1);
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
    expect(COLUMNS.liquidHours.title!(c, words)).toBe('US/Eastern');
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

describe('the extra ticks of the shown columns', () => {
  const spy = position({ ...stock('SPY'), exchange: 'ARCA', conId: 756733 }, { stockType: 'ETF', key: 'SPY' });
  const fut = position({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 50, conId: 515416632 }, { quantity: 1, multiplier: 50 });
  const cash = position({ symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD', conId: 12087792 });
  const rows = [aapl, aaplCall, spy, fut, cash].map((p) => ctx(p).row);
  const subsOf = (...ids: ColumnId[]) => addOnSubscriptions(rows, ids.map((id) => COLUMNS[id])).map((s) => `${contractKey(s.contract)}|${s.profile}`);

  it('asks for nothing with the default columns', () => {
    expect(addOnSubscriptions(rows, DEFAULT_COLUMNS.map((id) => COLUMNS[id]))).toEqual([]);
    expect(addOnSubscriptions(rows, COLUMN_IDS.filter((id) => !COLUMNS[id].profile).map((id) => COLUMNS[id]))).toEqual([]);
  });

  it('asks per position and profile, only where the column applies and the profile has ticks', () => {
    // One entry for the three range columns; the ETF is a stock too.
    expect(subsOf('high52w', 'from52wHigh', 'relVolume')).toEqual(['STK:AAPL|range', 'STK:SPY|range']);
    // NAV for the ETF only.
    expect(subsOf('etfNav', 'navPremium')).toEqual(['STK:SPY|etfNav']);
    // Options carry the mark already; forex and futures ask for it.
    expect(subsOf('mark')).toEqual(['CASH:EUR|mark', 'FUT:ES:20261218|mark', 'STK:AAPL|mark', 'STK:SPY|mark']);
    expect(subsOf('impliedVol30', 'futuresOpenInterest')).toEqual(['FUT:ES:20261218|futuresOi', 'FUT:ES:20261218|volatility', 'STK:AAPL|volatility', 'STK:SPY|volatility']);
    expect(subsOf('divYield', 'divNextDate')).toEqual(['STK:AAPL|dividends', 'STK:SPY|dividends']);
    expect(subsOf('bidYield', 'cusip', 'nextEarnings')).toEqual([]);
  });

  it('asks for the portfolio’s own quote contracts, so no new line opens', () => {
    const subs = addOnSubscriptions(rows, [COLUMNS.shortable, COLUMNS.futuresOpenInterest]);
    expect(subs.map((s) => s.contract)).toEqual([quoteContract(fut.contract), quoteContract(aapl.contract), quoteContract(spy.contract)]);
    // SPY's position names its listing; the quote is SMART-routed, as the portfolio's.
    expect(subs[2].contract).toMatchObject({ exchange: 'SMART', primaryExchange: 'ARCA' });
  });

  it('is the same list for the same columns in any order', () => {
    const a = addOnSubscriptions(rows, [COLUMNS.vwap, COLUMNS.high52w, COLUMNS.low52w]);
    const b = addOnSubscriptions([...rows].reverse(), [COLUMNS.low52w, COLUMNS.vwap, COLUMNS.high52w]);
    expect(b).toEqual(a);
  });
});

describe('the columns of extra market data, earnings and contract details', () => {
  it('reads a stock’s statistics, short-sale data and dividends', () => {
    const quote = q({
      ...aaplQuote,
      volume: 22_794_339,
      week52High: 260,
      week52Low: 169.21,
      week26High: 250,
      week13Low: 201.5,
      avgVolume: 45_588_678,
      impliedVol: 0.2636,
      rtHistVol: 0.231,
      callVolume: 462_487,
      callOpenInterest: 2_275_669,
      avgOptionVolume: 1_339_031,
      tradeRate: 12,
      volume10m: 320,
      vwap: 226.91,
      auctionImbalance: -25_000,
      shortable: 3,
      shortableShares: 191_230_895,
      borrowFee: 0.0025,
      dividends: { past12m: 1.06, next12m: 1.1, nextDate: '20261109', nextAmount: 0.27 },
    });
    const c = ctx(aapl, { livePx: 227.48, quote });
    expect(value('from52wHigh', c)).toBeCloseTo((227.48 / 260 - 1) * 100);
    expect(text('from52wHigh', c)).toBe('−12.51%');
    expect(cellColor(COLUMNS.from52wHigh, value('from52wHigh', c))).toBe('var(--dn)');
    expect(value('from52wLow', c)).toBeCloseTo((227.48 / 169.21 - 1) * 100);
    expect(text('high26w', c)).toBe('250.00');
    expect(text('low13w', c)).toBe('201.50');
    expect(text('avgVolume', c)).toBe('45.6M');
    expect(text('relVolume', c)).toBe('0.50×');
    expect(text('impliedVol30', c)).toBe('26.4%');
    expect(text('rtHistVol', c)).toBe('23.1%');
    expect(text('callVolume', c)).toBe('462.5K');
    expect(text('callOpenInterest', c)).toBe('2.3M');
    expect(text('avgOptionVolume', c)).toBe('1.3M');
    expect(text('tradeRate', c)).toBe('12');
    expect(text('volume10m', c)).toBe('320');
    expect(text('vwap', c)).toBe('226.91');
    expect(text('auctionImbalance', c)).toBe('−25.0K');
    expect(text('shortable', c)).toBe('Easy');
    expect(COLUMNS.shortable.title!(c, words)).toBe('IB 3');
    expect(text('shortableShares', c)).toBe('191.2M');
    expect(text('borrowFee', c)).toBe('0.0025');
    expect(text('divPast12m', c)).toBe('1.06');
    expect(text('divNext12m', c)).toBe('1.10');
    expect(text('divNextDate', c)).toBe('2026-11-09');
    expect(text('divNextAmount', c)).toBe('0.27');
    expect(value('divYield', c)).toBeCloseTo((1.1 / 227.48) * 100);
    expect(text('divYield', c)).toBe('0.484%');
    expect(value('annualDividends', c)).toBeCloseTo(110);
    expect(text('annualDividends', c)).toBe('+110');
    expect(value('daysToDividend', { ...c, now: NY_MORNING })).toBe(34);
    // A short position pays the dividends.
    const short = ctx({ ...aapl, quantity: -100 }, { livePx: 227.48, quote });
    expect(text('annualDividends', short)).toBe('−110');
    expect(cellColor(COLUMNS.annualDividends, value('annualDividends', short))).toBe('var(--dn)');
    // A delayed line has none of them: "—", never an older value.
    const bare = ctx(aapl, { livePx: 227.48, quote: aaplQuote });
    for (const id of ['high52w', 'from52wHigh', 'relVolume', 'shortable', 'divYield', 'daysToDividend', 'vwap'] as const) expect(text(id, bare), id).toBe('—');
  });

  it('shows no dividend as 0 when IB says the stock pays none, and "—" while IB has sent nothing', () => {
    // IB's ",,," (tickMap.ts → parseDividends): the summary came, without amounts or a date.
    const none = ctx(aapl, { livePx: 227.48, quote: q({ ...aaplQuote, dividends: {} }) });
    expect([text('divPast12m', none), text('divNext12m', none), text('divYield', none), text('annualDividends', none)]).toEqual(['0.00', '0.00', '0.000%', '+0']);
    const short = ctx({ ...aapl, quantity: -100 }, { livePx: 227.48, quote: q({ ...aaplQuote, dividends: {} }) });
    expect(Object.is(value('annualDividends', short), 0)).toBe(true);
    expect(cellColor(COLUMNS.annualDividends, value('annualDividends', short))).not.toBe('var(--dn)');
    // No next dividend to date or size.
    expect([text('divNextDate', none), text('divNextAmount', none), text('daysToDividend', none)]).toEqual(['—', '—', '—']);
    const bare = ctx(aapl, { livePx: 227.48, quote: aaplQuote });
    for (const id of ['divPast12m', 'divNext12m', 'divYield', 'annualDividends'] as const) expect(text(id, bare), id).toBe('—');
  });

  it('reads a price at its 52-week high as 0 % from it, through IB’s float32 noise', () => {
    // The probe's AAPL: 345.34 arrives as 345.33999634.
    const quote = q({ ...aaplQuote, last: 345.34, week52High: 345.33999634, week52Low: 345.34000397 });
    const c = ctx(aapl, { livePx: 345.34, quote });
    expect(value('from52wHigh', c)).toBe(0);
    expect(value('from52wLow', c)).toBe(0);
    expect(cellColor(COLUMNS.from52wHigh, value('from52wHigh', c))).toBe(cellColor(COLUMNS.from52wHigh, 0));
    // A real difference of one cent still counts.
    expect(value('from52wHigh', ctx(aapl, { livePx: 345.35, quote }))).toBeGreaterThan(0);
  });

  it('writes IB’s shortable code as words, by its thresholds', () => {
    const at = (shortable: number) => text('shortable', ctx(aapl, { quote: q({ shortable }) }));
    expect([at(3), at(2.6), at(2.5), at(2), at(1.5), at(0)]).toEqual(['Easy', 'Easy', 'Locate', 'Locate', 'No', 'No']);
    const zh = usePortfolioMessages.for('zh');
    expect(cellText(COLUMNS.shortable, ctx(aapl, { quote: q({ shortable: 2 }) }), { ...zh.words, kinds: zh.kinds }, clock)).toBe('需借券');
  });

  it('reads an ETF’s NAV and its premium', () => {
    const spy = position({ ...stock('SPY', 'ARCA'), conId: 756733 }, { stockType: 'ETF', key: 'SPY', avgPrice: 500 });
    const c = ctx(spy, { livePx: 571.3, quote: q({ last: 571.3, etfNav: 571.0, etfNavHigh: 572.4, etfNavLow: 569.9 }) });
    expect(text('etfNav', c)).toBe('571.00');
    expect(text('etfNavHigh', c)).toBe('572.40');
    expect(value('navPremium', c)).toBeCloseTo((571.3 / 571 - 1) * 100);
    expect(text('navPremium', c)).toBe('+0.05%');
    // Not an ETF: the cell is empty.
    expect(text('etfNav', ctx(aapl, { livePx: 227.48, quote: q({ etfNav: 1 }) }))).toBe('');
  });

  it('reads a future’s open interest, IV, mark and volume rate', () => {
    const fut = position({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 50, conId: 515416632 }, { quantity: 1, multiplier: 50 });
    const c = ctx(fut, { livePx: 7877, quote: q({ marketDataType: 3, futuresOpenInterest: 1_921_143, mark: 7877.65, impliedVol: 0.12183, volumeRate: 154 }) });
    expect(text('futuresOpenInterest', c)).toBe('1.9M');
    expect(text('mark', c)).toBe('7,877.65');
    expect(text('impliedVol30', c)).toBe('12.2%');
    expect(text('volumeRate', c)).toBe('154');
    // Stock-only columns stay empty.
    expect(text('divYield', c)).toBe('');
  });

  it('shows 321 in Quote status while IB refused the line’s extra ticks', () => {
    const c = ctx(aapl, { quote: q({ last: 227.48, ticksRefused: 'addOns' }) });
    expect(text('quoteStatus', c)).toBe('321');
    expect(COLUMNS.quoteStatus.title!(c, words)).toBe(en.words.ticksRefused.addOns);
    // IB's own error comes first.
    const err = ctx(aapl, { quote: q({ ticksRefused: 'all', error: { code: 10197, message: 'No market data during competing live session' } }) });
    expect(text('quoteStatus', err)).toBe('10197');
    expect(COLUMNS.quoteStatus.title!(err, words)).toBe('No market data during competing live session');
    expect(text('quoteStatus', ctx(aapl, { quote: q({ last: 1 }) }))).toBe('—');
  });

  it('shows the earnings from Wall Street Horizon and Tape’s estimate in their own columns; options their underlying’s', () => {
    const wsh: EarningsEvent = { key: 'STK:AAPL', date: '20261030', time: 'amc' };
    const est: EarningsEvent = { key: 'STK:AAPL', date: '20261030', estimated: true };
    expect(text('nextEarnings', ctx(aapl, { earnings: wsh }))).toBe('2026-10-30 AMC');
    expect(text('nextEarningsEst', ctx(aapl, { earnings: wsh }))).toBe('—');
    expect(text('nextEarnings', ctx(aapl, { earnings: est }))).toBe('—');
    expect(text('nextEarningsEst', ctx(aapl, { earnings: est }))).toBe('2026-10-30');
    expect(text('nextEarnings', ctx(aaplCall, { earnings: { ...wsh, time: 'bmo' } }))).toBe('2026-10-30 BMO');
    expect(text('nextEarnings', ctx(aapl))).toBe('—');
    const zh = usePortfolioMessages.for('zh');
    expect(cellText(COLUMNS.nextEarnings, ctx(aapl, { earnings: { ...wsh, time: 'dmh' } }), { ...zh.words, kinds: zh.kinds }, clock)).toBe('2026-10-30 盘中');
  });

  it('reads the contract details of version 2', () => {
    const optInfo: ContractInfo = {
      contract: { ...call, lastTradeDate: '20261016' },
      longName: 'APPLE INC',
      minTick: 0.01,
      v: 2,
      marketName: 'AAPL',
      contractMonth: '202610',
      realExpirationDate: '20261016',
      lastTradeTime: '16:00:00',
      lastTradeZone: 'US/Eastern',
      underSymbol: 'AAPL',
      underConId: 265598,
      underSecType: 'STK',
    };
    const c = ctx(aaplCall, { info: optInfo });
    expect(text('contractMonth', c)).toBe('2026-10');
    expect(value('lastTradeTime', c)).toBe('20261016 16:00');
    expect(text('lastTradeTime', c)).toBe('2026-10-16 16:00');
    expect(cellText(COLUMNS.lastTradeTime, c, words, createClock('12h', 'en'))).toBe('2026-10-16 4:00 PM');
    expect(COLUMNS.lastTradeTime.title!(c, words)).toBe('US/Eastern');
    expect(text('realExpiration', c)).toBe('2026-10-16');
    expect(text('marketName', c)).toBe('AAPL');
    expect(text('underlying', c)).toBe('AAPL');
    expect(COLUMNS.underlying.title!(c, words)).toBe('STK · conId 265598');
    // Before the details come: an option's own symbol; a future's underlying waits for them.
    expect(text('underlying', ctx(aaplCall))).toBe('AAPL');
    const fop = position({ symbol: 'ES', secType: 'FOP', exchange: 'CME', currency: 'USD', lastTradeDate: '20261016', strike: 7880, right: 'C', multiplier: 50, conId: 919511013 }, { quantity: 1, multiplier: 50 });
    expect(text('underlying', ctx(fop))).toBe('—');
    expect(text('underlying', ctx(fop, { info: { ...optInfo, underSymbol: 'ESZ6', underSecType: 'FUT', underConId: 515416632 } }))).toBe('ESZ6');
    // A stock's ISIN and market.
    const stkInfo: ContractInfo = { contract: aaplStock, longName: 'APPLE INC', minTick: 0.01, v: 2, isin: 'US0378331005', marketName: 'NMS' };
    expect(text('isin', ctx(aapl, { info: stkInfo }))).toBe('US0378331005');
    expect(text('marketName', ctx(aapl, { info: stkInfo }))).toBe('NMS');
    // Details of version 1 lack them: "—".
    expect(text('isin', ctx(aapl, { info: { contract: aaplStock, longName: 'APPLE INC', minTick: 0.01 } }))).toBe('—');
  });

  it('sorts the last trade by its instant, across the instruments’ zones', () => {
    // 2026-12-18: ES stops at 08:30 Chicago (14:30 UTC), an equity option at 09:00 New York (14:00 UTC).
    expect(zonedInstant('20261218', '08:30', 'US/Central')).toBe(Date.UTC(2026, 11, 18, 14, 30));
    expect(zonedInstant('20261218', '09:00', 'US/Eastern')).toBe(Date.UTC(2026, 11, 18, 14, 0));
    // Summer time, and an unknown or missing zone (the wall time as UTC).
    expect(zonedInstant('20261016', '16:00:00', 'US/Eastern')).toBe(Date.UTC(2026, 9, 16, 20, 0));
    expect(zonedInstant('20261016', '16:00', 'Mars/Olympus')).toBe(Date.UTC(2026, 9, 16, 16, 0));
    expect(zonedInstant('20261016', '16:00', undefined)).toBe(Date.UTC(2026, 9, 16, 16, 0));
    const fut = position({ symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218', multiplier: 50, conId: 515416632 }, { quantity: 1, multiplier: 50 });
    const opt = position({ ...option('SPY', '20261218', 600, 'C'), conId: 7002 }, { quantity: 1 });
    const es = ctx(fut, { info: { contract: fut.contract, longName: 'E-mini S&P 500', minTick: 0.25, v: 2, lastTradeTime: '08:30:00', lastTradeZone: 'US/Central' } });
    const spy = ctx(opt, { info: { contract: opt.contract, longName: 'SPY', minTick: 0.01, v: 2, lastTradeTime: '09:00:00', lastTradeZone: 'US/Eastern' } });
    expect([value('lastTradeTime', es), value('lastTradeTime', spy)]).toEqual(['20261218 08:30', '20261218 09:00']);
    const sorted = sortBy([es, spy], (c) => COLUMNS.lastTradeTime.sortValue!(c), COLUMNS.lastTradeTime.sort, 'asc');
    expect(sorted.map((c) => c.row.position.contract.symbol)).toEqual(['SPY', 'ES']);
  });

  it('sorts the earnings of one day by the time of day: before the open, during, after the close, unknown', () => {
    const at = (time: EarningsEvent['time'], minutes?: number) => ctx(aapl, { earnings: { key: 'STK:AAPL', date: '20261030', ...(time ? { time } : {}), ...(minutes !== undefined ? { minutes } : {}) } });
    const days = [at('amc'), at(undefined), at('dmh'), at('bmo'), at('bmo', 7 * 60)];
    const order = sortBy(days, (c) => COLUMNS.nextEarnings.sortValue!(c), COLUMNS.nextEarnings.sort, 'asc').map((c) => `${c.earnings!.time ?? '?'}${c.earnings!.minutes ?? ''}`);
    expect(order).toEqual(['bmo420', 'bmo', 'dmh', 'amc', '?']);
    // A later date comes after, whatever its time; an estimate sorts in its own column only.
    const next = ctx(aapl, { earnings: { key: 'STK:AAPL', date: '20261031', time: 'bmo' } });
    expect(COLUMNS.nextEarnings.sortValue!(next)! > COLUMNS.nextEarnings.sortValue!(at(undefined))!).toBe(true);
    expect(COLUMNS.nextEarningsEst.sortValue!(at('amc'))).toBeUndefined();
  });

  it('reads a bond’s details and yields', () => {
    const bond = position({ symbol: 'US-T', secType: 'BOND', exchange: 'SMART', currency: 'USD', conId: 742000123 }, { quantity: 10_000, avgPrice: 0.98 });
    const info: ContractInfo = {
      contract: bond.contract,
      longName: 'United States Treasury',
      minTick: 0.0001,
      v: 2,
      isin: 'US91282CLW90',
      bond: { cusip: '91282CLW9', coupon: 4.25, maturity: '20341115', bondType: 'US-T', callable: true, putable: false, convertible: true, descAppend: 'T 4 1/4 11/15/34', notes: 'Reopening' },
    };
    const c = ctx(bond, { info, quote: q({ bidYield: 4.2125, askYield: -0.1, lastYield: 0, bondFactor: 0.98765 }) });
    expect(text('name', c)).toBe('United States Treasury');
    expect(text('minTick', c)).toBe('0.0001');
    expect(text('isin', c)).toBe('US91282CLW90');
    expect(text('cusip', c)).toBe('91282CLW9');
    expect(text('coupon', c)).toBe('4.25');
    expect(text('maturity', c)).toBe('2034-11-15');
    expect(text('bondType', c)).toBe('US-T');
    expect(text('bondFeatures', c)).toBe('Callable · Convertible');
    expect(text('bondDesc', c)).toBe('T 4 1/4 11/15/34');
    expect(COLUMNS.bondDesc.title!(c, words)).toBe('Reopening');
    expect(text('bidYield', c)).toBe('4.213');
    expect(text('askYield', c)).toBe('−0.100');
    expect(text('lastYield', c)).toBe('0.000');
    expect(text('bondFactor', c)).toBe('0.98765');
    const plain = { ...info, bond: { ...info.bond, callable: false, putable: false, convertible: false } };
    expect(text('bondFeatures', ctx(bond, { info: plain }))).toBe('None');
    expect(text('bondFeatures', ctx(bond, { info: { ...info, bond: {} } }))).toBe('—');
  });
});

describe('new cell formats', () => {
  it('writes months, stamps, earnings, ratios, 3 decimals and features', () => {
    expect(formatValue('month', '202612', words, clock, NOW)).toBe('2026-12');
    expect(formatValue('stamp', '20261218 08:30', words, clock, NOW)).toBe('2026-12-18 08:30');
    expect(formatValue('stamp', '20261218 08:30', words, createClock('12h', 'zh'), NOW)).toBe('2026-12-18 上午 8:30');
    expect(formatValue('earn', '20261030|bmo', words, clock, NOW)).toBe('2026-10-30 BMO');
    expect(formatValue('earn', '20261030|', words, clock, NOW)).toBe('2026-10-30');
    expect(formatValue('ratio', 1.254, words, clock, NOW)).toBe('1.25×');
    expect(formatValue('num3', 4.2125, words, clock, NOW)).toBe('4.213');
    expect(formatValue('features', 'putable', words, clock, NOW)).toBe('Putable');
    expect(formatValue('shortable', 1, words, clock, NOW)).toBe('No');
    for (const fmt of ['month', 'stamp', 'earn', 'ratio', 'num3', 'features', 'shortable'] as const) expect(formatValue(fmt, undefined, words, clock, NOW)).toBe('—');
  });

  it('sorts the shortable column by IB’s code, not its word', () => {
    expect(COLUMNS.shortable.sort).toBe('num');
    const types: SecType[] = ['STK'];
    expect(COLUMNS.shortable.types).toEqual(types);
  });
});
