// Live, read-only check of the dashboard's data against a running IB Gateway / TWS with a paper
// account. Skipped unless TAPE_LIVE_IB is set, e.g.:
//
//   TAPE_LIVE_IB=127.0.0.1:4002 TAPE_CLIENT_ID=362 pnpm vitest run src/main/market/dashboard.live.test.ts
//
// Through the real services: the account values the header and the margin widget read (net
// liquidation, excess liquidity, margins, today's realized P&L), the IB dividend tick on a
// 'dividends' quote line (generic tick 456), earnings (the paper account has no WSH
// subscription: estimates from IB's market scanner) and SPY's daily bars for the benchmark.
// Market data and account data only; no orders. Use a client id no other program uses.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { contractKey, stock } from '@shared/contract';
import { defaultSettings } from '@shared/defaults';
import type { Quote, Settings } from '@shared/types';
import type { MainContext } from '../context';
import { createMemoryDatabase } from '../db/memory';
import { EventName, OUT_MSG_ID } from '../ib/tws';

const live = process.env.TAPE_LIVE_IB;
const dir = mkdtempSync(join(tmpdir(), 'tape-dashboard-live-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    whenReady: () => Promise.resolve(),
    on: () => undefined,
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined || Date.now() > end) return v;
    await sleep(200);
  }
}

describe.skipIf(!live)('dashboard data against a live IB Gateway', { timeout: 120_000 }, async () => {
  const { createApiLog } = await import('../ib/apiLog');
  const { createConnection } = await import('../ib/connection');
  const { createAccountService } = await import('../ib/account');
  const { createContractService } = await import('./contracts');
  const { createQuoteService } = await import('./quotes');
  const { createHistoryService } = await import('./history');
  const { createCorporateEventsService } = await import('./corporateEvents');

  const [host, port] = (live ?? '127.0.0.1:4002').split(':');
  const base = defaultSettings();
  const settings: Settings = { ...base, connection: { ...base.connection, host, port: Number(port) }, apiLog: { ...base.apiLog, writeFile: false } };

  const ctx = {
    demo: false,
    isDev: true,
    emit: () => undefined,
    store: { getSettings: () => settings, onSettingsChanged: () => () => undefined, getNav: () => [], setNav: () => undefined },
    notifier: { notify: (n: unknown) => n },
    db: createMemoryDatabase(),
  } as unknown as MainContext;
  ctx.apiLog = createApiLog(ctx);
  ctx.ib = createConnection(ctx);
  ctx.contracts = createContractService(ctx);
  ctx.quotes = createQuoteService(ctx);
  ctx.history = createHistoryService(ctx);
  ctx.account = createAccountService(ctx);
  ctx.corporateEvents = createCorporateEventsService(ctx);
  await sleep(10);

  // Nothing here may send an order.
  const orderFrames: number[] = [];
  ctx.ib.on(EventName.sent, (tokens: unknown) => {
    if (!Array.isArray(tokens)) return;
    const id = Number(tokens[0]);
    if (id === OUT_MSG_ID.PLACE_ORDER || id === OUT_MSG_ID.CANCEL_ORDER || id === OUT_MSG_ID.REQ_GLOBAL_CANCEL) orderFrames.push(id);
  });
  const errors: string[] = [];
  ctx.ib.onRequestError((e) => errors.push(`${e.reqId} ${e.code} ${e.message}`));

  afterAll(async () => {
    ctx.quotes.setRendererSubscriptions('dashboard-div', []);
    await ctx.ib.disconnect();
    rmSync(dir, { recursive: true, force: true });
    expect(orderFrames).toEqual([]);
  });

  it('connects', async () => {
    await ctx.ib.connect();
    expect(ctx.ib.isConnected()).toBe(true);
  });

  it('has the account values of the header and the margin widget', async () => {
    const s = await until(() => {
      const a = ctx.account.getSummary();
      return a?.netLiquidation && a.excessLiquidity !== undefined && a.maintMarginReq !== undefined && a.realizedPnL !== undefined ? a : undefined;
    }, 15_000);
    expect(s).toBeDefined();
    const cushion = (s!.excessLiquidity! / s!.netLiquidation!) * 100;
    console.log('[live] account', {
      netLiq: s!.netLiquidation,
      excess: s!.excessLiquidity,
      init: s!.initMarginReq,
      maint: s!.maintMarginReq,
      gross: s!.grossPositionValue,
      realizedToday: s!.realizedPnL,
      stockMV: s!.stockMarketValue,
      optionMV: s!.optionMarketValue,
      cushion: cushion.toFixed(2),
    });
    expect(cushion).toBeGreaterThan(0);
    expect(cushion).toBeLessThanOrEqual(100.0001);
    const positions = ctx.account.getPositions();
    console.log('[live] positions', positions.map((p) => `${p.contract.secType} ${p.contract.symbol} ${p.quantity}`));
  });

  it('receives IB dividends on a dividends line', async () => {
    const symbols = ['MSFT', 'KO', 'TSLA', 'NVDA'];
    const sent: string[] = [];
    const off = ctx.ib.on(EventName.sent, (tokens: unknown) => {
      if (Array.isArray(tokens) && Number(tokens[0]) === OUT_MSG_ID.REQ_MKT_DATA) sent.push(tokens.join('|'));
    });
    ctx.quotes.setRendererSubscriptions(
      'dashboard-div',
      symbols.map((s) => ({ contract: stock(s), profile: 'dividends' as const })),
    );
    const quote = (s: string): Quote | undefined => ctx.quotes.getQuote(contractKey(stock(s)));
    await until(() => (symbols.every((s) => quote(s)?.dividends !== undefined) ? true : undefined), 20_000);
    off();
    const seen = symbols.map((s) => ({ s, type: quote(s)?.marketDataType, dividends: quote(s)?.dividends }));
    console.log('[live] dividends', JSON.stringify(seen));
    expect(sent.some((t) => t.includes('318,456'))).toBe(true);
    // Live lines carry the tick; delayed ones (market data type 3 / 4) do not.
    const liveLines = seen.filter((x) => x.type === 1 || x.type === 2);
    expect(liveLines.some((x) => x.dividends !== undefined)).toBe(liveLines.length > 0);
    for (const x of seen) if (x.dividends?.nextDate) expect(x.dividends.nextDate).toMatch(/^\d{8}$/);
  });

  it('reports earnings (Wall Street Horizon or the scanner fallback)', { timeout: 600_000 }, async () => {
    const held = ctx.account.getPositions().filter((p) => p.contract.secType === 'STK').map((p) => p.contract);
    const stocks = (held.length ? held : [stock('AAPL')]).slice(0, 40);
    // The scanner's price band comes from the quotes the widget's dividends line keeps.
    ctx.quotes.setRendererSubscriptions(
      'dashboard-div',
      stocks.map((contract) => ({ contract, profile: 'dividends' as const })),
    );
    let scans = 0;
    const off = ctx.ib.on(EventName.sent, (tokens: unknown) => {
      if (Array.isArray(tokens) && Number(tokens[0]) === OUT_MSG_ID.REQ_SCANNER_SUBSCRIPTION) scans++;
    });
    try {
      // The scanner's searches run in the background: ask until none is left (about 10 scans a
      // stock, three at a time, plus up to 10 s waiting for a quote).
      const deadline = Date.now() + 30_000 + stocks.length * 10_000;
      let res = await ctx.corporateEvents.getEarnings(stocks);
      while (res.pending && Date.now() < deadline) {
        await sleep(1000);
        res = await ctx.corporateEvents.getEarnings(stocks);
      }
      console.log('[live] earnings', JSON.stringify(res), `${scans} scans`, errors.filter((e) => / 102\d\d /.test(e)));
      expect(['unsubscribed', 'ok']).toContain(res.status);
      expect(res.pending).toBeUndefined();
      if (res.status === 'ok' && res.source === 'scanner') {
        const estimated = res.events.filter((e) => e.estimated);
        expect(estimated.length).toBeGreaterThan(0);
        for (const e of estimated) expect(e.date).toMatch(/^\d{8}$/);
      }
      // Answered from memory the second time: the same events, no more scans.
      const sent = scans;
      const again = await ctx.corporateEvents.getEarnings(stocks);
      expect(again.status).toBe(res.status);
      expect(again.events).toEqual(res.events);
      expect(again.pending).toBeUndefined();
      expect(scans).toBe(sent);
    } finally {
      off();
    }
  });

  it('loads SPY daily bars for the benchmark', async () => {
    const bars = await ctx.history.get({ contract: stock('SPY'), timeframe: '1D', slot: 'dash-bench-SPY' });
    console.log('[live] SPY bars', bars.length, bars[0] && new Date(bars[0].time * 1000).toISOString().slice(0, 10), bars.at(-1)?.close);
    expect(bars.length).toBeGreaterThan(200);
  });
});
