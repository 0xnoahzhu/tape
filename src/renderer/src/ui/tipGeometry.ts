// Truncation check and placement of the overflow tip (see OverflowTip.tsx; unit tested).

/** One layout unit: Chromium lays text out in 1/64 px, so smaller differences are rounding. */
const LAYOUT_UNIT = 1 / 64;

/** Whether text `textWidth` wide is cut in a box whose content is `boxWidth` wide. */
export function overflows(textWidth: number, boxWidth: number): boolean {
  return textWidth - boxWidth > LAYOUT_UNIT;
}

const px = (v: string) => parseFloat(v) || 0;

/** The left and right edges of the content box of `el` (inside its border and padding). */
export function contentEdges(el: HTMLElement): { left: number; right: number } {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return { left: r.left + px(s.borderLeftWidth) + px(s.paddingLeft), right: r.right - px(s.borderRightWidth) - px(s.paddingRight) };
}

/**
 * Whether the text of `el` (a one-line ellipsis box) is cut. The text's natural width comes from a
 * Range over it, which is the full laid-out width however the box clips it (overflow: hidden or
 * clip, with or without an ellipsis), unlike scrollWidth, which depends on the box being a scroll
 * container.
 */
export function isTruncated(el: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(el);
  const { left, right } = contentEdges(el);
  return overflows(range.getBoundingClientRect().width, right - left);
}

export interface TipAnchor {
  /** Where the tip's left edge goes: its padding before the cut text, so the full text starts where that does. */
  left: number;
  /** The hovered area the tip goes under (or over). */
  top: number;
  bottom: number;
  /** Where a tip that spans what it lies over (the columns of a row) ends; without it the tip fits its text. */
  right?: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Space between the hovered area and the tip, and the least distance from the window's edges. */
export const TIP_GAP = 4;
export const TIP_MARGIN = 8;
/** The tip's horizontal padding. */
export const TIP_PAD_X = 8;

/**
 * Top-left corner of a tip of `size` in a window of `view`: under the anchor, or over it when it
 * does not fit under and there is more room above; shifted left as far as needed to stay inside.
 */
export function placeTip(anchor: TipAnchor, size: Size, view: Size): { left: number; top: number } {
  const below = anchor.bottom + TIP_GAP;
  const roomBelow = view.height - TIP_MARGIN - below;
  const roomAbove = anchor.top - TIP_GAP - TIP_MARGIN;
  const top = size.height <= roomBelow || roomBelow >= roomAbove ? below : anchor.top - TIP_GAP - size.height;
  return {
    left: Math.round(Math.max(TIP_MARGIN, Math.min(anchor.left, view.width - TIP_MARGIN - size.width))),
    top: Math.round(Math.max(TIP_MARGIN, Math.min(top, view.height - TIP_MARGIN - size.height))),
  };
}
