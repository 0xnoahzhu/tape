import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { ContractRef } from '@shared/types';
import type { MainContext, NewsHeadline, NewsPoll } from '../context';
import { createFakeContext, createFakeIb, fakeNews, settle, type FakeHeadline } from './fakeIb';
import { DEMO_NEWS_EVERY_MS } from './demo';
import {
  cleanHeadline,
  createNewsService,
  NEWS_TIME_SLACK_MS,
  newSeen,
  newsTime,
  POLL_GAP_MS,
  PROVIDERS_RETRY_MS,
  PROVIDERS_TIMEOUT_MS,
  READY_DELAY_MS,
  recordAnswer,
} from './news';

/** Tuesday 2026-10-13, 11:00 New York. */
const T0 = Date.parse('2026-10-13T11:00:00-04:00');
const FIVE_MIN = 5 * 60_000;
const NVDA = 4815747;
const AAPL = 265598;
const LOGIN = [
  { code: 'BRFG', name: 'Briefing.com General Market Columns' },
  { code: 'BRFUPDN', name: 'Briefing.com Analyst Actions' },
  { code: 'DJNL', name: 'Dow Jones Newsletters' },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

const h = (articleId: string, time: string, provider = 'BRFUPDN', text = `Headline ${articleId}`): NewsHeadline => ({ articleId, provider, time, text });

/** The news service on a connected fake IB whose login has LOGIN's providers. */
async function setup(opts: { providers?: typeof LOGIN; offline?: boolean; demo?: boolean } = {}) {
  const fake = createFakeIb();
  const news = fakeNews(fake, opts.providers ?? LOGIN);
  const f = createFakeContext(fake.ib, opts.demo);
  f.ctx.contracts = { resolve: async (c: ContractRef) => ({ ...c, conId: c.symbol === 'NVDA' ? NVDA : AAPL }) } as unknown as MainContext['contracts'];
  if (!opts.offline) fake.ready();
  const svc = createNewsService(f.ctx);
  await settle();
  const polls: NewsPoll[] = [];
  svc.onPoll((p) => void polls.push(p));
  let changes = 0;
  svc.onChange(() => void changes++);
  /** A headline IB gets now. */
  const publish = (x: Partial<FakeHeadline> & { articleId: string; time: string }) => news.headlines.push({ conId: NVDA, provider: 'BRFUPDN', text: `Headline ${x.articleId}`, ...x });
  return { ...f, fake, news, svc, polls, publish, changes: () => changes };
}

describe('news: headlines (pure)', () => {
  it("drops IB's metadata prefix and keeps a headline on one line", () => {
    expect(cleanHeadline('{A:800015:L:en:K:n/a:C:0.97}NVIDIA target raised to $150')).toBe('NVIDIA target raised to $150');
    expect(cleanHeadline('  Two\nlines  ')).toBe('Two lines');
    expect(cleanHeadline('x'.repeat(400))).toHaveLength(300);
  });

  it('reads headline times to compare them with each other', () => {
    expect(newsTime('2026-10-14 13:30:00.0')).toBe(Date.UTC(2026, 9, 14, 13, 30));
    expect(newsTime('20261014 13:30:15')).toBe(Date.UTC(2026, 9, 14, 13, 30, 15));
    expect(newsTime('1791086400')).toBe(1791086400_000);
    expect(newsTime('soon')).toBeUndefined();
  });

  it('reports nothing from a provider’s first answer, then the headlines no answer listed, oldest first', () => {
    const seen = newSeen();
    expect(recordAnswer(seen, ['BRFUPDN'], [h('a2', '2026-10-13 14:00:00.0'), h('a1', '2026-10-13 13:00:00.0')])).toEqual([]);
    const next = [h('a4', '2026-10-13 15:10:00.0'), h('a3', '2026-10-13 15:00:00.0'), h('a2', '2026-10-13 14:00:00.0')];
    expect(recordAnswer(seen, ['BRFUPDN'], next).map((x) => x.articleId)).toEqual(['a3', 'a4']);
    expect(recordAnswer(seen, ['BRFUPDN'], next)).toEqual([]);
  });

  it('does not report an old headline that comes back into the latest', () => {
    const seen = newSeen();
    recordAnswer(seen, ['BRFUPDN'], [h('a1', '2026-10-13 15:00:00.0')]);
    const old = new Date(Date.UTC(2026, 9, 13, 15) - NEWS_TIME_SLACK_MS - 60_000).toISOString().replace('T', ' ').slice(0, 19) + '.0';
    // A provider that publishes late (an hour behind the newest) still counts.
    expect(recordAnswer(seen, ['BRFUPDN'], [h('late', '2026-10-13 14:05:00.0'), h('old', old)]).map((x) => x.articleId)).toEqual(['late']);
  });

  it('starts each provider from its first answer', () => {
    const seen = newSeen();
    recordAnswer(seen, ['BRFUPDN'], [h('a1', '2026-10-13 15:00:00.0')]);
    expect(recordAnswer(seen, ['BRFUPDN', 'DJNL'], [h('d1', '2026-10-13 09:00:00.0', 'DJNL'), h('a2', '2026-10-13 15:30:00.0')]).map((x) => x.articleId)).toEqual(['a2']);
    expect(recordAnswer(seen, ['BRFUPDN', 'DJNL'], [h('d2', '2026-10-13 16:00:00.0', 'DJNL')]).map((x) => x.articleId)).toEqual(['d2']);
  });
});

describe('news: providers', () => {
  it('asks once per session: a plain reconnect keeps the answer, another login asks again', async () => {
    const t = await setup();
    expect(t.svc.providers()).toEqual({ status: 'ok', providers: LOGIN });
    expect(t.fake.callsOf('reqNewsProviders')).toHaveLength(1);
    t.fake.close();
    expect(t.svc.providers().status).toBe('ok');
    t.fake.ready();
    await settle();
    expect(t.fake.callsOf('reqNewsProviders')).toHaveLength(1);
    t.fake.close();
    t.news.providers = [{ code: 'BZ', name: 'Benzinga Pro' }];
    t.fake.newSession('params');
    expect(t.svc.providers().status).toBe('offline');
    t.fake.ready();
    expect(t.svc.providers().status).toBe('loading');
    expect(await t.svc.loadProviders()).toEqual({ status: 'ok', providers: [{ code: 'BZ', name: 'Benzinga Pro' }] });
    expect(t.fake.callsOf('reqNewsProviders')).toHaveLength(2);
  });

  it('reports an empty list as is (no API news subscription)', async () => {
    const t = await setup({ providers: [] });
    expect(t.svc.providers()).toEqual({ status: 'ok', providers: [] });
  });

  it('says so when IB does not answer, and asks again a minute later', async () => {
    const fake = createFakeIb();
    const news = fakeNews(fake, LOGIN);
    news.answerProviders = false;
    const f = createFakeContext(fake.ib);
    fake.ready();
    const svc = createNewsService(f.ctx);
    await settle();
    expect(svc.providers().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(PROVIDERS_TIMEOUT_MS);
    expect(svc.providers()).toEqual({ status: 'error', providers: [], message: 'IB did not list its news providers within 10 s' });
    news.answerProviders = true;
    await vi.advanceTimersByTimeAsync(PROVIDERS_RETRY_MS);
    expect(fake.callsOf('reqNewsProviders')).toHaveLength(2);
    expect(svc.providers().status).toBe('ok');
  });

  it('is offline until connected, and has the free providers in the demo', async () => {
    expect((await setup({ offline: true })).svc.providers()).toEqual({ status: 'offline', providers: [] });
    expect((await setup({ offline: true, demo: true })).svc.providers()).toEqual({ status: 'ok', providers: LOGIN });
  });
});

describe('news: checks', () => {
  it('checks each stock for the codes its alerts want that the login has, one at a time, then every 5 minutes', async () => {
    const t = await setup();
    t.svc.watch([
      { key: 'STK:NVDA', contract: stock('NVDA'), codes: ['BZ', 'BRFUPDN', 'BRFG'] },
      { key: 'STK:AAPL', contract: stock('AAPL'), codes: ['DJNL'] },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.news.requests).toEqual([{ reqId: expect.any(Number), conId: NVDA, codes: ['BRFG', 'BRFUPDN'] }]);
    expect(t.fake.callsOf('reqHistoricalNews')[0].slice(1)).toEqual([NVDA, 'BRFG+BRFUPDN', '', '', 10]);
    await vi.advanceTimersByTimeAsync(POLL_GAP_MS);
    expect(t.news.requests.map((r) => r.conId)).toEqual([NVDA, AAPL]);
    await vi.advanceTimersByTimeAsync(FIVE_MIN - POLL_GAP_MS - 1);
    expect(t.news.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.news.requests.map((r) => r.conId)).toEqual([NVDA, AAPL, NVDA]);
    expect(t.polls.map((p) => [p.key, p.sentAt - T0, p.seq, p.prevSeq ?? null])).toEqual([
      ['STK:NVDA', 0, 1, null],
      ['STK:AAPL', POLL_GAP_MS, 2, null],
      ['STK:NVDA', FIVE_MIN, 3, 1],
    ]);
    expect(t.svc.sequence()).toBe(4);
  });

  it('reports the headlines that came after the first answer', async () => {
    const t = await setup();
    t.publish({ articleId: 'old', time: '2026-10-13 14:00:00.0' });
    t.svc.watch([{ key: 'STK:NVDA', contract: stock('NVDA'), codes: ['BRFUPDN'] }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.polls[0]).toMatchObject({ fresh: [], listed: [{ articleId: 'old' }] });
    t.publish({ articleId: 'new', time: '2026-10-13 15:02:00.0', text: '{A:1:L:en:K:n/a:C:0.9}NVDA upgraded' });
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.polls[1].fresh).toEqual([{ articleId: 'new', provider: 'BRFUPDN', time: '2026-10-13 15:02:00.0', text: 'NVDA upgraded' }]);
    expect(t.svc.check('STK:NVDA')).toMatchObject({ seq: 2, checkedAt: T0 + FIVE_MIN, listed: [{ articleId: 'new' }, { articleId: 'old' }] });
  });

  it('checks a stock first when an alert on it is armed or it wants a new provider', async () => {
    const t = await setup();
    t.svc.watch([{ key: 'STK:NVDA', contract: stock('NVDA'), codes: ['BRFUPDN'] }]);
    await vi.advanceTimersByTimeAsync(60_000);
    t.svc.pollSoon('STK:NVDA');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.news.requests).toHaveLength(2);
    t.svc.watch([{ key: 'STK:NVDA', contract: stock('NVDA'), codes: ['BRFUPDN', 'DJNL'] }]);
    await vi.advanceTimersByTimeAsync(POLL_GAP_MS);
    expect(t.news.requests.map((r) => r.codes)).toEqual([['BRFUPDN'], ['BRFUPDN'], ['BRFUPDN', 'DJNL']]);
    // Unwatched: no more checks.
    t.svc.watch([]);
    await vi.advanceTimersByTimeAsync(2 * FIVE_MIN);
    expect(t.news.requests).toHaveLength(3);
  });

  it("keeps IB's refusal as the check's error until an answer comes", async () => {
    const t = await setup();
    t.news.refuse = { code: 10276, message: 'News feed is not allowed' };
    t.svc.watch([{ key: 'STK:NVDA', contract: stock('NVDA'), codes: ['BRFUPDN'] }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.svc.check('STK:NVDA')).toEqual({ listed: [], error: 'News feed is not allowed (IB 10276)' });
    expect(t.polls).toHaveLength(0);
    t.news.refuse = null;
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(t.svc.check('STK:NVDA')?.error).toBeUndefined();
    expect(t.polls).toHaveLength(1);
  });

  it('asks nothing when none of the codes is on the login', async () => {
    const t = await setup({ providers: [{ code: 'BRFG', name: 'Briefing.com General Market Columns' }] });
    t.svc.watch([{ key: 'STK:NVDA', contract: stock('NVDA'), codes: ['DJNL'] }]);
    await vi.advanceTimersByTimeAsync(2 * FIVE_MIN);
    expect(t.news.requests).toHaveLength(0);
  });

  it('waits while disconnected, and checks again after the reconnect once the views had their turn', async () => {
    const t = await setup();
    t.svc.watch([{ key: 'STK:NVDA', contract: stock('NVDA'), codes: ['BRFUPDN'] }]);
    await vi.advanceTimersByTimeAsync(0);
    t.fake.close();
    await vi.advanceTimersByTimeAsync(2 * FIVE_MIN);
    expect(t.news.requests).toHaveLength(1);
    t.fake.ready();
    await vi.advanceTimersByTimeAsync(READY_DELAY_MS - 1);
    expect(t.news.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.news.requests).toHaveLength(2);
    expect(t.polls.at(-1)).toMatchObject({ seq: 2, prevSeq: 1 });
  });

  it('answers from the simulator in the demo', async () => {
    const t = await setup({ offline: true, demo: true });
    t.svc.watch([{ key: 'STK:NVDA', contract: stock('NVDA'), codes: ['BRFG', 'BRFUPDN', 'DJNL'] }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.polls[0].listed.length).toBeGreaterThan(0);
    expect(t.polls[0].listed[0].text).toMatch(/^\[Demo\] /);
    await vi.advanceTimersByTimeAsync(DEMO_NEWS_EVERY_MS + FIVE_MIN);
    expect(t.polls.flatMap((p) => p.fresh).length).toBeGreaterThan(0);
  });
});
