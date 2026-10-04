import { useLayoutEffect, useState, type RefObject } from 'react';

/** Client size of an element, updated on resize (0 × 0 until mounted). */
export function useSize(ref: RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
