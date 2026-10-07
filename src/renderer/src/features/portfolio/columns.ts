// The Positions table's column catalog (pure): every column the table can show, grouped as in the
// column editor, with where its value comes from, which instruments it applies to, how it is
// formatted and how it sorts. Labels, IB sources and formulas are in messages.ts.
//
// The rule behind the catalog: a column shows IB's own data ('ib') or a calculation by Tape
// ('calc'), and a calculated column reads as one (a dim ƒ after its header, a tooltip giving the
// formula). A cell is empty when the column does not apply to the instrument, and "—" when it
// applies but IB has not sent the value. Most columns are computed from data Tape already receives:
// the position and portfolio updates, reqPnLSingle, the account's exchange rates, the contract
// details fetched once per position and the ticks of the position's own quote line. A column with a
// `profile` needs more generic ticks on that line: they are asked for only while the column is
// shown, and only for the positions it applies to (addOnSubscriptions, the 'positions-table' quote
// owner). The earnings columns read the holdings' earnings dates (getEarnings). A column whose unit
// or source a live check has not confirmed yet is `unverified`, which its tooltip says.

import { contractKey, contractLabel, daysToExpiry } from '@shared/contract';
import { addOnApplies, type AddOnProfile } from '@shared/quoteProfiles';
import { wallClockAt } from '@shared/timeFormat';
import type { ContractInfo, ContractRef, EarningsEvent, Quote, QuoteDividends, QuoteSubscription, SecType } from '@shared/types';
import type { CellWords } from './cells';
import { isExchangeTraded, livePrice, quoteContract, underlyingOf, type PositionRow } from './calc';

export const COLUMN_GROUPS = ['position', 'ibPnl', 'contract', 'quote', 'stats', 'short', 'income', 'options', 'other'] as const;
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
  'contractMonth',
  'lastTradeTime',
  'realExpiration',
  'isin',
  'marketName',
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
  // Statistics
  'high52w',
  'low52w',
  'from52wHigh',
  'from52wLow',
  'high26w',
  'low26w',
  'high13w',
  'low13w',
  'avgVolume',
  'relVolume',
  'impliedVol30',
  'rtHistVol',
  'callVolume',
  'putVolume',
  'callOpenInterest',
  'putOpenInterest',
  'avgOptionVolume',
  'tradeCount',
  'tradeRate',
  'volumeRate',
  'volume3m',
  'volume5m',
  'volume10m',
  'vwap',
  'auctionPrice',
  'auctionVolume',
  'auctionImbalance',
  'regImbalance',
  // Short selling
  'shortable',
  'shortableShares',
  'borrowFee',
  // Dividends and earnings
  'divPast12m',
  'divNext12m',
  'divNextDate',
  'divNextAmount',
  'divYield',
  'annualDividends',
  'daysToDividend',
  'nextEarnings',
  'nextEarningsEst',
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
  // ETF NAV, futures and bonds
  'etfNav',
  'etfNavHigh',
  'etfNavLow',
  'navPremium',
  'futuresOpenInterest',
  'bidYield',
  'askYield',
  'lastYield',
  'bondFactor',
  'cusip',
  'coupon',
  'maturity',
  'bondType',
  'bondFeatures',
  'bondDesc',
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
 * plain integer, kind / right / halt / dataType / shortable = IB codes as words, hours = today's
 * sessions, month = YYYYMM, stamp = "YYYYMMDD HH:MM" (a date and a wall time), earn = an earnings
 * date and its time of day ("YYYYMMDD|amc"), ratio = a multiple (1.25×), features = a bond's
 * features as words.
 */
export type Fmt =
  | 'text'
  | 'qty'
  | 'px'
  | 'num0'
  | 'num2'
  | 'num3'
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
  | 'hours'
  | 'month'
  | 'stamp'
  | 'shortable'
  | 'earn'
  | 'ratio'
  | 'features';

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
  /** The next earnings of the position's underlying (undefined while unknown or while no shown column reads them). */
  earnings?: EarningsEvent;
  /** Unix ms (days to expiry, today's trading hours). */
  now: number;
}

/** Editor notes of type-specific columns. */
export type ColumnNote = 'options' | 'derivatives' | 'stocks' | 'stocksOptions' | 'stocksFutures' | 'etfs' | 'futures' | 'bonds';

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
  /** A narrower test within `types` (ETF columns: stocks IB types as exchange-traded). */
  when?(row: PositionRow): boolean;
  note?: ColumnNote;
  /** Data beyond the position row: the position's quote, its contract details, the rows' gross value, or the holdings' earnings. */
  needs?: 'quote' | 'details' | 'gross' | 'earnings';
  /**
   * Generic ticks the column needs beyond the position's basic line: asked for, on the positions it
   * applies to, only while it is shown (addOnSubscriptions).
   */
  profile?: AddOnProfile | 'dividends';
  /** A live check has not confirmed the value's unit or source yet (messages.ts → unverified gives why). */
  unverified?: true;
  fmt: Fmt;
  color?: 'sign' | 'muted';
  value(c: CellCtx): CellValue;
  /** Sort key when it is not the value (Symbol: stocks, then their options by expiry and strike). */
  sortValue?(c: CellCtx): CellValue;
  /** A second, smaller line (Unrealized P&L: its percent). */
  sub?: { value(c: CellCtx): number | undefined; fmt: Fmt };
  /** The cell's tooltip (a status message, the zone of trading hours). */
  title?(c: CellCtx, w: CellWords): string | undefined;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const pos = (n: number | undefined): n is number => finite(n) && n > 0;
const text = (s: string | undefined | null): string | undefined => (s && s.trim() ? s.trim() : undefined);

const OPTIONS: readonly SecType[] = ['OPT', 'FOP'];
const OPTIONS_WAR: readonly SecType[] = ['OPT', 'FOP', 'WAR'];
const EXPIRING: readonly SecType[] = ['OPT', 'FOP', 'FUT', 'WAR'];
const MONTHLY: readonly SecType[] = ['OPT', 'FOP', 'FUT'];
const STOCKS: readonly SecType[] = ['STK'];
const STOCKS_OPTIONS: readonly SecType[] = ['STK', 'OPT'];
const STOCKS_FUTURES: readonly SecType[] = ['STK', 'FUT'];
const FUTURES: readonly SecType[] = ['FUT'];
const BONDS: readonly SecType[] = ['BOND'];
/** Instruments whose quotes carry trades (IDEALPRO forex quotes bid / ask only). */
const TRADED: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'BOND', 'WAR', 'CFD', 'CRYPTO'];
const SESSIONED: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'WAR', 'CFD', 'CRYPTO'];
const WITH_CLOSE: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'CASH', 'CFD', 'CRYPTO'];
const HALTABLE: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'WAR'];
const DELTA: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP'];
/**
 * Instruments whose contract details carry IB's own name and minimum tick (a bond's arrive whole
 * from bondContractDetails, contracts.ts).
 */
const NAMED: readonly SecType[] = ['STK', 'OPT', 'IND', 'FUT', 'FOP', 'CASH', 'BAG', 'CFD', 'WAR', 'CRYPTO', 'BOND'];
/** Instruments IB has contract details of (a combo has none of its own). */
const DETAILED: readonly SecType[] = NAMED.filter((t) => t !== 'BAG');

export const isOptionType = (t: SecType): boolean => t === 'OPT' || t === 'FOP';

/** A stock IB types as exchange-traded (ETF, ETN, ETC, ETP): the ETF NAV columns apply to it. */
const isEtf = (row: PositionRow): boolean => row.position.contract.secType === 'STK' && isExchangeTraded(row.position.stockType);

/** Whether a column applies to a row's instrument (else its cell is empty). */
export function applies(def: ColumnDef, row: PositionRow): boolean {
  return (!def.types || def.types.includes(row.position.contract.secType)) && (!def.when || def.when(row));
}

/**
 * The extra generic ticks the shown columns need: one subscription per position's quote contract
 * (the same keys as the 'portfolio' owner, so no new line opens) and profile, for the positions a
 * column applies to and whose type the profile has ticks for ('dividends': stocks). Option lines
 * carry the mark already. Sorted, so the list is the same for the same columns and positions.
 */
export function addOnSubscriptions(rows: readonly PositionRow[], defs: readonly ColumnDef[]): QuoteSubscription[] {
  const out = new Map<string, QuoteSubscription>();
  for (const def of defs) {
    const profile = def.profile;
    if (!profile) continue;
    for (const row of rows) {
      const secType = row.position.contract.secType;
      if (!applies(def, row) || (profile === 'dividends' ? secType !== 'STK' : !addOnApplies(profile, secType))) continue;
      if (profile === 'mark' && isOptionType(secType)) continue;
      const contract = quoteContract(row.position.contract);
      const k = `${contractKey(contract)}|${profile}`;
      if (!out.has(k)) out.set(k, { contract, profile });
    }
  }
  return [...out.keys()].sort().map((k) => out.get(k)!);
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

/**
 * The instant (unix ms) of a wall time, "YYYYMMDD" and "HH:MM", in an instrument's zone (IB's ids,
 * 'US/Central', are IANA ones). Without a zone, or with one the runtime does not know, the wall time
 * is read as UTC.
 */
export function zonedInstant(day: string, time: string, zone: string | undefined): number | undefined {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) return undefined;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (!zone) return wall;
  try {
    // The zone's offset at that instant, found by reading the guess back (twice: across a DST change).
    let at = wall;
    for (let i = 0; i < 2; i++) {
      const r = wallClockAt(at, zone);
      at += wall - Date.UTC(r.y, r.mo - 1, r.d, r.h, r.m, r.s);
    }
    return at;
  } catch {
    return wall;
  }
}

/** The last trading day and time as "YYYYMMDD HH:MM" (the stamp format), in the instrument's zone. */
function lastTradeStamp(c: CellCtx): string | undefined {
  const day = c.info?.contract.lastTradeDate ?? c.row.position.contract.lastTradeDate;
  const time = c.info?.lastTradeTime;
  return day && /^\d{8}$/.test(day) && time && /^\d{2}:\d{2}/.test(time) ? `${day} ${time.slice(0, 5)}` : undefined;
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
  // IB's underSymbol (a futures option's is its future, 'ESZ6'); an option's or warrant's own symbol
  // until the details come.
  underlying: {
    kind: 'ib',
    align: 'left',
    width: 80,
    sort: 'text',
    fmt: 'text',
    types: ['OPT', 'FOP', 'WAR', 'FUT', 'CFD'],
    note: 'derivatives',
    needs: 'details',
    value: (c) => {
      const k = c.row.position.contract;
      return text(c.info?.underSymbol) ?? (k.secType === 'OPT' || k.secType === 'WAR' ? text(k.symbol) : undefined);
    },
    title: (c) => {
      const i = c.info;
      if (!i?.underSecType && !i?.underConId) return undefined;
      return [text(i.underSecType), i.underConId ? `conId ${i.underConId}` : undefined].filter(Boolean).join(' · ');
    },
  },
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
  contractMonth: {
    kind: 'ib',
    align: 'left',
    width: 104,
    sort: 'text',
    fmt: 'month',
    types: MONTHLY,
    note: 'derivatives',
    needs: 'details',
    value: (c) => (/^\d{6}$/.test(c.info?.contractMonth ?? '') ? c.info!.contractMonth : undefined),
  },
  // The last trading day and time, in the instrument's zone (the cell's tooltip); sorts by the
  // instant, so 08:30 US/Central comes after 09:00 US/Eastern.
  lastTradeTime: {
    kind: 'ib',
    align: 'left',
    width: 148,
    sort: 'num',
    fmt: 'stamp',
    types: EXPIRING,
    note: 'derivatives',
    needs: 'details',
    value: lastTradeStamp,
    sortValue: (c) => {
      const stamp = lastTradeStamp(c);
      return stamp ? zonedInstant(stamp.slice(0, 8), stamp.slice(9), c.info?.lastTradeZone ?? c.info?.timeZoneId) : undefined;
    },
    title: (c) => text(c.info?.lastTradeZone),
  },
  realExpiration: {
    kind: 'ib',
    align: 'left',
    width: 92,
    sort: 'text',
    fmt: 'date',
    types: EXPIRING,
    note: 'derivatives',
    needs: 'details',
    value: (c) => (/^\d{8}$/.test(c.info?.realExpirationDate ?? '') ? c.info!.realExpirationDate : undefined),
  },
  isin: { kind: 'ib', align: 'left', width: 100, sort: 'text', fmt: 'text', types: ['STK', 'BOND'], needs: 'details', value: (c) => text(c.info?.isin) },
  marketName: { kind: 'ib', align: 'left', width: 72, sort: 'text', fmt: 'text', types: DETAILED, needs: 'details', value: (c) => text(c.info?.marketName) },
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
  // Option lines always ask for the mark (generic tick 221); the others while the column is shown.
  mark: { ...tick('px', (q) => q.mark, ['STK', 'OPT', 'FOP', 'FUT', 'CASH', 'CRYPTO']), profile: 'mark' },
  lastRthTrade: { ...tick('px', (q) => q.lastRthTrade, STOCKS, 'stocks'), width: 100 },
  halted: {
    ...tick('halt', (q) => q.haltCode ?? (q.halted == null ? undefined : q.halted ? 1 : 0), HALTABLE),
    align: 'left',
    width: 80,
  },
  dataType: { ...tick('dataType', (q) => q.marketDataType), align: 'left', width: 96 },
  // IB's last error, else 321 while IB refused the line's extra generic ticks (it runs without them).
  quoteStatus: {
    ...tick('id', (q) => q.error?.code ?? (q.ticksRefused ? 321 : undefined)),
    align: 'left',
    width: 96,
    title: (c, w) => c.q?.error?.message ?? (c.q?.ticksRefused ? w.ticksRefused[c.q.ticksRefused] : undefined),
  },
};

/** A quote field that comes with an add-on profile's generic ticks. */
const extra = (profile: ColumnDef['profile'], fmt: Fmt, read: (q: Quote) => number | undefined, types: readonly SecType[], note: ColumnNote, width?: number): Def => ({
  ...tick(fmt, read, types, note),
  profile,
  ...(width ? { width } : {}),
});

/** A calculation on the quote (with an add-on profile's ticks): `f(quote, row)`. */
const calcQ = (profile: ColumnDef['profile'], fmt: Fmt, f: (q: Quote, c: CellCtx) => number | undefined, types: readonly SecType[], note: ColumnNote, width: number): Def => ({
  kind: 'calc',
  align: 'right',
  width,
  sort: 'num',
  fmt,
  needs: 'quote',
  types,
  note,
  profile,
  value: (c) => (c.q ? f(c.q, c) : undefined),
});

/**
 * Relative difference below which a reference counts as the price itself: IB sends the week ranges
 * (ticks 15–20) as 32-bit floats (a 52-week high of 345.34 arrives as 345.33999634), whose rounding
 * error is under 2⁻²⁴ of the value.
 */
const FLOAT32_EPS = 2 ** -23;

/** (Price ÷ ref − 1) × 100, at the row's valuation price; 0 when they differ only by the float32 noise. */
function fromRef(c: CellCtx, ref: number | undefined): number | undefined {
  if (!pos(c.row.last) || !pos(ref)) return undefined;
  const r = c.row.last / ref - 1;
  return Math.abs(r) < FLOAT32_EPS ? 0 : r * 100;
}

const STATS: Partial<Record<ColumnId, Def>> = {
  high52w: extra('range', 'px', (q) => q.week52High, STOCKS, 'stocks'),
  low52w: extra('range', 'px', (q) => q.week52Low, STOCKS, 'stocks'),
  from52wHigh: { ...calcQ('range', 'pctS', (q, c) => fromRef(c, q.week52High), STOCKS, 'stocks', 112), color: 'sign' },
  from52wLow: { ...calcQ('range', 'pctS', (q, c) => fromRef(c, q.week52Low), STOCKS, 'stocks', 112), color: 'sign' },
  high26w: extra('range', 'px', (q) => q.week26High, STOCKS, 'stocks'),
  low26w: extra('range', 'px', (q) => q.week26Low, STOCKS, 'stocks'),
  high13w: extra('range', 'px', (q) => q.week13High, STOCKS, 'stocks'),
  low13w: extra('range', 'px', (q) => q.week13Low, STOCKS, 'stocks'),
  avgVolume: extra('range', 'big', (q) => q.avgVolume, STOCKS, 'stocks', 84),
  relVolume: { ...calcQ('range', 'ratio', (q) => (finite(q.volume) && pos(q.avgVolume) ? q.volume / q.avgVolume : undefined), STOCKS, 'stocks', 92), unverified: true },
  impliedVol30: extra('volatility', 'vol', (q) => q.impliedVol, STOCKS_FUTURES, 'stocksFutures', 104),
  rtHistVol: { ...extra('volatility', 'vol', (q) => q.rtHistVol, STOCKS, 'stocks', 104), unverified: true },
  callVolume: extra('optionFlow', 'big', (q) => q.callVolume, STOCKS, 'stocks', 100),
  putVolume: extra('optionFlow', 'big', (q) => q.putVolume, STOCKS, 'stocks', 100),
  callOpenInterest: extra('optionFlow', 'big', (q) => q.callOpenInterest, STOCKS_FUTURES, 'stocksFutures'),
  putOpenInterest: extra('optionFlow', 'big', (q) => q.putOpenInterest, STOCKS_FUTURES, 'stocksFutures'),
  avgOptionVolume: extra('optionFlow', 'big', (q) => q.avgOptionVolume, STOCKS, 'stocks', 104),
  tradeCount: { ...extra('activity', 'big', (q) => q.tradeCount, STOCKS, 'stocks', 80), unverified: true },
  tradeRate: extra('activity', 'big', (q) => q.tradeRate, STOCKS, 'stocks', 100),
  volumeRate: extra('activity', 'big', (q) => q.volumeRate, STOCKS_FUTURES, 'stocksFutures', 88),
  volume3m: extra('activity', 'big', (q) => q.volume3m, STOCKS, 'stocks', 84),
  volume5m: extra('activity', 'big', (q) => q.volume5m, STOCKS, 'stocks', 84),
  volume10m: extra('activity', 'big', (q) => q.volume10m, STOCKS, 'stocks', 88),
  vwap: { ...extra('vwap', 'px', (q) => q.vwap, STOCKS, 'stocks'), unverified: true },
  auctionPrice: { ...extra('auction', 'px', (q) => q.auctionPrice, STOCKS, 'stocks', 88), unverified: true },
  auctionVolume: { ...extra('auction', 'big', (q) => q.auctionVolume, STOCKS, 'stocks', 104), unverified: true },
  auctionImbalance: { ...extra('auction', 'big', (q) => q.auctionImbalance, STOCKS, 'stocks', 88), unverified: true },
  regImbalance: { ...extra('auction', 'big', (q) => q.regulatoryImbalance, STOCKS, 'stocks', 100), unverified: true },
};

const SHORT: Partial<Record<ColumnId, Def>> = {
  // IB's code as a word; sorts by the code (more to borrow, higher).
  shortable: {
    ...extra('shortSale', 'shortable', (q) => q.shortable, STOCKS, 'stocks', 72),
    align: 'left',
    title: (c) => (finite(c.q?.shortable) ? `IB ${c.q.shortable}` : undefined),
  },
  shortableShares: extra('shortSale', 'big', (q) => q.shortableShares, STOCKS, 'stocks', 112),
  borrowFee: { ...extra('shortSale', 'dec', (q) => q.borrowFee, STOCKS, 'stocks', 80), unverified: true },
};

/**
 * IB's dividend summary (tick 59) of a stock's line, with an empty 12-month sum read as 0: IB sent
 * the summary and it has none (",,," for a stock that pays no dividend). "—" only while IB has sent
 * no summary (a delayed line never gets one).
 */
const dividendsOf = (q: Quote): (QuoteDividends & { past12m: number; next12m: number }) | undefined =>
  q.dividends ? { ...q.dividends, past12m: q.dividends.past12m ?? 0, next12m: q.dividends.next12m ?? 0 } : undefined;

/** A field of IB's dividend summary (dividendsOf). */
const div = (fmt: Fmt, read: (d: NonNullable<ReturnType<typeof dividendsOf>>) => number | undefined, width: number): Def =>
  extra(
    'dividends',
    fmt,
    (q) => {
      const d = dividendsOf(q);
      return d ? read(d) : undefined;
    },
    STOCKS,
    'stocks',
    width,
  );

/** An earnings date as 'YYYYMMDD|time' (the earn format), from IB's Wall Street Horizon or Tape's estimate. */
const earningsOf = (e: EarningsEvent | undefined, estimated: boolean): string | undefined =>
  e && !!e.estimated === estimated && /^\d{8}$/.test(e.date) ? `${e.date}|${e.time ?? ''}` : undefined;

/**
 * Where a release of each time of day falls within its date, in minutes after midnight New York (for
 * sorting): before the open, during the session, after the close; one of unknown time last.
 */
const EARNINGS_MINUTES: Record<NonNullable<EarningsEvent['time']>, number> = { bmo: 9 * 60 + 29, dmh: 16 * 60 - 1, amc: 24 * 60 - 2 };

/** An earnings column's sort key: the date, then the release time (IB's exact one when pinned), as a number. */
function earningsOrder(e: EarningsEvent | undefined, estimated: boolean): number | undefined {
  if (!e || !earningsOf(e, estimated)) return undefined;
  const minutes = e.minutes ?? (e.time ? EARNINGS_MINUTES[e.time] : 24 * 60 - 1);
  return Number(e.date) * 1440 + minutes;
}

const INCOME: Partial<Record<ColumnId, Def>> = {
  divPast12m: div('px', (d) => d.past12m, 92),
  divNext12m: div('px', (d) => d.next12m, 92),
  divNextDate: {
    kind: 'ib',
    align: 'left',
    width: 92,
    sort: 'text',
    fmt: 'date',
    needs: 'quote',
    types: STOCKS,
    note: 'stocks',
    profile: 'dividends',
    value: (c) => c.q?.dividends?.nextDate,
  },
  divNextAmount: div('px', (d) => d.nextAmount, 72),
  divYield: calcQ(
    'dividends',
    'pctFine',
    (q, c) => {
      const next12m = dividendsOf(q)?.next12m;
      return finite(next12m) && pos(c.row.last) ? (next12m / c.row.last) * 100 : undefined;
    },
    STOCKS,
    'stocks',
    80,
  ),
  annualDividends: {
    ...calcQ(
      'dividends',
      'pnl',
      (q, c) => {
        const next12m = dividendsOf(q)?.next12m;
        // None for a stock that pays none, short or long (never −0).
        return finite(next12m) ? (next12m ? next12m * c.row.position.quantity : 0) : undefined;
      },
      STOCKS,
      'stocks',
      124,
    ),
    color: 'sign',
  },
  daysToDividend: calcQ('dividends', 'days', (q, c) => (/^\d{8}$/.test(q.dividends?.nextDate ?? '') ? daysToExpiry(q.dividends!.nextDate!, new Date(c.now)) : undefined), STOCKS, 'stocks', 92),
  nextEarnings: {
    kind: 'ib',
    align: 'left',
    width: 120,
    sort: 'num',
    fmt: 'earn',
    types: STOCKS_OPTIONS,
    note: 'stocksOptions',
    needs: 'earnings',
    unverified: true,
    value: (c) => earningsOf(c.earnings, false),
    sortValue: (c) => earningsOrder(c.earnings, false),
  },
  nextEarningsEst: {
    kind: 'calc',
    align: 'left',
    width: 120,
    sort: 'num',
    fmt: 'earn',
    types: STOCKS_OPTIONS,
    note: 'stocksOptions',
    needs: 'earnings',
    value: (c) => earningsOf(c.earnings, true),
    sortValue: (c) => earningsOrder(c.earnings, true),
  },
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

/** An ETF's NAV field (generic ticks 577, 614, 623); the frozen NAV stands in for the live one. */
const nav = (read: (q: Quote) => number | undefined, width?: number): Def => ({ ...extra('etfNav', 'px', read, STOCKS, 'etfs', width), when: isEtf, unverified: true });

/** A bond's details field (bondContractDetails). */
const bond = (fmt: Fmt, read: (b: NonNullable<ContractInfo['bond']>) => string | number | undefined, width: number, align: 'left' | 'right' = 'left'): Def => ({
  kind: 'ib',
  align,
  width,
  sort: align === 'left' ? 'text' : 'num',
  fmt,
  types: BONDS,
  note: 'bonds',
  needs: 'details',
  unverified: true,
  value: (c) => {
    const v = c.info?.bond ? read(c.info.bond) : undefined;
    return typeof v === 'string' ? text(v) : v;
  },
});

const OTHER: Partial<Record<ColumnId, Def>> = {
  etfNav: nav((q) => q.etfNav),
  etfNavHigh: nav((q) => q.etfNavHigh),
  etfNavLow: nav((q) => q.etfNavLow),
  navPremium: { ...calcQ('etfNav', 'pctS', (q, c) => fromRef(c, q.etfNav), STOCKS, 'etfs', 92), color: 'sign', when: isEtf, unverified: true },
  futuresOpenInterest: extra('futuresOi', 'big', (q) => q.futuresOpenInterest, FUTURES, 'futures'),
  // Bond lines carry the yields with their prices (ticks 50–52, delayed 103 / 104): as sent.
  bidYield: { ...tick('num3', (q) => q.bidYield, BONDS, 'bonds'), width: 80, unverified: true },
  askYield: { ...tick('num3', (q) => q.askYield, BONDS, 'bonds'), width: 80, unverified: true },
  lastYield: { ...tick('num3', (q) => q.lastYield, BONDS, 'bonds'), width: 80, unverified: true },
  bondFactor: { ...extra('bondFactor', 'dec', (q) => q.bondFactor, BONDS, 'bonds', 80), unverified: true },
  cusip: bond('text', (b) => b.cusip, 80),
  coupon: bond('dec', (b) => b.coupon, 72, 'right'),
  maturity: bond('date', (b) => b.maturity, 92),
  bondType: bond('text', (b) => b.bondType, 80),
  // Callable, putable, convertible as words; 'none' when IB says it is none of them.
  bondFeatures: bond(
    'features',
    (b) => {
      if (b.callable === undefined && b.putable === undefined && b.convertible === undefined) return undefined;
      const on = (['callable', 'putable', 'convertible'] as const).filter((k) => b[k]);
      return on.length ? on.join(',') : 'none';
    },
    112,
  ),
  bondDesc: { ...bond('text', (b) => b.descAppend, 140), title: (c) => text(c.info?.bond?.notes) },
};

const BY_GROUP: Record<ColumnGroup, Partial<Record<ColumnId, Def>>> = {
  position: POSITION,
  ibPnl: IB_PNL,
  contract: CONTRACT,
  quote: QUOTE,
  stats: STATS,
  short: SHORT,
  income: INCOME,
  options: OPTION,
  other: OTHER,
};

/** Every column by id. */
export const COLUMNS = Object.fromEntries(
  COLUMN_GROUPS.flatMap((group) => Object.entries(BY_GROUP[group]).map(([id, def]) => [id, { ...def, id, group } as ColumnDef])),
) as Record<ColumnId, ColumnDef>;
