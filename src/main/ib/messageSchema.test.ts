import { ConjunctionConnection, Encoder, PriceCondition, TriggerMethod, type Contract, type Order } from './tws';
import { describe, expect, it } from 'vitest';
import { decodeFrame, decodeFrameText, formatLogLine, frameBytes, frameLogLine, frameTokens, messageName } from './messageSchema';
import gateway from './tws/__fixtures__/gateway-193.json';
import synthetic from './tws/__fixtures__/synthetic.json';

/** Encodes a request with the real TWS encoder and flattens it like the socket does. */
function encode(sv: number, send: (e: Encoder) => void): unknown[] {
  let tokens: unknown[] = [];
  const flatten = (a: unknown[]): unknown[] => a.flatMap((v) => (Array.isArray(v) ? flatten(v) : [v]));
  const encoder = new Encoder({
    serverVersion: sv,
    sendMsg: (...args: unknown[]) => {
      tokens = flatten(args).map((v) => (v === true ? 1 : v === false ? 0 : v));
    },
    emitError: (msg: string) => {
      throw new Error(msg);
    },
  });
  send(encoder);
  return tokens;
}

const field = (fields: Array<[string, string]>, name: string) => fields.find(([k]) => k === name)?.[1];

describe('messageName', () => {
  it('maps protocol ids to callback and request names', () => {
    expect(messageName('in', 1)).toBe('tickPrice');
    expect(messageName('in', 4)).toBe('error');
    expect(messageName('in', 9)).toBe('nextValidId');
    expect(messageName('in', 15)).toBe('managedAccounts');
    expect(messageName('in', 6)).toBe('updateAccountValue');
    expect(messageName('in', 11)).toBe('execDetails');
    expect(messageName('in', 94)).toBe('pnl');
    expect(messageName('out', 1)).toBe('reqMktData');
    expect(messageName('out', 71)).toBe('startApi');
    expect(messageName('out', 92)).toBe('reqPnL');
    expect(messageName('out', 6)).toBe('reqAccountUpdates');
    expect(messageName('out', 9)).toBe('reqContractDetails');
    expect(messageName('out', 81)).toBe('reqMatchingSymbols');
  });
});

describe('decodeFrame', () => {
  it('decodes the handshake and the server version', () => {
    const hs = decodeFrame('out', ['API\0', 0, 0, 0, 9, 'v100..193']);
    expect(hs).toMatchObject({ msgId: 'API', name: 'API handshake', err: false, bytes: 17 });
    expect(hs.fields).toEqual([
      ['prefix', 'API\\0'],
      ['versions', 'v100..193'],
    ]);
    const sv = decodeFrame('in', ['193', '20261004 11:22:58 China Standard Time'], { firstReceived: true });
    expect(sv.name).toBe('serverVersion');
    expect(sv.msgId).toBe('—');
    expect(sv.fields).toEqual([
      ['version', '193'],
      ['connTime', '20261004 11:22:58 China Standard Time'],
    ]);
  });

  it('computes bytes and the raw frame', () => {
    const e = decodeFrame('out', [71, 2, 101, '']);
    expect(e.name).toBe('startApi');
    expect(e.fields).toEqual([
      ['version', '2'],
      ['clientId', '101'],
      ['optCapab', ''],
    ]);
    expect(e.bytes).toBe(4 + 3 + 2 + 4 + 1);
    expect(e.raw).toBe('71␀2␀101␀');
    expect(frameBytes(['4', 'ü'])).toBe(4 + 2 + 3);
  });

  it('names tick fields like the design ("1 BID", "8 VOLUME")', () => {
    const p = decodeFrame('in', ['1', '6', '1001', '1', '227.48', '300', '0']);
    expect(p).toMatchObject({ name: 'tickPrice', msgId: '1', reqId: '1001', err: false });
    expect(p.fields).toEqual([
      ['version', '6'],
      ['reqId', '1001'],
      ['field', '1 BID'],
      ['price', '227.48'],
      ['size', '300'],
      ['attrib', '0'],
    ]);
    const s = decodeFrame('in', ['2', '6', '1003', '8', '154320']);
    expect(field(s.fields, 'field')).toBe('8 VOLUME');
    const o = decodeFrame('in', ['21', '1004', '13', '0', '0.25', '0.5', '3.1', '0', '0.02', '0.1', '-0.05', '227']);
    expect(o.name).toBe('tickOptionComputation');
    expect(field(o.fields, 'field')).toBe('13 MODEL_OPTION');
    expect(field(o.fields, 'undPrice')).toBe('227');
  });

  it('flags real errors but not notices', () => {
    const ok = decodeFrame('in', ['4', '2', '-1', '2104', 'Market data farm connection is OK:usfarm', '']);
    expect(ok).toMatchObject({ name: 'error', reqId: '-1', err: false });
    expect(field(ok.fields, 'code')).toBe('2104');
    expect(field(ok.fields, 'msg')).toBe('Market data farm connection is OK:usfarm');
    expect(decodeFrame('in', ['4', '2', '1009', '10090', 'Part of requested market data is not subscribed.', '']).err).toBe(true);
    expect(decodeFrame('in', ['4', '2', '1', '321', "Error validating request.-'bC' : cause - Read-Only mode.", '']).err).toBe(true);
    expect(decodeFrame('in', ['4', '2', '7', '202', 'Order Canceled - reason:', '']).err).toBe(false);
  });

  it('decodes account and portfolio messages', () => {
    const a = decodeFrame('in', ['63', '1', '9001', 'DUP899854', 'NetLiquidation', '1020171.48', 'USD']);
    expect(a).toMatchObject({ name: 'accountSummary', reqId: '9001' });
    expect(field(a.fields, 'tag')).toBe('NetLiquidation');
    expect(field(a.fields, 'value')).toBe('1020171.48');
    const v = decodeFrame('in', ['6', '2', 'StockMarketValue', '0.00', 'USD', 'DUP899854']);
    expect(v.fields).toEqual([
      ['version', '2'],
      ['key', 'StockMarketValue'],
      ['value', '0.00'],
      ['currency', 'USD'],
      ['account', 'DUP899854'],
    ]);
    const pnl = decodeFrame('in', ['94', '9002', '8214.37', '52880.1', '1.7976931348623157E308']);
    expect(pnl.fields).toEqual([
      ['reqId', '9002'],
      ['dailyPnL', '8214.37'],
      ['unrealizedPnL', '52880.1'],
      ['realizedPnL', ''],
    ]);
    const pos = decodeFrame('in', ['61', '3', 'DU1', '265598', 'AAPL', 'STK', '', '0', '', '', 'NASDAQ', 'USD', 'AAPL', 'NMS', '300', '182.4']);
    expect(field(pos.fields, 'symbol')).toBe('AAPL');
    expect(field(pos.fields, 'position')).toBe('300');
    expect(field(pos.fields, 'avgCost')).toBe('182.4');
    expect(field(pos.fields, 'strike')).toBeUndefined();
    expect(field(pos.fields, 'conId')).toBe('265598');
    expect(decodeFrame('in', ['15', '1', 'DUP899854']).fields).toEqual([
      ['version', '1'],
      ['accounts', 'DUP899854'],
    ]);
  });

  it('decodes order status, executions and commission reports', () => {
    const s = decodeFrame('in', ['3', '4012', 'PreSubmitted', '0', '100', '0', '1825', '0', '0', '101', '', '0']);
    expect(s).toMatchObject({ name: 'orderStatus', reqId: '4012' });
    expect(field(s.fields, 'status')).toBe('PreSubmitted');
    expect(field(s.fields, 'clientId')).toBe('101');
    const exec = decodeFrame('in', [
      '11', '-1', '4008', '265598', 'AAPL', 'STK', '', '0', '', '', 'SMART', 'USD', 'AAPL', 'NMS',
      '0000e0d5.6704b3a5.01.01', '20261004 10:31:44 US/Eastern', 'DU1', 'NASDAQ', 'BOT', '100', '226.95', '1825', '101', '0', '100', '226.95', '', '', '', '', '2', '0',
    ]);
    expect(exec).toMatchObject({ name: 'execDetails', reqId: '-1' });
    expect(field(exec.fields, 'execId')).toBe('0000e0d5.6704b3a5.01.01');
    expect(field(exec.fields, 'side')).toBe('BOT');
    expect(field(exec.fields, 'execExchange')).toBe('NASDAQ');
    const c = decodeFrame('in', ['59', '1', '0000e0d5.6704b3a5.01.01', '1.0', 'USD', '1.7976931348623157E308', '1.7976931348623157E308', '0']);
    expect(c.name).toBe('commissionReport');
    expect(field(c.fields, 'commission')).toBe('1.0');
  });

  it('shows the main fields of openOrder and hides the long tail', () => {
    const tokens = ['5', '4012', '265598', 'AAPL', 'STK', '', '0', '?', '', 'SMART', 'USD', 'AAPL', 'NMS', 'BUY', '100', 'LMT', '226.5', '0', 'DAY', '', 'DU1', '', '0', '', '101', '1825', '0', '0', '0', ''];
    tokens.push(...Array.from({ length: 80 }, (_, i) => String(i % 3 === 0 ? '' : i)));
    const e = decodeFrame('in', tokens);
    expect(e).toMatchObject({ name: 'openOrder', reqId: '4012' });
    expect(field(e.fields, 'symbol')).toBe('AAPL');
    expect(field(e.fields, 'lmtPrice')).toBe('226.5');
    expect(field(e.fields, 'clientId')).toBe('101');
    expect(e.fields.some(([k]) => /^f\d+$/.test(k))).toBe(false);
    expect(e.fields.every(([, v]) => v !== '')).toBe(true);
  });

  it('summarizes symbol samples and historical data', () => {
    const s = decodeFrame('in', ['79', '1004', '2', '4027', 'AAP', 'STK', 'NYSE', 'USD', '2', 'OPT', 'WAR', 'ADVANCE AUTO PARTS', '', '1', 'AAPL', 'STK', 'NASDAQ', 'USD', '0', 'APPLE INC', '']);
    expect(s.fields).toEqual([
      ['reqId', '1004'],
      ['count', '2'],
      ['matches', 'AAP STK NYSE, AAPL STK NASDAQ'],
    ]);
    const h = decodeFrame('in', ['17', '7', 'a', 'b', '2', '20261001', '1', '2', '0.5', '1.5', '100', '1.2', '5', '20261002', '1', '2', '0.5', '1.5', '100', '1.2', '5']);
    expect(h.fields).toEqual([
      ['reqId', '7'],
      ['startDate', 'a'],
      ['endDate', 'b'],
      ['bars', '2'],
      ['first', '20261001'],
      ['last', '20261002'],
    ]);
  });

  it('lists unknown layouts as f1..fn', () => {
    const e = decodeFrame('in', ['19', '1', '<xml/>']);
    expect(e.name).toBe('scannerParameters');
    expect(e.fields).toEqual([
      ['f1', '1'],
      ['f2', '<xml/>'],
    ]);
    expect(decodeFrame('in', ['250', 'x']).name).toBe('msg 250');
  });

  it('decodes requests encoded by the TWS encoder', () => {
    const aapl: Contract = { symbol: 'AAPL', secType: 'STK' as Contract['secType'], exchange: 'SMART', currency: 'USD' };
    const mkt = decodeFrame('out', encode(193, (e) => e.reqMktData(1001, aapl, '233,318', false, false)));
    expect(mkt).toMatchObject({ name: 'reqMktData', reqId: '1001' });
    // Unset contract fields (expiry, strike, right …) are left out of the list.
    expect(mkt.fields.map(([k]) => k)).toEqual([
      'version',
      'reqId',
      'symbol',
      'secType',
      'exchange',
      'currency',
      'deltaNeutral',
      'genericTicks',
      'snapshot',
      'regulatorySnapshot',
      'mktDataOptions',
    ]);
    expect(field(mkt.fields, 'genericTicks')).toBe('233,318');
    expect(field(mkt.fields, 'snapshot')).toBe('0');
    expect(mkt.raw.split('\u2400')).toHaveLength(20);
    expect(mkt.fields.some(([k]) => /^f\d+$/.test(k))).toBe(false);

    const cd = decodeFrame('out', encode(193, (e) => e.reqContractDetails(1003, aapl)));
    expect(cd).toMatchObject({ name: 'reqContractDetails', reqId: '1003' });
    expect(cd.fields.some(([k]) => /^f\d+$/.test(k))).toBe(false);

    const cancel = decodeFrame('out', encode(193, (e) => e.cancelOrder(4012, { manualOrderCancelTime: undefined, extOperator: '', manualOrderIndicator: undefined })));
    expect(cancel).toMatchObject({ name: 'cancelOrder', reqId: '4012' });
    expect(cancel.fields.some(([k]) => /^f\d+$/.test(k))).toBe(false);

    const hist = decodeFrame('out', encode(193, (e) => e.reqHistoricalData(1005, aapl, '', '1 D', '5 mins' as never, 'TRADES' as never, 1, 2, false, [])));
    expect(field(hist.fields, 'barSize')).toBe('5 mins');
    expect(field(hist.fields, 'whatToShow')).toBe('TRADES');
    expect(hist.fields.some(([k]) => /^f\d+$/.test(k))).toBe(false);

    const sum = decodeFrame('out', encode(193, (e) => e.reqAccountSummary(9001, 'All', 'NetLiquidation,BuyingPower')));
    expect(sum.fields).toEqual([
      ['version', '1'],
      ['reqId', '9001'],
      ['group', 'All'],
      ['tags', 'NetLiquidation,BuyingPower'],
    ]);
  });

  it('decodes placeOrder with conditions, trailing and iceberg fields', () => {
    const contract: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK' as Contract['secType'], exchange: 'SMART', currency: 'USD' };
    const order: Order = {
      action: 'SELL' as Order['action'],
      orderType: 'TRAIL' as Order['orderType'],
      totalQuantity: 100,
      tif: 'GTC' as Order['tif'],
      trailingPercent: 2.5,
      trailStopPrice: 220,
      displaySize: 10,
      outsideRth: true,
      goodAfterTime: '20261005 09:35:00 US/Eastern',
      transmit: true,
      account: 'DU1',
      conditions: [new PriceCondition(235, TriggerMethod.Default, 265598, 'SMART', true, ConjunctionConnection.AND)],
      conditionsIgnoreRth: true,
      conditionsCancelOrder: false,
    };
    for (const sv of [176, 187, 193]) {
      const e = decodeFrame('out', encode(sv, (enc) => enc.placeOrder(4012, contract, order)), { serverVersion: sv });
      expect(e).toMatchObject({ name: 'placeOrder', reqId: '4012' });
      expect(Object.fromEntries(e.fields)).toMatchObject({
        orderId: '4012',
        conId: '265598',
        symbol: 'AAPL',
        secType: 'STK',
        exchange: 'SMART',
        action: 'SELL',
        totalQty: '100',
        orderType: 'TRAIL',
        tif: 'GTC',
        account: 'DU1',
        transmit: '1',
        displaySize: '10',
        outsideRth: '1',
        goodAfterTime: '20261005 09:35:00 US/Eastern',
        trailStopPrice: '220',
        trailingPercent: '2.5',
        conditions: 'Price #265598 >= 235',
        conditionsIgnoreRth: '1',
      });
    }
  });

  it('shows includeOvernight and the GTD expiry of placeOrder', () => {
    const contract: Contract = { conId: 265598, symbol: 'AAPL', secType: 'STK' as Contract['secType'], exchange: 'SMART', currency: 'USD' };
    const order: Order = { action: 'BUY' as Order['action'], orderType: 'LMT' as Order['orderType'], totalQuantity: 1, lmtPrice: 1, tif: 'DAY' as Order['tif'], transmit: true };
    for (const sv of [189, 191, 192, 193]) {
      const on = decodeFrame('out', encode(sv, (enc) => enc.placeOrder(7, contract, { ...order, includeOvernight: true, outsideRth: true })), { serverVersion: sv });
      expect(Object.fromEntries(on.fields)).toMatchObject({ tif: 'DAY', outsideRth: '1', includeOvernight: '1' });
      const off = decodeFrame('out', encode(sv, (enc) => enc.placeOrder(7, contract, order)), { serverVersion: sv });
      expect(Object.fromEntries(off.fields)).not.toHaveProperty('includeOvernight');
    }
    const gtd = decodeFrame('out', encode(193, (enc) => enc.placeOrder(7, { ...contract, exchange: 'OVERNIGHT', primaryExch: 'NASDAQ' }, { ...order, tif: 'GTD' as Order['tif'], goodTillDate: '20261009 16:00:00 US/Eastern' })));
    expect(Object.fromEntries(gtd.fields)).toMatchObject({ exchange: 'OVERNIGHT', primaryExch: 'NASDAQ', tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' });
  });

  it('decodes combo legs of a BAG order', () => {
    const contract: Contract = {
      symbol: 'AAPL',
      secType: 'BAG' as Contract['secType'],
      exchange: 'SMART',
      currency: 'USD',
      comboLegs: [
        { conId: 11, ratio: 1, action: 'BUY' as never, exchange: 'SMART' },
        { conId: 12, ratio: 1, action: 'SELL' as never, exchange: 'SMART' },
      ],
    };
    const order: Order = { action: 'BUY' as Order['action'], orderType: 'LMT' as Order['orderType'], totalQuantity: 1, lmtPrice: 1.25, tif: 'DAY' as Order['tif'], transmit: true };
    const e = decodeFrame('out', encode(193, (enc) => enc.placeOrder(7, contract, order)));
    expect(Object.fromEntries(e.fields)).toMatchObject({ secType: 'BAG', comboLegs: 'BUY 1×11, SELL 1×12', lmtPrice: '1.25', tif: 'DAY' });
  });
});

describe('formatLogLine', () => {
  it('writes time, direction, name, id and body', () => {
    const t = new Date(2026, 9, 3, 10, 2, 11, 204).getTime();
    expect(formatLogLine({ t, dir: 'out', name: 'reqMktData', reqId: '1001', fields: [['version', '11'], ['reqId', '1001']] })).toBe(
      '10:02:11.204  SEND  reqMktData         1001   version=11  reqId=1001',
    );
    expect(formatLogLine({ t, dir: 'in', name: 'nextValidId', fields: [['orderId', '1']] })).toBe('10:02:11.204  RECV  nextValidId        -      orderId=1');
  });

  it('pads milliseconds and changes the second', () => {
    const t = new Date(2026, 9, 3, 10, 2, 11, 0).getTime();
    const line = (ms: number) => formatLogLine({ t: t + ms, dir: 'in', name: 'x', fields: [] }).slice(0, 12);
    expect([5, 50, 999, 1000, 1007, 61_000].map(line)).toEqual(['10:02:11.005', '10:02:11.050', '10:02:11.999', '10:02:12.000', '10:02:12.007', '10:03:12.000']);
    expect(line(0)).toBe('10:02:11.000');
  });
});

/** Frames as the TWS client passes them: received fields (strings) or sent tokens, and their text. */
function corpus(): Array<{ dir: 'in' | 'out'; tokens: unknown[]; text: string; sv: number; first?: boolean }> {
  const frames: Array<{ dir: 'in' | 'out'; tokens: unknown[]; text: string; sv: number; first?: boolean }> = [];
  const received = (tokens: string[], sv: number, first = false) => frames.push({ dir: 'in', tokens, text: tokens.join('\0') + '\0', sv, first });
  const sent = (tokens: unknown[], sv = 193) => frames.push({ dir: 'out', tokens, text: tokens.join('\0'), sv });
  received(gateway.handshake, gateway.serverVersion, true);
  for (const f of gateway.frames) received(f.tokens, gateway.serverVersion);
  for (const f of synthetic.frames) received(f.tokens, f.serverVersion);
  received(['94', '9002', '8214.37', '1.7976931348623157E308', '2147483647'], 193);
  received(['4', '2', '7', '201', 'Order rejected – ü € 日本', ''], 193);
  received(['999', 'a', '', 'b'], 193);
  received(['1'], 193);
  received([''], 193);
  received(['', ''], 193);
  sent([71, 2, 139, '']);
  sent([4, 1, 4012, ''], 176);
  sent([1, 11, 1001, undefined, 'AAPL', 'STK', '', 0, '', '', 'SMART', 'ISLAND', 'USD', '', '', 0, '', 0, 0, '']);
  sent(encode(193, (e) => e.reqContractDetails(9001, { symbol: 'AAPL', secType: 'STK' as Contract['secType'], exchange: 'SMART', currency: 'USD' })));
  return frames;
}

describe('frame text', () => {
  it('splits received text at its final NUL and sent text as is', () => {
    expect(frameTokens('in', '1\x006\x00\x00')).toEqual(['1', '6', '']);
    expect(frameTokens('out', '71\x002\x00101\x00')).toEqual(['71', '2', '101', '']);
    expect(frameTokens('in', '')).toEqual([]);
  });

  it('decodes text exactly like tokens (fixtures, unset values, unicode, empty tokens)', () => {
    const frames = corpus();
    expect(frames.length).toBeGreaterThan(250);
    for (const f of frames) {
      const opts = { serverVersion: f.sv, firstReceived: f.first };
      const expected = decodeFrame(f.dir, f.tokens, opts);
      const actual = decodeFrameText(f.dir, f.text, opts);
      expect(actual, f.text).toEqual(expected);
      expect(Object.keys(actual), f.text).toEqual(Object.keys(expected));
    }
  });

  it('formats log lines straight from text exactly like decoded entries', () => {
    const t0 = new Date(2026, 9, 4, 10, 0, 59, 990).getTime();
    corpus().forEach((f, i) => {
      const t = t0 + i * 7; // crosses seconds and minutes
      const opts = { serverVersion: f.sv, firstReceived: f.first };
      expect(frameLogLine(t, f.dir, f.text, opts), f.text).toBe(formatLogLine({ t, dir: f.dir, ...decodeFrame(f.dir, f.tokens, opts) }));
    });
  });
});
