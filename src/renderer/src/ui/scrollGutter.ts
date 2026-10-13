// Scrollers whose content keeps its width when their vertical scrollbar appears.
//
// macOS overlay scrollbars take no room, but classic ones do: on macOS with "Show scroll bars:
// Always" (or "Automatically" with a mouse connected) and the styled 10px ones on Windows / Linux
// (global.css). When the content of such a scroller starts to overflow (the ticket's Advanced
// opens, a list grows), the scrollbar takes its width from the content and buttons and fields
// narrow. `scrollbar-gutter: stable` reserves that room whether the content overflows or not, and
// lessGutter() gives it back from the right padding, so the content is as wide as with overlay
// scrollbars and does not change. With overlay scrollbars both have no effect.

import type { CSSProperties } from 'react';

/**
 * Sets --sbw on :root to the width a classic vertical scrollbar takes (0px with overlay ones) and
 * keeps it current when macOS switches between the two (a mouse plugged in, System Settings).
 */
export function trackScrollbarWidth(): void {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;left:0;top:-200px;width:100px;height:100px;overflow-y:scroll;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const update = () => document.documentElement.style.setProperty('--sbw', `${probe.offsetWidth - probe.clientWidth}px`);
  update();
  // The probe's content box narrows or widens with its scrollbar.
  new ResizeObserver(update).observe(probe);
}

/** For a vertical scroller: room for its scrollbar is kept whether it shows or not. */
export const stableGutter: CSSProperties = { scrollbarGutter: 'stable' };

/** A right padding of `px` less the room a classic scrollbar takes in a stable gutter (never below 0). */
export const lessGutter = (px: number) => `max(0px, ${px}px - var(--sbw, 0px))`;
