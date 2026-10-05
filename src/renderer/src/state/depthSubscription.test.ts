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
    await setDepthOwner('depth-view', stock('AAPL'));
    expect(setDepthSubscription).toHaveBeenLastCalledWith(stock('AAPL'));
    // The floating ticket wants the same book: nothing is sent again.
    await setDepthOwner('ticket-panel', stock('AAPL'));
    expect(setDepthSubscription).toHaveBeenCalledTimes(1);
    // The depth view goes: the panel keeps the line.
    await setDepthOwner('depth-view', null);
    expect(setDepthSubscription).toHaveBeenCalledTimes(1);
    await setDepthOwner('ticket-panel', null);
    expect(setDepthSubscription).toHaveBeenLastCalledWith(null);
    expect(setDepthSubscription).toHaveBeenCalledTimes(2);
  });

  it('sends again when forced (after a reconnect)', async () => {
    await setDepthOwner('depth-view', stock('MSFT'));
    await setDepthOwner('depth-view', stock('MSFT'), true);
    expect(setDepthSubscription).toHaveBeenCalledTimes(2);
    await setDepthOwner('depth-view', null);
  });

  it('wants the newest owner’s instrument', () => {
    expect(wantedDepth(new Map())).toBeNull();
    expect(wantedDepth(new Map([['a', stock('A')], ['b', stock('B')]]))).toEqual(stock('B'));
  });
});
