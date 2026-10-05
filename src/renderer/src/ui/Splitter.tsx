// Horizontal splitter on the top edge of a pane (place it inside a positioned parent): drag it, use ↑/↓ when focused, or double-click
// to restore the default height. The pane's height is remembered per device.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { clampSplit, loadSplit, saveSplit, type SplitLimits } from './splitGeometry';

const STEP = 16;
/** Height of the grab strip; it straddles the 1px gap between the panes. */
const HIT = 8;

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
  height,
  min,
  max,
  onChange,
  onReset,
  title,
  style,
}: {
  height: number;
  min: number;
  max: number;
  /** `persist` is true when the gesture ends (pointer up, a key press). */
  onChange: (height: number, persist: boolean) => void;
  onReset: () => void;
  title: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState(false);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: height };
    setActive(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) onChange(d.h - (e.clientY - d.y), false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActive(false);
    onChange(d.h - (e.clientY - d.y), true);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowUp' ? height + STEP : e.key === 'ArrowDown' ? height - STEP : e.key === 'Home' ? max : e.key === 'End' ? min : null;
    if (next == null) return;
    e.preventDefault();
    onChange(next, true);
  };

  const lit = active || hover;
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(height)}
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
        // Straddles the top edge of the pane it sizes (and the 1px gap above it).
        position: 'absolute',
        left: 0,
        right: 0,
        top: -(HIT / 2) - 0.5,
        zIndex: 2,
        height: HIT,
        cursor: 'row-resize',
        touchAction: 'none',
        outlineOffset: -2,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: HIT / 2 - 1,
          height: 2,
          background: lit ? 'var(--ac)' : 'transparent',
          transition: 'background .12s',
        }}
      />
    </div>
  );
}
