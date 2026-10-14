// News requests and messages (reqNewsProviders / reqHistoricalNews, newsProviders /
// historicalNews / historicalNewsEnd). No recorded frames: Tape had never sent them, and the paper
// account used for the recordings has no API news subscription. The frames below are hand-built in
// the field order of IB's EClient / EDecoder (Java, C++ and Python agree): no version fields, the
// providers as code / name pairs, a headline as reqId, time, provider, article id, text, the end
// as reqId and hasMore. While @stoqey/ib is installed its decoder and encoder are compared too.

import { afterEach, describe, expect, it } from 'vitest';
import { IBApi } from './client.ts';
import { decodeMessage, isDecodedMessage } from './decoder.ts';
import * as encoder from './encoder.ts';
import { EventName } from './enums.ts';
import { IN_MSG_ID, MAX_SERVER_VERSION, MIN_SERVER_VERSION, OUT_MSG_ID } from './messageIds.ts';
import { Lane, laneOf, pairingOf } from './sendQueue.ts';
import { FakeTws, nextEvent } from './__fixtures__/fakeTws.ts';
import { normalizeEvents } from './__fixtures__/normalize.ts';
import { loadStoqey } from './__fixtures__/stoqeyRef.ts';
import { decodeFrame } from '../messageSchema.ts';

const stoqey = loadStoqey();
const VERSIONS = [MIN_SERVER_VERSION, 182, 189, MAX_SERVER_VERSION];

const PROVIDERS = ['85', '3', 'BRFG', 'Briefing.com General Market Columns', 'BRFUPDN', 'Briefing.com Analyst Actions', 'DJ-N', 'Dow Jones Newswires'];
const HEADLINE = ['86', '9030', '2026-10-14 13:30:00.0', 'BRFUPDN', 'BRFUPDN$1a2b3c4d', '{A:800015:L:en:K:n/a:C:0.97}NVIDIA target raised to $150 at Example Securities'];
const END = ['87', '9030', '1'];

/** Our events, and @stoqey/ib's for the same frame when it is installed. */
function decodeBoth(fields: string[], sv = MAX_SERVER_VERSION) {
  const ours = decodeMessage(fields, sv);
  if (stoqey) expect(normalizeEvents(stoqey.decode(fields, sv))).toStrictEqual(normalizeEvents(ours));
  return ours;
}

describe('news encoder', () => {
  it('asks for the providers with the message id alone, at every supported server version', () => {
    for (const sv of VERSIONS) expect(encoder.reqNewsProviders(sv)).toEqual([85]);
  });

  it('asks for the latest headlines of a conId with the codes joined by "+" and an empty options list', () => {
    for (const sv of VERSIONS) {
      expect(encoder.reqHistoricalNews(sv, 9030, 4815747, 'BRFG+BRFUPDN+DJNL', '', '', 10)).toEqual([86, 9030, 4815747, 'BRFG+BRFUPDN+DJNL', '', '', 10, '']);
    }
  });

  it('sends a date range and the options as tag=value text, like EClient', () => {
    expect(
      encoder.reqHistoricalNews(193, 9031, 265598, 'DJ-N', '2026-10-13 00:00:00.0', '2026-10-14 00:00:00.0', 300, [
        { tag: 'a', value: '1' },
        { tag: 'b', value: '2' },
      ]),
    ).toEqual([86, 9031, 265598, 'DJ-N', '2026-10-13 00:00:00.0', '2026-10-14 00:00:00.0', 300, 'a=1;b=2;']);
  });

  it('matches @stoqey/ib when it is installed', () => {
    if (!stoqey) return;
    for (const sv of VERSIONS) {
      expect(stoqey.encode(sv, (enc) => enc.reqNewsProviders()).tokens).toEqual(encoder.reqNewsProviders(sv));
      expect(stoqey.encode(sv, (enc) => enc.reqHistoricalNews(9030, 4815747, 'BRFG', '', '', 10, [])).tokens).toEqual(encoder.reqHistoricalNews(sv, 9030, 4815747, 'BRFG', '', '', 10, []));
    }
  });

  it('puts headline polls in the market data lane and the providers request in control; neither pairs with a cancel', () => {
    expect(laneOf(OUT_MSG_ID.REQ_HISTORICAL_NEWS)).toBe(Lane.MarketData);
    expect(laneOf(OUT_MSG_ID.REQ_NEWS_PROVIDERS)).toBe(Lane.Control);
    expect(pairingOf(OUT_MSG_ID.REQ_HISTORICAL_NEWS, 9030)).toBeUndefined();
  });
});

describe('news decoder', () => {
  it('decodes the providers as code / name pairs', () => {
    expect(isDecodedMessage(IN_MSG_ID.NEWS_PROVIDERS)).toBe(true);
    expect(decodeBoth(PROVIDERS)).toEqual([
      {
        name: EventName.newsProviders,
        args: [
          [
            { providerCode: 'BRFG', providerName: 'Briefing.com General Market Columns' },
            { providerCode: 'BRFUPDN', providerName: 'Briefing.com Analyst Actions' },
            { providerCode: 'DJ-N', providerName: 'Dow Jones Newswires' },
          ],
        ],
      },
    ]);
  });

  it('decodes a login without API news providers as an empty list', () => {
    expect(decodeBoth(['85', '0'])).toEqual([{ name: EventName.newsProviders, args: [[]] }]);
  });

  it('decodes a headline as IB sends it (the text keeps its metadata prefix) and the end of the answer', () => {
    expect(isDecodedMessage(IN_MSG_ID.HISTORICAL_NEWS)).toBe(true);
    expect(isDecodedMessage(IN_MSG_ID.HISTORICAL_NEWS_END)).toBe(true);
    expect(decodeBoth(HEADLINE)).toEqual([{ name: EventName.historicalNews, args: [9030, ...HEADLINE.slice(2)] }]);
    expect(decodeBoth(END)).toEqual([{ name: EventName.historicalNewsEnd, args: [9030, true] }]);
    expect(decodeBoth(['87', '9030', '0'])).toEqual([{ name: EventName.historicalNewsEnd, args: [9030, false] }]);
  });

  it('decodes the same fields at every supported server version (none of them is version-gated)', () => {
    for (const sv of VERSIONS) {
      expect(decodeMessage(PROVIDERS, sv)).toEqual(decodeMessage(PROVIDERS, MAX_SERVER_VERSION));
      expect(decodeMessage(HEADLINE, sv)).toEqual(decodeMessage(HEADLINE, MAX_SERVER_VERSION));
    }
  });

  it('reports a truncated frame as error 505 and survives a negative count', () => {
    const [e] = decodeMessage(['85', '2', 'BRFG', 'Briefing.com General Market Columns', 'DJNL'], 193);
    expect(e.name).toBe('error');
    expect(e.args[1]).toBe(505);
    expect(decodeMessage(HEADLINE.slice(0, 4), 193)[0].args[1]).toBe(505);
    expect(decodeMessage(['85', '-1'], 193)).toEqual([{ name: EventName.newsProviders, args: [[]] }]);
  });
});

describe('news in the API log', () => {
  it('names the request and answer fields', () => {
    const out = decodeFrame('out', encoder.reqHistoricalNews(193, 9030, 4815747, 'BRFG+DJNL', '', '', 10));
    expect(out).toMatchObject({ name: 'reqHistoricalNews', reqId: '9030' });
    expect(out.fields).toEqual([
      ['reqId', '9030'],
      ['conId', '4815747'],
      ['providerCodes', 'BRFG+DJNL'],
      ['startDateTime', ''],
      ['endDateTime', ''],
      ['totalResults', '10'],
      ['options', ''],
    ]);
    expect(decodeFrame('out', [85])).toMatchObject({ name: 'reqNewsProviders', fields: [] });
    expect(decodeFrame('in', PROVIDERS)).toMatchObject({
      name: 'newsProviders',
      fields: [
        ['count', '3'],
        ['providers', 'BRFG Briefing.com General Market Columns, BRFUPDN Briefing.com Analyst Actions, DJ-N Dow Jones Newswires'],
      ],
    });
    expect(decodeFrame('in', HEADLINE)).toMatchObject({ name: 'historicalNews', reqId: '9030', fields: [['reqId', '9030'], ['time', HEADLINE[2]], ['providerCode', 'BRFUPDN'], ['articleId', HEADLINE[4]], ['headline', HEADLINE[5]]] });
    expect(decodeFrame('in', END)).toMatchObject({ name: 'historicalNewsEnd', reqId: '9030', fields: [['reqId', '9030'], ['hasMore', '1']] });
  });
});

describe('news over the socket', () => {
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
    api.reqNewsProviders();
    api.reqHistoricalNews(9030, 4815747, 'BRFG+BRFUPDN', '', '', 10);
    const frames = await session.waitFrames(3);
    expect(frames[1]).toEqual(['85']);
    expect(frames[2]).toEqual(['86', '9030', '4815747', 'BRFG+BRFUPDN', '', '', '10', '']);
    const providers = nextEvent(api, EventName.newsProviders);
    session.send(PROVIDERS);
    expect(await providers).toEqual([
      [
        { providerCode: 'BRFG', providerName: 'Briefing.com General Market Columns' },
        { providerCode: 'BRFUPDN', providerName: 'Briefing.com Analyst Actions' },
        { providerCode: 'DJ-N', providerName: 'Dow Jones Newswires' },
      ],
    ]);
    const headline = nextEvent(api, EventName.historicalNews);
    session.send(HEADLINE);
    expect(await headline).toEqual([9030, ...HEADLINE.slice(2)]);
    const end = nextEvent(api, EventName.historicalNewsEnd);
    session.send(END);
    expect(await end).toEqual([9030, true]);
  });
});
