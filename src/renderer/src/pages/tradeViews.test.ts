import { describe, expect, it } from 'vitest';
import { DESK_TABS } from '../features/options/deskStore';
import { shownView, tradeViews } from './tradeViews';

describe('trade page views', () => {
  it('always has Chart and Options; Depth only with Level 2 on', () => {
    expect(tradeViews(false)).toEqual(['chart', 'opt']);
    expect(tradeViews(true)).toEqual(['chart', 'opt', 'depth']);
  });

  it('falls back to the chart from Depth with Level 2 off', () => {
    expect(shownView('depth', false)).toBe('chart');
    expect(shownView('depth', true)).toBe('depth');
    expect(shownView('opt', false)).toBe('opt');
    expect(shownView('chart', true)).toBe('chart');
  });

  it('the options desk always has Flow', () => {
    expect(DESK_TABS).toEqual(['chain', 'vol', 'flow', 'pos']);
  });
});
