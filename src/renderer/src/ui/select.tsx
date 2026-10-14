// Drop-down menus in the design's dense square style: a menu under an anchor (Dropdown), its
// headings and items, and a 34px Select box built on them. Used by the order ticket (order type,
// conditions, algos) and the alert dialog (alert type, indicator signal).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { giveKeysBack, keysHome } from './focus';
import { stableGutter } from './scrollGutter';

export interface Choice<K> {
  key: K;
  label: ReactNode;
  /** Why the choice is not available (shown as its tooltip); it stays visible but inert. */
  why?: string | null;
  title?: string;
}

const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

/**
 * A menu under (or above, when there is no room) an anchor, drawn over everything in a portal so
 * a scrolling body (the ticket's, a dialog's) does not clip it. Clicking outside or Escape closes it.
 *
 * While it is open it owns the keyboard: ↑ / ↓ / Home / End move through the available items,
 * Enter picks the highlighted one, and no key reaches the shortcuts behind it (Enter there would
 * submit the order or the dialog behind the menu). A text field the menu belongs to (a symbol
 * search) keeps its typing; Enter there picks the highlighted item, if any. `zIndex` must be above
 * the layer the anchor is in (dialogs are 19 to 21). A menu of the order ticket or a floating panel
 * gives it the keys back when it closes: a pick with the mouse leaves the focus on the page (its
 * items take none), where the ticket's keys would not work.
 */
export function Dropdown({ anchor, onClose, width, zIndex = 19, children }: { anchor: HTMLElement | null; onClose: () => void; width?: number; zIndex?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const highlighted = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([aria-disabled="true"])') ?? [])];
  const highlight = (el: HTMLElement | null) => {
    highlighted.current?.style.removeProperty('background');
    highlighted.current = el;
    if (!el) return;
    el.style.background = 'var(--p2)';
    el.scrollIntoView({ block: 'nearest' });
  };
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const h = ref.current.offsetHeight;
    const w = width ?? a.width;
    const margin = 8;
    const below = window.innerHeight - a.bottom - margin;
    const above = a.top - margin;
    const down = h <= below || below >= above;
    const maxHeight = Math.max(120, (down ? below : above) - 4);
    const top = down ? a.bottom + 4 : Math.max(margin, a.top - 4 - Math.min(h, maxHeight));
    const left = Math.max(margin, Math.min(a.right - w, window.innerWidth - w - margin));
    setPos({ left, top, maxHeight });
  }, [anchor, width]);
  // Once placed, the chosen item is in view and highlighted (a long menu opens at it).
  useLayoutEffect(() => {
    if (!pos || !ref.current) return;
    const active = ref.current.querySelector<HTMLElement>('[aria-checked="true"]');
    active?.scrollIntoView({ block: 'nearest' });
    if (active && active.getAttribute('aria-disabled') !== 'true') highlight(active);
  }, [pos]);
  useEffect(() => {
    const home = keysHome(anchor);
    return () => void giveKeysBack(home);
  }, [anchor]);
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = editable(e.target);
      const list = items();
      const current = highlighted.current?.isConnected ? list.indexOf(highlighted.current) : -1;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          handled();
          if (!list.length) return;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          highlight(list[current < 0 ? (step > 0 ? 0 : list.length - 1) : (current + step + list.length) % list.length]);
          return;
        }
        case 'Home':
        case 'End':
          if (typing) return;
          handled();
          if (list.length) highlight(list[e.key === 'Home' ? 0 : list.length - 1]);
          return;
        case 'Enter':
          // In a text field without a highlighted item, Enter is the field's own.
          if (typing && current < 0) return;
          handled();
          if (current >= 0 && !e.repeat) list[current].click();
          return;
        default:
          // Nothing else reaches the shortcuts behind the menu (B / S switch the ticket's side).
          if (!typing && e.key !== 'Tab') handled();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="no-drag" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex }}>
      <div
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: pos?.left ?? -9999,
          top: pos?.top ?? 0,
          width: width ?? anchor?.offsetWidth,
          maxHeight: pos?.maxHeight,
          overflowY: 'auto',
          // A symbol search's results come and go while it is open; the rows keep their width.
          ...stableGutter,
          background: 'var(--p)',
          boxShadow: '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.25)',
          padding: '6px 0',
          display: 'flex',
          flexDirection: 'column',
          fontSize: 13,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A heading line inside a drop-down menu (not selectable; the keys skip it). */
export function MenuHeading({ children }: { children: ReactNode }) {
  return <div style={{ padding: '8px 12px 4px', fontSize: 11, color: 'var(--dm)' }}>{children}</div>;
}

/**
 * A drop-down menu item with an optional hint line; inert with a reason when unavailable. The reason
 * is its tooltip, or with `showWhy` its hint line (a menu whose reasons must be read, not hovered).
 */
export function MenuChoice({
  label,
  hint,
  active,
  why,
  showWhy,
  onPick,
}: {
  label: ReactNode;
  hint?: string;
  active?: boolean;
  why?: string | null;
  showWhy?: boolean;
  onPick: () => void;
}) {
  const line = why && showWhy ? why : hint;
  return (
    <div
      onClick={why ? undefined : onPick}
      title={why ?? hint}
      className={why ? undefined : 'hover-p2'}
      role="menuitemradio"
      aria-checked={!!active}
      aria-disabled={!!why}
      style={{
        padding: line ? '6px 12px' : '0 12px',
        minHeight: line ? undefined : 30,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        cursor: why ? 'not-allowed' : 'pointer',
        boxShadow: active ? 'inset 2px 0 0 var(--ac)' : undefined,
        opacity: why ? 0.45 : 1,
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--tx)' }}>{label}</div>
      {line && (
        <div className="ellipsis" style={{ fontSize: 11, lineHeight: 1.35, color: 'var(--dm)' }}>
          {line}
        </div>
      )}
    </div>
  );
}

/**
 * A 34px box showing the chosen option with ▾ that opens a menu of the options. Options carrying a
 * `group` are listed under a heading for each group (in the order the options come).
 */
export function Select<K extends string | number>({
  options,
  value,
  onChange,
  disabled,
  title,
  width,
  zIndex,
  showWhy,
  style,
}: {
  options: Array<Choice<K> & { hint?: string; group?: string }>;
  value: K;
  onChange: (k: K) => void;
  disabled?: boolean;
  title?: string;
  /** Menu width (default: the box's). */
  width?: number;
  /** The menu's layer (Dropdown); above the dialog the box is in. */
  zIndex?: number;
  /** Unavailable options say why on their hint line, not only in their tooltip. */
  showWhy?: boolean;
  style?: CSSProperties;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.key === value);
  return (
    <>
      <div
        ref={box}
        role="button"
        aria-haspopup="menu"
        aria-disabled={disabled}
        title={title}
        onClick={disabled ? undefined : () => setAnchor(anchor ? null : box.current)}
        style={{
          height: 34,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 10px',
          background: 'var(--p)',
          boxShadow: `inset 0 0 0 1px ${anchor ? 'var(--ac)' : 'var(--ln)'}`,
          fontSize: 12,
          cursor: disabled ? 'not-allowed' : 'pointer',
          minWidth: 0,
          ...(disabled ? { opacity: 0.55 } : undefined),
          ...style,
        }}
      >
        <div className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
          {current?.label ?? String(value)}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1, color: 'var(--dm)', flexShrink: 0 }}>▾</div>
      </div>
      {anchor && (
        <Dropdown anchor={anchor} width={width} zIndex={zIndex} onClose={() => setAnchor(null)}>
          {options.map((o, i) => (
            <div key={String(o.key)} style={{ display: 'contents' }}>
              {o.group != null && o.group !== options[i - 1]?.group && <MenuHeading>{o.group}</MenuHeading>}
              <MenuChoice
                label={o.label}
                hint={o.hint}
                active={o.key === value}
                why={o.why}
                showWhy={showWhy}
                onPick={() => {
                  setAnchor(null);
                  onChange(o.key);
                }}
              />
            </div>
          ))}
        </Dropdown>
      )}
    </>
  );
}
