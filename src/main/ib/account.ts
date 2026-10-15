// Account service: account summary, portfolio and positions, P&L.
//
// On every handshake: reqAccountSummary (headline values), reqAccountUpdates (portfolio with
// market prices and P&L, exchange rates), reqPositions (cross-check), reqPnL (account P&L) and one
// reqPnLSingle per position (daily, unrealized and realized P&L). Values are kept when the
// connection drops and comes back to the same account. Another account or Gateway (a new session,
// onSessionChange) starts empty at once: the renderer gets a null summary and no positions before
// anything of the new session, so the previous account's values never show under it.
//
// The positions event says whether IB has listed the positions since the last handshake
// (`loaded`, set at positionEnd): until then an instrument missing from the list may still be held,
// and the order review says its position was not checked (renderer ticket/orderRisk.ts).

import { EventName, type Contract, type IBApi } from './tws';
import { contractKey, multiplierOf } from '@shared/contract';
import type { AccountSummary, Position } from '@shared/types';
import type { AccountService, MainContext } from '../context';
import { fromIbContract, num } from './ibContract';

/**
 * reqAccountSummary tags and the summary fields they fill. The header shows IB's own Cushion and
 * Leverage rather than computing them from the other figures.
 */
const SUMMARY_TAGS = {
  NetLiquidation: 'netLiquidation',
  TotalCashValue: 'totalCashValue',
  BuyingPower: 'buyingPower',
  AvailableFunds: 'availableFunds',
  ExcessLiquidity: 'excessLiquidity',
  InitMarginReq: 'initMarginReq',
  MaintMarginReq: 'maintMarginReq',
  AccruedDividend: 'accruedDividend',
  Cushion: 'cushion',
  Leverage: 'leverage',
} as const satisfies Record<string, keyof AccountSummary>;

/** updateAccountValue keys that are not part of the account summary tags. */
const ACCOUNT_VALUES = {
  StockMarketValue: 'stockMarketValue',
  OptionMarketValue: 'optionMarketValue',
} as const satisfies Record<string, keyof AccountSummary>;

type NumericField = (typeof SUMMARY_TAGS)[keyof typeof SUMMARY_TAGS] | (typeof ACCOUNT_VALUES)[keyof typeof ACCOUNT_VALUES];

/**
 * Tags IB may answer under another name: Leverage with its securities segment's suffix
 * ("Leverage-S"). Only these: another tag's segment row ("NetLiquidation-S") is not the account's total.
 */
const SUMMARY_ALIASES: Readonly<Record<string, NumericField>> = { 'Leverage-S': 'leverage' };

/** The summary field an accountSummary tag fills, if any. */
export function summaryField(tag: string): NumericField | undefined {
  return (SUMMARY_TAGS as Record<string, NumericField>)[tag] ?? SUMMARY_ALIASES[tag];
}

const LEDGER_PREFIX = '$LEDGER-';

/**
 * The summary field an updateAccountValue fills, if any. IB sends the market values as plain keys
 * or, as paper accounts do, only as ledger keys ("$LEDGER-StockMarketValue"), either way one row
 * per currency plus "BASE". Only the BASE row is the account-currency total: a currency's own row
 * holds that currency's positions only, so it is never the account's figure, not even the account
 * currency's row (a USD account holding HKD stocks would show its USD stocks alone). Reading BASE
 * alone also never depends on the account currency, which is not known before NetLiquidation.
 */
export function accountValueField(key: string, currency: string): NumericField | undefined {
  const name = key.startsWith(LEDGER_PREFIX) ? key.slice(LEDGER_PREFIX.length) : key;
  const field = (ACCOUNT_VALUES as Record<string, NumericField>)[name];
  return field && currency === 'BASE' ? field : undefined;
}

/**
 * The currency an updateAccountValue exchange rate is for, if it is one: "ExchangeRate" or, as
 * paper accounts send it, "$LEDGER-ExchangeRate", one row per currency. The value is the account
 * (base) currency per unit of that currency; the "BASE" row carries no currency of its own.
 */
export function exchangeRateOf(key: string, currency: string): string | undefined {
  if (key !== 'ExchangeRate' && key !== `${LEDGER_PREFIX}ExchangeRate`) return undefined;
  return currency && currency !== 'BASE' ? currency : undefined;
}

const EMIT_MS = 250;
/** Instruments routed through SMART; positions report their listing exchange instead. */
const SMART_ROUTED = new Set(['STK', 'OPT', 'WAR', 'BAG']);

interface MarketFields {
  marketPrice?: number;
  marketValue?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
}

export function createAccountService(ctx: MainContext): AccountService {
  let summary: AccountSummary | null = null;
  /** Positions of the active account by conId (contract key when IB sends no conId). */
  const positions = new Map<string, Position>();
  /** Contract details looked up per position (industry / category / stock type for the allocation chart). */
  const details = new Map<string, { industry?: string; category?: string; stockType?: string }>();
  const detailsRequested = new Set<string>();

  let summaryReqId = -1;
  let pnlReqId = -1;
  const pnlSingleByConId = new Map<number, number>();
  const conIdByPnlReq = new Map<number, number>();
  /** Positions reported during the current reqPositions round (stale ones are removed at positionEnd). */
  let positionsSeen: Set<string> | null = null;
  /** IB has listed the positions since the last handshake (positionEnd). */
  let positionsLoaded = false;

  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let dirtySummary = false;
  let dirtyPositions = false;

  const activeAccount = () => ctx.ib.getState().account ?? '';
  const isActive = (account: string | undefined) => !account || !activeAccount() || account === activeAccount();

  // ---------------------------------------------------------------------------
  // Emitting

  function markDirty(s: boolean, p: boolean): void {
    dirtySummary ||= s;
    dirtyPositions ||= p;
    if (!emitTimer) emitTimer = setTimeout(flush, EMIT_MS);
  }

  function flush(): void {
    emitTimer = null;
    if (dirtySummary && summary) ctx.emit({ type: 'account', summary });
    if (dirtyPositions) {
      ctx.emit({ type: 'positions', positions: [...positions.values()], loaded: positionsLoaded });
      syncPnlSingles();
    }
    dirtySummary = dirtyPositions = false;
  }

  function patchSummary(patch: Partial<AccountSummary>): void {
    const account = activeAccount();
    const base: AccountSummary = summary && summary.account === account ? summary : { account, currency: 'USD', updatedAt: Date.now() };
    summary = { ...base, ...patch, updatedAt: Date.now() };
    markDirty(true, false);
  }

  // ---------------------------------------------------------------------------
  // Positions

  const positionId = (c: Contract) => (c.conId ? String(c.conId) : contractKey(fromIbContract(c)));

  function positionContract(c: Contract, prev: Position | undefined) {
    const ref = fromIbContract(c);
    if (SMART_ROUTED.has(ref.secType)) ref.exchange = 'SMART';
    else if (!c.exchange && prev) ref.exchange = prev.contract.exchange;
    if (!ref.primaryExchange && prev?.contract.primaryExchange) ref.primaryExchange = prev.contract.primaryExchange;
    return ref;
  }

  function upsertPosition(account: string, c: Contract, quantity: unknown, avgCost: unknown, market?: MarketFields): void {
    const id = positionId(c);
    const qty = num(quantity) ?? 0;
    if (qty === 0) {
      if (positions.delete(id)) markDirty(false, true);
      return;
    }
    const prev = positions.get(id);
    const contract = positionContract(c, prev);
    const info = details.get(id);
    const next: Position = {
      account: account || activeAccount(),
      key: contractKey(contract),
      contract,
      quantity: qty,
      averageCost: num(avgCost) ?? prev?.averageCost,
      multiplier: multiplierOf(contract),
      marketPrice: market ? market.marketPrice : prev?.marketPrice,
      marketValue: market ? market.marketValue : prev?.marketValue,
      unrealizedPnL: market ? market.unrealizedPnL : prev?.unrealizedPnL,
      realizedPnL: market ? market.realizedPnL : prev?.realizedPnL,
      dailyPnL: prev?.dailyPnL,
      pnlValue: prev?.pnlValue,
      pnlUnrealized: prev?.pnlUnrealized,
      pnlRealized: prev?.pnlRealized,
      industry: info?.industry ?? prev?.industry,
      category: info?.category ?? prev?.category,
      stockType: info?.stockType ?? prev?.stockType,
      updatedAt: Date.now(),
    };
    positions.set(id, stripUndefined(next));
    markDirty(false, true);
    lookUpDetails(id, next);
  }

  /** Industry, category and stock type come from contract details, once per instrument. */
  function lookUpDetails(id: string, p: Position): void {
    if (detailsRequested.has(id)) return;
    detailsRequested.add(id);
    ctx.contracts
      .getInfo(p.contract)
      .then((info) => {
        if (!info) return;
        details.set(id, { industry: info.industry, category: info.category, stockType: info.stockType });
        const cur = positions.get(id);
        if (cur && (info.industry || info.category || info.stockType)) {
          positions.set(id, stripUndefined({ ...cur, industry: info.industry, category: info.category, stockType: info.stockType }));
          markDirty(false, true);
        }
      })
      .catch(() => detailsRequested.delete(id));
  }

  /** One reqPnLSingle per position; cancelled when the position goes away. */
  function syncPnlSingles(): void {
    const api = ctx.ib.api;
    const account = activeAccount();
    if (!api || !account) return;
    const held = new Set<number>();
    for (const p of positions.values()) if (p.contract.conId) held.add(p.contract.conId);
    for (const conId of held) {
      if (pnlSingleByConId.has(conId)) continue;
      const reqId = ctx.ib.nextReqId();
      pnlSingleByConId.set(conId, reqId);
      conIdByPnlReq.set(reqId, conId);
      api.reqPnLSingle(reqId, account, null, conId);
    }
    for (const [conId, reqId] of pnlSingleByConId) {
      if (held.has(conId)) continue;
      api.cancelPnLSingle(reqId);
      pnlSingleByConId.delete(conId);
      conIdByPnlReq.delete(reqId);
    }
  }

  // ---------------------------------------------------------------------------
  // IB events

  /** Drops every value and tells the renderer at once (flush never sends a null summary). */
  function clearValues(): void {
    summary = null;
    positions.clear();
    positionsLoaded = false;
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    dirtySummary = dirtyPositions = false;
    ctx.emit({ type: 'account', summary: null });
    ctx.emit({ type: 'positions', positions: [], loaded: false });
  }

  /**
   * Tape moved to another Gateway, client id or account: the previous account's values go. Its
   * subscriptions ended with the previous socket; contract details stay (they are the instrument's).
   */
  function resetSession(): void {
    clearValues();
    positionsSeen = null;
    pnlSingleByConId.clear();
    conIdByPnlReq.clear();
    summaryReqId = pnlReqId = -1;
  }

  function onReady(api: IBApi): void {
    const account = activeAccount();
    // Values of another account (a session change has normally dropped them already).
    if ((summary && summary.account !== account) || [...positions.values()].some((p) => p.account && p.account !== account)) clearValues();
    // The positions kept across a reconnect may have changed meanwhile: listed again from here.
    if (positionsLoaded) {
      positionsLoaded = false;
      markDirty(false, true);
    }
    summaryReqId = ctx.ib.nextReqId();
    api.reqAccountSummary(summaryReqId, 'All', Object.keys(SUMMARY_TAGS).join(','));
    if (account) api.reqAccountUpdates(true, account);
    positionsSeen = new Set();
    api.reqPositions();
    pnlSingleByConId.clear();
    conIdByPnlReq.clear();
    if (account) {
      pnlReqId = ctx.ib.nextReqId();
      api.reqPnL(pnlReqId, account);
    }
    syncPnlSingles();
  }

  function onClosed(): void {
    summaryReqId = pnlReqId = -1;
    pnlSingleByConId.clear();
    conIdByPnlReq.clear();
    positionsSeen = null;
  }

  setImmediate(() => {
    const ib = ctx.ib;
    ib.onReady(onReady);
    ib.onClosed(onClosed);
    ib.onSessionChange(resetSession);

    ib.on(EventName.accountSummary, (reqId: number, account: string, tag: string, value: string, currency: string) => {
      if (reqId !== summaryReqId || !isActive(account)) return;
      const field = summaryField(tag);
      if (!field) return;
      patchSummary({ [field]: num(value), ...(tag === 'NetLiquidation' && currency ? { currency } : {}) });
    });

    ib.on(EventName.updateAccountValue, (key: string, value: string, currency: string, account: string) => {
      if (!isActive(account)) return;
      const rateOf = exchangeRateOf(key, currency);
      if (rateOf) {
        const rate = num(value);
        if (rate == null || rate <= 0 || summary?.exchangeRates?.[rateOf] === rate) return;
        patchSummary({ exchangeRates: { ...summary?.exchangeRates, [rateOf]: rate } });
        return;
      }
      const field = accountValueField(key, currency);
      if (!field) return;
      patchSummary({ [field]: num(value) });
    });

    ib.on(
      EventName.updatePortfolio,
      (c: Contract, pos: number, marketPrice: number, marketValue: number, averageCost?: number, unrealizedPNL?: number, realizedPNL?: number, account?: string) => {
        if (!isActive(account)) return;
        upsertPosition(account ?? '', c, pos, averageCost, {
          marketPrice: num(marketPrice),
          marketValue: num(marketValue),
          unrealizedPnL: num(unrealizedPNL),
          realizedPnL: num(realizedPNL),
        });
      },
    );

    ib.on(EventName.position, (account: string, c: Contract, pos: number, avgCost?: number) => {
      if (!isActive(account)) return;
      positionsSeen?.add(positionId(c));
      upsertPosition(account, c, pos, avgCost);
    });

    ib.on(EventName.positionEnd, () => {
      const seen = positionsSeen;
      positionsSeen = null;
      if (!seen) return;
      for (const id of [...positions.keys()]) {
        if (!seen.has(id)) positions.delete(id);
      }
      // Sent also when nothing changed: the renderer learns the list is complete.
      positionsLoaded = true;
      markDirty(false, true);
    });

    ib.on(EventName.pnl, (reqId: number, dailyPnL: number, unrealizedPnL?: number, realizedPnL?: number) => {
      if (reqId !== pnlReqId) return;
      patchSummary({ dailyPnL: num(dailyPnL), unrealizedPnL: num(unrealizedPnL), realizedPnL: num(realizedPnL) });
    });

    // The P&L engine's figures are kept apart from the portfolio update's (the positions table shows
    // them first: they are real time) and as IB sends them: IB's "no value" (Double.MAX) clears each
    // of them, the daily P&L too, rather than keeping an older figure as IB's current one.
    ib.on(EventName.pnlSingle, (reqId: number, _pos: number, dailyPnL: number, unrealized?: number, realized?: number, value?: number) => {
      const conId = conIdByPnlReq.get(reqId);
      if (conId == null) return;
      const id = String(conId);
      const cur = positions.get(id);
      if (!cur) return;
      positions.set(
        id,
        stripUndefined({
          ...cur,
          dailyPnL: num(dailyPnL),
          pnlValue: num(value),
          pnlUnrealized: num(unrealized),
          pnlRealized: num(realized),
          updatedAt: Date.now(),
        }),
      );
      markDirty(false, true);
    });
  });

  return {
    getSummary: () => summary,
    getPositions: () => [...positions.values()],
    positionsLoaded: () => positionsLoaded,
  };
}

/** Drops undefined members so the IPC payload stays small and clean. */
function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}
