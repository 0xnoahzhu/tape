// Decodes raw API frames (the token arrays of EventName.sent / EventName.received, or their
// NUL-joined text) into API log entries: message name, named fields, request id, size and the
// raw frame. The API log decodes lazily (only frames someone reads or writes to a file), so
// this is off the socket's hot path but still runs for every frame while file logging is on.
//
// Message names come from the TWS client's protocol id enums, converted to the names of the
// EWrapper callbacks / EClient requests (TICK_PRICE -> tickPrice, REQ_MKT_DATA -> reqMktData).
// Field layouts follow the TWS decoder / encoder (ib/tws) for modern servers (server version
// 176+, TWS / IB Gateway 10.x); older layouts only differ in a few version tokens, which are
// handled where they shift the fields. Tokens without a name are listed as f<position>.

import { IBApiTickType, IN_MSG_ID, OUT_MSG_ID } from './tws';
import { hms } from '@shared/format';
import type { ApiLogEntry } from '@shared/types';
import { isErrorCode, isScannerCancelAck } from './errorCodes';

export type Direction = 'out' | 'in';
export type Fields = Array<[string, string]>;
export type DecodedFrame = Omit<ApiLogEntry, 'seq' | 't' | 'dir'>;

/** Server version assumed before the handshake tells the real one. */
export const DEFAULT_SERVER_VERSION = 193;

// ---------------------------------------------------------------------------
// Message names

const camel = (constant: string): string =>
  constant
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');

/** Protocol constants whose callback / request name is not the plain camel-cased constant. */
const IN_NAMES: Record<string, string> = {
  ERR_MSG: 'error',
  ACCT_VALUE: 'updateAccountValue',
  PORTFOLIO_VALUE: 'updatePortfolio',
  ACCT_UPDATE_TIME: 'updateAccountTime',
  ACCT_DOWNLOAD_END: 'accountDownloadEnd',
  MANAGED_ACCTS: 'managedAccounts',
  CONTRACT_DATA: 'contractDetails',
  CONTRACT_DATA_END: 'contractDetailsEnd',
  BOND_CONTRACT_DATA: 'bondContractDetails',
  EXECUTION_DATA: 'execDetails',
  EXECUTION_DATA_END: 'execDetailsEnd',
  MARKET_DEPTH: 'updateMktDepth',
  MARKET_DEPTH_L2: 'updateMktDepthL2',
  NEWS_BULLETINS: 'updateNewsBulletin',
  RECEIVE_FA: 'receiveFA',
  TICK_EFP: 'tickEFP',
  REAL_TIME_BARS: 'realtimeBar',
  REROUTE_MKT_DATA: 'rerouteMktDataReq',
  REROUTE_MKT_DEPTH: 'rerouteMktDepthReq',
  PNL: 'pnl',
  PNL_SINGLE: 'pnlSingle',
  REPLACE_FA_END: 'replaceFAEnd',
};

const OUT_NAMES: Record<string, string> = {
  REQ_ACCOUNT_DATA: 'reqAccountUpdates',
  REQ_CONTRACT_DATA: 'reqContractDetails',
  REQ_PNL: 'reqPnL',
  CANCEL_PNL: 'cancelPnL',
  REQ_PNL_SINGLE: 'reqPnLSingle',
  CANCEL_PNL_SINGLE: 'cancelPnLSingle',
  REQ_FA: 'requestFA',
  REPLACE_FA: 'replaceFA',
  REQ_CALC_IMPLIED_VOLAT: 'calculateImpliedVolatility',
  REQ_CALC_OPTION_PRICE: 'calculateOptionPrice',
  CANCEL_CALC_IMPLIED_VOLAT: 'cancelCalculateImpliedVolatility',
  CANCEL_CALC_OPTION_PRICE: 'cancelCalculateOptionPrice',
  SET_SERVER_LOGLEVEL: 'setServerLogLevel',
};

function nameTable(ids: Record<string, string | number>, overrides: Record<string, string>): Map<number, string> {
  const table = new Map<number, string>();
  for (const [constant, id] of Object.entries(ids)) {
    if (typeof id === 'number' && id >= 0) table.set(id, overrides[constant] ?? camel(constant));
  }
  return table;
}

const inNames = nameTable(IN_MSG_ID as unknown as Record<string, string | number>, IN_NAMES);
const outNames = nameTable(OUT_MSG_ID as unknown as Record<string, string | number>, OUT_NAMES);

/** Callback / request name of a protocol message id, e.g. ('in', 1) -> "tickPrice". */
export function messageName(dir: Direction, msgId: number): string | undefined {
  return (dir === 'in' ? inNames : outNames).get(msgId);
}

// ---------------------------------------------------------------------------
// Field reader

/** Java's Double.MAX_VALUE / Integer.MAX_VALUE / Long.MAX_VALUE mean "not set" on the wire. */
const UNSET = new Set(['1.7976931348623157E308', '1.7976931348623157e+308', '2147483647', '9223372036854775807']);
/** Every UNSET marker has at least this many characters (skips the set lookup for short values). */
const UNSET_MIN_LENGTH = 10;
const isUnset = (v: string): boolean => v.length >= UNSET_MIN_LENGTH && UNSET.has(v);
const shown = (v: string): string => (isUnset(v) ? '' : v);

/**
 * Contract fields that are usually empty (a stock has no expiry, strike or right). They are
 * listed only when set; the raw frame still shows every token.
 */
const OPTIONAL_FIELDS = new Set(['conId', 'lastTradeDate', 'strike', 'right', 'multiplier', 'primaryExch', 'localSymbol', 'tradingClass', 'includeExpired', 'secIdType', 'secId', 'issuerId']);
const BLANK = new Set(['', '0', '0.0', '?']);

const tick = (v: string): string => {
  const name = (IBApiTickType as unknown as Record<number, string | undefined>)[Number(v)];
  return name && v !== '' ? `${v} ${name}` : v;
};

/** Walks the tokens of one message and names them. All reads are bounds-safe. */
export class FieldReader {
  /** Named fields; "not set" markers are already shown as empty values. */
  readonly fields: Fields = [];
  readonly sv: number;
  private readonly tokens: readonly string[];
  private pos: number;

  constructor(tokens: readonly string[], start: number, sv: number) {
    this.tokens = tokens;
    this.pos = start;
    this.sv = sv;
  }

  /** Index of the next token (1-based position after the message id equals pos). */
  get position(): number {
    return this.pos;
  }

  get done(): boolean {
    return this.pos >= this.tokens.length;
  }

  peek(offset = 0): string {
    return this.tokens[this.pos + offset] ?? '';
  }

  /** The token `offset` places before the end of the message ('' when there is none). */
  fromEnd(offset = 0): string {
    return this.tokens[this.tokens.length - 1 - offset] ?? '';
  }

  /** Names the next token and returns its raw value. */
  f(name: string, format?: (v: string) => string): string {
    if (this.done) return '';
    const v = this.tokens[this.pos++];
    if (OPTIONAL_FIELDS.has(name) && (BLANK.has(v) || isUnset(v))) return v;
    this.add(name, format ? format(v) : v);
    return v;
  }

  fs(...names: string[]): void {
    for (const n of names) this.f(n);
  }

  /** Names the next token only when it is set (not empty, 0 or unset). */
  set(name: string): string {
    const v = this.str();
    if (!BLANK.has(v) && !isUnset(v)) this.add(name, v);
    return v;
  }

  /** Consumes tokens without listing them (they stay visible in the raw frame). */
  skip(n = 1): void {
    this.pos = Math.min(this.tokens.length, this.pos + Math.max(0, n));
  }

  /** Consumes one token and returns it as an integer (0 when empty). */
  int(): number {
    if (this.done) return 0;
    const n = parseInt(this.tokens[this.pos++], 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** Consumes one token and returns it. */
  str(): string {
    return this.done ? '' : this.tokens[this.pos++];
  }

  /** Adds a field (also used for computed summaries of several tokens). */
  add(name: string, value: string): void {
    this.fields.push([name, shown(value)]);
  }
}

/**
 * Formats the fields straight into a log line body ("a=1  b=2") instead of listing them, with
 * the same rules as decodeFrame + entryBody (compact schemas drop empty values; the id column
 * shows the first field named like the schema's id).
 */
class LineReader extends FieldReader {
  body = '';
  id: string | undefined;
  private readonly idName: string | undefined;
  private readonly compact: boolean;

  constructor(tokens: readonly string[], sv: number, schema: Schema) {
    super(tokens, 1, sv);
    this.idName = schema.id;
    this.compact = !!schema.compact;
  }

  override add(name: string, value: string): void {
    const v = shown(value);
    if (this.compact && v === '') return;
    if (this.id === undefined && name === this.idName) this.id = v;
    this.body += this.body ? `  ${name}=${v}` : `${name}=${v}`;
  }
}

interface Schema {
  /** Field shown in the reqId column (request id, ticker id or order id). */
  id?: string;
  /** Long messages: hide empty fields and do not list the unnamed tail. */
  compact?: boolean;
  read(r: FieldReader): void;
}

type FieldSpec = string | [string, (v: string) => string];

/** A fixed sequence of fields. */
const seq =
  (...names: FieldSpec[]) =>
  (r: FieldReader): void => {
    for (const n of names) {
      if (typeof n === 'string') r.f(n);
      else r.f(n[0], n[1]);
    }
  };

const plain = (...names: FieldSpec[]): Schema => ({ read: seq(...names) });
const withId = (id: string, ...names: FieldSpec[]): Schema => ({ id, read: seq(...names) });

/** Contract fields in the order used by requests; returns the secType. */
function contractOut(r: FieldReader, opts: { primaryExch?: boolean; includeExpired?: boolean } = {}): string {
  r.f('conId');
  r.f('symbol');
  const secType = r.f('secType');
  r.fs('lastTradeDate', 'strike', 'right', 'multiplier', 'exchange');
  if (opts.primaryExch !== false) r.f('primaryExch');
  r.fs('currency', 'localSymbol', 'tradingClass');
  if (opts.includeExpired) r.f('includeExpired');
  return secType;
}

/** Combo legs of BAG requests (conId, ratio, action, exchange). */
function comboLegs(r: FieldReader, perLeg = 4): void {
  const n = r.int();
  const legs: string[] = [];
  for (let i = 0; i < n && !r.done; i++) {
    const conId = r.str();
    const ratio = r.str();
    const action = r.str();
    r.skip(perLeg - 3);
    legs.push(`${action} ${ratio}×${conId}`);
  }
  r.add('comboLegs', legs.join(', '));
}

const summarize = (values: string[], max = 8): string =>
  values.length <= max ? values.join(', ') : `${values.slice(0, max).join(', ')} … (${values.length})`;

// ---------------------------------------------------------------------------
// Incoming messages

function openOrder(r: FieldReader): void {
  if (r.sv < 145) r.f('version');
  r.f('orderId');
  r.fs('conId', 'symbol', 'secType', 'lastTradeDate', 'strike', 'right', 'multiplier', 'exchange', 'currency', 'localSymbol', 'tradingClass');
  r.fs('action', 'totalQty', 'orderType', 'lmtPrice', 'auxPrice', 'tif', 'ocaGroup', 'account', 'openClose', 'origin', 'orderRef');
  r.fs('clientId', 'permId', 'outsideRth', 'hidden', 'discretionaryAmt', 'goodAfterTime');
}

function completedOrder(r: FieldReader): void {
  r.fs('conId', 'symbol', 'secType', 'lastTradeDate', 'strike', 'right', 'multiplier', 'exchange', 'currency', 'localSymbol', 'tradingClass');
  r.fs('action', 'totalQty', 'orderType', 'lmtPrice', 'auxPrice', 'tif', 'ocaGroup', 'account', 'openClose', 'origin', 'orderRef');
  r.fs('permId', 'outsideRth', 'hidden', 'discretionaryAmt', 'goodAfterTime');
}

function contractDetails(r: FieldReader): void {
  if (r.sv < 164) r.f('version');
  r.f('reqId');
  r.fs('symbol', 'secType', 'lastTradeDateOrContractMonth');
  if (r.sv >= 182) r.f('lastTradeDate');
  r.fs('strike', 'right', 'exchange', 'currency', 'localSymbol', 'marketName', 'tradingClass', 'conId', 'minTick');
  if (r.sv >= 110 && r.sv < 164) r.skip(); // mdSizeMultiplier
  r.fs('multiplier', 'orderTypes', 'validExchanges', 'priceMagnifier', 'underConId', 'longName', 'primaryExch');
  r.fs('contractMonth', 'industry', 'category', 'subcategory', 'timeZoneId', 'tradingHours', 'liquidHours', 'evRule', 'evMultiplier');
  const n = r.int();
  const ids: string[] = [];
  for (let i = 0; i < n && !r.done; i++) ids.push(`${r.str()}=${r.str()}`);
  if (ids.length) r.add('secIdList', ids.join(' '));
  r.fs('aggGroup', 'underSymbol', 'underSecType', 'marketRuleIds', 'realExpirationDate', 'stockType');
  if (r.sv >= 164) r.fs('minSize', 'sizeIncrement', 'suggestedSizeIncrement');
}

function historicalData(r: FieldReader): void {
  if (r.sv < 124) r.f('version');
  r.fs('reqId', 'startDate', 'endDate');
  const n = r.int();
  r.add('bars', String(n));
  const perBar = r.sv < 124 ? 9 : 8;
  if (n > 0) {
    r.add('first', r.peek(0));
    r.add('last', r.peek((n - 1) * perBar));
  }
  r.skip(n * perBar);
}

function symbolSamples(r: FieldReader): void {
  r.f('reqId');
  const n = r.int();
  r.add('count', String(n));
  const items: string[] = [];
  for (let i = 0; i < n && !r.done; i++) {
    r.skip(); // conId
    const symbol = r.str();
    const secType = r.str();
    const primary = r.str();
    r.skip(); // currency
    r.skip(r.int()); // derivative sec types
    if (r.sv >= 176) r.skip(2); // description, issuerId
    items.push(`${symbol} ${secType}${primary ? ' ' + primary : ''}`);
  }
  r.add('matches', summarize(items));
}

/** scannerData: the row count and the symbols in rank order (each row is 16 fields in version 3). */
function scannerData(r: FieldReader): void {
  const v = Number(r.f('version'));
  r.f('reqId');
  const n = r.int();
  r.add('count', String(n));
  const items: string[] = [];
  for (let i = 0; i < n && !r.done; i++) {
    r.skip(); // rank
    if (v >= 3) r.skip(); // conId
    items.push(r.str());
    r.skip(12 + (v >= 2 ? 1 : 0)); // secType … projection, legs
  }
  r.add('symbols', summarize(items));
}

function secDefOptParams(r: FieldReader): void {
  r.fs('reqId', 'exchange', 'underlyingConId', 'tradingClass', 'multiplier');
  const expirations: string[] = [];
  for (let n = r.int(), i = 0; i < n && !r.done; i++) expirations.push(r.str());
  const strikes: string[] = [];
  for (let n = r.int(), i = 0; i < n && !r.done; i++) strikes.push(r.str());
  r.add('expirations', summarize(expirations, 4));
  r.add('strikes', summarize(strikes, 4));
}

const IN_SCHEMAS: Record<string, Schema> = {
  tickPrice: withId('reqId', 'version', 'reqId', ['field', tick], 'price', 'size', 'attrib'),
  tickSize: withId('reqId', 'version', 'reqId', ['field', tick], 'size'),
  tickGeneric: withId('reqId', 'version', 'reqId', ['field', tick], 'value'),
  tickString: withId('reqId', 'version', 'reqId', ['field', tick], 'value'),
  tickOptionComputation: {
    id: 'reqId',
    read(r) {
      if (r.sv < 156) r.f('version');
      r.f('reqId');
      r.f('field', tick);
      if (r.sv >= 156) r.f('tickAttrib');
      r.fs('impliedVol', 'delta', 'optPrice', 'pvDividend', 'gamma', 'vega', 'theta', 'undPrice');
    },
  },
  tickReqParams: withId('reqId', 'reqId', 'minTick', 'bboExchange', 'snapshotPermissions'),
  tickSnapshotEnd: withId('reqId', 'version', 'reqId'),
  marketDataType: withId('reqId', 'version', 'reqId', 'marketDataType'),
  orderStatus: {
    id: 'orderId',
    read(r) {
      if (r.sv < 131) r.f('version');
      r.fs('orderId', 'status', 'filled', 'remaining', 'avgFillPrice', 'permId', 'parentId', 'lastFillPrice', 'clientId', 'whyHeld', 'mktCapPrice');
    },
  },
  openOrder: { id: 'orderId', compact: true, read: openOrder },
  openOrderEnd: plain('version'),
  completedOrder: { compact: true, read: completedOrder },
  completedOrdersEnd: plain(),
  orderBound: withId('orderId', 'permId', 'clientId', 'orderId'),
  error: withId('reqId', 'version', 'reqId', 'code', 'msg', 'advancedOrderReject'),
  nextValidId: plain('version', 'orderId'),
  managedAccounts: plain('version', 'accounts'),
  currentTime: plain('version', 'time'),
  accountSummary: withId('reqId', 'version', 'reqId', 'account', 'tag', 'value', 'currency'),
  accountSummaryEnd: withId('reqId', 'version', 'reqId'),
  updateAccountValue: plain('version', 'key', 'value', 'currency', 'account'),
  updatePortfolio: plain(
    'version',
    'conId',
    'symbol',
    'secType',
    'lastTradeDate',
    'strike',
    'right',
    'multiplier',
    'primaryExch',
    'currency',
    'localSymbol',
    'tradingClass',
    'position',
    'marketPrice',
    'marketValue',
    'averageCost',
    'unrealizedPNL',
    'realizedPNL',
    'account',
  ),
  updateAccountTime: plain('version', 'time'),
  accountDownloadEnd: plain('version', 'account'),
  position: plain(
    'version',
    'account',
    'conId',
    'symbol',
    'secType',
    'lastTradeDate',
    'strike',
    'right',
    'multiplier',
    'exchange',
    'currency',
    'localSymbol',
    'tradingClass',
    'position',
    'avgCost',
  ),
  positionEnd: plain('version'),
  pnl: withId('reqId', 'reqId', 'dailyPnL', 'unrealizedPnL', 'realizedPnL'),
  pnlSingle: withId('reqId', 'reqId', 'position', 'dailyPnL', 'unrealizedPnL', 'realizedPnL', 'value'),
  execDetails: {
    id: 'reqId',
    read(r) {
      if (r.sv < 136) r.f('version');
      r.fs('reqId', 'orderId', 'conId', 'symbol', 'secType', 'lastTradeDate', 'strike', 'right', 'multiplier', 'exchange', 'currency', 'localSymbol', 'tradingClass');
      r.fs('execId', 'time', 'account', 'execExchange', 'side', 'shares', 'price', 'permId', 'clientId', 'liquidation', 'cumQty', 'avgPrice');
      r.fs('orderRef', 'evRule', 'evMultiplier', 'modelCode', 'lastLiquidity', 'pendingPriceRevision');
    },
  },
  execDetailsEnd: withId('reqId', 'version', 'reqId'),
  commissionReport: plain('version', 'execId', 'commission', 'currency', 'realizedPNL', 'yield', 'yieldRedemptionDate'),
  historicalData: { id: 'reqId', compact: true, read: historicalData },
  historicalDataUpdate: withId('reqId', 'reqId', 'barCount', 'date', 'open', 'close', 'high', 'low', 'wap', 'volume'),
  headTimestamp: withId('reqId', 'reqId', 'headTimestamp'),
  contractDetails: { id: 'reqId', compact: true, read: contractDetails },
  contractDetailsEnd: withId('reqId', 'version', 'reqId'),
  symbolSamples: { id: 'reqId', compact: true, read: symbolSamples },
  securityDefinitionOptionParameter: { id: 'reqId', compact: true, read: secDefOptParams },
  securityDefinitionOptionParameterEnd: withId('reqId', 'reqId'),
  updateMktDepth: withId('reqId', 'version', 'reqId', 'position', 'operation', 'side', 'price', 'size'),
  updateMktDepthL2: withId('reqId', 'version', 'reqId', 'position', 'marketMaker', 'operation', 'side', 'price', 'size', 'isSmartDepth'),
  rerouteMktDataReq: withId('reqId', 'reqId', 'conId', 'exchange'),
  realtimeBar: withId('reqId', 'version', 'reqId', 'time', 'open', 'high', 'low', 'close', 'volume', 'wap', 'count'),
  userInfo: withId('reqId', 'reqId', 'whiteBrandingId'),
  wshMetaData: withId('reqId', 'reqId', 'dataJson'),
  wshEventData: withId('reqId', 'reqId', 'dataJson'),
  scannerData: { id: 'reqId', compact: true, read: scannerData },
};

// ---------------------------------------------------------------------------
// Outgoing messages

const CONDITION_TYPES: Record<number, string> = { 1: 'Price', 3: 'Time', 4: 'Margin', 5: 'Execution', 6: 'Volume', 7: 'PercentChange' };

/** Reads order conditions; returns readable summaries such as "Price #265598 >= 235". */
function orderConditions(r: FieldReader): string[] {
  const n = r.int();
  const out: string[] = [];
  for (let i = 0; i < n && !r.done; i++) {
    const type = r.int();
    const conj = r.str();
    const label = CONDITION_TYPES[type] ?? `Type ${type}`;
    let text = label;
    if (type === 5) {
      const secType = r.str();
      const exchange = r.str();
      const symbol = r.str();
      text = `${label} ${symbol} ${secType} ${exchange}`;
    } else {
      const op = r.str() === '1' ? '>=' : '<=';
      const value = r.str();
      text = `${label} ${op} ${value}`;
      if (type === 1 || type === 6 || type === 7) {
        const conId = r.str();
        r.skip(); // exchange
        text = `${label} #${conId} ${op} ${value}`;
        if (type === 1) r.skip(); // trigger method
      }
    }
    out.push(i > 0 ? `${conj === 'o' ? 'OR' : 'AND'} ${text}` : text);
  }
  return out;
}

/** placeOrder: the fields a trader checks; the full frame stays in `raw`. */
function placeOrder(r: FieldReader): void {
  if (r.sv < 145) r.f('version');
  r.f('orderId');
  const secType = contractOut(r);
  r.fs('secIdType', 'secId');
  r.f('action');
  r.f('totalQty');
  const orderType = r.f('orderType');
  r.fs('lmtPrice', 'auxPrice', 'tif', 'ocaGroup', 'account');
  r.skip(2); // openClose, origin
  r.fs('orderRef', 'transmit', 'parentId');
  r.skip(); // blockOrder
  r.set('sweepToFill');
  r.f('displaySize');
  r.set('triggerMethod');
  r.f('outsideRth');
  r.set('hidden');
  if (secType === 'BAG') {
    comboLegs(r, 8);
    r.skip(r.int()); // per-leg prices
    const params: string[] = [];
    for (let i = r.int(); i > 0; i--) params.push(`${r.str()}=${r.str()}`);
    if (params.length) r.add('comboRouting', params.join(','));
  }
  r.skip(); // deprecated sharesAllocation
  r.set('discretionaryAmt');
  r.fs('goodAfterTime', 'goodTillDate');
  r.skip(r.sv < 177 ? 4 : 3); // FA group / method / percentage (/ profile)
  r.skip(); // modelCode
  r.skip(3); // shortSaleSlot, designatedLocation, exemptCode
  r.set('ocaType');
  r.skip(2); // rule80A, settlingFirm
  r.set('allOrNone');
  r.set('minQty');
  r.set('percentOffset');
  r.skip(9); // eTradeOnly … stockRangeUpper
  r.skip(3); // overridePercentageConstraints, volatility, volatilityType
  const deltaNeutralType = r.str();
  r.skip(); // deltaNeutralAuxPrice
  if (deltaNeutralType) r.skip(8);
  r.skip(2); // continuousUpdate, referencePriceType
  r.fs('trailStopPrice', 'trailingPercent');
  r.skip(2); // scale init / subs level size
  const scaleIncrement = r.str();
  if (scaleIncrement) r.skip(7);
  r.skip(3); // scaleTable, activeStartTime, activeStopTime
  if (r.str()) r.skip(); // hedgeType (+ hedgeParam)
  r.skip(4); // optOutSmartRouting, clearingAccount, clearingIntent, notHeld
  if (r.str() === '1') r.skip(3); // delta neutral contract
  const algo = r.str();
  if (algo) {
    const params: string[] = [];
    for (let i = r.int(); i > 0; i--) params.push(`${r.str()}=${r.str()}`);
    r.add('algoStrategy', params.length ? `${algo} (${params.join(', ')})` : algo);
  }
  r.skip(); // algoId
  r.set('whatIf');
  r.skip(4); // orderMiscOptions, solicited, randomizeSize, randomizePrice
  if (orderType === 'PEG BENCH') r.skip(5);
  const conditions = orderConditions(r);
  if (conditions.length) {
    r.add('conditions', conditions.join(' '));
    r.fs('conditionsIgnoreRth', 'conditionsCancelOrder');
  }
  // The variable middle of the message is not walked: includeOvernight is the last field before
  // the manual order indicator (192+).
  if (r.sv >= 189 && r.fromEnd(r.sv >= 192 ? 1 : 0) === '1') r.add('includeOvernight', '1');
}

const OUT_SCHEMAS: Record<string, Schema> = {
  startApi: plain('version', 'clientId', 'optCapab'),
  reqMktData: {
    id: 'reqId',
    read(r) {
      r.fs('version', 'reqId');
      if (contractOut(r) === 'BAG') comboLegs(r);
      if (r.f('deltaNeutral') === '1') r.fs('dnConId', 'dnDelta', 'dnPrice');
      r.fs('genericTicks', 'snapshot', 'regulatorySnapshot', 'mktDataOptions');
    },
  },
  cancelMktData: withId('reqId', 'version', 'reqId'),
  reqMktDepth: {
    id: 'reqId',
    read(r) {
      r.fs('version', 'reqId');
      contractOut(r, { primaryExch: r.sv >= 149 });
      r.fs('numRows', 'isSmartDepth', 'mktDepthOptions');
    },
  },
  cancelMktDepth: withId('reqId', 'version', 'reqId', 'isSmartDepth'),
  placeOrder: { id: 'orderId', compact: true, read: placeOrder },
  cancelOrder: {
    id: 'orderId',
    read(r) {
      if (r.sv < 192) r.f('version');
      r.f('orderId');
      if (r.sv >= 169) r.f('manualOrderCancelTime');
      if (r.sv >= 187 && r.sv < 190) r.skip(3);
      if (r.sv >= 192) r.fs('extOperator', 'manualOrderIndicator');
    },
  },
  reqGlobalCancel: {
    read(r) {
      if (r.sv < 192) r.f('version');
      else r.fs('extOperator', 'manualOrderIndicator');
    },
  },
  reqOpenOrders: plain('version'),
  reqAllOpenOrders: plain('version'),
  reqAutoOpenOrders: plain('version', 'autoBind'),
  reqCompletedOrders: plain('apiOnly'),
  reqIds: plain('version', 'numIds'),
  reqManagedAccts: plain('version'),
  reqAccountSummary: withId('reqId', 'version', 'reqId', 'group', 'tags'),
  cancelAccountSummary: withId('reqId', 'version', 'reqId'),
  reqAccountUpdates: plain('version', 'subscribe', 'account'),
  reqPositions: plain('version'),
  cancelPositions: plain('version'),
  reqPnL: withId('reqId', 'reqId', 'account', 'modelCode'),
  cancelPnL: withId('reqId', 'reqId'),
  reqPnLSingle: withId('reqId', 'reqId', 'account', 'modelCode', 'conId'),
  cancelPnLSingle: withId('reqId', 'reqId'),
  reqExecutions: withId('reqId', 'version', 'reqId', 'clientId', 'account', 'time', 'symbol', 'secType', 'exchange', 'side'),
  reqContractDetails: {
    id: 'reqId',
    read(r) {
      r.fs('version', 'reqId');
      contractOut(r, { includeExpired: true });
      r.fs('secIdType', 'secId', 'issuerId');
    },
  },
  reqHistoricalData: {
    id: 'reqId',
    read(r) {
      if (r.sv < 124) r.f('version');
      r.f('reqId');
      const secType = contractOut(r, { includeExpired: true });
      r.fs('endDateTime', 'barSize', 'duration', 'useRTH', 'whatToShow', 'formatDate');
      if (secType === 'BAG') comboLegs(r);
      r.fs('keepUpToDate', 'chartOptions');
    },
  },
  cancelHistoricalData: withId('reqId', 'version', 'reqId'),
  reqHeadTimestamp: {
    id: 'reqId',
    read(r) {
      r.f('reqId');
      contractOut(r, { includeExpired: true });
      r.fs('useRTH', 'whatToShow', 'formatDate');
    },
  },
  reqMarketDataType: plain('version', 'marketDataType'),
  reqCurrentTime: plain('version'),
  reqMatchingSymbols: withId('reqId', 'reqId', 'pattern'),
  reqSecDefOptParams: withId('reqId', 'reqId', 'underlyingSymbol', 'futFopExchange', 'underlyingSecType', 'underlyingConId'),
  reqWshMetaData: withId('reqId', 'reqId'),
  cancelWshMetaData: withId('reqId', 'reqId'),
  reqWshEventData: withId('reqId', 'reqId', 'conId', 'filter', 'fillWatchlist', 'fillPortfolio', 'fillCompetitors', 'startDate', 'endDate', 'totalLimit'),
  cancelWshEventData: withId('reqId', 'reqId'),
  reqScannerSubscription: {
    id: 'reqId',
    compact: true,
    read: seq(
      'reqId',
      'numberOfRows',
      'instrument',
      'locationCode',
      'scanCode',
      'abovePrice',
      'belowPrice',
      'aboveVolume',
      'marketCapAbove',
      'marketCapBelow',
      'moodyRatingAbove',
      'moodyRatingBelow',
      'spRatingAbove',
      'spRatingBelow',
      'maturityDateAbove',
      'maturityDateBelow',
      'couponRateAbove',
      'couponRateBelow',
      'excludeConvertible',
      'averageOptionVolumeAbove',
      'scannerSettingPairs',
      'stockTypeFilter',
      'filterOptions',
      'options',
    ),
  },
  cancelScannerSubscription: withId('reqId', 'version', 'reqId'),
};

// ---------------------------------------------------------------------------
// Frames

/** Schemas by protocol id (one map lookup per frame instead of name + schema lookups). */
function schemaTable(names: Map<number, string>, schemas: Record<string, Schema>): Map<number, Schema> {
  const table = new Map<number, Schema>();
  for (const [id, name] of names) if (Object.hasOwn(schemas, name)) table.set(id, schemas[name]);
  return table;
}

const inSchemas = schemaTable(inNames, IN_SCHEMAS);
const outSchemas = schemaTable(outNames, OUT_SCHEMAS);

const SEP = '␀';

const tokenText = (v: unknown): string => (v == null ? '' : String(v));

/** Bytes on the wire: 4-byte length prefix plus every token NUL-terminated (UTF-8). */
export function frameBytes(tokens: readonly string[]): number {
  return tokens.reduce((n, t) => n + Buffer.byteLength(t, 'utf8') + 1, 4);
}

/**
 * Tokens of a frame's text: tokens joined by NUL. A received frame's text ends with the final
 * NUL of its last token (as read from the socket); a sent frame's text does not.
 */
export function frameTokens(dir: Direction, text: string): string[] {
  const tokens = text.split('\0');
  if (dir === 'in' && tokens[tokens.length - 1] === '') tokens.pop();
  return tokens;
}

export interface DecodeOptions {
  serverVersion?: number;
  /** The first frame received on a connection is the server version, not a message. */
  firstReceived?: boolean;
}

/**
 * Decodes one frame. `tokens` are the values passed to EventName.sent (numbers, strings,
 * undefined) or EventName.received (strings).
 */
export function decodeFrame(dir: Direction, rawTokens: readonly unknown[], opts: DecodeOptions = {}): DecodedFrame {
  const tokens = rawTokens.map(tokenText);
  if (dir === 'out' && tokens[0] === 'API\0') return handshake(tokens[tokens.length - 1] ?? '');
  return decodeTokens(dir, tokens, frameBytes(tokens), opts);
}

/**
 * Decodes one frame from its text (see frameTokens): the same result as decodeFrame with the
 * frame's tokens, without converting tokens one by one. Not for the "API\0" handshake.
 */
export function decodeFrameText(dir: Direction, text: string, opts: DecodeOptions = {}): DecodedFrame {
  const tokens = frameTokens(dir, text);
  // Every token is NUL-terminated on the wire; the text lacks the final NUL unless it was popped.
  const terminated = dir === 'in' && tokens.length > 0 && text.endsWith('\0');
  const bytes = 4 + Buffer.byteLength(text, 'utf8') + (terminated || !tokens.length ? 0 : 1);
  return decodeTokens(dir, tokens, bytes, opts);
}

function handshake(versions: string): DecodedFrame {
  return {
    msgId: 'API',
    name: 'API handshake',
    fields: [
      ['prefix', 'API\\0'],
      ['versions', versions],
    ],
    bytes: 8 + Buffer.byteLength(versions, 'utf8'),
    err: false,
    raw: `API${SEP}${versions}`,
  };
}

function decodeTokens(dir: Direction, tokens: string[], bytes: number, opts: DecodeOptions): DecodedFrame {
  const sv = opts.serverVersion || DEFAULT_SERVER_VERSION;
  const raw = tokens.join(SEP);

  if (dir === 'in' && opts.firstReceived) {
    return {
      msgId: '—',
      name: 'serverVersion',
      fields: named(tokens, 0, ['version', 'connTime']),
      bytes,
      err: false,
      raw,
    };
  }

  const msgId = tokens[0] ?? '';
  const id = Number(msgId);
  const name = messageName(dir, id) ?? `msg ${msgId}`;
  const schema = (dir === 'in' ? inSchemas : outSchemas).get(id);

  let fields: Fields;
  if (schema) {
    const reader = new FieldReader(tokens, 1, sv);
    schema.read(reader);
    fields = reader.fields;
    if (schema.compact) fields = fields.filter(([, v]) => v !== '');
    else addUnnamed(fields, tokens, reader.position);
  } else {
    fields = addUnnamed([], tokens, 1);
  }

  const reqId = schema?.id ? fieldValue(fields, schema.id) : undefined;
  const code = name === 'error' ? Number(fieldValue(fields, 'code')) : NaN;
  // IB acknowledges a scanner cancel with error 162; that one reports no failure.
  const err =
    dir === 'in' && name === 'error' && Number.isFinite(code) && isErrorCode(code) && !isScannerCancelAck(code, fieldValue(fields, 'msg') ?? '');
  return reqId ? { msgId, name, reqId, fields, bytes, err, raw } : { msgId, name, fields, bytes, err, raw };
}

function fieldValue(fields: Fields, name: string): string | undefined {
  for (const [k, v] of fields) if (k === name) return v;
  return undefined;
}

function named(tokens: readonly string[], start: number, names: string[]): Fields {
  const out: Fields = [];
  names.forEach((n, i) => {
    if (start + i < tokens.length) out.push([n, tokens[start + i]]);
  });
  return addUnnamed(out, tokens, start + names.length);
}

/** Appends the tokens without a schema name as f<position> (position 1 = first token after the id). */
function addUnnamed(out: Fields, tokens: readonly string[], from: number): Fields {
  for (let i = from; i < tokens.length; i++) out.push([`f${i}`, shown(tokens[i])]);
  return out;
}

// ---------------------------------------------------------------------------
// Text form (log files and export)

/** "a=1  b=2", the body shown in the API log list. */
export function entryBody(fields: Fields): string {
  let body = '';
  for (let i = 0; i < fields.length; i++) body += (i ? '  ' : '') + fields[i][0] + '=' + fields[i][1];
  return body;
}

let clockSecond = NaN;
let clockHms = '';

/** Local "HH:MM:SS.mmm" like hmsMs(); the HH:MM:SS part is reused within the same second. */
function clock(t: number): string {
  const second = Math.floor(t / 1000);
  if (second !== clockSecond) {
    clockSecond = second;
    clockHms = hms(t);
  }
  const ms = Math.floor(t) - second * 1000;
  return `${clockHms}.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}`;
}

function logLine(t: number, dir: Direction, name: string, reqId: string | undefined, body: string): string {
  return `${clock(t)}  ${dir === 'out' ? 'SEND' : 'RECV'}  ${name.padEnd(18)} ${(reqId || '-').padEnd(6)} ${body}`;
}

/** "10:02:11.204  SEND  reqMktData         1001   version=11  reqId=1001 …" */
export function formatLogLine(e: Pick<ApiLogEntry, 't' | 'dir' | 'name' | 'reqId' | 'fields'>): string {
  return logLine(e.t, e.dir, e.name, e.reqId, entryBody(e.fields));
}

/**
 * The log line of a frame given as text (see frameTokens): the same as
 * formatLogLine(decodeFrameText(…)) without building the entry (log files format every frame).
 */
export function frameLogLine(t: number, dir: Direction, text: string, opts: DecodeOptions = {}): string {
  const tokens = frameTokens(dir, text);
  const id = Number(tokens[0] ?? '');
  const schema = (dir === 'in' ? inSchemas : outSchemas).get(id);
  if (!schema || (dir === 'in' && opts.firstReceived)) {
    return formatLogLine({ t, dir, ...decodeTokens(dir, tokens, 0, opts) });
  }
  const r = new LineReader(tokens, opts.serverVersion || DEFAULT_SERVER_VERSION, schema);
  schema.read(r);
  if (!schema.compact) for (let i = r.position; i < tokens.length; i++) r.add(`f${i}`, tokens[i]);
  return logLine(t, dir, messageName(dir, id) ?? '', r.id, r.body);
}
