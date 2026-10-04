import { describe, expect, it } from 'vitest';
import { TIMEFRAMES } from '@shared/timeframes';
import {
  activeIndex,
  DEFAULT_FAVORITES,
  hiddenActive,
  toolbarChips,
  type ToolbarMetrics,
  isFavorite,
  itemKey,
  PICKER_ITEMS,
  PICKER_SECTIONS,
  pickerKey,
  toggleFavorite,
  type PickerItem,
} from './timeframePicker';

const tf = (t: string): PickerItem => ({ kind: 'interval', tf: t as never });
const range = (r: string): PickerItem => ({ kind: 'range', range: r as never });

describe('timeframe picker', () => {
  it('has the sections of the screenshot: seconds, minutes, hours, days, ranges', () => {
    expect(PICKER_SECTIONS.map((s) => [s.id, s.items.map(itemKey)])).toEqual([
      ['seconds', ['tf:1s', 'tf:5s', 'tf:10s', 'tf:15s', 'tf:30s', 'tf:45s']],
      ['minutes', ['tf:1m', 'tf:3m', 'tf:5m', 'tf:10m', 'tf:15m', 'tf:30m']],
      ['hours', ['tf:1h', 'tf:2h', 'tf:3h', 'tf:4h']],
      ['days', ['tf:1D', 'tf:1W', 'tf:1M', 'tf:1Q', 'tf:1Y']],
      ['ranges', ['range:1M', 'range:3M', 'range:YTD', 'range:1Y', 'range:5Y', 'range:MAX']],
    ]);
    expect(PICKER_ITEMS.filter((i) => i.kind === 'interval').map((i) => (i as { tf: string }).tf)).toEqual(TIMEFRAMES);
  });

  it('stars and unstars, keeping picker order (the toolbar follows it)', () => {
    let f = DEFAULT_FAVORITES;
    expect(isFavorite(f, tf('1m'))).toBe(true);
    expect(isFavorite(f, tf('45s'))).toBe(false);
    f = toggleFavorite(f, tf('45s'));
    f = toggleFavorite(f, range('YTD'));
    f = toggleFavorite(f, range('1M'));
    f = toggleFavorite(f, tf('5m'));
    expect(f).toEqual({ timeframes: ['45s', '1m', '1h', '1D', '1W', '1M', '1Y'], ranges: ['1M', 'YTD'] });
    // The interval M and the range 1M are different rows.
    expect(isFavorite(f, tf('1M'))).toBe(true);
    expect(isFavorite(toggleFavorite(f, tf('1M')), range('1M'))).toBe(true);
    expect(toggleFavorite(toggleFavorite(f, range('5Y')), range('5Y'))).toEqual(f);
  });

  it('focuses the current row: the range while one is active, else the interval', () => {
    expect(PICKER_ITEMS[activeIndex('1h', null)]).toEqual(tf('1h'));
    expect(PICKER_ITEMS[activeIndex('1h', '3M')]).toEqual(range('3M'));
  });

  it('moves with the arrows (wrapping), picks with Enter, stars with Space, closes with Escape', () => {
    const n = PICKER_ITEMS.length;
    expect(n).toBe(27);
    expect(pickerKey('ArrowDown', 3)).toEqual({ kind: 'focus', index: 4 });
    expect(pickerKey('ArrowDown', n - 1)).toEqual({ kind: 'focus', index: 0 });
    expect(pickerKey('ArrowUp', 0)).toEqual({ kind: 'focus', index: n - 1 });
    expect(pickerKey('Home', 9)).toEqual({ kind: 'focus', index: 0 });
    expect(pickerKey('End', 9)).toEqual({ kind: 'focus', index: n - 1 });
    expect(pickerKey('Enter', 2)).toEqual({ kind: 'select' });
    expect(pickerKey(' ', 2)).toEqual({ kind: 'star' });
    expect(pickerKey('Escape', 2)).toEqual({ kind: 'close' });
    expect(pickerKey('b', 2)).toBeUndefined();
  });

  it('shows the favorites that fit the toolbar in picker order, keeping the button and the active labels it needs', () => {
    // Every chip 30 px, the button 30 px plus 20 px per label, gaps of 2 px, the divider 9 px.
    const metrics: ToolbarMetrics = { chip: () => 30, button: (labels) => 30 + labels.length * 20, divider: 9, gap: 2 };
    const fav = { timeframes: DEFAULT_FAVORITES.timeframes, ranges: ['1M', '3M'] as never };
    const day = [tf('1D')];
    // All of them: 9 chips + divider + button = 270 + 9 + 30 + 10 gaps.
    expect(toolbarChips(fav, day, metrics, 329).map(itemKey)).toHaveLength(9);
    // One pixel less: the last range goes first (the active interval keeps its chip).
    expect(toolbarChips(fav, day, metrics, 328).map(itemKey)).toEqual(['tf:1m', 'tf:5m', 'tf:1h', 'tf:1D', 'tf:1W', 'tf:1M', 'tf:1Y', 'range:1M']);
    // Narrower: the coarser intervals go; an active interval left without a chip takes room on the button.
    const narrow = toolbarChips(fav, [tf('1Y')], metrics, 150);
    expect(narrow.map(itemKey)).toEqual(['tf:1m', 'tf:5m', 'tf:1h']);
    expect(hiddenActive('1Y', null, narrow).map(itemKey)).toEqual(['tf:1Y']);
    // Nothing fits: only the button.
    expect(toolbarChips(fav, day, metrics, 40)).toEqual([]);
    // The button shows the active range and interval when neither has a chip, the range first.
    expect(hiddenActive('30m', '1M', narrow).map(itemKey)).toEqual(['range:1M', 'tf:30m']);
    expect(hiddenActive('1m', null, narrow)).toEqual([]);
  });
});
