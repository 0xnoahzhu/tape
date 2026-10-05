// How a floating panel lays itself out for its own width (never the window's): below
// LANDSCAPE_MIN_WIDTH the docked panel's single column, above it three columns whose type and
// controls grow a little with the width. Pure.

import { DOCKED_SCALE, label12, type TicketScale } from '../ticket/parts';
import { LANDSCAPE_MIN_WIDTH } from './model';

export type PanelLayout = 'column' | 'landscape' | 'large';

/** From this width on, the three columns use the larger sizes. */
export const LARGE_WIDTH = 1240;

export function panelLayout(width: number): PanelLayout {
  if (!(width >= LANDSCAPE_MIN_WIDTH)) return 'column';
  return width >= LARGE_WIDTH ? 'large' : 'landscape';
}

/** Sizes of the ticket's controls in the panel. */
export function ticketScale(layout: PanelLayout): TicketScale {
  if (layout === 'column') return DOCKED_SCALE;
  const large = layout === 'large';
  return {
    label: large ? { ...label12, fontSize: 13 } : label12,
    quote: large ? 28 : 24,
    quotePad: large ? '16px 18px' : '14px 16px',
    side: large ? 50 : 44,
    type: large ? 38 : 34,
    typeFont: large ? 14 : 13,
    field: large ? 50 : 46,
    priceSize: large ? 19 : 17,
    qtyRoom: large ? 200 : 160,
    totals: large ? 14 : 13,
    submit: large ? 58 : 52,
    submitFont: large ? 18 : 16,
  };
}

/** Padding inside a column and the gap between its blocks. */
export const columnSpacing = (layout: PanelLayout) => (layout === 'large' ? { pad: 24, gap: 18 } : { pad: 18, gap: 14 });
