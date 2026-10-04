// Option chain definitions (reqSecDefOptParams). Results are kept in memory for 10 minutes and
// persisted in the kv cache (namespace 'secdef') for a day; an older persisted chain is still
// answered at once (without its expired expirations) and refreshed in the background.
// Demo mode returns a synthesized chain from the simulator.

import { EventName } from '../ib/tws';
import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, OptionChainParams } from '@shared/types';
import type { MainContext, OptionsService } from '../context';
import { demoMarket } from './demo';
import { ibRequest, isIbConnected, NOT_CONNECTED, TtlCache } from './ibRequest';
import { nyDay } from './nyTime';

const CHAIN_TIMEOUT_MS = 15_000;
const CHAIN_TTL_MS = 10 * 60_000;
export const SECDEF_NS = 'secdef';
/** Persisted chains older than this are refreshed in the background when used. */
export const SECDEF_TTL_MS = 86_400_000;

/** Today in New York as YYYYMMDD. */
function todayYmd(nowMs: number): string {
  const d = nyDay(nowMs);
  return `${d.y}${String(d.m).padStart(2, '0')}${String(d.d).padStart(2, '0')}`;
}

/** Drops expirations before today (a persisted chain may be days old); chains left without any go too. */
export function withoutExpired(rows: OptionChainParams[], nowMs: number): OptionChainParams[] {
  const today = todayYmd(nowMs);
  return rows.map((r) => ({ ...r, expirations: r.expirations.filter((e) => e >= today) })).filter((r) => r.expirations.length > 0);
}

const isChain = (v: unknown): v is OptionChainParams[] =>
  Array.isArray(v) && v.length > 0 && v.every((r) => r && typeof r.exchange === 'string' && Array.isArray(r.expirations) && Array.isArray(r.strikes));

/**
 * Normalizes reqSecDefOptParams rows: expirations and strikes sorted and unique, SMART first,
 * then the trading class named like the underlying (e.g. SPX before SPXW, AAPL before 2AAPL).
 */
export function sortChainParams(rows: OptionChainParams[], symbol: string): OptionChainParams[] {
  const sym = symbol.toUpperCase();
  return rows
    .map((r) => ({
      ...r,
      expirations: [...new Set(r.expirations)].sort(),
      strikes: [...new Set(r.strikes)].filter((k) => Number.isFinite(k) && k > 0).sort((a, b) => a - b),
    }))
    .sort(
      (a, b) =>
        Number(b.exchange === 'SMART') - Number(a.exchange === 'SMART') ||
        Number(b.tradingClass === sym) - Number(a.tradingClass === sym) ||
        a.exchange.localeCompare(b.exchange) ||
        a.tradingClass.localeCompare(b.tradingClass),
    );
}

export function createOptionsService(ctx: MainContext): OptionsService {
  const cache = new TtlCache<OptionChainParams[]>();
  const refreshing = new Set<string>();

  const load = async (underlying: ContractRef): Promise<OptionChainParams[]> => {
    const resolved = await ctx.contracts.resolve(underlying);
    if (!resolved.conId) throw new Error(`Unknown contract: ${contractLabel(underlying)}`);
    const rows: OptionChainParams[] = [];
    const result = await ibRequest<OptionChainParams[]>(ctx, {
      label: `Option chain for ${contractLabel(underlying)}`,
      timeoutMs: CHAIN_TIMEOUT_MS,
      send: (api, reqId) =>
        api.reqSecDefOptParams(reqId, resolved.symbol, resolved.secType === 'FUT' ? resolved.exchange : '', resolved.secType, resolved.conId!),
      events: {
        [EventName.securityDefinitionOptionParameter]: (args) => {
          const [exchange, underlyingConId, tradingClass, multiplier, expirations, strikes] = args as [string, number, string, string, string[], number[]];
          rows.push({
            exchange,
            underlyingConId,
            tradingClass,
            multiplier: Number(multiplier) || 100,
            expirations: expirations ?? [],
            strikes: strikes ?? [],
          });
        },
        [EventName.securityDefinitionOptionParameterEnd]: (_args, ctl) => ctl.resolve(rows),
      },
    });
    return sortChainParams(result, resolved.symbol);
  };

  /** Loads from IB and persists a non-empty chain. */
  const fetchAndStore = async (underlying: ContractRef, key: string): Promise<OptionChainParams[]> => {
    const rows = await load(underlying);
    if (rows.length) void ctx.db?.kv.set(SECDEF_NS, key, rows);
    return rows;
  };

  const refreshInBackground = (underlying: ContractRef, key: string) => {
    if (refreshing.has(key) || !isIbConnected(ctx)) return;
    refreshing.add(key);
    fetchAndStore(underlying, key)
      .then((rows) => rows.length && cache.set(key, rows, CHAIN_TTL_MS))
      .catch(() => undefined)
      .finally(() => refreshing.delete(key));
  };

  const loadCached = async (underlying: ContractRef, key: string): Promise<OptionChainParams[]> => {
    const row = await ctx.db?.kv.get<OptionChainParams[]>(SECDEF_NS, key).catch(() => undefined);
    if (row && isChain(row.value)) {
      const now = Date.now();
      const rows = withoutExpired(row.value, now);
      const stale = now - row.updatedAt >= SECDEF_TTL_MS;
      if (rows.length) {
        if (stale) refreshInBackground(underlying, key);
        return rows;
      }
    }
    if (!isIbConnected(ctx)) throw new Error(NOT_CONNECTED);
    return fetchAndStore(underlying, key);
  };

  return {
    async getChainParams(underlying: ContractRef): Promise<OptionChainParams[]> {
      if (!underlying?.symbol) throw new Error('Invalid underlying');
      if (ctx.demo) return demoMarket().chainParams(underlying);
      const key = contractKey(underlying);
      return cache.get(key, CHAIN_TTL_MS, () => loadCached(underlying, key));
    },
  };
}
