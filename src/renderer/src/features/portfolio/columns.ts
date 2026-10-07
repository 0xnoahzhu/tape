// The Positions table's column catalog (pure): every column the table can show, grouped as in the
// column editor, with where its value comes from, which instruments it applies to, how it is
// formatted and how it sorts. Labels, IB sources and formulas are in messages.ts.
//
// The rule behind the catalog: a column shows IB's own data ('ib') or a calculation by Tape
// ('calc'), and a calculated column reads as one (a dim ƒ after its header, a tooltip giving the
// formula). A cell is empty when the column does not apply to the instrument, and "—" when it
// applies but IB has not sent the value. Every column here is computed from data Tape already
// receives: the position and portfolio updates, reqPnLSingle, the account's exchange rates, the
// contract details fetched once per position and the ticks of the position's own quote line.

import { contractLabel, daysToExpiry } from '@shared/contract';
import { wallClockAt } from '@shared/timeFormat';
import type { ContractInfo, ContractRef, Quote, SecType } from '@shared/types';
import { livePrice, underlyingOf, type PositionRow } from './calc';

export const COLUMN_GROUPS = ['position', 'ibPnl', 'contract', 'quote', 'options'] as const;
export type ColumnGroup = (typeof COLUMN_GROUPS)[number];

/** Every column id in catalog order (the editor's order within each group). */
export const COLUMN_IDS = [
  // Position
  'symbol',
  'name',
  'secType',
  'quantity',
  'avgPrice',
  'averageCost',
  'costBasis',
  'price',
  'value',
  'weight',
  'unrealized',
  'unrealizedPct',
  'dayPnl',
  'currency',
  'fxRate',
  'valueBase',
  'pctGross',
  'account',
  // IB P&L
  'marketPriceIb',
  'marketValueIb',
  'unrealizedIb',
  'realizedIb',
  'dailyPnlIb',
  'unrealizedPnlIb',
  'realizedPnlIb',
  'valuePnlIb',
  'totalPnl',
  // Contract
  'conId',
  'localSymbol',
  'exchange',
  'tradingClass',
  'multiplier',
  'expiry',
  'daysToExpiry',
  'strike',
  'right',
  'underlying',
  'industry',
  'category',
  'subcategory',
  'stockType',
  'minTick',
  'timeZone',
  'tradingHours',
  'liquidHours',
  // Quote
  'last',
  'lastSize',
  'lastTime',
  'bid',
  'ask',
  'bidSize',
  'askSize',
  'mid',
  'spread',
  'spreadPct',
  'close',
  'change',
  'changePct',
  'open',
  'high',
  'low',
  'volume',
  'mark',
  'lastRthTrade',
  'halted',
  'dataType',
  'quoteStatus',
  // Options
  'optIv',
  'delta',
  'gamma',
  'theta',
  'vega',
  'undPrice',
  'optModelPrice',
  'pvDividend',
  'openInterest',
  'moneyness',
  'intrinsic',
  'extrinsic',
  'breakEven',
  'positionDelta',
  'deltaDollars',
  'positionGamma',
  'positionTheta',
  'positionVega',
] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];

/** Today's table: Symbol, Qty, Avg, Price, Value, % NLV, Unrl. P&L (with %), Day P&L. */
export const DEFAULT_COLUMNS: readonly ColumnId[] = ['symbol', 'quantity', 'avgPrice', 'price', 'value', 'weight', 'unrealized', 'dayPnl'];

/** Always shown, always first, and sticky when the table scrolls sideways. */
export const PINNED: ColumnId = 'symbol';

export const isColumnId = (v: unknown): v is ColumnId => typeof v === 'string' && (COLUMN_IDS as readonly string[]).includes(v);

/**
 * How a value is written (cells.ts): qty = position size, px = price, pnl = signed money, chg =
 * signed price, pctS = signed percent, pctU = unsigned percent (shares), pctFine = unsigned percent
 * of small ratios (3 decimals below 1 %: a spread), vol = a volatility fraction as percent, big = compact count (12.4K), dec = as many decimals as it has, id = a
 * plain integer, kind / right / halt / dataType = IB codes as words, hours = today's sessions.
 */
export type Fmt =
  | 'text'
  | 'qty'
  | 'px'
  | 'num0'
  | 'num2'
  | 'num4'
  | 'dec'
  | 'id'
  | 'pnl'
  | 'chg'
  | 'pctS'
  | 'pctU'
  | 'pctFine'
  | 'vol'
  | 'big'
  | 'date'
  | 'days'
  | 'time'
  | 'greek3'
  | 'greek4'
  | 'kind'
  | 'right'
  | 'halt'
  | 'dataType'
  | 'hours';

/** A cell's raw value: what sorts and what is formatted (never the formatted label). */
export type CellValue = number | string | undefined;

/** What a cell is computed from. */
export interface CellCtx {
  row: PositionRow;
  /** The position's own quote; undefined until IB sends it (or while no shown column needs quotes). */
  q?: Quote;
  /** Contract details: undefined while unknown, null when IB has none. */
  info?: ContractInfo | null;
  /** Σ |value in the account currency| of all rows; undefined while a row's is unknown. */
  grossBase?: number;
  /** Unix ms (days to expiry, today's trading hours). */
  now: number;
}

/** Editor notes of type-specific columns. */
export type ColumnNote = 'options' | 'derivatives' | 'stocks' | 'stocksOptions';

export interface ColumnDef {
  id: ColumnId;
  group: ColumnGroup;
  /** 'ib': a value IB sends, shown as sent; 'calc': calculated by Tape (marked ƒ, with its formula). */
  kind: 'ib' | 'calc';
  align: 'left' | 'right';
  /**
   * Minimum width in px, wide enough for the header in either language with its ƒ and a sort arrow;
   * columns share the spare width (Symbol twice as much as the others).
   */
  width: number;
  /** Compare values as numbers or as text. */
  sort: 'num' | 'text';
  /** The instrument types the column applies to (all when absent); other rows get an empty cell. */
  types?: readonly SecType[];
  note?: ColumnNote;
  /** Data beyond the position row: the position's quote, its contract details, or the rows' gross value. */
  needs?: 'quote' | 'details' | 'gross';
  fmt: Fmt;
  color?: 'sign' | 'muted';
  value(c: CellCtx): CellValue;
  /** Sort key when it is not the value (Symbol: stocks, then their options by expiry and strike). */
  sortValue?(c: CellCtx): CellValue;
  /** A second, smaller line (Unrealized P&L: its percent). */
  sub?: { value(c: CellCtx): number | undefined; fmt: Fmt };
  /** The cell's tooltip (a status message, the zone of trading hours). */
  title?(c: CellCtx): string | undefined;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const pos = (n: number | undefined): n is number => finite(n) && n > 0;
const text = (s: string | undefined | null): string | undefined => (s && s.trim() ? s.trim() : undefined);

const OPTIONS: readonly SecType[] = ['OPT', 'FOP'];
const OPTIONS_WAR: readonly SecType[] = ['OPT', 'FOP', 'WAR'];
const EXPIRING: readonly SecType[] = ['OPT', 'FOP', 'FUT', 'WAR'];
const STOCKS: readonly SecType[] = ['STK'];
const STOCKS_OPTIONS: readonly SecType[] = ['STK', 'OPT'];
/** Instruments whose quotes carry trades (IDEALPRO forex quotes bid / ask only). */
const TRADED: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'BOND', 'WAR', 'CFD', 'CRYPTO'];
const SESSIONED: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'WAR', 'CFD', 'CRYPTO'];
const WITH_CLOSE: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'CFD', 'CRYPTO'];
const HALTABLE: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'WAR'];
const DELTA: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP'];
/**
 * Instruments whose contract details carry IB's own name and minimum tick. A bond's details arrive
 * without them (contracts.ts keeps only bondContractDetails' contract), so its ContractInfo holds
 * Tape's defaults (the symbol, 0.01), which must not read as IB's.
 */
const NAMED: readonly SecType[] = ['STK', 'OPT', 'IND', 'FUT', 'FOP', 'CASH', 'BAG', 'CFD', 'WAR', 'CRYPTO'];

export const isOptionType = (t: SecType): boolean => t === 'OPT' || t === 'FOP';

/** Whether a column applies to a row's instrument (else its cell is empty). */
export function applies(def: ColumnDef, row: PositionRow): boolean {
  return !def.types || def.types.includes(row.position.contract.secType);
}

/** A row's identity: its conId (contract keys collide for SPX / SPXW, or bonds of one issuer), else its key. */
export function rowId(row: PositionRow): string {
  const conId = row.position.contract.conId;
  return conId ? String(conId) : row.key;
}

const TYPE_RANK: Partial<Record<SecType, number>> = { STK: 0, OPT: 1, FUT: 2, FOP: 3 };

/**
 * Symbol's sort key: the underlying, then stock before its options, futures and futures options,
 * then expiry, strike and right; so a stock's options follow it in ascending order.
 */
export function contractOrderKey(c: ContractRef): string {
  const strike = finite(c.strike) ? c.strike.toFixed(4).padStart(14, '0') : '';
  return [underlyingOf(c).symbol, TYPE_RANK[c.secType] ?? 4, c.lastTradeDate ?? '', strike, c.right ?? ''].join(' ');
}

/** Units of the underlying a position moves with: quantity × multiplier. */
const size = (r: PositionRow): number => r.position.quantity * (r.position.multiplier || 1);

const twoSided = (q: Quote | undefined, option: boolean): q is Quote & { bid: number; ask: number } =>
  !!q && pos(q.ask) && finite(q.bid) && (option ? q.bid >= 0 : q.bid > 0) && q.ask >= q.bid;

function midOf(c: CellCtx): number | undefined {
  return twoSided(c.q, isOptionType(c.row.position.contract.secType)) ? (c.q.bid + c.q.ask) / 2 : undefined;
}

function spreadOf(c: CellCtx): number | undefined {
  return twoSided(c.q, isOptionType(c.row.position.contract.secType)) ? c.q.ask - c.q.bid : undefined;
}

/**
 * The quote's own price, never IB's portfolio mark or the previous close (so a change is today's):
 * options the mark, else the midpoint (as the row is valued); others the last trade, else the
 * midpoint, else the mark.
 */
export function quotePrice(c: CellCtx): number | undefined {
  const q = c.q;
  if (!q) return undefined;
  const secType = c.row.position.contract.secType;
  if (isOptionType(secType)) return livePrice(secType, q, undefined);
  if (pos(q.last)) return q.last;
  return midOf(c) ?? (pos(q.mark) ? q.mark : undefined);
}

/** IB's model underlying price of an option (tick 13). */
const undPx = (c: CellCtx): number | undefined => (pos(c.q?.undPrice) ? c.q.undPrice : undefined);

function intrinsic(c: CellCtx): number | undefined {
  const S = undPx(c);
  const K = c.row.position.contract.strike;
  if (S === undefined || !finite(K)) return undefined;
  return Math.max(0, c.row.position.contract.right === 'P' ? K - S : S - K);
}

/** Option greek × quantity × multiplier; undefined until IB sends the greek. */
function scaled(c: CellCtx, greek: number | undefined): number | undefined {
  return finite(greek) ? greek * size(c.row) : undefined;
}

function positionDelta(c: CellCtx): number | undefined {
  const r = c.row;
  switch (r.position.contract.secType) {
    case 'STK':
      return r.position.quantity;
    case 'FUT':
      return size(r);
    default:
      return scaled(c, c.q?.delta);
  }
}

/**
 * Today's sessions from IB's tradingHours / liquidHours ("20261006:0400-20261006:2000;20261007:CLOSED",
 * in the instrument's zone): the ranges ending today as "0400-2000" (several joined by ','), "CLOSED"
 * on a day without a session, undefined when IB lists nothing for today. A session that starts the
 * evening before (futures) counts for the day it ends. Older servers write "0930-1600" without the
 * end date.
 */
export function todaysHours(hours: string | undefined, timeZone: string | undefined, now: number): string | undefined {
  if (!hours) return undefined;
  let r: { y: number; mo: number; d: number };
  try {
    r = wallClockAt(now, timeZone || undefined);
  } catch {
    r = wallClockAt(now);
  }
  const today = `${r.y}${String(r.mo).padStart(2, '0')}${String(r.d).padStart(2, '0')}`;
  const ranges: string[] = [];
  let closed = false;
  for (const item of hours.split(';')) {
    const m = /^(\d{8}):(.*)$/.exec(item.trim());
    if (!m) continue;
    const [, day, rest] = m;
    if (rest === 'CLOSED') {
      closed ||= day === today;
      continue;
    }
    for (const range of rest.split(',')) {
      const x = /^(\d{4})-(?:(\d{8}):)?(\d{4})$/.exec(range.trim());
      if (x && (x[2] ?? day) === today) ranges.push(`${x[1]}-${x[3]}`);
    }
  }
  if (ranges.length) return ranges.join(',');
  return closed ? 'CLOSED' : undefined;
}

type Def = Omit<ColumnDef, 'id' | 'group'>;

const POSITION: Partial<Record<ColumnId, Def>> = {
  symbol: {
    kind: 'ib',
    align: 'left',
    width: 200,
    sort: 'text',
    fmt: 'text',
    value: (c) => contractLabel(c.row.position.contract),
    sortValue: (c) => contractOrderKey(c.row.position.contract),
  },
  name: { kind: 'ib', align: 'left', width: 160, sort: 'text', fmt: 'text', needs: 'details', types: NAMED, value: (c) => text(c.info?.longName) },
  secType: { kind: 'ib', align: 'left', width: 72, sort: 'text', fmt: 'kind', value: (c) => c.row.position.contract.secType },
  quantity: { kind: 'ib', align: 'right', width: 72, sort: 'num', fmt: 'qty', value: (c) => c.row.position.quantity },
  avgPrice: { kind: 'calc', align: 'right', width: 84, sort: 'num', fmt: 'px', color: 'muted', value: (c) => c.row.position.avgPrice },
  averageCost: { kind: 'ib', align: 'right', width: 92, sort: 'num', fmt: 'px', value: (c) => c.row.position.averageCost },
  costBasis: {
    kind: 'calc',
    align: 'right',
    width: 96,
    sort: 'num',
    fmt: 'num0',
    value: (c) => {
      const p = c.row.position;
      return p.quantity * (p.averageCost ?? p.avgPrice * (p.multiplier || 1));
    },
  },
  price: { kind: 'calc', align: 'right', width: 84, sort: 'num', fmt: 'px', value: (c) => c.row.last },
  value: { kind: 'calc', align: 'right', width: 96, sort: 'num', fmt: 'num0', value: (c) => c.row.value },
  weight: { kind: 'calc', align: 'right', width: 72, sort: 'num', fmt: 'pctU', color: 'muted', value: (c) => c.row.weight },
  unrealized: {
    kind: 'calc',
    align: 'right',
    width: 104,
    sort: 'num',
    fmt: 'pnl',
    color: 'sign',
    value: (c) => c.row.unrealized,
    sub: { value: (c) => c.row.unrealizedPct, fmt: 'pctS' },
  },
  unrealizedPct: { kind: 'calc', align: 'right', width: 80, sort: 'num', fmt: 'pctS', color: 'sign', value: (c) => c.row.unrealizedPct },
  dayPnl: { kind: 'calc', align: 'right', width: 96, sort: 'num', fmt: 'pnl', color: 'sign', value: (c) => c.row.dayPnl },
  currency: { kind: 'ib', align: 'left', width: 64, sort: 'text', fmt: 'text', value: (c) => text(c.row.position.contract.currency) },
  fxRate: { kind: 'ib', align: 'right', width: 72, sort: 'num', fmt: 'num4', value: (c) => c.row.fx },
  valueBase: { kind: 'calc', align: 'right', width: 112, sort: 'num', fmt: 'num0', value: (c) => c.row.valueBase },
  pctGross: {
    kind: 'calc',
    align: 'right',
    width: 72,
    sort: 'num',
    fmt: 'pctU',
    color: 'muted',
    needs: 'gross',
    value: (c) => (finite(c.row.valueBase) && pos(c.grossBase) ? (Math.abs(c.row.valueBase) / c.grossBase) * 100 : undefined),
  },
  account: { kind: 'ib', align: 'left', width: 96, sort: 'text', fmt: 'text', value: (c) => text(c.row.position.account) },
};

const IB_PNL: Partial<Record<ColumnId, Def>> = {
  marketPriceIb: { kind: 'ib', align: 'right', width: 88, sort: 'num', fmt: 'px', value: (c) => c.row.position.marketPrice },
  marketValueIb: { kind: 'ib', align: 'right', width: 96, sort: 'num', fmt: 'num0', value: (c) => c.row.position.marketValue },
  unrealizedIb: { kind: 'ib', align: 'right', width: 104, sort: 'num', fmt: 'pnl', color: 'sign', value: (c) => c.row.position.unrealizedPnL },
  realizedIb: { kind: 'ib', align: 'right', width: 104, sort: 'num', fmt: 'pnl', color: 'sign', value: (c) => c.row.position.realizedPnL },
  dailyPnlIb: { kind: 'ib', align: 'right', width: 104, sort: 'num', fmt: 'pnl', color: 'sign', value: (c) => c.row.position.dailyPnL },
  unrealizedPnlIb: { kind: 'ib', align: 'right', width: 124, sort: 'num', fmt: 'pnl', color: 'sign', value: (c) => c.row.position.pnlUnrealized },
  realizedPnlIb: { kind: 'ib', align: 'right', width: 108, sort: 'num', fmt: 'pnl', color: 'sign', value: (c) => c.row.position.pnlRealized },
  valuePnlIb: { kind: 'ib', align: 'right', width: 104, sort: 'num', fmt: 'num0', value: (c) => c.row.position.pnlValue },
  totalPnl: {
    kind: 'calc',
    align: 'right',
    width: 104,
    sort: 'num',
    fmt: 'pnl',
    color: 'sign',
    value: (c) => {
      const { pnlUnrealized: u, pnlRealized: r } = c.row.position;
      return finite(u) && finite(r) ? u + r : undefined;
    },
  },
};

const CONTRACT: Partial<Record<ColumnId, Def>> = {
  conId: { kind: 'ib', align: 'right', width: 88, sort: 'num', fmt: 'id', value: (c) => c.row.position.contract.conId },
  localSymbol: { kind: 'ib', align: 'left', width: 120, sort: 'text', fmt: 'text', value: (c) => text(c.row.position.contract.localSymbol) },
  exchange: {
    kind: 'ib',
    align: 'left',
    width: 80,
    sort: 'text',
    fmt: 'text',
    types: ['STK', 'FUT', 'FOP', 'CASH', 'CFD', 'BOND', 'CRYPTO'],
    // Stocks are routed through SMART; the listing is their primary exchange. For the others SMART is
    // Tape's stand-in while IB has not named the exchange (updatePortfolio carries none), never a listing.
    value: (c) => {
      const k = c.row.position.contract;
      return text(k.secType === 'STK' ? k.primaryExchange : k.exchange === 'SMART' ? undefined : k.exchange);
    },
  },
  tradingClass: {
    kind: 'ib',
    align: 'left',
    width: 72,
    sort: 'text',
    fmt: 'text',
    types: ['STK', 'OPT', 'FUT', 'FOP', 'WAR'],
    value: (c) => text(c.row.position.contract.tradingClass),
  },
  // IB's own multiplier, not Position.multiplier (which falls back to 100 for options); IB leaves out
  // a stock's 1.
  multiplier: {
    kind: 'ib',
    align: 'right',
    width: 56,
    sort: 'num',
    fmt: 'dec',
    value: (c) => {
      const k = c.row.position.contract;
      return pos(k.multiplier) ? k.multiplier : k.secType === 'STK' ? 1 : undefined;
    },
  },
  expiry: {
    kind: 'ib',
    align: 'left',
    width: 92,
    sort: 'text',
    fmt: 'date',
    types: EXPIRING,
    note: 'derivatives',
    value: (c) => (/^\d{8}$/.test(c.row.position.contract.lastTradeDate ?? '') ? c.row.position.contract.lastTradeDate : undefined),
  },
  daysToExpiry: {
    kind: 'calc',
    align: 'right',
    width: 76,
    sort: 'num',
    fmt: 'days',
    types: EXPIRING,
    note: 'derivatives',
    value: (c) => {
      const d = c.row.position.contract.lastTradeDate;
      return d && /^\d{8}$/.test(d) ? daysToExpiry(d, new Date(c.now)) : undefined;
    },
  },
  strike: { kind: 'ib', align: 'right', width: 72, sort: 'num', fmt: 'px', types: OPTIONS_WAR, note: 'options', value: (c) => c.row.position.contract.strike },
  right: { kind: 'ib', align: 'left', width: 68, sort: 'text', fmt: 'right', types: OPTIONS_WAR, note: 'options', value: (c) => c.row.position.contract.right },
  underlying: { kind: 'ib', align: 'left', width: 80, sort: 'text', fmt: 'text', types: OPTIONS_WAR, note: 'options', value: (c) => text(c.row.position.contract.symbol) },
  industry: {
    kind: 'ib',
    align: 'left',
    width: 120,
    sort: 'text',
    fmt: 'text',
    types: STOCKS_OPTIONS,
    note: 'stocksOptions',
    value: (c) => text(c.row.position.industry ?? c.info?.industry),
  },
  category: {
    kind: 'ib',
    align: 'left',
    width: 120,
    sort: 'text',
    fmt: 'text',
    types: STOCKS_OPTIONS,
    note: 'stocksOptions',
    value: (c) => text(c.row.position.category ?? c.info?.category),
  },
  subcategory: {
    kind: 'ib',
    align: 'left',
    width: 120,
    sort: 'text',
    fmt: 'text',
    types: STOCKS_OPTIONS,
    note: 'stocksOptions',
    needs: 'details',
    value: (c) => text(c.info?.subcategory),
  },
  stockType: {
    kind: 'ib',
    align: 'left',
    width: 80,
    sort: 'text',
    fmt: 'text',
    types: STOCKS,
    note: 'stocks',
    value: (c) => text(c.row.position.stockType ?? c.info?.stockType),
  },
  minTick: {
    kind: 'ib',
    align: 'right',
    width: 64,
    sort: 'num',
    fmt: 'dec',
    needs: 'details',
    types: NAMED,
    value: (c) => (pos(c.info?.minTick) ? c.info.minTick : undefined),
  },
  timeZone: { kind: 'ib', align: 'left', width: 96, sort: 'text', fmt: 'text', needs: 'details', value: (c) => text(c.info?.timeZoneId) },
  tradingHours: {
    kind: 'ib',
    align: 'left',
    width: 112,
    sort: 'text',
    fmt: 'hours',
    needs: 'details',
    value: (c) => todaysHours(c.info?.tradingHours, c.info?.timeZoneId, c.now),
    title: (c) => text(c.info?.timeZoneId),
  },
  liquidHours: {
    kind: 'ib',
    align: 'left',
    width: 112,
    sort: 'text',
    fmt: 'hours',
    needs: 'details',
    value: (c) => todaysHours(c.info?.liquidHours, c.info?.timeZoneId, c.now),
    title: (c) => text(c.info?.timeZoneId),
  },
};

/** A quote field as IB sent it. */
const tick = (fmt: Fmt, read: (q: Quote) => number | undefined, types?: readonly SecType[], note?: ColumnNote): Def => ({
  kind: 'ib',
  align: 'right',
  width: fmt === 'big' ? 80 : 84,
  sort: 'num',
  fmt,
  needs: 'quote',
  ...(types ? { types } : {}),
  ...(note ? { note } : {}),
  value: (c) => (c.q ? read(c.q) : undefined),
});

const QUOTE: Partial<Record<ColumnId, Def>> = {
  last: tick('px', (q) => q.last, TRADED),
  lastSize: tick('big', (q) => q.lastSize, TRADED),
  lastTime: { ...tick('time', (q) => q.lastTime, ['STK', 'OPT', 'FUT', 'FOP', 'WAR', 'CFD', 'CRYPTO']), align: 'left', width: 88 },
  bid: tick('px', (q) => q.bid),
  ask: tick('px', (q) => q.ask),
  bidSize: tick('big', (q) => q.bidSize),
  askSize: tick('big', (q) => q.askSize),
  mid: { kind: 'calc', align: 'right', width: 84, sort: 'num', fmt: 'px', needs: 'quote', value: midOf },
  spread: { kind: 'calc', align: 'right', width: 72, sort: 'num', fmt: 'px', needs: 'quote', value: spreadOf },
  spreadPct: {
    kind: 'calc',
    align: 'right',
    width: 84,
    sort: 'num',
    fmt: 'pctFine',
    needs: 'quote',
    value: (c) => {
      const spread = spreadOf(c);
      const mid = midOf(c);
      return spread !== undefined && pos(mid) ? (spread / mid) * 100 : undefined;
    },
  },
  close: tick('px', (q) => q.close, [...WITH_CLOSE, 'WAR']),
  change: {
    kind: 'calc',
    align: 'right',
    width: 80,
    sort: 'num',
    fmt: 'chg',
    color: 'sign',
    needs: 'quote',
    types: WITH_CLOSE,
    value: (c) => {
      const p = quotePrice(c);
      return p !== undefined && pos(c.q?.close) ? p - c.q.close : undefined;
    },
  },
  changePct: {
    kind: 'calc',
    align: 'right',
    width: 80,
    sort: 'num',
    fmt: 'pctS',
    color: 'sign',
    needs: 'quote',
    types: WITH_CLOSE,
    value: (c) => {
      const p = quotePrice(c);
      return p !== undefined && pos(c.q?.close) ? (p / c.q.close - 1) * 100 : undefined;
    },
  },
  open: tick('px', (q) => q.open, SESSIONED),
  high: tick('px', (q) => q.high, SESSIONED),
  low: tick('px', (q) => q.low, SESSIONED),
  volume: tick('big', (q) => q.volume, TRADED),
  // Option lines ask for the mark (generic tick 221); stock lines do not.
  mark: tick('px', (q) => q.mark, OPTIONS, 'options'),
  lastRthTrade: { ...tick('px', (q) => q.lastRthTrade, STOCKS, 'stocks'), width: 100 },
  halted: {
    ...tick('halt', (q) => q.haltCode ?? (q.halted == null ? undefined : q.halted ? 1 : 0), HALTABLE),
    align: 'left',
    width: 80,
  },
  dataType: { ...tick('dataType', (q) => q.marketDataType), align: 'left', width: 96 },
  quoteStatus: { ...tick('id', (q) => q.error?.code), align: 'left', width: 96, title: (c) => c.q?.error?.message },
};

const OPTION: Partial<Record<ColumnId, Def>> = {
  optIv: { ...tick('vol', (q) => q.iv, OPTIONS, 'options'), width: 76 },
  delta: { ...tick('greek3', (q) => q.delta, OPTIONS, 'options'), width: 64 },
  gamma: { ...tick('greek4', (q) => q.gamma, OPTIONS, 'options'), width: 64 },
  theta: { ...tick('greek3', (q) => q.theta, OPTIONS, 'options'), width: 64 },
  vega: { ...tick('greek3', (q) => q.vega, OPTIONS, 'options'), width: 64 },
  undPrice: { ...tick('px', (q) => q.undPrice, OPTIONS, 'options'), width: 80 },
  optModelPrice: { ...tick('px', (q) => q.optPrice, OPTIONS, 'options'), width: 80 },
  pvDividend: { ...tick('px', (q) => q.pvDividend, OPTIONS, 'options'), width: 88 },
  openInterest: { ...tick('big', (q) => q.openInterest, OPTIONS, 'options'), width: 72 },
  moneyness: {
    kind: 'calc',
    align: 'right',
    width: 72,
    sort: 'num',
    fmt: 'pctS',
    color: 'sign',
    needs: 'quote',
    types: OPTIONS,
    note: 'options',
    value: (c) => {
      const S = undPx(c);
      const K = c.row.position.contract.strike;
      if (S === undefined || !pos(K)) return undefined;
      return ((c.row.position.contract.right === 'P' ? K - S : S - K) / K) * 100;
    },
  },
  intrinsic: { kind: 'calc', align: 'right', width: 80, sort: 'num', fmt: 'px', needs: 'quote', types: OPTIONS, note: 'options', value: intrinsic },
  extrinsic: {
    kind: 'calc',
    align: 'right',
    width: 80,
    sort: 'num',
    fmt: 'px',
    needs: 'quote',
    types: OPTIONS,
    note: 'options',
    value: (c) => {
      const p = quotePrice(c);
      const i = intrinsic(c);
      return p !== undefined && i !== undefined ? p - i : undefined;
    },
  },
  breakEven: {
    kind: 'calc',
    align: 'right',
    width: 92,
    sort: 'num',
    fmt: 'px',
    types: OPTIONS,
    note: 'options',
    value: (c) => {
      const { contract: k, avgPrice } = c.row.position;
      if (!finite(k.strike) || !finite(avgPrice)) return undefined;
      return k.right === 'P' ? k.strike - avgPrice : k.strike + avgPrice;
    },
  },
  positionDelta: { kind: 'calc', align: 'right', width: 84, sort: 'num', fmt: 'num0', needs: 'quote', types: DELTA, value: positionDelta },
  deltaDollars: {
    kind: 'calc',
    align: 'right',
    width: 104,
    sort: 'num',
    fmt: 'num0',
    needs: 'quote',
    types: DELTA,
    value: (c) => {
      const d = positionDelta(c);
      const S = isOptionType(c.row.position.contract.secType) ? undPx(c) : c.row.last;
      return finite(d) && finite(S) ? d * S : undefined;
    },
  },
  positionGamma: { kind: 'calc', align: 'right', width: 96, sort: 'num', fmt: 'num2', needs: 'quote', types: OPTIONS, note: 'options', value: (c) => scaled(c, c.q?.gamma) },
  positionTheta: {
    kind: 'calc',
    align: 'right',
    width: 88,
    sort: 'num',
    fmt: 'pnl',
    color: 'sign',
    needs: 'quote',
    types: OPTIONS,
    note: 'options',
    value: (c) => scaled(c, c.q?.theta),
  },
  positionVega: {
    kind: 'calc',
    align: 'right',
    width: 88,
    sort: 'num',
    fmt: 'pnl',
    color: 'sign',
    needs: 'quote',
    types: OPTIONS,
    note: 'options',
    value: (c) => scaled(c, c.q?.vega),
  },
};

const BY_GROUP: Record<ColumnGroup, Partial<Record<ColumnId, Def>>> = { position: POSITION, ibPnl: IB_PNL, contract: CONTRACT, quote: QUOTE, options: OPTION };

/** Every column by id. */
export const COLUMNS = Object.fromEntries(
  COLUMN_GROUPS.flatMap((group) => Object.entries(BY_GROUP[group]).map(([id, def]) => [id, { ...def, id, group } as ColumnDef])),
) as Record<ColumnId, ColumnDef>;
