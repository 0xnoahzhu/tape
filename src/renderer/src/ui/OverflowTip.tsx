// The full text of a one-line ellipsis box, shown on hover when the box cuts it. Native title
// tooltips come late (1–2 s on macOS) and not at all while the row under the pointer keeps
// re-rendering (live prices), so this one is drawn by the app: after a short rest of the pointer,
// in a portal over everything, and only while the text is actually cut.
//
// It is a pointer affordance only: keyboard selection never shows it, and it is hidden from
// assistive technology, which reads the full text from the box itself (an ellipsis only paints).

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isTruncated, placeTip, TIP_MARGIN, type TipAnchor } from './tipGeometry';

/** How long the pointer rests on the box before the tip shows. */
const TIP_DELAY_MS = 350;
const TIP_MAX_WIDTH = 360;

/** Anything that starts something else hides the tip (as does a scroll that moves the hover area). */
const HIDE_ON = ['wheel', 'keydown', 'pointerdown'] as const;

export interface OverflowTip<T extends HTMLElement> {
  /** The ellipsis box whose text may be cut. */
  textRef: RefObject<T | null>;
  /** Spread on the hover area (the box or a larger element around it). */
  hoverProps: {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  /** Render anywhere in the component (a portal). */
  tip: ReactNode;
}

/** `content` is what the tip says: the full text, possibly with more (a listing tag). */
export function useOverflowTip<T extends HTMLElement = HTMLDivElement>(content: ReactNode): OverflowTip<T> {
  const textRef = useRef<T>(null);
  /** The hover area under the pointer, also after the tip was dismissed. */
  const inside = useRef<HTMLElement | null>(null);
  /** The hover area while a tip is pending or shown. */
  const [armed, setArmed] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      const el = textRef.current;
      if (!el?.isConnected || !isTruncated(el)) return;
      const area = armed.getBoundingClientRect();
      setAnchor({ left: el.getBoundingClientRect().left, top: area.top, bottom: area.bottom });
    }, TIP_DELAY_MS);
    const dismiss = () => {
      setArmed(null);
      setAnchor(null);
    };
    // Content elsewhere may scroll by itself (a list following new rows); that leaves the tip.
    const onScroll = (e: Event) => {
      if (e.target === document || (e.target instanceof Node && e.target.contains(armed))) dismiss();
    };
    const opts = { capture: true, passive: true };
    for (const type of HIDE_ON) window.addEventListener(type, dismiss, opts);
    window.addEventListener('scroll', onScroll, opts);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      clearTimeout(timer);
      for (const type of HIDE_ON) window.removeEventListener(type, dismiss, opts);
      window.removeEventListener('scroll', onScroll, opts);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [armed]);

  const hoverProps = {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch') return;
      inside.current = e.currentTarget;
      setArmed(e.currentTarget);
    },
    // After a dismissal (a key press, a scroll) the tip comes back only once the pointer moves.
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (!armed && inside.current && (e.movementX || e.movementY)) setArmed(inside.current);
    },
    onPointerLeave: () => {
      inside.current = null;
      setArmed(null);
      setAnchor(null);
    },
  };

  return { textRef, hoverProps, tip: anchor && <Tip anchor={anchor}>{content}</Tip> };
}

function Tip({ anchor, children }: { anchor: TipAnchor; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Measured after every render (the content may change while shown); unchanged places keep the state.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = placeTip(anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
  });
  return createPortal(
    <div
      ref={ref}
      aria-hidden
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? undefined : 'hidden',
        // Over menus and dialogs (30), under the lock screen (40).
        zIndex: 35,
        width: 'max-content',
        maxWidth: `min(${TIP_MAX_WIDTH}px, calc(100vw - ${2 * TIP_MARGIN}px))`,
        padding: '6px 8px',
        background: 'var(--p)',
        boxShadow: '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.2)',
        color: 'var(--tx)',
        font: '12px/1.4 var(--sans)',
        overflowWrap: 'anywhere',
        pointerEvents: 'none',
        animation: 'tape-fade-in .1s ease-out',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
