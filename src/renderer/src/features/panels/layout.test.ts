import { describe, expect, it } from 'vitest';
import { DOCKED_SCALE } from '../ticket/parts';
import { LARGE_WIDTH, panelLayout, ticketScale } from './layout';
import { DEFAULT_SIZE, LANDSCAPE_MIN_WIDTH, MIN_SIZE } from './model';

describe('floating panel layout breakpoints', () => {
  it('is the docked single column below the landscape width (the minimum size included)', () => {
    expect(panelLayout(MIN_SIZE.ticket.width)).toBe('column');
    expect(panelLayout(MIN_SIZE.strategy.width)).toBe('column');
    expect(panelLayout(LANDSCAPE_MIN_WIDTH - 1)).toBe('column');
    expect(panelLayout(0)).toBe('column');
    expect(panelLayout(Number.NaN)).toBe('column');
  });

  it('has three columns from the landscape width, the default size included', () => {
    expect(panelLayout(LANDSCAPE_MIN_WIDTH)).toBe('landscape');
    expect(panelLayout(DEFAULT_SIZE.width)).toBe('landscape');
    expect(panelLayout(LARGE_WIDTH - 1)).toBe('landscape');
  });

  it('grows type and controls in a large panel', () => {
    expect(panelLayout(LARGE_WIDTH)).toBe('large');
    expect(panelLayout(2400)).toBe('large');
    const normal = ticketScale('landscape');
    const large = ticketScale('large');
    expect(large.submit).toBeGreaterThan(normal.submit);
    expect(large.quote).toBeGreaterThan(normal.quote);
    expect(normal.quote).toBeGreaterThan(DOCKED_SCALE.quote);
  });

  it('keeps the docked sizes in the single column', () => {
    expect(ticketScale('column')).toBe(DOCKED_SCALE);
  });
});
