// Pre-trade checks of an order: what a quick look at the ticket can miss before the review's
// Confirm. Pure: the ticket (useTicket) and the strategy builder (options/sendStrategy) pass the
// order, the account's position and values, and the market in. Each risk is a red row of the
// review (layout/Dialogs.tsx, layout/orderReview.ts), and any of them has to be acknowledged
// ("I have checked these warnings") before Confirm can send. None of them refuses the order: IB
// still applies its own precautions, and Tape cannot know every reason for a large order. A check
// that cannot run (positions not listed yet, no account values, no exchange rate) is a risk of its
// own (`unchecked`), so a review never looks clean for want of data.

import { contractKey } from '@shared/contract';
import type { ContractRef, OrderRequest, OrderType, Quote, SecType } from '@shared/types';
import type { StoreState } from '../../state/store';

/**
 * How current the prices behind an order are: IB's market data type of the instrument's quote
 * (1 live, 2 frozen, 3 / 4 delayed), or none when it has no bid, ask or last price.
 */
export type MarketDataQuality = 'live' | 'delayed' | 'frozen' | 'none';

export function marketDataOf(q: Quote | undefined): MarketDataQuality {
  const priced = (n: number | undefined) => n != null && n > 0;
  if (!q || !(priced(q.bid) || priced(q.ask) || priced(q.last) || priced(q.mark))) return 'none';
  if (q.marketDataType === 2) return 'frozen';
  // 4 is delayed-frozen: the last delayed values while the market is closed.
  if (q.marketDataType === 3 || q.marketDataType === 4) return 'delayed';
  return 'live';
}

/** The worse of two qualities (a combo is as current as its stalest leg). */
export function worseData(a: MarketDataQuality, b: MarketDataQuality): MarketDataQuality {
  const rank: Record<MarketDataQuality, number> = { live: 0, delayed: 1, frozen: 2, none: 3 };
  return rank[b] > rank[a] ? b : a;
}

export type OrderRisk =
  /** A sell that opens a short position, or adds to one (`before` ≤ 0). */
  | { kind: 'opensShort'; before: number; after: number }
  /** A long position turns short, or a short one long. */
  | { kind: 'flips'; before: number; after: number }
  /** The order is worth more than LARGE_NOTIONAL_SHARE of net liquidation (both in the account currency). */
  | { kind: 'largeNotional'; amount: number; netLiq: number; currency: string }
  /** What the order opens costs more than the buying power (account currency; not for futures or written options, whose margin IB's what-if has). */
  | { kind: 'overBuyingPower'; amount: number; buyingPower: number; currency: string }
  /** A buy limit far above the ask or a sell limit far below the bid (the last price when the side is missing). */
  | { kind: 'farThroughMarket'; side: 'BUY' | 'SELL'; limit: number; market: number; ref: 'bid' | 'ask' | 'last'; pct: number }
  /** A market order, or a price taken from the bid / ask, while the prices are not live. */
  | { kind: 'marketOnStaleData'; data: Exclude<MarketDataQuality, 'live'>; market: boolean }
  /**
   * Checks that could not run, so the review does not look clean although Tape never checked:
   * IB has not listed the account's positions yet (`positions`), there is no summary of the account
   * yet (`account`), or IB sent no rate from the order's `currency` to the account's (`rate`).
   */
  | { kind: 'unchecked'; missing: UncheckedInput[]; currency?: string; accountCurrency?: string };

/** What a check needs and did not have (see the `unchecked` risk). */
export type UncheckedInput = 'positions' | 'account' | 'rate';

export type OrderRiskKind = OrderRisk['kind'];

/** What the checks compare the order with. */
export interface RiskContext {
  /** Signed position of this account in the instrument (0 when none). */
  position: number;
  /**
   * false: IB has not listed the account's positions yet (after a handshake or a session change),
   * so `position` may be 0 for want of them. The position checks then report `unchecked`.
   */
  positionsKnown?: boolean;
  bid?: number;
  ask?: number;
  last?: number;
  /** Net liquidation and buying power (AccountSummary), in the account currency; undefined before IB sent them. */
  netLiq?: number;
  buyingPower?: number;
  accountCurrency?: string;
  /**
   * Units of the account currency per unit of the order's currency (AccountSummary.exchangeRates);
   * 1 when they are the same. Without it the amounts are not compared (an `unchecked` risk says so).
   */
  rate?: number;
  marketData: MarketDataQuality;
  /** The limit price follows the bid / ask: nobody typed it. */
  priceFromQuote?: boolean;
  /**
   * A modify: the working order's quantity and what of it has filled (already in `position`). Its
   * position checks count only when the quantity grows; a smaller or equal one opens nothing new.
   */
  modified?: { quantity: number; filled: number };
}

/** An order worth more than this share of net liquidation is a large order. */
export const LARGE_NOTIONAL_SHARE = 0.25;
/** How far through the market (bid / ask) a limit may be before it is far through it. */
export const THROUGH_MARKET_SHARE = 0.05;
/** Options' spreads are wide: the band is wider. */
export const OPTION_THROUGH_MARKET_SHARE = 0.2;

/** Orders that execute at the market: their fill is whatever the market is then. */
const MARKET_TYPES: readonly OrderType[] = ['MKT', 'MTL', 'MOC'];
/** Instruments whose position Tape compares with the order (a forex "position" is a cash balance; a combo has legs). */
const POSITION_TYPES: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'WAR', 'CFD', 'BOND'];
const OPTION_TYPES: readonly SecType[] = ['OPT', 'FOP', 'WAR'];
/** Instruments whose order ties up margin, not its amount: IB's what-if has that margin. */
const MARGINED_TYPES: readonly SecType[] = ['FUT'];

const positive = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n > 0;

/**
 * The risks of a single-instrument order (`est`: its amount in the order's currency, as the ticket
 * shows it). Strategy combos use strategyRisks.
 */
export function orderRisks(req: OrderRequest, est: number | undefined, ctx: RiskContext): OrderRisk[] {
  const risks: OrderRisk[] = [];
  const missing: UncheckedInput[] = [];
  const buy = req.action === 'BUY';
  const qty = req.quantity;
  const secType = req.contract.secType;
  // A forex order sized by an amount (IB's cashQty): the whole amount is what it opens.
  const cashSized = qty === 0 && positive(req.cashQty);
  const before = ctx.position;
  // A modify: what is left of the order acts on the position (its fills are in it already).
  const acting = Math.max(0, qty - (ctx.modified?.filled ?? 0));
  const grows = !ctx.modified || qty > ctx.modified.quantity;
  // Without IB's list of positions a 0 would only mean "not listed yet": the row says so instead.
  if (qty > 0 && grows && POSITION_TYPES.includes(secType) && ctx.positionsKnown === false) missing.push('positions');
  else if (qty > 0 && grows && POSITION_TYPES.includes(secType)) {
    const after = before + (buy ? acting : -acting);
    if (!buy && after < 0 && before <= 0) risks.push({ kind: 'opensShort', before, after });
    else if (before !== 0 && after !== 0 && Math.sign(after) !== Math.sign(before)) risks.push({ kind: 'flips', before, after });
  }

  const amount = positive(est) && positive(ctx.rate) ? est * ctx.rate : undefined;
  const currency = ctx.accountCurrency ?? req.contract.currency;
  if (positive(est)) missing.push(...valuesMissing(ctx));
  if (amount != null && positive(ctx.netLiq) && amount > LARGE_NOTIONAL_SHARE * ctx.netLiq) {
    risks.push({ kind: 'largeNotional', amount, netLiq: ctx.netLiq, currency });
  }
  // Only what the order opens needs buying power (closing a position frees it). A short option's
  // premium and a future's notional say nothing about their margin: IB's what-if covers that.
  if (amount != null && ctx.buyingPower != null && (qty > 0 || cashSized) && !MARGINED_TYPES.includes(secType) && (buy || !OPTION_TYPES.includes(secType))) {
    const opens = buy ? Math.max(0, acting - Math.max(0, -before)) : Math.max(0, acting - Math.max(0, before));
    const opening = cashSized ? amount : (amount * opens) / qty;
    if (opening > 0 && opening > ctx.buyingPower) risks.push({ kind: 'overBuyingPower', amount: opening, buyingPower: ctx.buyingPower, currency });
  }

  const limit = req.orderType === 'LMT' || req.orderType === 'LOC' ? req.limitPrice : undefined;
  if (positive(limit)) {
    const band = OPTION_TYPES.includes(secType) ? OPTION_THROUGH_MARKET_SHARE : THROUGH_MARKET_SHARE;
    const side = buy ? ctx.ask : ctx.bid;
    const ref: 'bid' | 'ask' | 'last' | null = positive(side) ? (buy ? 'ask' : 'bid') : positive(ctx.last) ? 'last' : null;
    const market = ref === 'last' ? ctx.last : side;
    if (ref && positive(market)) {
      const through = buy ? limit / market - 1 : 1 - limit / market;
      if (through > band) risks.push({ kind: 'farThroughMarket', side: req.action, limit, market, ref, pct: through * 100 });
    }
  }

  const atMarket = MARKET_TYPES.includes(req.orderType);
  if (ctx.marketData !== 'live' && (atMarket || ctx.priceFromQuote)) risks.push({ kind: 'marketOnStaleData', data: ctx.marketData, market: atMarket });
  if (missing.length) risks.push(unchecked(missing, req.contract.currency, ctx));
  return risks;
}

/**
 * What the size and buying power checks lack: the account's values (no summary of it yet), or IB's
 * rate from the order's currency to the account's (the summary is there, the rate is not).
 */
function valuesMissing(ctx: Pick<RiskContext, 'netLiq' | 'buyingPower' | 'rate'>): UncheckedInput[] {
  if (ctx.netLiq == null || ctx.buyingPower == null) return ['account'];
  return positive(ctx.rate) ? [] : ['rate'];
}

const unchecked = (missing: UncheckedInput[], currency: string | undefined, ctx: Pick<RiskContext, 'accountCurrency'>): OrderRisk => ({
  kind: 'unchecked',
  missing,
  ...(missing.includes('rate') ? { currency, accountCurrency: ctx.accountCurrency } : {}),
});

/**
 * The risks of a strategy combo (BAG): its size against the account, and prices taken from legs
 * whose data is not live (the net price comes from their quotes). `amount` is the order's cost in
 * the order's currency (`currency`), positive for a net debit. The legs' own position effects are
 * the strategy's point and are listed leg by leg in the review instead.
 */
export function strategyRisks(
  market: boolean,
  amount: number | undefined,
  ctx: Omit<RiskContext, 'position' | 'positionsKnown' | 'bid' | 'ask' | 'last' | 'priceFromQuote' | 'modified'>,
  currency?: string,
): OrderRisk[] {
  const risks: OrderRisk[] = [];
  const value = amount != null && Number.isFinite(amount) && positive(ctx.rate) ? Math.abs(amount) * ctx.rate : undefined;
  const accountCurrency = ctx.accountCurrency ?? 'USD';
  if (value != null && value > 0 && positive(ctx.netLiq) && value > LARGE_NOTIONAL_SHARE * ctx.netLiq) {
    risks.push({ kind: 'largeNotional', amount: value, netLiq: ctx.netLiq, currency: accountCurrency });
  }
  // A net debit is paid; a net credit's margin is IB's what-if's business.
  if (value != null && amount != null && amount > 0 && ctx.buyingPower != null && value > ctx.buyingPower) {
    risks.push({ kind: 'overBuyingPower', amount: value, buyingPower: ctx.buyingPower, currency: accountCurrency });
  }
  if (ctx.marketData !== 'live') risks.push({ kind: 'marketOnStaleData', data: ctx.marketData, market });
  const missing = amount != null && Number.isFinite(amount) && amount !== 0 ? valuesMissing(ctx) : [];
  if (missing.length) risks.push(unchecked(missing, currency, ctx));
  return risks;
}

/**
 * Units of the account currency per unit of `currency`: 1 for the same currency, else IB's rate
 * (AccountSummary.exchangeRates), undefined when unknown.
 */
export function rateTo(currency: string | undefined, account: { currency: string; exchangeRates?: Record<string, number> } | null | undefined): number | undefined {
  if (!account) return undefined;
  if (!currency || currency === account.currency) return 1;
  const r = account.exchangeRates?.[currency];
  return positive(r) ? r : undefined;
}

/**
 * An account's position in `contract` (its lines summed; 0 without one): what an order there changes.
 * `account`: the connected one (new orders go there), or a modified order's own.
 */
export function accountPosition(s: Pick<StoreState, 'connection' | 'positions'>, contract: ContractRef, account = s.connection.account): number {
  const key = contractKey(contract);
  return s.positions.filter((p) => (!account || p.account === account) && contractKey(p.contract) === key).reduce((n, p) => n + p.quantity, 0);
}

/**
 * The account side of the checks for an order on `contract`: the position of the account the order
 * goes to (the connected one, or a modified order's own) in it (summed over its lines) and whether IB
 * has listed the positions yet, and its net liquidation and buying power with the rate of the order's
 * currency. Values of another account (a summary not yet replaced, or the connected account's when
 * the order is another's) are left out. Tape lists the connected account's positions only
 * (main/ib/account.ts), so another account's position is not known.
 */
export function accountRiskContext(
  s: Pick<StoreState, 'connection' | 'positions' | 'positionsLoaded' | 'account'>,
  contract: ContractRef,
  account = s.connection.account,
): Pick<RiskContext, 'position' | 'positionsKnown' | 'netLiq' | 'buyingPower' | 'accountCurrency' | 'rate'> {
  const position = accountPosition(s, contract, account);
  const summary = s.account && (!account || s.account.account === account) ? s.account : null;
  const listed = !account || !s.connection.account || account === s.connection.account;
  return {
    position,
    positionsKnown: s.positionsLoaded && listed,
    netLiq: summary?.netLiquidation,
    buyingPower: summary?.buyingPower,
    accountCurrency: summary?.currency,
    rate: rateTo(contract.currency, summary),
  };
}
