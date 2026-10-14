// News for alerts (the 'news' rule, market/alerts.ts): the IB login's API news providers and
// background checks for new headlines about the instruments news alerts watch.
//
// Providers: reqNewsProviders once per session (ConnectionState.session) when the connection is
// ready; a plain reconnect keeps the answer, a new session (another login, other subscriptions)
// asks again. IB answers without a request id, so one request is outstanding at a time, with a
// timeout (retried a minute later). The demo feed has the three free providers.
//
// Headlines: one reqHistoricalNews per instrument (its conId) for the codes its alerts want that
// the login has, the latest NEWS_RESULTS (IB lists them newest first; times and article ids are
// IB's). Checks go one at a time and at least POLL_GAP_MS apart, each instrument NEWS_POLL_MS
// after its last check, so they spread out; they wait READY_DELAY_MS after a (re)connect and go in
// the send queue's market data lane, behind orders and control. An instrument that is new, wants a
// new provider, or whose alert was just armed (pollSoon) is checked first.
//
// What is new: an article id no earlier answer in this app run listed. The first answer that
// includes a provider only records what it lists (nothing from before the check is announced), and
// a headline more than NEWS_TIME_SLACK_MS older than the newest one seen from its provider is not
// new either (an old one that came back into the latest, e.g. after a retraction). IB does not
// document the time zone of headline times, so they are only compared with each other. Nothing is
// persisted: after a restart the first answer is again only recorded. Checks are numbered in the
// order they are sent; each answer goes to the listeners with its number and the previous answer's,
// so an alert armed in between (NewsService.sequence) knows the answer is where it starts
// (market/alerts.ts).

import { EventName } from '../ib/tws';
import { availableNewsCodes, NEWS_POLL_MS } from '@shared/alerts';
import { contractLabel } from '@shared/contract';
import type { NewsProvider, NewsProviders } from '@shared/types';
import type { MainContext, NewsCheck, NewsHeadline, NewsPoll, NewsService, NewsWatch, Unsubscribe } from '../context';
import { DEMO_NEWS_PROVIDERS, demoMarket } from './demo';
import { afterStartup, ibRequest, isIbConnected } from './ibRequest';

/** Headlines asked per check: more than a few minutes bring for one instrument. */
export const NEWS_RESULTS = 10;
/** Least time between two checks (of any instruments). */
export const POLL_GAP_MS = 2_000;
/** After a (re)connect checks wait this long, so the views' requests go first. */
export const READY_DELAY_MS = 5_000;
export const NEWS_TIMEOUT_MS = 20_000;
export const PROVIDERS_TIMEOUT_MS = 10_000;
/** A providers request IB did not answer is asked again after this. */
export const PROVIDERS_RETRY_MS = 60_000;
/** A headline this much older than its provider's newest seen one is not new (see the header). */
export const NEWS_TIME_SLACK_MS = 60 * 60_000;
/** Article ids remembered per instrument (a check lists NEWS_RESULTS). */
const MAX_SEEN = 500;
/** Longest headline text kept. */
const HEADLINE_MAX = 300;

// ---------------------------------------------------------------------------
// Headlines (pure)

/** IB's metadata before some headlines: "{A:800015:L:en:K:n/a:C:0.97}" (article type, language, sentiment, confidence). */
const META_PREFIX = /^\{[^{}]*\}\s*/;

/** A headline's text as shown: without IB's metadata prefix, on one line, at most HEADLINE_MAX characters. */
export function cleanHeadline(text: string): string {
  const s = text.replace(META_PREFIX, '').replace(/\s+/g, ' ').trim();
  return s.length > HEADLINE_MAX ? `${s.slice(0, HEADLINE_MAX - 1).trimEnd()}…` : s;
}

/**
 * A headline time as a number to compare with other headline times: "2026-10-14 13:30:00.0" (or
 * "20261014 13:30:00") read as if UTC, epoch seconds or milliseconds as they are. Undefined when
 * it cannot be read. Not an instant: IB does not say which time zone its times are in.
 */
export function newsTime(s: string): number | undefined {
  const t = s.trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[ T-]+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (/^\d{10}$/.test(t)) return Number(t) * 1000;
  if (/^\d{13}$/.test(t)) return Number(t);
  return undefined;
}

/** What earlier answers of one instrument listed. */
export interface SeenHeadlines {
  ids: Set<string>;
  /** Providers an answer has included: their later headlines can be new. */
  providers: Set<string>;
  /** Newest headline time seen per provider (newsTime). */
  newest: Map<string, number>;
}

export const newSeen = (): SeenHeadlines => ({ ids: new Set(), providers: new Set(), newest: new Map() });

/** Newest first; headlines without a readable time keep their place after the others. */
export function byTimeDesc(list: readonly NewsHeadline[]): NewsHeadline[] {
  return list
    .map((h, i) => ({ h, i, t: newsTime(h.time) }))
    .sort((a, b) => {
      if (a.t !== undefined && b.t !== undefined && a.t !== b.t) return b.t - a.t;
      if ((a.t === undefined) !== (b.t === undefined)) return a.t === undefined ? 1 : -1;
      return a.i - b.i;
    })
    .map((x) => x.h);
}

/**
 * Records an answer for `codes` (newest first, as IB lists) and returns the headlines that are new,
 * oldest first: an article id not seen before, from a provider an earlier answer included, not more
 * than NEWS_TIME_SLACK_MS older than that provider's newest headline seen before.
 */
export function recordAnswer(seen: SeenHeadlines, codes: readonly string[], listed: readonly NewsHeadline[]): NewsHeadline[] {
  const fresh: NewsHeadline[] = [];
  for (const h of listed) {
    if (!h.articleId || seen.ids.has(h.articleId)) continue;
    const t = newsTime(h.time);
    const newest = seen.newest.get(h.provider);
    if (seen.providers.has(h.provider) && (t === undefined || newest === undefined || t >= newest - NEWS_TIME_SLACK_MS)) fresh.push(h);
    seen.ids.add(h.articleId);
  }
  for (const h of listed) {
    const t = newsTime(h.time);
    const newest = seen.newest.get(h.provider);
    if (t !== undefined && (newest === undefined || t > newest)) seen.newest.set(h.provider, t);
  }
  for (const c of codes) seen.providers.add(c);
  // The oldest ids go first (a Set keeps insertion order).
  for (const id of seen.ids) {
    if (seen.ids.size <= MAX_SEEN) break;
    seen.ids.delete(id);
  }
  return byTimeDesc(fresh).reverse();
}

const headlineOf = (time: unknown, provider: unknown, articleId: unknown, text: unknown): NewsHeadline => ({
  articleId: String(articleId ?? ''),
  provider: String(provider ?? ''),
  time: String(time ?? ''),
  text: cleanHeadline(String(text ?? '')),
});

function providersOf(list: unknown): NewsProvider[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((p: { providerCode?: unknown; providerName?: unknown }) => ({ code: String(p?.providerCode ?? '').trim(), name: String(p?.providerName ?? '').trim() }))
    .filter((p) => p.code);
}

// ---------------------------------------------------------------------------
// Service

interface Watched {
  key: string;
  contract: NewsWatch['contract'];
  /** The codes the instrument's alerts want, sorted. */
  codes: string[];
  conId?: number;
  /** Next regular check (epoch ms). */
  due: number;
  seen: SeenHeadlines;
  last?: NewsCheck;
}

export function createNewsService(ctx: MainContext): NewsService {
  const watched = new Map<string, Watched>();
  /** Instruments to check before the regular ones, in order. */
  const soon: string[] = [];
  /** The instrument being checked. */
  let busy: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = -Infinity;
  let readyAt = -Infinity;
  /** The number of the next check sent. */
  let seq = 1;
  /** The providers IB listed for a session, or why it did not. */
  let known: { session: number; providers: NewsProvider[] } | null = null;
  let failed: { session: number; message: string } | null = null;
  let pending: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const pollListeners = new Set<(p: NewsPoll) => void>();
  const changeListeners = new Set<() => void>();

  const online = () => ctx.demo || isIbConnected(ctx);
  const sessionNow = () => ctx.ib.getState().session;

  const changed = () => {
    for (const l of [...changeListeners]) {
      try {
        l();
      } catch (err) {
        console.error('[news] listener failed:', err);
      }
    }
  };

  const providers = (): NewsProviders => {
    if (ctx.demo) return { status: 'ok', providers: DEMO_NEWS_PROVIDERS.map((p) => ({ ...p })) };
    const session = sessionNow();
    if (known?.session === session) return { status: 'ok', providers: known.providers };
    if (!isIbConnected(ctx)) return { status: 'offline', providers: [] };
    if (failed?.session === session && !pending) return { status: 'error', providers: [], message: failed.message };
    return { status: 'loading', providers: [] };
  };

  /** Asks IB for the login's providers, unless this session's are known or being asked for. */
  const askProviders = () => {
    if (ctx.demo || pending || !isIbConnected(ctx) || known?.session === sessionNow()) return;
    const api = ctx.ib.api;
    if (!api) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const session = sessionNow();
    const subs: Unsubscribe[] = [];
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let resolvePending: () => void = () => undefined;
    const finish = (result: { list: NewsProvider[] } | { error: string } | { closed: true }) => {
      if (done) return;
      done = true;
      for (const off of subs) off();
      if (timeout) clearTimeout(timeout);
      pending = null;
      if (sessionNow() === session) {
        if ('list' in result) {
          known = { session, providers: result.list };
          failed = null;
        } else if ('error' in result) {
          failed = { session, message: result.error };
          retryTimer = setTimeout(() => {
            retryTimer = null;
            askProviders();
          }, PROVIDERS_RETRY_MS);
        }
      }
      resolvePending();
      // The session changed while IB was asked (another login on the same socket): ask for the new one's.
      if (sessionNow() !== session) askProviders();
      changed();
      schedule();
    };
    pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    subs.push(ctx.ib.on(EventName.newsProviders, (list: unknown) => finish({ list: providersOf(list) })));
    subs.push(ctx.ib.onClosed(() => finish({ closed: true })));
    timeout = setTimeout(() => finish({ error: `IB did not list its news providers within ${PROVIDERS_TIMEOUT_MS / 1000} s` }), PROVIDERS_TIMEOUT_MS);
    try {
      api.reqNewsProviders();
    } catch (err) {
      finish({ error: err instanceof Error ? err.message : String(err) });
    }
    if (!done) changed();
  };

  // ---------------------------------------------------------------------------
  // Checks

  const nextDue = (): { key: string; at: number } | null => {
    while (soon.length && !watched.has(soon[0])) soon.shift();
    if (soon.length) return { key: soon[0], at: 0 };
    let best: Watched | undefined;
    for (const w of watched.values()) if (!best || w.due < best.due) best = w;
    return best ? { key: best.key, at: best.due } : null;
  };

  /** Arms the timer for the next check: the soonest due, POLL_GAP_MS after the last, READY_DELAY_MS after a (re)connect. */
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (busy || !watched.size || !online()) return;
    // Which codes to ask depends on the providers: their answer schedules again.
    if (providers().status === 'loading') return;
    const next = nextDue();
    if (!next) return;
    const at = Math.max(next.at, lastSentAt + POLL_GAP_MS, readyAt + READY_DELAY_MS);
    timer = setTimeout(
      () => {
        timer = null;
        void run(next.key);
      },
      Math.max(0, at - Date.now()),
    );
  }

  async function fetchHeadlines(w: Watched, codes: string[]): Promise<NewsHeadline[]> {
    if (ctx.demo) return demoMarket().headlines(w.contract.symbol, codes, NEWS_RESULTS).map((h) => headlineOf(h.time, h.provider, h.articleId, h.headline));
    const conId = w.conId ?? w.contract.conId ?? (await ctx.contracts.resolve(w.contract)).conId;
    if (!conId) throw new Error(`Unknown contract: ${contractLabel(w.contract)}`);
    w.conId = conId;
    const rows: NewsHeadline[] = [];
    return ibRequest<NewsHeadline[]>(ctx, {
      label: `Headlines for ${contractLabel(w.contract)}`,
      timeoutMs: NEWS_TIMEOUT_MS,
      send: (api, reqId) => api.reqHistoricalNews(reqId, conId, codes.join('+'), '', '', NEWS_RESULTS),
      events: {
        [EventName.historicalNews]: ([time, provider, articleId, text]) => void rows.push(headlineOf(time, provider, articleId, text)),
        [EventName.historicalNewsEnd]: (_args, ctl) => ctl.resolve(rows),
      },
    });
  }

  async function run(key: string): Promise<void> {
    const w = watched.get(key);
    if (!w || busy || !online()) return schedule();
    const i = soon.indexOf(key);
    if (i >= 0) soon.splice(i, 1);
    w.due = Date.now() + NEWS_POLL_MS;
    // None of the codes on this login: nothing to ask (the alerts' statuses say so).
    const codes = availableNewsCodes(w.codes, providers());
    if (!codes.length) return schedule();
    busy = key;
    const sentAt = Date.now();
    const checkSeq = seq++;
    lastSentAt = sentAt;
    try {
      const listed = byTimeDesc(await fetchHeadlines(w, codes));
      if (watched.get(key) !== w) return;
      const fresh = recordAnswer(w.seen, codes, listed);
      const prevSeq = w.last?.seq;
      w.last = { seq: checkSeq, checkedAt: Date.now(), listed };
      const poll: NewsPoll = { key, codes, seq: checkSeq, sentAt, fresh, listed };
      if (prevSeq !== undefined) poll.prevSeq = prevSeq;
      for (const l of [...pollListeners]) {
        try {
          l(poll);
        } catch (err) {
          console.error('[news] listener failed:', err);
        }
      }
    } catch (err) {
      if (watched.get(key) !== w) return;
      if (!online()) {
        // Cut short by the connection: asked again once it is back.
        w.due = Date.now();
        return;
      }
      w.last = { ...(w.last ?? { listed: [] }), error: err instanceof Error ? err.message : String(err) };
      changed();
    } finally {
      if (busy === key) busy = null;
      schedule();
    }
  }

  afterStartup(() => {
    ctx.ib.onReady(() => {
      readyAt = Date.now();
      askProviders();
      schedule();
    });
    ctx.ib.onClosed(() => {
      if (timer) clearTimeout(timer);
      timer = null;
      changed();
    });
    // Another login may have other subscriptions; IB's news itself is the same, so what was seen stays.
    ctx.ib.onSessionChange(() => {
      known = null;
      failed = null;
      for (const w of watched.values()) {
        if (!w.last?.error) continue;
        const { error: _error, ...rest } = w.last;
        w.last = rest;
      }
      changed();
    });
    // Connected already (the ready listener above may only hear later sessions): ask now.
    askProviders();
    schedule();
  });

  return {
    providers,

    async loadProviders() {
      askProviders();
      if (pending) await pending;
      return providers();
    },

    watch(list) {
      const next = new Map((Array.isArray(list) ? list : []).map((item) => [item.key, item]));
      for (const key of [...watched.keys()]) if (!next.has(key)) watched.delete(key);
      for (const item of next.values()) {
        const codes = [...new Set(item.codes)].sort();
        const w = watched.get(item.key);
        if (!w) {
          watched.set(item.key, { key: item.key, contract: item.contract, codes, due: Date.now(), seen: newSeen() });
          if (!soon.includes(item.key)) soon.push(item.key);
          continue;
        }
        // A provider the instrument was not asked for: its first answer marks where it starts.
        if (codes.some((c) => !w.codes.includes(c)) && !soon.includes(item.key)) soon.push(item.key);
        w.codes = codes;
        w.contract = item.contract;
      }
      schedule();
    },

    pollSoon(key) {
      if (!watched.has(key) || soon.includes(key)) return;
      soon.push(key);
      schedule();
    },

    sequence: () => seq,

    check: (key) => watched.get(key)?.last,

    onPoll(listener) {
      pollListeners.add(listener);
      return () => void pollListeners.delete(listener);
    },

    onChange(listener) {
      changeListeners.add(listener);
      return () => void changeListeners.delete(listener);
    },
  };
}
