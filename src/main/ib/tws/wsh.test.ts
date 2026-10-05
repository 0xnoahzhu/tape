// Wall Street Horizon requests and messages (reqWshMetaData / reqWshEventData, wshMetaData /
// wshEventData). The paper account answers every request with error 10276 (no WSH
// subscription), so the frames follow EClient / EDecoder for server versions 176..193.

import { afterEach, describe, expect, it } from 'vitest';
import { IBApi } from './client.ts';
import { decodeMessage, isDecodedMessage } from './decoder.ts';
import * as encoder from './encoder.ts';
import { EventName } from './enums.ts';
import { TwsEncodeError } from './errors.ts';
import { IN_MSG_ID, OUT_MSG_ID } from './messageIds.ts';
import { pairingOf } from './sendQueue.ts';
import { FakeTws, nextEvent } from './__fixtures__/fakeTws.ts';
import { decodeFrame } from '../messageSchema.ts';

describe('WSH encoder', () => {
  it('encodes the meta data request and its cancel', () => {
    expect(encoder.reqWshMetaData(193, 9200)).toEqual([100, 9200]);
    expect(encoder.cancelWshMetaData(193, 9200)).toEqual([101, 9200]);
    expect(encoder.cancelWshEventData(193, 9201)).toEqual([103, 9201]);
  });

  it('encodes an event request by conId with the filter, fill flags, dates and limit', () => {
    expect(encoder.reqWshEventData(193, 9201, { conId: 265598, startDate: '20261005', endDate: '20270103', totalLimit: 10 })).toEqual([
      102, 9201, 265598, '', 0, 0, 0, '20261005', '20270103', 10,
    ]);
    expect(encoder.reqWshEventData(176, 9201, { conId: 265598 })).toEqual([102, 9201, 265598, '', 0, 0, 0, '', '', undefined]);
  });

  it('sends an unset conId and limit as empty fields', () => {
    const filter = JSON.stringify({ watchlist: ['265598'], wshe_ed: 'true' });
    expect(encoder.reqWshEventData(193, 9202, { filter, fillPortfolio: true, totalLimit: 2147483647 })).toEqual([
      102, 9202, undefined, filter, 0, 1, 0, '', '', undefined,
    ]);
  });

  it('refuses a conId together with a filter', () => {
    expect(() => encoder.reqWshEventData(193, 9203, { conId: 1, filter: '{}' })).toThrow(TwsEncodeError);
  });

  it('pairs each request with its cancel, so an unsent pair is dropped', () => {
    expect(pairingOf(OUT_MSG_ID.REQ_WSH_META_DATA, 7)).toEqual({ key: '100:7', cancel: false });
    expect(pairingOf(OUT_MSG_ID.CANCEL_WSH_META_DATA, 7)).toEqual({ key: '100:7', cancel: true });
    expect(pairingOf(OUT_MSG_ID.REQ_WSH_EVENT_DATA, 8)).toEqual({ key: '102:8', cancel: false });
    expect(pairingOf(OUT_MSG_ID.CANCEL_WSH_EVENT_DATA, 8)).toEqual({ key: '102:8', cancel: true });
  });
});

describe('WSH decoder', () => {
  it('decodes the meta data and event data JSON', () => {
    expect(isDecodedMessage(IN_MSG_ID.WSH_META_DATA)).toBe(true);
    expect(isDecodedMessage(IN_MSG_ID.WSH_EVENT_DATA)).toBe(true);
    const meta = '{"validated":true,"meta_data":{"event_types":[]}}';
    expect(decodeMessage(['104', '9200', meta], 193)).toEqual([{ name: EventName.wshMetaData, args: [9200, meta] }]);
    const events = '[{"conid":265598,"event_type":"wshe_ed"}]';
    expect(decodeMessage(['105', '9201', events], 193)).toEqual([{ name: EventName.wshEventData, args: [9201, events] }]);
  });

  it('reports a truncated frame as error 505', () => {
    const [e] = decodeMessage(['105', '9201'], 193);
    expect(e.name).toBe('error');
    expect(e.args[1]).toBe(505);
  });
});

describe('WSH in the API log', () => {
  it('names the request and answer fields', () => {
    const out = decodeFrame('out', [102, 9201, 265598, '', 0, 0, 0, '20261005', '20270103', '']);
    expect(out).toMatchObject({ name: 'reqWshEventData', reqId: '9201' });
    expect(out.fields.map(([k]) => k)).toEqual(['reqId', 'conId', 'filter', 'fillWatchlist', 'fillPortfolio', 'fillCompetitors', 'startDate', 'endDate', 'totalLimit']);
    expect(decodeFrame('out', [100, 9200])).toMatchObject({ name: 'reqWshMetaData', reqId: '9200' });
    expect(decodeFrame('in', ['105', '9201', '[]'])).toMatchObject({ name: 'wshEventData', reqId: '9201', fields: [['reqId', '9201'], ['dataJson', '[]']] });
  });
});

describe('WSH over the socket', () => {
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

  it('sends the requests and emits the answers', async () => {
    const fake = await FakeTws.start();
    servers.push(fake);
    const api = new IBApi({ host: '127.0.0.1', port: fake.port });
    clients.push(api);
    api.on(EventName.error, () => undefined);
    api.connect(121);
    await nextEvent(api, EventName.nextValidId);
    const session = await fake.session();
    api.reqWshMetaData(9200);
    api.reqWshEventData(9201, { conId: 265598, startDate: '20261005' });
    const frames = await session.waitFrames(3);
    expect(frames[1]).toEqual(['100', '9200']);
    expect(frames[2]).toEqual(['102', '9201', '265598', '', '0', '0', '0', '20261005', '', '']);
    const meta = nextEvent(api, EventName.wshMetaData);
    session.send([104, 9200, '{"x":1}']);
    expect(await meta).toEqual([9200, '{"x":1}']);
    const data = nextEvent(api, EventName.wshEventData);
    session.send([105, 9201, '[]']);
    expect(await data).toEqual([9201, '[]']);
  });
});
