// The interval / range picker of the chart toolbar (pure, unit-tested): its sections and rows,
// favorites (the toolbar's chips, kept in picker order), the chips that fit the toolbar's width
// and keyboard navigation.

import { TIMEFRAME_GROUPS, isTimeframe, type TimeframeGroup } from '@shared/timeframes';
import type { Timeframe } from '@shared/types';
import { isChartRange, RANGES, type ChartRange } from './ranges';

export type PickerItem = { kind: 'interval'; tf: Timeframe } | { kind: 'range'; range: ChartRange };
export type PickerSectionId = TimeframeGroup | 'ranges';

export interface PickerSection {
  id: PickerSectionId;
  items: readonly PickerItem[];
}

/** Sections in picker order: seconds, minutes, hours, days, ranges. */
export const PICKER_SECTIONS: readonly PickerSection[] = [
  ...TIMEFRAME_GROUPS.map((g) => ({ id: g.group, items: g.timeframes.map((tf): PickerItem => ({ kind: 'interval', tf })) })),
  { id: 'ranges', items: RANGES.map((range): PickerItem => ({ kind: 'range', range })) },
];

/** Every row, in picker order (the keyboard moves through these). */
export const PICKER_ITEMS: readonly PickerItem[] = PICKER_SECTIONS.flatMap((s) => s.items);

/** Favorite intervals and ranges: the toolbar's chips, each list in picker order. */
export interface Favorites {
  timeframes: readonly Timeframe[];
  ranges: readonly ChartRange[];
}

/** Today's toolbar before favorites existed: 1m 5m 1h D W M Y, no ranges. */
export const DEFAULT_FAVORITES: Favorites = { timeframes: ['1m', '5m', '1h', '1D', '1W', '1M', '1Y'], ranges: [] };

export const itemKey = (item: PickerItem): string => (item.kind === 'interval' ? `tf:${item.tf}` : `range:${item.range}`);

export function sameItem(a: PickerItem, b: PickerItem): boolean {
  return itemKey(a) === itemKey(b);
}

export function isFavorite(f: Favorites, item: PickerItem): boolean {
  return item.kind === 'interval' ? f.timeframes.includes(item.tf) : f.ranges.includes(item.range);
}

/** `f` with `item` starred or unstarred; both lists stay in picker order. */
export function toggleFavorite(f: Favorites, item: PickerItem): Favorites {
  const on = !isFavorite(f, item);
  const keep = (other: PickerItem) => (sameItem(other, item) ? on : isFavorite(f, other));
  return {
    timeframes: PICKER_ITEMS.filter((i): i is Extract<PickerItem, { kind: 'interval' }> => i.kind === 'interval' && keep(i)).map((i) => i.tf),
    ranges: PICKER_ITEMS.filter((i): i is Extract<PickerItem, { kind: 'range' }> => i.kind === 'range' && keep(i)).map((i) => i.range),
  };
}

/** Stored favorites: known entries in picker order; the defaults when missing or malformed. */
export function parseFavorites(raw: unknown): Favorites {
  if (!raw || typeof raw !== 'object') return DEFAULT_FAVORITES;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.timeframes) || !Array.isArray(r.ranges)) return DEFAULT_FAVORITES;
  const tfs = new Set(r.timeframes.filter(isTimeframe));
  const ranges = new Set(r.ranges.filter(isChartRange));
  return {
    timeframes: PICKER_ITEMS.flatMap((i) => (i.kind === 'interval' && tfs.has(i.tf) ? [i.tf] : [])),
    ranges: PICKER_ITEMS.flatMap((i) => (i.kind === 'range' && ranges.has(i.range) ? [i.range] : [])),
  };
}

/** The row that is current: the active range while one is, else the active interval. */
export function activeIndex(timeframe: Timeframe, range: ChartRange | null): number {
  const item: PickerItem = range ? { kind: 'range', range } : { kind: 'interval', tf: timeframe };
  return Math.max(0, PICKER_ITEMS.findIndex((i) => sameItem(i, item)));
}

/** Widths (px) of the toolbar's parts, measured in the page. */
export interface ToolbarMetrics {
  /** Width of an item's chip. */
  chip(item: PickerItem): number;
  /** Width of the "▾" button showing these (active) items' labels, or none. */
  button(labels: readonly PickerItem[]): number;
  /** Width of the divider between interval and range chips, and the gap between all parts. */
  divider: number;
  gap: number;
}

/**
 * The favorite chips the toolbar shows within `maxWidth`: the favorites in picker order
 * (intervals, then ranges) for as long as they fit beside the "▾" button, which always shows and
 * carries the labels of the active items (`active`) left without a chip. Favorites that do not
 * fit stay in the picker.
 */
export function toolbarChips(favorites: Favorites, active: readonly PickerItem[], metrics: ToolbarMetrics, maxWidth: number): PickerItem[] {
  const all = PICKER_ITEMS.filter((i) => isFavorite(favorites, i));
  for (let k = all.length; k > 0; k--) {
    const shown = all.slice(0, k);
    const hidden = active.filter((a) => !shown.some((i) => sameItem(i, a)));
    const divider = shown.some((i) => i.kind === 'range') && shown.some((i) => i.kind === 'interval');
    const parts = k + (divider ? 1 : 0) + 1;
    const width = shown.reduce((w, i) => w + metrics.chip(i), 0) + (divider ? metrics.divider : 0) + metrics.button(hidden) + (parts - 1) * metrics.gap;
    if (width <= maxWidth) return shown;
  }
  return [];
}

/** The active items without a chip among `shown`: the range first, then the interval (the "▾" button's labels). */
export function hiddenActive(timeframe: Timeframe, range: ChartRange | null, shown: readonly PickerItem[]): PickerItem[] {
  const active: PickerItem[] = [...(range ? [{ kind: 'range', range } as PickerItem] : []), { kind: 'interval', tf: timeframe }];
  return active.filter((a) => !shown.some((i) => sameItem(i, a)));
}

export type PickerKeyAction = { kind: 'focus'; index: number } | { kind: 'select' } | { kind: 'star' } | { kind: 'close' };

/**
 * What a key does in the open picker with row `index` focused: ↑ / ↓ move (wrapping), Home / End
 * jump, Enter picks the row, Space stars it, Escape (and Tab) close. undefined: not the picker's key.
 */
export function pickerKey(key: string, index: number, count = PICKER_ITEMS.length): PickerKeyAction | undefined {
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: (index + 1) % count };
    case 'ArrowUp':
      return { kind: 'focus', index: (index - 1 + count) % count };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: count - 1 };
    case 'Enter':
      return { kind: 'select' };
    case ' ':
      return { kind: 'star' };
    case 'Escape':
    case 'Tab':
      return { kind: 'close' };
    default:
      return undefined;
  }
}
