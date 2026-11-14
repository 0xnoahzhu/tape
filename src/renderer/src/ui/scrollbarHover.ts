// Scrollbars widen and light up under the pointer (global.css). CSS alone cannot do it: a thumb's
// :hover only covers the thumb, not the rest of its bar. So the scroller under the pointer gets
// data-sb-hover="y" while the pointer is over its vertical scrollbar, "x" over its horizontal one,
// and keeps it while a press that started there is held (dragging the thumb).

/** A scroller's padding box (px, viewport) and the room its scrollbars take in it. */
export interface ScrollBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Width of the vertical scrollbar (0: none) and height of the horizontal one. */
  v: number;
  h: number;
}

/**
 * Which scrollbar of `box` the point (x, y) is over: the vertical one on the right edge, the
 * horizontal one on the bottom edge, or neither (also the corner where they meet).
 */
export function scrollbarAt(box: ScrollBox, x: number, y: number): 'x' | 'y' | null {
  if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return null;
  const onV = box.v > 0 && x >= box.right - box.v;
  const onH = box.h > 0 && y >= box.bottom - box.h;
  if (onV && onH) return null;
  return onV ? 'y' : onH ? 'x' : null;
}

/** An element's padding box and scrollbar sizes; null when it shows no scrollbar. */
function scrollBox(el: Element): ScrollBox | null {
  if (!(el instanceof HTMLElement)) return null;
  const spareW = el.offsetWidth - el.clientWidth - el.clientLeft;
  const spareH = el.offsetHeight - el.clientHeight - el.clientTop;
  if (spareW <= 0 && spareH <= 0) return null;
  const cs = getComputedStyle(el);
  const v = Math.max(0, spareW - parseFloat(cs.borderRightWidth));
  const h = Math.max(0, spareH - parseFloat(cs.borderBottomWidth));
  if (!v && !h) return null;
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft;
  const top = r.top + el.clientTop;
  return { left, top, right: left + el.clientWidth + v, bottom: top + el.clientHeight + h, v, h };
}

/** Keeps data-sb-hover on the scroller whose scrollbar is under the pointer. */
export function trackScrollbarHover(): void {
  let marked: HTMLElement | null = null;
  const mark = (el: HTMLElement | null, axis: 'x' | 'y' | null) => {
    if (marked && (marked !== el || !axis)) delete marked.dataset.sbHover;
    marked = axis ? el : null;
    if (marked && axis && marked.dataset.sbHover !== axis) marked.dataset.sbHover = axis;
  };
  window.addEventListener(
    'pointermove',
    (e) => {
      // A press held from the bar (dragging the thumb) keeps it lit wherever the pointer goes.
      if (e.buttons && marked) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const box = el && scrollBox(el);
      mark(el, box ? scrollbarAt(box, e.clientX, e.clientY) : null);
    },
    { passive: true },
  );
  const clear = () => mark(null, null);
  window.addEventListener('pointerup', (e) => {
    // Released off the bar: the next move decides again.
    if (marked && e.target !== marked) clear();
  });
  document.documentElement.addEventListener('pointerleave', clear);
  window.addEventListener('blur', clear);
}
