// The Trade page's views: Chart and Options, always both. Level 2 is the order ticket's Book
// (ticket/DepthBlock.tsx), not a view of its own.

import type { TradeView } from '../state/store';

/** The Trade page's tabs, in order. */
export const TRADE_VIEWS: readonly TradeView[] = ['chart', 'opt'];
