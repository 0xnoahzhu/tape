import { describe, expect, it } from 'vitest';
import { createFakeContext, createFakeIb } from './fakeIb';
import { ibRequest, IbRequestError, isWarningCode, Limiter, NOT_CONNECTED, TtlCache } from './ibRequest';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TtlCache', () => {
  it('shares in-flight loads and caches results for the TTL', async () => {
    let now = 0;
    const cache = new TtlCache<number>(() => now);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.get('k', 1000, load), cache.get('k', 1000, load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    now = 999;
    expect(await cache.get('k', 1000, load)).toBe(1);
    now = 1000;
    expect(await cache.get('k', 1000, load)).toBe(2);
  });

  it('does not cache failures and supports value-dependent TTLs', async () => {
    const cache = new TtlCache<string | null>();
    await expect(cache.get('k', 1000, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cache.get('k', (v) => (v ? 1000 : 0), async () => null)).toBeNull();
    expect(cache.peek('k')).toBeUndefined();
    expect(await cache.get('k', (v) => (v ? 1000 : 0), async () => 'x')).toBe('x');
    expect(cache.peek('k')).toBe('x');
  });
});

describe('Limiter', () => {
  it('runs at most N tasks at a time', async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await wait(10);
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(task)));
    expect(peak).toBe(2);
    expect(limiter.running).toBe(0);
  });

  it('keeps going after a failing task', async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await limiter.run(async () => 7)).toBe(7);
  });
});

describe('ibRequest', () => {
  const setup = () => {
    const fake = createFakeIb();
    const { ctx } = createFakeContext(fake.ib);
    return { fake, ctx };
  };

  it('rejects at once when not connected', async () => {
    const { ctx } = setup();
    await expect(ibRequest(ctx, { label: 'x', timeoutMs: 100, send: () => undefined, events: {} })).rejects.toThrow(NOT_CONNECTED);
  });

  it('resolves from events for its own reqId and unsubscribes afterwards', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    let sent = 0;
    const p = ibRequest<string[]>(ctx, {
      label: 'test',
      timeoutMs: 1000,
      send: (api, id) => {
        sent = id;
        api.reqContractDetails(id, {});
      },
      events: {
        rows: ([v], ctl) => (v === 'end' ? ctl.resolve(['done']) : undefined),
      },
    });
    fake.emit('rows', sent + 1, 'end'); // someone else's request
    fake.emit('rows', sent, 'end');
    await expect(p).resolves.toEqual(['done']);
    expect(fake.callsOf('reqContractDetails')).toHaveLength(1);
  });

  it('rejects with the IB error, ignoring warnings', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    let id = 0;
    const p = ibRequest(ctx, { label: 'history', timeoutMs: 1000, send: (_api, r) => void (id = r), events: {} });
    fake.error(id, 2176, 'Warning');
    fake.error(id, 162, 'Historical Market Data Service error message:Trading TWS session is connected from a different IP address');
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IbRequestError);
    expect((err as IbRequestError).code).toBe(162);
    expect((err as Error).message).toBe('Historical Market Data Service error message:Trading TWS session is connected from a different IP address (IB 162)');
  });

  it('times out with a readable error and cancels at IB', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    const p = ibRequest(ctx, {
      label: 'Historical data for AAPL',
      timeoutMs: 20,
      send: () => undefined,
      cancel: (api, id) => api.cancelHistoricalData(id),
      events: {},
    });
    await expect(p).rejects.toThrow('Historical data for AAPL timed out after 0 s');
    expect(fake.callsOf('cancelHistoricalData')).toHaveLength(1);
  });

  it('rejects when the connection closes', async () => {
    const { fake, ctx } = setup();
    fake.ready();
    const p = ibRequest(ctx, { label: 'Search', timeoutMs: 1000, send: () => undefined, events: {} });
    fake.close();
    await expect(p).rejects.toThrow('Search: connection closed');
  });

  it('classifies warnings', () => {
    expect([2104, 2152, 2176, 10167, 10090].every(isWarningCode)).toBe(true);
    expect([162, 200, 354, 10197, 10092].some(isWarningCode)).toBe(false);
  });
});
