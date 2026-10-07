// Symbol search (reqMatchingSymbols) and contract details (reqContractDetails) with caching.
// Stocks found by search are routed through SMART where IB reaches their listing that way, else
// on their own exchange (routeMatch).
// Contract details are persisted in the kv cache (namespace 'contract', by contract key and by
// conId), so instruments resolve without IB after a restart; entries older than a week, or built by
// an older mapping (ContractInfo.v below CONTRACT_DETAILS_VERSION), are used at once and fetched
// again in the background, through a paced queue (RefetchQueue: one request per instrument, at most
// REFETCH_MAX at a time, REFETCH_GAP_MS apart, only while connected): the control lane they share
// goes ahead of market data, so an upgrade of every held instrument must not crowd it. In demo
// mode without a connection both are answered from the simulator's built-in table.

import { EventName, type ContractDescription, type ContractDetails } from '../ib/tws';
import { CONTRACT_DETAILS_VERSION, contractKey, contractLabel } from '@shared/contract';
import type { ContractInfo, ContractRef, SymbolMatch } from '@shared/types';
import type { ContractService, MainContext } from '../context';
import { demoContractInfo, demoSearch } from './demo';
import { pickDetails, sortMatches, toContractInfo, toIbContract, toSymbolMatch } from './ibContract';
import { afterStartup, ibRequest, isIbConnected, NOT_CONNECTED, TtlCache } from './ibRequest';

const DETAILS_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 8_000;
const INFO_TTL_MS = 12 * 3600_000;
/** "No security definition" answers are kept briefly so a typo does not hammer IB. */
const UNKNOWN_TTL_MS = 60_000;
/** Search results per pattern (typing back and forth repeats patterns). */
export const SEARCH_TTL_MS = 5 * 60_000;
/** Persisted contract details older than this are refreshed in the background when used. */
export const CONTRACT_REFRESH_MS = 7 * 86_400_000;
export const CONTRACT_NS = 'contract';
const conIdKey = (conId: number) => `conId:${conId}`;
/** Background refetches in flight at most, and the least time between two of them. */
export const REFETCH_MAX = 2;
export const REFETCH_GAP_MS = 250;

/**
 * Listing exchanges whose stocks IB reaches through SMART: the US markets and those where a
 * reqContractDetails by conId with exchange SMART resolved every listing tried (IB paper
 * account, October 2026). Elsewhere (MEXI, B3, SEHK, NSE, TWSE, JSE, TASE, WSE, FWB2, MOEX,
 * DOLLR4LOT …) IB answers SMART requests with error 200, so those stocks are quoted and routed
 * on their own exchange, as are stocks of exchanges not listed here: with the primary exchange
 * as the exchange every listing tried resolved, except on venues that only list stocks (PINK,
 * AQSE, AEQLIT, ISED, PURE), and those are all reached through SMART.
 */
const SMART_LISTINGS = new Set([
  // US
  'NASDAQ',
  'NYSE',
  'ARCA',
  'AMEX',
  'BATS',
  'IEX',
  'NYSENAT',
  'MEMX',
  'LTSE',
  'PINK',
  // Canada
  'TSE',
  'VENTURE',
  'AEQLIT',
  'PURE',
  // Europe
  'LSE',
  'LSEETF',
  'LSEIOB1',
  'AQSE',
  'IBIS',
  'IBIS2',
  'FWB',
  'SWB',
  'GETTEX',
  'GETTEX2',
  'SBF',
  'AEB',
  'ENEXT.BE',
  'BVL',
  'ISED',
  'BM',
  'BVME',
  'BVME.ETF',
  'EBS',
  'SFB',
  'CPH',
  'HEX',
  'OSE',
  // Asia-Pacific
  'TSEJ',
  'KRX',
  'ASX',
]);

/** Routes a stock found by symbol search: SMART where it reaches the listing, else its own exchange. */
export function routeMatch(m: SymbolMatch): SymbolMatch {
  const c = m.contract;
  if (c.secType !== 'STK' || c.exchange !== 'SMART' || !c.primaryExchange || SMART_LISTINGS.has(c.primaryExchange)) return m;
  return { ...m, contract: { ...c, exchange: c.primaryExchange } };
}

class SupersededError extends Error {}
class OfflineError extends Error {}

/**
 * IB silently drops a symbol search sent while another one is pending, so searches run one at
 * a time (the one-per-second rule itself is enforced by the send queue, ib/tws/pacing.ts).
 * Waiting searches coalesce to the latest pattern: a queued search is superseded (resolves
 * empty, without a request) when a newer one arrives before it was sent, since while typing
 * only the latest pattern matters.
 */
class SearchQueue {
  private busy = false;
  private queued: { pattern: string; resolve: (m: SymbolMatch[]) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly send: (pattern: string) => Promise<SymbolMatch[]>) {}

  run(pattern: string): Promise<SymbolMatch[]> {
    return new Promise((resolve, reject) => {
      if (this.queued) this.queued.reject(new SupersededError('superseded'));
      this.queued = { pattern, resolve, reject };
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy || !this.queued) return;
    const job = this.queued;
    this.queued = null;
    this.busy = true;
    this.send(job.pattern)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}

/**
 * Background refetches of persisted details (see the header): deduplicated by key, at most
 * REFETCH_MAX at a time and REFETCH_GAP_MS apart, only while `ready`; `pump` resumes them (on
 * every handshake). A refetch that fails because the connection went is queued again.
 */
export class RefetchQueue {
  private readonly queued = new Map<string, () => Promise<unknown>>();
  private readonly running = new Set<string>();
  private lastStart = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ready: () => boolean) {}

  add(key: string, job: () => Promise<unknown>): void {
    if (this.queued.has(key) || this.running.has(key)) return;
    this.queued.set(key, job);
    this.pump();
  }

  pump(): void {
    while (!this.timer && this.queued.size && this.running.size < REFETCH_MAX && this.ready()) {
      const wait = this.lastStart + REFETCH_GAP_MS - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      const [key, job] = this.queued.entries().next().value!;
      this.queued.delete(key);
      this.running.add(key);
      this.lastStart = Date.now();
      job()
        .catch(() => {
          if (!this.ready() && !this.queued.has(key)) this.queued.set(key, job);
        })
        .finally(() => {
          this.running.delete(key);
          this.pump();
        });
    }
  }
}

const isInfo = (v: unknown): v is ContractInfo => !!v && typeof v === 'object' && !!(v as ContractInfo).contract?.symbol;

export function createContractService(ctx: MainContext): ContractService {
  const infoCache = new TtlCache<ContractInfo | null>();
  const byConId = new Map<number, ContractInfo>();
  const searchCache = new TtlCache<SymbolMatch[]>();
  const refetch = new RefetchQueue(() => isIbConnected(ctx));
  afterStartup(() => ctx.ib.onReady(() => refetch.pump()));

  const fetchDetails = (c: ContractRef): Promise<ContractDetails[]> => {
    const rows: ContractDetails[] = [];
    return ibRequest<ContractDetails[]>(ctx, {
      label: `Contract details for ${contractLabel(c)}`,
      timeoutMs: DETAILS_TIMEOUT_MS,
      send: (api, reqId) => api.reqContractDetails(reqId, toIbContract(c)),
      events: {
        [EventName.contractDetails]: ([details]) => void rows.push(details as ContractDetails),
        // A bond's details arrive whole, as other instruments' do (its contract in `.contract`).
        [EventName.bondContractDetails]: ([details]) => void rows.push(details as ContractDetails),
        [EventName.contractDetailsEnd]: (_args, ctl) => ctl.resolve(rows),
      },
      onError: (e, ctl) => {
        // 200 = no security definition: the contract does not exist (or is ambiguous).
        if (e.code !== 200) return false;
        ctl.resolve([]);
        return true;
      },
    });
  };

  // ---------------------------------------------------------------------------
  // Persistence

  const readPersisted = async (c: ContractRef, key: string): Promise<{ info: ContractInfo; updatedAt: number } | undefined> => {
    const kv = ctx.db?.kv;
    if (!kv) return undefined;
    try {
      const row = (c.conId ? await kv.get<ContractInfo>(CONTRACT_NS, conIdKey(c.conId)) : undefined) ?? (await kv.get<ContractInfo>(CONTRACT_NS, key));
      return row && isInfo(row.value) ? { info: row.value, updatedAt: row.updatedAt } : undefined;
    } catch {
      return undefined;
    }
  };

  /** Stores the details by the requested key, the resolved contract's key and its conId. */
  const persist = (info: ContractInfo, requestedKey: string) => {
    const kv = ctx.db?.kv;
    if (!kv) return;
    const keys = new Set([requestedKey, contractKey(info.contract)]);
    if (info.contract.conId) keys.add(conIdKey(info.contract.conId));
    for (const k of keys) void kv.set(CONTRACT_NS, k, info);
  };

  const remember = (info: ContractInfo) => {
    if (info.contract.conId) byConId.set(info.contract.conId, info);
  };

  const fetchInfo = async (c: ContractRef, key: string): Promise<ContractInfo | null> => {
    const picked = pickDetails(await fetchDetails(c), c);
    if (!picked) return null;
    const info = toContractInfo(picked, c);
    if (picked.priceMagnifier && picked.priceMagnifier > 0) info.priceMagnifier = picked.priceMagnifier;
    remember(info);
    persist(info, key);
    return info;
  };

  /** Re-reads old or outdated persisted details without making the caller wait (paced, see the header). */
  const refreshInBackground = (c: ContractRef, key: string) => {
    refetch.add(key, async () => {
      const info = await fetchInfo(c, key);
      if (info) infoCache.set(key, info, INFO_TTL_MS);
    });
  };

  const loadInfo = async (c: ContractRef, key: string): Promise<ContractInfo | null> => {
    const persisted = await readPersisted(c, key);
    if (persisted) {
      remember(persisted.info);
      const outdated = (persisted.info.v ?? 1) < CONTRACT_DETAILS_VERSION;
      if (outdated || Date.now() - persisted.updatedAt >= CONTRACT_REFRESH_MS) refreshInBackground(c, key);
      return persisted.info;
    }
    if (!isIbConnected(ctx)) throw new OfflineError(NOT_CONNECTED);
    return fetchInfo(c, key);
  };

  const getInfo = async (c: ContractRef): Promise<ContractInfo | null> => {
    if (!c || (!c.symbol && !c.conId)) return null;
    if (c.conId && byConId.has(c.conId)) return byConId.get(c.conId)!;
    const key = contractKey(c);
    const cached = infoCache.peek(key);
    if (cached !== undefined) return cached;
    try {
      return await infoCache.get(key, (v) => (v ? INFO_TTL_MS : UNKNOWN_TTL_MS), () => loadInfo(c, key));
    } catch (err) {
      if (!(err instanceof OfflineError)) throw err;
      if (ctx.demo) return demoContractInfo(c);
      throw new Error(NOT_CONNECTED);
    }
  };

  const resolve = async (c: ContractRef): Promise<ContractRef> => {
    if (c.conId && c.secType !== 'BAG') return c;
    const info = await getInfo(c);
    if (!info) throw new Error(`Unknown contract: ${contractLabel(c)}`);
    return { ...c, ...info.contract };
  };

  // ---------------------------------------------------------------------------
  // Symbol search

  const sendSearch = (pattern: string): Promise<SymbolMatch[]> =>
    ibRequest<SymbolMatch[]>(ctx, {
      label: `Symbol search "${pattern}"`,
      timeoutMs: SEARCH_TIMEOUT_MS,
      send: (api, reqId) => api.reqMatchingSymbols(reqId, pattern),
      events: {
        [EventName.symbolSamples]: ([descriptions], ctl) => {
          const matches = ((descriptions as ContractDescription[]) ?? [])
            .map(toSymbolMatch)
            .filter((m): m is SymbolMatch => !!m)
            .map(routeMatch);
          ctl.resolve(sortMatches(matches, pattern));
        },
      },
    });
  const queue = new SearchQueue(sendSearch);

  const search = async (pattern: string): Promise<SymbolMatch[]> => {
    const p = String(pattern ?? '').trim();
    if (!p) return [];
    const key = p.toUpperCase();
    const cached = searchCache.peek(key);
    if (cached) return cached;
    if (!isIbConnected(ctx)) {
      if (ctx.demo) return demoSearch(p);
      throw new Error(NOT_CONNECTED);
    }
    try {
      return await searchCache.get(key, SEARCH_TTL_MS, () => queue.run(p));
    } catch (err) {
      if (err instanceof SupersededError) return [];
      throw err;
    }
  };

  return { getInfo, resolve, search };
}
