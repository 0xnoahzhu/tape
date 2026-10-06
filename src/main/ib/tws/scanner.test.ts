// Market scanner requests and messages (reqScannerSubscription / cancelScannerSubscription,
// scannerData). The frames below were sent to and received from IB Gateway 10.50 (paper account,
// server version 193, no Wall Street Horizon subscription) by a read-only probe on 2026-10-06;
// __fixtures__/scanner-193.json holds a cut 50-row answer of the same session.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { IBApi } from './client.ts';
import { decodeMessage, isDecodedMessage } from './decoder.ts';
import * as encoder from './encoder.ts';
import { EventName } from './enums.ts';
import { IN_MSG_ID, OUT_MSG_ID } from './messageIds.ts';
import { Lane, laneOf, pairingOf } from './sendQueue.ts';
import type { ContractDetails, ScannerSubscription, TagValue } from './types.ts';
import { FakeTws, nextEvent } from './__fixtures__/fakeTws.ts';
import { decodeFrame } from '../messageSchema.ts';
import { isScannerCancelAck } from '../errorCodes.ts';

const SCAN = 'SCAN_nextEarningsDateTime_ASC';
const wire = (tokens: readonly unknown[]): string[] => tokens.map((t) => (t == null ? '' : String(t)));
const filter = (above: string, below: string): TagValue[] => [
  { tag: 'nextEarningsDateTimeAbove', value: above },
  { tag: 'nextEarningsDateTimeBelow', value: below },
];

/** Price and market cap band, the whole horizon (sent by the probe as request 700). */
const PROBE_PRICE_FRAME = wire([
  22, 700, 50, 'STK', 'STK.US.MAJOR', SCAN, 140, 154, '', 10000, '', '', '', '', '', '', '', '', '', 0, '', '', 'ALL',
  'nextEarningsDateTimeAbove=20261006;nextEarningsDateTimeBelow=20270215;', '',
]);
/** Market cap only, November (request 600). */
const PROBE_MCAP_FRAME = wire([
  22, 600, 50, 'STK', 'STK.US.MAJOR', SCAN, '', '', '', 1000000, '', '', '', '', '', '', '', '', '', 0, '', '', 'ALL',
  'nextEarningsDateTimeAbove=20261101;nextEarningsDateTimeBelow=20261130;', '',
]);
/** The answer to request 600: three rows. */
const ROWS_600 = [
  '20', '3', '600', '3',
  '0', '4391', 'AMD', 'STK', '', '0', '', 'SMART', 'USD', 'AMD', 'NMS', 'NMS', '', '', '', '',
  '1', '890493863', 'SPCX', 'STK', '', '0', '', 'SMART', 'USD', 'SPCX', 'NMS', 'NMS', '', '', '', '',
  '2', '4815747', 'NVDA', 'STK', '', '0', '', 'SMART', 'USD', 'NVDA', 'NMS', 'NMS', '', '', '', '',
];
/** Four rows of a price band (request 706); VST's market name is its symbol. */
const ROWS_706 = [
  '20', '3', '706', '4',
  '0', '174076715', 'LAMR', 'STK', '', '0', '', 'SMART', 'USD', 'LAMR', 'NMS', 'NMS', '', '', '', '',
  '1', '6890', 'EOG', 'STK', '', '0', '', 'SMART', 'USD', 'EOG', 'EOG', 'EOG', '', '', '', '',
  '2', '290651477', 'ROKU', 'STK', '', '0', '', 'SMART', 'USD', 'ROKU', 'NMS', 'NMS', '', '', '', '',
  '3', '254457731', 'VST', 'STK', '', '0', '', 'SMART', 'USD', 'VST', 'VST', 'VST', '', '', '', '',
];
/** One day (request 708): VST alone. */
const ROWS_708 = ['20', '3', '708', '1', '0', '254457731', 'VST', 'STK', '', '0', '', 'SMART', 'USD', 'VST', 'VST', 'VST', '', '', '', ''];

const fixture: { frames: Array<{ label: string; dir: 'in' | 'out'; tokens: string[] }> } = JSON.parse(
  readFileSync(new URL('./__fixtures__/scanner-193.json', import.meta.url), 'utf8'),
);
const fixtureFrame = (label: string): string[] => fixture.frames.find((f) => f.label.startsWith(label))!.tokens;

/** The scannerData events of a frame as [reqId, rank, conId, symbol]. */
const rowsOf = (fields: string[]) =>
  decodeMessage(fields, 193)
    .filter((e) => e.name === EventName.scannerData)
    .map((e) => [e.args[0], e.args[1], (e.args[2] as ContractDetails).contract.conId, (e.args[2] as ContractDetails).contract.symbol]);

describe('scanner encoder', () => {
  const sub: ScannerSubscription = {
    numberOfRows: 50,
    instrument: 'STK',
    locationCode: 'STK.US.MAJOR',
    scanCode: SCAN,
    abovePrice: 140,
    belowPrice: 154,
    marketCapAbove: 10000,
    stockTypeFilter: 'ALL',
  };

  it('encodes the probe frames field for field, at every supported server version', () => {
    const tokens = encoder.reqScannerSubscription(193, 700, sub, [], filter('20261006', '20270215'));
    expect(tokens).toHaveLength(25);
    expect(wire(tokens)).toEqual(PROBE_PRICE_FRAME);
    expect(wire(encoder.reqScannerSubscription(176, 700, sub, [], filter('20261006', '20270215')))).toEqual(PROBE_PRICE_FRAME);
    const mcapOnly: ScannerSubscription = { ...sub, abovePrice: undefined, belowPrice: undefined, marketCapAbove: 1000000 };
    expect(wire(encoder.reqScannerSubscription(193, 600, mcapOnly, undefined, filter('20261101', '20261130')))).toEqual(PROBE_MCAP_FRAME);
    const recorded = fixtureFrame('reqScannerSubscription');
    expect(wire(encoder.reqScannerSubscription(193, 644, { ...mcapOnly, marketCapAbove: 30000 }, [], filter('20261006', '20270215')))).toEqual(recorded);
  });

  it('sends unset fields empty, the filter before the options and booleans as 1 / 0', () => {
    const sparse: ScannerSubscription = {
      abovePrice: Number.MAX_VALUE,
      belowPrice: 9.5,
      aboveVolume: 2147483647,
      couponRateAbove: 1.5,
      excludeConvertible: true,
      averageOptionVolumeAbove: 100,
      scannerSettingPairs: 'Annual,true',
    };
    const tokens = encoder.reqScannerSubscription(193, 701, sparse, [{ tag: 'opt', value: '1' }], [{ tag: 'priceAbove', value: '5' }]);
    expect(tokens).toEqual([
      22, 701, undefined, '', '', '', undefined, 9.5, undefined, undefined, undefined, '', '', '', '', '', '', 1.5, undefined, 1, 100, 'Annual,true', '', 'priceAbove=5;', 'opt=1;',
    ]);
  });

  it('encodes the cancel and pairs it with its request in the market data lane', () => {
    expect(encoder.cancelScannerSubscription(193, 600)).toEqual([23, 1, 600]);
    expect(pairingOf(OUT_MSG_ID.REQ_SCANNER_SUBSCRIPTION, 7)).toEqual({ key: '22:7', cancel: false });
    expect(pairingOf(OUT_MSG_ID.CANCEL_SCANNER_SUBSCRIPTION, 7)).toEqual({ key: '22:7', cancel: true });
    expect(laneOf(OUT_MSG_ID.REQ_SCANNER_SUBSCRIPTION)).toBe(Lane.MarketData);
    expect(laneOf(OUT_MSG_ID.CANCEL_SCANNER_SUBSCRIPTION)).toBe(Lane.MarketData);
  });

  it('is on the Encoder object too', () => {
    const sent: unknown[][] = [];
    const enc = new encoder.Encoder({ serverVersion: 193, sendMsg: (t) => void sent.push(t as unknown[]), emitError: () => undefined });
    enc.reqScannerSubscription(700, sub, [], filter('20261006', '20270215'));
    enc.cancelScannerSubscription(700);
    expect(wire(sent[0])).toEqual(PROBE_PRICE_FRAME);
    expect(sent[1]).toEqual([23, 1, 700]);
  });
});

describe('scanner decoder', () => {
  it('emits a scannerData event per row, then scannerDataEnd', () => {
    const events = decodeMessage(ROWS_600, 193);
    expect(events.map((e) => e.name)).toEqual(['scannerData', 'scannerData', 'scannerData', 'scannerDataEnd']);
    expect(events[0].args).toEqual([
      600,
      0,
      {
        contract: {
          conId: 4391,
          symbol: 'AMD',
          secType: 'STK',
          lastTradeDateOrContractMonth: '',
          strike: 0,
          right: undefined,
          exchange: 'SMART',
          currency: 'USD',
          localSymbol: 'AMD',
          tradingClass: 'NMS',
        },
        marketName: 'NMS',
      },
      '',
      '',
      '',
      '',
    ]);
    expect(rowsOf(ROWS_600)).toEqual([
      [600, 0, 4391, 'AMD'],
      [600, 1, 890493863, 'SPCX'],
      [600, 2, 4815747, 'NVDA'],
    ]);
    expect(events[3].args).toEqual([600]);
  });

  it('decodes the price band answers of the probe', () => {
    expect(rowsOf(ROWS_706).map(([, , , s]) => s)).toEqual(['LAMR', 'EOG', 'ROKU', 'VST']);
    const vst = decodeMessage(ROWS_706, 193)[3].args[2] as ContractDetails;
    expect(vst.marketName).toBe('VST');
    expect(rowsOf(ROWS_708)).toEqual([[708, 0, 254457731, 'VST']]);
  });

  it('decodes a cut 50-row answer', () => {
    const events = decodeMessage(fixtureFrame('scannerData'), 193);
    expect(events).toHaveLength(51);
    expect(events.slice(0, 50).map((e) => e.args[1])).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(events[50]).toEqual({ name: EventName.scannerDataEnd, args: [644] });
  });

  it('decodes an empty answer as the end alone', () => {
    expect(decodeMessage(['20', '3', '629', '0'], 193)).toEqual([{ name: EventName.scannerDataEnd, args: [629] }]);
  });

  it('reads version 1 rows (no conId, no legs)', () => {
    const v1 = ['20', '1', '5', '1', '0', 'AAPL', 'STK', '', '0', '', 'SMART', 'USD', 'AAPL', 'NMS', 'NMS', '1.5', 'b', 'p'];
    const events = decodeMessage(v1, 193);
    expect(events.map((e) => e.name)).toEqual(['scannerData', 'scannerDataEnd']);
    expect((events[0].args[2] as ContractDetails).contract.conId).toBeUndefined();
    expect(events[0].args.slice(3)).toEqual(['1.5', 'b', 'p', undefined]);
  });

  it('reports a truncated row as one error 505 without rows', () => {
    const events = decodeMessage(ROWS_600.slice(0, -3), 193);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('error');
    expect(events[0].args.slice(1, 3)).toEqual([505, -1]);
  });

  it('decodes message 20 only (19, the scanner parameters, stays skipped)', () => {
    expect(isDecodedMessage(IN_MSG_ID.SCANNER_DATA)).toBe(true);
    expect(isDecodedMessage(IN_MSG_ID.SCANNER_PARAMETERS)).toBe(false);
  });
});

describe('scanner in the API log', () => {
  it('names the request fields and the cancel', () => {
    const out = decodeFrame('out', PROBE_PRICE_FRAME);
    expect(out).toMatchObject({ name: 'reqScannerSubscription', reqId: '700' });
    expect(out.fields).toEqual([
      ['reqId', '700'],
      ['numberOfRows', '50'],
      ['instrument', 'STK'],
      ['locationCode', 'STK.US.MAJOR'],
      ['scanCode', SCAN],
      ['abovePrice', '140'],
      ['belowPrice', '154'],
      ['marketCapAbove', '10000'],
      ['excludeConvertible', '0'],
      ['stockTypeFilter', 'ALL'],
      ['filterOptions', 'nextEarningsDateTimeAbove=20261006;nextEarningsDateTimeBelow=20270215;'],
    ]);
    expect(decodeFrame('out', [23, 1, 600])).toMatchObject({ name: 'cancelScannerSubscription', reqId: '600' });
  });

  it('summarizes the rows by symbol', () => {
    const e = decodeFrame('in', ROWS_600);
    expect(e).toMatchObject({ name: 'scannerData', reqId: '600', err: false });
    expect(e.fields).toEqual([
      ['version', '3'],
      ['reqId', '600'],
      ['count', '3'],
      ['symbols', 'AMD, SPCX, NVDA'],
    ]);
    const cut = decodeFrame('in', fixtureFrame('scannerData'));
    expect(cut.fields.find(([k]) => k === 'count')?.[1]).toBe('50');
    expect(cut.fields.find(([k]) => k === 'symbols')?.[1]).toMatch(/^PEP, DAL, UNH, .* … \(50\)$/);
  });

  it('shows the item count and the cancel acknowledgement as notices, other 162s as errors', () => {
    expect(decodeFrame('in', fixtureFrame('165')).err).toBe(false);
    const ack = fixtureFrame('162');
    expect(decodeFrame('in', ack).err).toBe(false);
    const disabled = ['4', '2', '601', '162', 'Historical Market Data Service error message:Scanner filter usdMarketCapAbove is disabled.', ''];
    expect(decodeFrame('in', disabled).err).toBe(true);
    expect(isScannerCancelAck(162, ack[4])).toBe(true);
    expect(isScannerCancelAck(162, 'API scanner subscription canceled: 7')).toBe(true);
    expect(isScannerCancelAck(162, disabled[4])).toBe(false);
    expect(isScannerCancelAck(165, ack[4])).toBe(false);
  });
});

describe('scanner over the socket', () => {
  const servers: FakeTws[] = [];
  const clients: IBApi[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) {
      c.removeAllListeners();
      try {
        c.disconnect();
      } catch {
        // already closed
      }
    }
    for (const s of servers.splice(0)) await s.close();
  });

  it('sends the scan and its cancel and emits the rows', async () => {
    const fake = await FakeTws.start();
    servers.push(fake);
    const api = new IBApi({ host: '127.0.0.1', port: fake.port });
    clients.push(api);
    api.on(EventName.error, () => undefined);
    api.connect(122);
    await nextEvent(api, EventName.nextValidId);
    const session = await fake.session();
    const sub: ScannerSubscription = { numberOfRows: 50, instrument: 'STK', locationCode: 'STK.US.MAJOR', scanCode: SCAN, abovePrice: 140, belowPrice: 154 };
    api.reqScannerSubscription(700, { ...sub, marketCapAbove: 10000, stockTypeFilter: 'ALL' }, [], filter('20261006', '20270215'));
    expect((await session.waitFrames(2))[1]).toEqual(PROBE_PRICE_FRAME);
    const rows: unknown[][] = [];
    api.on(EventName.scannerData, (...args: unknown[]) => void rows.push(args));
    const end = nextEvent(api, EventName.scannerDataEnd);
    session.send(ROWS_708);
    expect(await end).toEqual([708]);
    expect(rows.map((r) => [r[0], r[1], (r[2] as ContractDetails).contract.symbol])).toEqual([[708, 0, 'VST']]);
    api.cancelScannerSubscription(700);
    expect((await session.waitFrames(3))[2]).toEqual(['23', '1', '700']);
  });
});
