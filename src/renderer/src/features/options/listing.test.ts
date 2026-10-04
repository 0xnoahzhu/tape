import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { ContractRef } from '@shared/types';
import type { ChainExpiry } from './chain';
import { buildListed, dropUnlisted, isListed, strikeKey } from './listing';
import { buildStrategy, legContract } from './strategies';

// Weeklies list every strike; the monthly lists only the multiples of 5.
const union = [325, 327.5, 330, 332.5, 335, 337.5, 340];
const listed = (c: ContractRef) => c.lastTradeDate === '20261009' || c.strike! % 5 === 0;
const getContractInfo = vi.fn(async (c: ContractRef) => (listed(c) ? { contract: c, longName: '', minTick: 0.01 } : null));
(globalThis as unknown as { window: unknown }).window = { tape: { getContractInfo } };

const exp = (expiry: string): ChainExpiry => ({ expiry, tradingClass: 'AAPL', multiplier: 100, exchange: 'SMART', strikes: union });
const chain = [exp('20261009'), exp('20261120')];
const underlying = stock('AAPL');

describe('listing', () => {
  beforeEach(() => {
    getContractInfo.mockClear();
  });

  it('drops unlisted strikes from their expiry only', () => {
    const unlisted = new Set([strikeKey('AAPL', '20261120', 332.5)]);
    const out = dropUnlisted(chain, unlisted);
    expect(out[0]).toBe(chain[0]);
    expect(out[1].strikes).toEqual([325, 327.5, 330, 335, 337.5, 340]);
    expect(dropUnlisted(chain, new Set())).toBe(chain);
  });

  it('checks a strike once and remembers missing ones', async () => {
    const c = legContract({ side: 'BUY', right: 'C', strike: 337.5, expiry: '20261120', qty: 1, tradingClass: 'AAPL', multiplier: 100 }, underlying);
    expect(await isListed(c)).toBe(false);
    expect(await isListed({ ...c, right: 'P' })).toBe(false);
    expect(getContractInfo).toHaveBeenCalledTimes(1);
  });

  it('treats a failed lookup as listed and asks again later', async () => {
    getContractInfo.mockRejectedValueOnce(new Error('Not connected'));
    const c = legContract({ side: 'BUY', right: 'C', strike: 340, expiry: '20261009', qty: 1, tradingClass: 'AAPL', multiplier: 100 }, underlying);
    expect(await isListed(c)).toBe(true);
    expect(await isListed(c)).toBe(true);
    expect(getContractInfo).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a calendar until the back month leg is listed', async () => {
    const build = (unlisted: ReadonlySet<string>) => buildStrategy('calendar', dropUnlisted(chain, unlisted), 0, 332.5);
    expect(build(new Set()).map((l) => [l.expiry, l.strike])).toEqual([
      ['20261009', 332.5],
      ['20261120', 332.5],
    ]);
    const legs = await buildListed(build, (l) => legContract(l, underlying));
    expect(legs.map((l) => [l.side, l.expiry, l.strike])).toEqual([
      ['SELL', '20261009', 332.5],
      ['BUY', '20261120', 330],
    ]);
  });

  it('counts strike steps over the listed strikes', async () => {
    const build = (unlisted: ReadonlySet<string>) => buildStrategy('vertical', dropUnlisted(chain, unlisted), 1, 332.5);
    const legs = await buildListed(build, (l) => legContract(l, underlying));
    expect(legs.map((l) => l.strike)).toEqual([330, 340]);
  });
});
