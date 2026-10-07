// Live, read-only check of the Positions table's extra market data and of contract details version 2
// against a running IB Gateway / TWS with a paper account. Skipped unless TAPE_LIVE_IB is set, e.g.:
//
//   TAPE_LIVE_IB=127.0.0.1:4002 TAPE_CLIENT_ID=917 pnpm vitest run src/main/market/positionColumns.live.test.ts
//
// Through the real quote and contract services: the 'portfolio' owner's lines for a stock, an ETF, a
// future, a forex pair and a crypto, then the 'positions-table' owner with every add-on profile each
// of them has ticks for. Every generic tick list sent stays within LEGAL_GENERIC_TICKS minus
// NEVER_REQUESTED, IB answers no 321, and the add-ons re-request each line once without opening a
// new one. Paper accounts only (every managed account must start with DU); market data and contract
// details only, no orders. Use a client id no other program uses. The future is ESZ6 (December 2026).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { contractKey, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import { ADD_ON_PROFILES, addOnApplies } from '@shared/quoteProfiles';
import type { ContractRef, QuoteSubscription, Settings } from '@shared/types';
import type { MainContext } from '../context';
import { createMemoryDatabase } from '../db/memory';
import { EventName, OUT_MSG_ID } from '../ib/tws';
import { LEGAL_GENERIC_TICKS, NEVER_REQUESTED } from './subscriptions';

const live = process.env.TAPE_LIVE_IB;
const dir = mkdtempSync(join(tmpdir(), 'tape-columns-live-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    whenReady: () => Promise.resolve(),
    on: () => undefined,
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HELD: ContractRef[] = [
  stock('AAPL'),
  { ...stock('SPY'), primaryExchange: 'ARCA' },
  { symbol: 'ES', secType: 'FUT', exchange: 'CME', currency: 'USD', lastTradeDate: '20261218' },
  { symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' },
  { symbol: 'BTC', secType: 'CRYPTO', exchange: 'PAXOS', currency: 'USD' },
];

describe.skipIf(!live)('Positions table columns against a live IB Gateway', { timeout: 180_000 }, async () => {
  const { createApiLog } = await import('../ib/apiLog');
  const { createConnection } = await import('../ib/connection');
  const { createContractService } = await import('./contracts');
  const { createQuoteService } = await import('./quotes');

  const [host, port] = (live ?? '127.0.0.1:4002').split(':');
  const base = defaultSettings();
  const settings: Settings = { ...base, connection: { ...base.connection, host, port: Number(port) }, apiLog: { ...base.apiLog, writeFile: false } };
  const ctx = {
    demo: false,
    isDev: true,
    emit: () => undefined,
    store: { getSettings: () => settings, onSettingsChanged: () => () => undefined },
    notifier: { notify: (n: unknown) => n },
    db: createMemoryDatabase(),
  } as unknown as MainContext;
  ctx.apiLog = createApiLog(ctx);
  ctx.ib = createConnection(ctx);
  ctx.contracts = createContractService(ctx);
  ctx.quotes = createQuoteService(ctx);
  await sleep(10);

  // Nothing here may send an order.
  const orderFrames: number[] = [];
  let mktData = 0;
  let cancels = 0;
  ctx.ib.on(EventName.sent, (tokens: unknown) => {
    if (!Array.isArray(tokens)) return;
    const id = Number(tokens[0]);
    if (id === OUT_MSG_ID.PLACE_ORDER || id === OUT_MSG_ID.CANCEL_ORDER || id === OUT_MSG_ID.REQ_GLOBAL_CANCEL) orderFrames.push(id);
    if (id === OUT_MSG_ID.REQ_MKT_DATA) mktData++;
    if (id === OUT_MSG_ID.CANCEL_MKT_DATA) cancels++;
  });
  const errors: Array<{ reqId: number; code: number; message: string }> = [];
  ctx.ib.onRequestError((e) => errors.push(e));
  /** The generic tick list of every reqMktData, by its contract's type. */
  const lists: Array<{ secType: string; ticks: string }> = [];

  afterAll(async () => {
    ctx.quotes.setRendererSubscriptions('positions-table', []);
    ctx.quotes.setRendererSubscriptions('portfolio', []);
    await ctx.ib.disconnect();
    rmSync(dir, { recursive: true, force: true });
    expect(orderFrames).toEqual([]);
  });

  it('connects to a paper account', async () => {
    await ctx.ib.connect();
    expect(ctx.ib.isConnected()).toBe(true);
    const accounts = ctx.ib.getState().accounts ?? [];
    if (!accounts.length || !accounts.every((a) => a.startsWith('DU'))) {
      await ctx.ib.disconnect();
      throw new Error('Not a paper account: stopped');
    }
    // Every list the quote service sends, as it sends it.
    const api = ctx.ib.api!;
    const req = api.reqMktData.bind(api);
    api.reqMktData = ((reqId, contract, ticks, ...rest) => {
      lists.push({ secType: String(contract.secType ?? ''), ticks: ticks ?? '' });
      return req(reqId, contract, ticks, ...rest);
    }) as typeof api.reqMktData;
  });

  it('opens one line per held instrument with its basic ticks', async () => {
    ctx.quotes.setRendererSubscriptions('portfolio', HELD.map((contract) => ({ contract, profile: 'basic' as const })));
    await sleep(6000);
    expect(mktData).toBe(HELD.length);
    for (const c of HELD) console.log('[live] portfolio', contractKey(c), JSON.stringify(ctx.quotes.getQuote(contractKey(c))));
  });

  it('asks for every add-on once per line, within the legal ticks, and IB refuses none', async () => {
    const before = { mktData, cancels };
    const subs: QuoteSubscription[] = HELD.flatMap((contract) => ADD_ON_PROFILES.filter((p) => addOnApplies(p, contract.secType) && p !== 'etfNav').map((profile) => ({ contract, profile })));
    subs.push({ contract: HELD[1], profile: 'etfNav' });
    ctx.quotes.setRendererSubscriptions('positions-table', subs);
    await sleep(15_000);
    // Lines whose list grew are requested again once; none is added.
    expect(mktData - before.mktData).toBe(cancels - before.cancels);
    expect(mktData - before.mktData).toBeLessThanOrEqual(HELD.length);
    for (const { secType, ticks } of lists) {
      for (const id of ticks ? ticks.split(',').map(Number) : []) {
        expect(LEGAL_GENERIC_TICKS[secType as keyof typeof LEGAL_GENERIC_TICKS]?.has(id), `${secType} ${id}`).toBe(true);
        expect(NEVER_REQUESTED.has(id), `${secType} ${id}`).toBe(false);
      }
    }
    expect(errors.filter((e) => e.code === 321)).toEqual([]);
    for (const c of HELD) console.log('[live] with add-ons', contractKey(c), JSON.stringify(ctx.quotes.getQuote(contractKey(c))));
    console.log('[live] lists', JSON.stringify(lists));
  });

  it('removing the add-ons re-requests nothing', async () => {
    const before = { mktData, cancels };
    ctx.quotes.setRendererSubscriptions('positions-table', []);
    await sleep(3000);
    expect({ mktData, cancels }).toEqual(before);
  });

  it('keeps contract details of version 2', async () => {
    const aapl = await ctx.contracts.getInfo(stock('AAPL'));
    expect(aapl).toMatchObject({ v: 2, isin: 'US0378331005', marketName: 'NMS' });
    const es = await ctx.contracts.getInfo(HELD[2]);
    expect(es).toMatchObject({ v: 2, contractMonth: '202612', lastTradeTime: '08:30:00', lastTradeZone: 'US/Central', underSymbol: 'ES' });
    console.log('[live] details', JSON.stringify({ aapl, es }));
  });
});
