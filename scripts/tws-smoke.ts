// Live smoke test of the built-in TWS API client (src/main/ib/tws) against a running
// TWS / IB Gateway. Paper accounts only: it refuses to place an order when an account does
// not look like a paper account (IB paper account ids start with "D").
//
//   node scripts/tws-smoke.ts [--host 127.0.0.1] [--port 4002] [--client-id 122] [--no-order]
//
// Steps: connect, nextValidId, current time, account summary, positions, contract details,
// matching symbols, option parameters, open / completed orders, executions, then one BUY 1
// AAPL LMT 1.00 GTC order far below the market which is cancelled right away, disconnect.
// Exits with code 1 when a step fails.

import { parseArgs } from 'node:util';
import { EventName, IBApi, type Contract, type ContractDescription, type ContractDetails } from '../src/main/ib/tws/index.ts';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4002' },
    'client-id': { type: 'string', default: '122' },
    'no-order': { type: 'boolean', default: false },
  },
});

const clientId = Number(values['client-id']);
const api = new IBApi({ host: values.host, port: Number(values.port) });
const t0 = Date.now();
const log = (msg: string) => console.log(`[${String(Date.now() - t0).padStart(5)} ms] ${msg}`);
const failures: string[] = [];
let sent = 0;
let received = 0;

api.on(EventName.sent, () => sent++);
api.on(EventName.received, () => received++);
api.on(EventName.info, (message: string, code: number) => log(`info  ${code} ${message}`));
api.on(EventName.error, (err: Error, code: number, reqId: number) => log(`error ${code} (req ${reqId}) ${err.message}`));
api.on(EventName.disconnected, () => log('disconnected'));

/** Resolves with the arguments of the first `event` matching `pred`, or undefined after `ms`. */
function waitFor(event: string, pred: (...args: any[]) => boolean = () => true, ms = 10_000): Promise<unknown[] | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      api.off(event, handler);
      resolve(undefined);
    }, ms);
    const handler = (...args: unknown[]) => {
      if (!pred(...args)) return;
      clearTimeout(timer);
      api.off(event, handler);
      resolve(args);
    };
    api.on(event, handler);
  });
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await run();
    if (result === undefined) throw new Error('timed out');
    return result;
  } catch (err) {
    failures.push(name);
    log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Collects `event` until `endEvent` arrives (both optionally filtered by request id). */
function collect(event: string, endEvent: string, reqId?: number, ms = 10_000): Promise<unknown[][] | undefined> {
  const rows: unknown[][] = [];
  const onRow = (...args: unknown[]) => {
    if (reqId === undefined || args[0] === reqId) rows.push(args);
  };
  api.on(event, onRow);
  return waitFor(endEvent, (...args) => reqId === undefined || args[0] === reqId, ms).then((end) => {
    api.off(event, onRow);
    return end ? rows : undefined;
  });
}

const aapl: Contract = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' };

// ---------------------------------------------------------------------------

log(`connecting to ${values.host}:${values.port} as client ${clientId}`);
const server = waitFor(EventName.server);
const accountsP = waitFor(EventName.managedAccounts);
const nextIdP = waitFor(EventName.nextValidId);
api.connect(clientId);

const [serverVersion, connTime] = ((await server) ?? []) as [number, string];
if (!serverVersion) {
  log('FAIL  no server version (is TWS / IB Gateway running?)');
  process.exit(1);
}
log(`server version ${serverVersion}, connection time "${connTime}", isConnected=${api.isConnected}`);
const nextId = await step('nextValidId', async () => ((await nextIdP)?.[0] as number | undefined));
const accountList = ((await accountsP)?.[0] as string | undefined) ?? '';
const accounts = accountList.split(',').filter(Boolean);
log(`nextValidId ${nextId}, managed accounts ${accounts.join(', ')}`);

await step('reqCurrentTime', async () => {
  api.reqCurrentTime();
  const t = (await waitFor(EventName.currentTime))?.[0] as number | undefined;
  if (t !== undefined) log(`currentTime ${t} (${new Date(t * 1000).toISOString()})`);
  return t;
});

await step('reqAccountSummary', async () => {
  const reqId = 9001;
  const rows = collect(EventName.accountSummary, EventName.accountSummaryEnd, reqId);
  api.reqAccountSummary(reqId, 'All', 'NetLiquidation,TotalCashValue,BuyingPower,AvailableFunds');
  const r = await rows;
  api.cancelAccountSummary(reqId);
  if (r) log(`accountSummary: ${r.map((a) => `${a[1]} ${a[2]}=${a[3]} ${a[4]}`).join('; ')}`);
  return r;
});

await step('reqPositions', async () => {
  const rows = collect(EventName.position, EventName.positionEnd);
  api.reqPositions();
  const r = await rows;
  api.cancelPositions();
  if (r) log(`positions: ${r.length ? r.map((a) => `${(a[1] as Contract).symbol} ${a[2]} @ ${a[3]}`).join('; ') : 'none'}`);
  return r;
});

await step('reqContractDetails', async () => {
  const reqId = 9010;
  const rows = collect(EventName.contractDetails, EventName.contractDetailsEnd, reqId);
  api.reqContractDetails(reqId, aapl);
  const r = await rows;
  const d = r?.[0]?.[1] as ContractDetails | undefined;
  if (d) log(`contractDetails: ${d.contract.symbol} conId ${d.contract.conId} ${d.longName} on ${d.contract.primaryExch}, minTick ${d.minTick}, ${r!.length} result(s)`);
  return r?.length ? r : undefined;
});

await step('reqMatchingSymbols', async () => {
  const reqId = 9014;
  const p = waitFor(EventName.symbolSamples, (id) => id === reqId);
  api.reqMatchingSymbols(reqId, 'AAPL');
  const list = (await p)?.[1] as ContractDescription[] | undefined;
  if (list) log(`symbolSamples: ${list.length} matches, first ${list[0]?.contract?.symbol} (${list[0]?.contract?.description ?? ''})`);
  return list;
});

await step('reqSecDefOptParams', async () => {
  const reqId = 9012;
  const rows = collect(EventName.securityDefinitionOptionParameter, EventName.securityDefinitionOptionParameterEnd, reqId);
  api.reqSecDefOptParams(reqId, 'AAPL', '', 'STK', 265598);
  const r = await rows;
  const smart = r?.find((a) => a[1] === 'SMART');
  if (r) log(`secDefOptParams: ${r.length} exchanges; SMART: ${(smart?.[5] as string[] | undefined)?.length ?? 0} expirations, ${(smart?.[6] as number[] | undefined)?.length ?? 0} strikes, multiplier ${smart?.[4]}`);
  return r?.length ? r : undefined;
});

await step('reqAllOpenOrders', async () => {
  const rows = collect(EventName.openOrder, EventName.openOrderEnd);
  api.reqAllOpenOrders();
  const r = await rows;
  if (r) log(`open orders: ${r.length}`);
  return r;
});

await step('reqCompletedOrders', async () => {
  const rows = collect(EventName.completedOrder, EventName.completedOrdersEnd);
  api.reqCompletedOrders(false);
  const r = await rows;
  if (r) log(`completed orders: ${r.length}`);
  return r;
});

await step('reqExecutions', async () => {
  const reqId = 9015;
  const rows = collect(EventName.execDetails, EventName.execDetailsEnd, reqId);
  api.reqExecutions(reqId, {});
  const r = await rows;
  if (r) log(`executions: ${r.length}`);
  return r;
});

// ---------------------------------------------------------------------------
// One far-from-market limit order, cancelled right away.

const paper = accounts.length > 0 && accounts.every((a) => a.startsWith('D'));
if (values['no-order']) {
  log('order step skipped (--no-order)');
} else if (!paper || nextId === undefined) {
  failures.push('placeOrder');
  log(`FAIL  placeOrder: refusing to place an order (accounts ${accounts.join(', ') || 'unknown'} are not all paper accounts)`);
} else {
  const orderId = nextId;
  const statuses: string[] = [];
  api.on(EventName.orderStatus, (id: number, status: string) => {
    if (id === orderId && statuses[statuses.length - 1] !== status) {
      statuses.push(status);
      log(`orderStatus ${id} ${status}`);
    }
  });
  await step('placeOrder', async () => {
    const open = waitFor(EventName.openOrder, (id) => id === orderId);
    const working = waitFor(EventName.orderStatus, (id, status) => id === orderId && ['PreSubmitted', 'Submitted', 'Inactive', 'Cancelled'].includes(status));
    log(`placeOrder ${orderId}: BUY 1 AAPL LMT 1.00 GTC (account ${accounts[0]})`);
    api.placeOrder(orderId, aapl, { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1.0, tif: 'GTC', transmit: true, account: accounts[0] });
    const o = await open;
    if (o) log(`openOrder ${orderId}: ${(o[2] as { action: string }).action} ${(o[2] as { totalQuantity: number }).totalQuantity} ${(o[1] as Contract).symbol} status ${(o[3] as { status: string }).status}`);
    return working;
  });
  await step('cancelOrder', async () => {
    const cancelled = waitFor(EventName.orderStatus, (id, status) => id === orderId && (status === 'Cancelled' || status === 'ApiCancelled'), 120_000);
    api.cancelOrder(orderId);
    return cancelled;
  });
  log(`order ${orderId} statuses: ${statuses.join(' -> ')}`);
}

// ---------------------------------------------------------------------------

const gone = waitFor(EventName.disconnected);
api.disconnect();
await step('disconnect', async () => gone);
log(`frames sent ${sent}, received ${received}; isConnected=${api.isConnected}`);
if (failures.length) {
  log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
log('OK: all steps passed');
process.exit(0);
