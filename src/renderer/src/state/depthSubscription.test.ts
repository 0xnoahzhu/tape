import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';

const setDepthSubscription = vi.fn();
(globalThis as unknown as { window: unknown }).window = { tape: { setDepthSubscription } };

const { setDepthOwner, wantedDepth } = await import('./depthSubscription');

describe('shared Level 2 subscription', () => {
  beforeEach(() => {
    setDepthSubscription.mockReset();
    setDepthSubscription.mockResolvedValue(undefined);
  });

  it('follows the newest owner and is released when nobody wants a book', async () => {
    await setDepthOwner('first', stock('AAPL'));
    expect(setDepthSubscription).toHaveBeenLastCalledWith(stock('AAPL'));
    // A second owner wants the same book: nothing is sent again.
    await setDepthOwner('second', stock('AAPL'));
    expect(setDepthSubscription).toHaveBeenCalledTimes(1);
    // The first goes: the second keeps the line.
    await setDepthOwner('first', null);
    expect(setDepthSubscription).toHaveBeenCalledTimes(1);
    await setDepthOwner('second', null);
    expect(setDepthSubscription).toHaveBeenLastCalledWith(null);
    expect(setDepthSubscription).toHaveBeenCalledTimes(2);
  });

  it('sends again when forced (after a reconnect)', async () => {
    await setDepthOwner('ticket-book', stock('MSFT'));
    await setDepthOwner('ticket-book', stock('MSFT'), true);
    expect(setDepthSubscription).toHaveBeenCalledTimes(2);
    await setDepthOwner('ticket-book', null);
  });

  it('wants the newest owner’s instrument', () => {
    expect(wantedDepth(new Map())).toBeNull();
    expect(wantedDepth(new Map([['a', stock('A')], ['b', stock('B')]]))).toEqual(stock('B'));
  });
});
