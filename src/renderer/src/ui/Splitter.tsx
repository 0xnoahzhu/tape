// Splitter on one edge of a pane (place it inside the pane's positioned box): on the top edge it sizes
// the pane's height, on the left or right edge its width. Drag it, use the arrow keys when focused, or
// double-click to restore the default size. The size is remembered per device (useSplitHeight, or the
// caller's own storage for widths).

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { clampSplit, loadSplit, saveSplit, type SplitLimits } from './splitGeometry';

const STEP = 16;
/** Thickness of the grab strip; it straddles the 1px gap between the panes. */
const HIT = 8;

/** The pane's edge the splitter sits on: top sizes its height, left / right its width. */
export type SplitEdge = 'top' | 'left' | 'right';

/** The lower pane's height for `container`, with its setter, persisted under `key`. */
export function useSplitHeight(key: string, fallback: number, limits: SplitLimits, container: RefObject<HTMLElement | null>) {
  const [stored, setStored] = useState(() => loadSplit(key, fallback));
  const [box, setBox] = useState(0);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientHeight));
    ro.observe(el);
    setBox(el.clientHeight);
    return () => ro.disconnect();
  }, [container]);

  // Before the container is measured the stored value is used as it is.
  const height = box ? clampSplit(stored, box, limits) : stored;
  const set = (h: number, persist: boolean) => {
    const next = box ? clampSplit(h, box, limits) : h;
    setStored(next);
    if (persist) saveSplit(key, next);
  };
  const max = box ? Math.max(limits.min, box - limits.minAbove) : height;
  return { height, max, set, reset: () => set(fallback, true) };
}

export function Splitter({
  size,
  edge = 'top',
  min,
  max,
  onChange,
  onReset,
  title,
  style,
}: {
  /** The pane's height (top edge) or width (left / right edge). */
  size: number;
  edge?: SplitEdge;
  min: number;
  max: number;
  /** `persist` is true when the gesture ends (pointer up, a key press). */
  onChange: (size: number, persist: boolean) => void;
  onReset: () => void;
  title: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ at: number; size: number } | null>(null);
  const across = edge !== 'top';
  // The pane grows towards its edge: up from the top edge, left from the left one, right from the right one.
  const sign = edge === 'right' ? 1 : -1;
  const at = (e: PointerEvent<HTMLDivElement>) => (across ? e.clientX : e.clientY);
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState(false);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { at: at(e), size };
    setActive(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) onChange(d.size + sign * (at(e) - d.at), false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActive(false);
    onChange(d.size + sign * (at(e) - d.at), true);
  };
  const [grow, shrink] = edge === 'top' ? ['ArrowUp', 'ArrowDown'] : edge === 'left' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowRight', 'ArrowLeft'];
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === grow ? size + STEP : e.key === shrink ? size - STEP : e.key === 'Home' ? max : e.key === 'End' ? min : null;
    if (next == null) return;
    e.preventDefault();
    onChange(next, true);
  };

  const lit = active || hover;
  return (
    <div
      role="separator"
      aria-orientation={across ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={title}
      title={title}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
      onKeyDown={key}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="focus-ring"
      style={{
        // Straddles the edge of the pane it sizes (and the 1px gap beside it).
        position: 'absolute',
        ...(across ? { top: 0, bottom: 0, width: HIT, [edge]: -(HIT / 2) - 0.5 } : { left: 0, right: 0, top: -(HIT / 2) - 0.5, height: HIT }),
        zIndex: 2,
        cursor: across ? 'col-resize' : 'row-resize',
        touchAction: 'none',
        outlineOffset: -2,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          ...(across ? { top: 0, bottom: 0, left: HIT / 2 - 1, width: 2 } : { left: 0, right: 0, top: HIT / 2 - 1, height: 2 }),
          background: lit ? 'var(--ac)' : 'transparent',
          transition: 'background .12s',
        }}
      />
    </div>
  );
}
