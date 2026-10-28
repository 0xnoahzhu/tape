// Every `title` in the app, shown by the app rather than the system. A native title comes after
// 1–2 s, goes at the slightest move of the pointer, and often not at all over an element that keeps
// re-rendering (live prices); this one comes once the pointer rests on the element (TIP_DELAY_MS),
// at once on the next one right after (the warm switch the overflow tip has), and goes when the
// pointer leaves, on a press, a wheel, a key, a scroll, a resize or when the window loses focus.
//
// One listener on the document finds the element with a title under the pointer and moves its text
// to `data-tip`, so the system shows nothing; the element keeps it as an accessible description
// (`aria-description`, unless it names one itself). React sets a title again only when its value
// changes: the next move (or the observer while the tip shows) takes the new one. Hover areas of the
// app's own tips (OverflowTip.tsx, marked `data-own-tip`) are left to them.

import { useEffect, useState } from 'react';
import { markTipLeft, Tip, tipDelay } from './OverflowTip';
import type { TipAnchor } from './tipGeometry';

const HIDE_ON = ['pointerdown', 'wheel', 'keydown'] as const;

/** The element under the pointer whose title the tip shows, if any: its text taken from `title` to `data-tip`. */
export function tipHost(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-own-tip]')) return null;
  const host = target.closest('[title], [data-tip]');
  if (!host) return null;
  const title = host.getAttribute('title');
  if (title !== null) {
    host.removeAttribute('title');
    if (title.trim()) {
      host.setAttribute('data-tip', title);
      if (!host.hasAttribute('aria-label') && !host.hasAttribute('aria-labelledby')) host.setAttribute('aria-description', title);
    } else host.removeAttribute('data-tip');
  }
  return host.getAttribute('data-tip') ? host : null;
}

export function GlobalTip() {
  const [shown, setShown] = useState<{ host: Element; text: string; anchor: TipAnchor } | null>(null);

  useEffect(() => {
    let host: Element | null = null;
    let open = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watch: MutationObserver | undefined;

    const hide = () => {
      clearTimeout(timer);
      watch?.disconnect();
      watch = undefined;
      if (open) markTipLeft();
      open = false;
      host = null;
      setShown(null);
    };
    const show = (el: Element) => {
      const text = el.getAttribute('data-tip');
      if (!el.isConnected || !text) return;
      const r = el.getBoundingClientRect();
      open = true;
      setShown({ host: el, text, anchor: { left: r.left, top: r.top, bottom: r.bottom } });
      // A new title while the tip shows (a price, a count) is taken at once.
      watch = new MutationObserver(() => {
        if (tipHost(el) !== el) return hide();
        const next = el.getAttribute('data-tip') ?? '';
        setShown((s) => (s && s.host === el && s.text !== next ? { ...s, text: next } : s));
      });
      watch.observe(el, { attributes: true, attributeFilter: ['title'] });
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const next = tipHost(e.target);
      if (next !== host) {
        if (host) hide();
        host = next;
      }
      // Only a moving pointer arms it (as the overflow tip): after a dismissal it comes back on a move.
      if (!host || open || !(e.movementX || e.movementY)) return;
      clearTimeout(timer);
      const el = host;
      timer = setTimeout(() => show(el), tipDelay());
    };
    const onScroll = (e: Event) => {
      if (host && (e.target === document || (e.target instanceof Node && e.target.contains(host)))) hide();
    };
    const opts = { capture: true, passive: true };
    document.addEventListener('pointermove', onMove, opts);
    document.addEventListener('pointerleave', hide);
    for (const type of HIDE_ON) window.addEventListener(type, hide, opts);
    window.addEventListener('scroll', onScroll, opts);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      clearTimeout(timer);
      watch?.disconnect();
      document.removeEventListener('pointermove', onMove, opts);
      document.removeEventListener('pointerleave', hide);
      for (const type of HIDE_ON) window.removeEventListener(type, hide, opts);
      window.removeEventListener('scroll', onScroll, opts);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, []);

  if (!shown) return null;
  // The lock screen's own titles go over it; every other one stays under it.
  const zIndex = shown.host.closest('[data-lock-root]') ? 45 : 35;
  return (
    <Tip anchor={shown.anchor} zIndex={zIndex}>
      <div style={{ whiteSpace: 'pre-line' }}>{shown.text}</div>
    </Tip>
  );
}
