// Account service: account summary, portfolio and positions, P&L, and NAV history sampling
// (persisted in the database's NAV log, see navHistory.ts).
//
// On every handshake: reqAccountSummary (headline values), reqAccountUpdates (portfolio with
// market prices and P&L), reqPositions (cross-check), reqPnL (account P&L) and one
// reqPnLSingle per position (daily P&L). Values are kept when the connection drops.

import { EventName, type Contract, type IBApi } from './tws';
import { contractKey, multiplierOf } from '@shared/contract';
import type { AccountSummary, Position } from '@shared/types';
import type { AccountService, MainContext } from '../context';
import { fromIbContract, num } from './ibContract';
import { createNavRecorder, NAV_SAMPLE_MS } from './navHistory';

/** reqAccountSummary tags and the summary fields they fill. */
const SUMMARY_TAGS = {
  NetLiquidation: 'netLiquidation',
  TotalCashValue: 'totalCashValue',
  BuyingPower: 'buyingPower',
  AvailableFunds: 'availableFunds',
  ExcessLiquidity: 'excessLiquidity',
  InitMarginReq: 'initMarginReq',
  MaintMarginReq: 'maintMarginReq',
  GrossPositionValue: 'grossPositionValue',
  AccruedDividend: 'accruedDividend',
} as const satisfies Record<string, keyof AccountSummary>;

/** updateAccountValue keys that are not part of the account summary tags. */
const ACCOUNT_VALUES = {
  StockMarketValue: 'stockMarketValue',
  OptionMarketValue: 'optionMarketValue',
} as const satisfies Record<string, keyof AccountSummary>;

type NumericField = (typeof SUMMARY_TAGS)[keyof typeof SUMMARY_TAGS] | (typeof ACCOUNT_VALUES)[keyof typeof ACCOUNT_VALUES];

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

  let navTimer: ReturnType<typeof setInterval> | null = null;
  let navSampled = false;
  // Partial contexts (unit tests) may come without a database: NAV then stays in memory.
  const navHistory = createNavRecorder(ctx.db as MainContext['db'] | undefined, {
    get: () => ctx.store.getNav?.() ?? [],
    clear: () => ctx.store.setNav([]),
  });

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
      ctx.emit({ type: 'positions', positions: [...positions.values()] });
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
    const multiplier = multiplierOf(contract);
    const cost = num(avgCost);
    const info = details.get(id);
    const next: Position = {
      account: account || activeAccount(),
      key: contractKey(contract),
      contract,
      quantity: qty,
      avgPrice: cost != null ? cost / multiplier : (prev?.avgPrice ?? 0),
      multiplier,
      marketPrice: market ? market.marketPrice : prev?.marketPrice,
      marketValue: market ? market.marketValue : prev?.marketValue,
      unrealizedPnL: market ? market.unrealizedPnL : prev?.unrealizedPnL,
      realizedPnL: market ? market.realizedPnL : prev?.realizedPnL,
      dailyPnL: prev?.dailyPnL,
      pnlValue: prev?.pnlValue,
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
  // NAV history

  function sampleNav(): void {
    const netLiq = summary?.netLiquidation;
    if (!netLiq || netLiq <= 0) return;
    navSampled = true;
    void navHistory.add({ t: Date.now(), netLiq }).then((points) => ctx.emit({ type: 'nav', points }));
  }

  // ---------------------------------------------------------------------------
  // IB events

  function onReady(api: IBApi): void {
    const account = activeAccount();
    if (summary && summary.account !== account) {
      summary = null;
      positions.clear();
      markDirty(true, true);
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
    navSampled = false;
    if (navTimer) clearInterval(navTimer);
    navTimer = setInterval(() => ctx.ib.isConnected() && sampleNav(), NAV_SAMPLE_MS);
  }

  function onClosed(): void {
    if (navTimer) clearInterval(navTimer);
    navTimer = null;
    summaryReqId = pnlReqId = -1;
    pnlSingleByConId.clear();
    conIdByPnlReq.clear();
    positionsSeen = null;
  }

  setImmediate(() => {
    // Import / compact the NAV history now, so the first snapshot already has it.
    void navHistory.load().then((points) => points.length && ctx.emit({ type: 'nav', points }));

    const ib = ctx.ib;
    ib.onReady(onReady);
    ib.onClosed(onClosed);

    ib.on(EventName.accountSummary, (reqId: number, account: string, tag: string, value: string, currency: string) => {
      if (reqId !== summaryReqId || !isActive(account)) return;
      const field = (SUMMARY_TAGS as Record<string, NumericField>)[tag];
      if (!field) return;
      patchSummary({ [field]: num(value), ...(tag === 'NetLiquidation' && currency ? { currency } : {}) });
      if (tag === 'NetLiquidation' && !navSampled) sampleNav();
    });

    ib.on(EventName.updateAccountValue, (key: string, value: string, currency: string, account: string) => {
      const field = (ACCOUNT_VALUES as Record<string, NumericField>)[key];
      if (!field || !isActive(account)) return;
      if (summary?.currency && currency && currency !== summary.currency) return;
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
      let removed = false;
      for (const id of [...positions.keys()]) {
        if (!seen.has(id)) removed = positions.delete(id) || removed;
      }
      if (removed) markDirty(false, true);
    });

    ib.on(EventName.pnl, (reqId: number, dailyPnL: number, unrealizedPnL?: number, realizedPnL?: number) => {
      if (reqId !== pnlReqId) return;
      patchSummary({ dailyPnL: num(dailyPnL), unrealizedPnL: num(unrealizedPnL), realizedPnL: num(realizedPnL) });
    });

    // The P&L engine marks positions at its own price, which outside regular hours differs from the
    // portfolio update's marketPrice: its value is kept apart (pnlValue) so a row's price, value and
    // unrealized P&L stay from one source and the daily P&L can be re-marked to it.
    ib.on(EventName.pnlSingle, (reqId: number, _pos: number, dailyPnL: number, _unrealized?: number, _realized?: number, value?: number) => {
      const conId = conIdByPnlReq.get(reqId);
      if (conId == null) return;
      const id = String(conId);
      const cur = positions.get(id);
      if (!cur) return;
      const daily = num(dailyPnL);
      const pnlValue = num(value);
      positions.set(
        id,
        stripUndefined({
          ...cur,
          dailyPnL: daily ?? cur.dailyPnL,
          pnlValue: pnlValue ?? cur.pnlValue,
          updatedAt: Date.now(),
        }),
      );
      markDirty(false, true);
    });
  });

  return {
    getSummary: () => summary,
    getPositions: () => [...positions.values()],
  };
}

/** Drops undefined members so the IPC payload stays small and clean. */
function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}
