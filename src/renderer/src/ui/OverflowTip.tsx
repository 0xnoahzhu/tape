// The full text of a one-line ellipsis box, shown on hover when the box cuts it. Native title
// tooltips come late (1–2 s on macOS) and not at all while the row under the pointer keeps
// re-rendering (live prices), so this one is drawn by the app: once the pointer rests on the box,
// in a portal over everything, and only while the text is actually cut. Right after one tip
// closes, the next shows at once, so a list of cut names can be read by moving down it.
//
// It is a pointer affordance only: keyboard selection never shows it, and it is hidden from
// assistive technology, which reads the full text from the box itself (an ellipsis only paints).

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { contentEdges, isTruncated, placeTip, TIP_MARGIN, TIP_PAD_X, type TipAnchor } from './tipGeometry';

/** How long the pointer rests on the box before the tip shows. */
const TIP_DELAY_MS = 350;
/** A tip the pointer left this recently makes the next one show without the delay. */
const TIP_WARM_MS = 300;
const TIP_MAX_WIDTH = 360;

/** Anything that starts something else hides the tip (as does a scroll that moves the hover area). */
const HIDE_ON = ['wheel', 'keydown', 'pointerdown'] as const;

/** When the pointer last left a shown tip's hover area (shared by all tips). */
let lastLeft = -Infinity;

export interface OverflowTip<T extends HTMLElement> {
  /** The ellipsis box whose text may be cut. */
  textRef: RefObject<T | null>;
  /** Spread on the hover area (the box or a larger element around it). */
  hoverProps: {
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  /** Render anywhere in the component (a portal). */
  tip: ReactNode;
}

/**
 * `content` is what the tip says: the full text, possibly with more (a listing tag). With `spanRef`
 * the tip reaches the right edge of that element's content box: a row with more columns, which the
 * tip then covers whole instead of ending inside one (a price cut to its last digits).
 */
export function useOverflowTip<T extends HTMLElement = HTMLDivElement>(content: ReactNode, spanRef?: RefObject<HTMLElement | null>): OverflowTip<T> {
  const textRef = useRef<T>(null);
  /** The hover area while the pointer is on it, until a dismissal. */
  const [area, setArea] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  /** The wait for the pointer to rest. */
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hide = () => {
    clearTimeout(timer.current);
    setArea(null);
    setAnchor(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!area) return;
    // Content elsewhere may scroll by itself (a list following new rows); that leaves the tip.
    const onScroll = (e: Event) => {
      if (e.target === document || (e.target instanceof Node && e.target.contains(area))) hide();
    };
    const opts = { capture: true, passive: true };
    for (const type of HIDE_ON) window.addEventListener(type, hide, opts);
    window.addEventListener('scroll', onScroll, opts);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      for (const type of HIDE_ON) window.removeEventListener(type, hide, opts);
      window.removeEventListener('scroll', onScroll, opts);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, [area]);

  // Checked when the pointer comes to rest, not before: the text may be cut only later (a price
  // arriving widens its column), and the next rest checks again.
  const show = (hovered: HTMLElement) => {
    const el = textRef.current;
    if (!el?.isConnected || !isTruncated(el)) return;
    const box = hovered.getBoundingClientRect();
    const span = spanRef?.current;
    setAnchor({ left: contentEdges(el).left - TIP_PAD_X, top: box.top, bottom: box.bottom, right: span?.isConnected ? contentEdges(span).right : undefined });
  };

  const hoverProps = {
    // Only a pointer that moves counts. Pointer enter is not enough: it never comes for a row put
    // under a still pointer (new results), and after a dismissal (a key, a scroll) the tip should
    // come back only once the pointer moves.
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (anchor || e.pointerType === 'touch' || !(e.movementX || e.movementY)) return;
      const target = e.currentTarget;
      setArea(target);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => show(target), performance.now() - lastLeft < TIP_WARM_MS ? 0 : TIP_DELAY_MS);
    },
    onPointerLeave: () => {
      if (anchor) lastLeft = performance.now();
      hide();
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
        // As wide as what it spans, or as its text up to a width it wraps at.
        width: anchor.right !== undefined ? anchor.right - anchor.left : 'max-content',
        maxWidth: anchor.right !== undefined ? `calc(100vw - ${2 * TIP_MARGIN}px)` : `min(${TIP_MAX_WIDTH}px, calc(100vw - ${2 * TIP_MARGIN}px))`,
        padding: `6px ${TIP_PAD_X}px`,
        // Set off from the panel or dropdown it lies on (--p), where the shadow hardly shows in dark.
        background: 'var(--p2)',
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
