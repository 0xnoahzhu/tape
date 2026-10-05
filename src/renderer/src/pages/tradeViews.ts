// The Trade page's views: Chart and Options always, Depth while Level 2 is switched on
// (settings.features.depth, Settings › Market Data).

import type { TradeView } from '../state/store';

/** The Trade page's tabs, in order. */
export function tradeViews(depth: boolean): TradeView[] {
  return depth ? ['chart', 'opt', 'depth'] : ['chart', 'opt'];
}

/** The view to show: Depth with Level 2 switched off falls back to the chart. */
export function shownView(view: TradeView, depth: boolean): TradeView {
  return tradeViews(depth).includes(view) ? view : 'chart';
}
