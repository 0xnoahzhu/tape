// Small controls of the order ticket's Advanced panel and type menu, in the design's dense square
// style: switch rows, collapsible sections, check boxes, segmented choices and drop-down menus.

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { OrderField } from '@shared/orderRules';
import type { TimingField, TimingInput } from '@shared/orderTiming';
import { useClock } from '../../i18n';
import type { TicketState } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import { TextField } from './fields';
import { goodAfterCommit, goodAfterDisplay, goodAfterInput, goodAfterTyping } from './timing';

/** Choices that cannot be combined with the rest of the order stay visible but inert. */
export const unavailableStyle: CSSProperties = { opacity: 0.4, cursor: 'not-allowed' };
export const hint11: CSSProperties = { fontSize: 11, lineHeight: 1.45, color: 'var(--dm)' };
export const label11: CSSProperties = { fontSize: 11, color: 'var(--dm)' };

/** A clickable row with a label (and optional description) and a switch on the right. */
export function SwitchRow({
  label,
  desc,
  on,
  onToggle,
  disabled,
  title,
}: {
  label: ReactNode;
  desc?: ReactNode;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div
      onClick={disabled ? undefined : onToggle}
      title={title}
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {desc == null ? (
        <div style={{ fontSize: 13, opacity: disabled && !on ? 0.55 : 1 }}>{label}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, opacity: disabled && !on ? 0.55 : 1 }}>
          <div style={{ fontSize: 13 }}>{label}</div>
          <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--dm)' }}>{desc}</div>
        </div>
      )}
      <Toggle on={on} disabled={disabled} />
    </div>
  );
}

/**
 * A collapsible section of the Advanced panel: a header line with the title and, when closed, a
 * summary of what is on in it ("AON · Ice 100"), then its content.
 */
export function Section({
  title,
  summary,
  open,
  onToggle,
  children,
  testId,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div data-section={testId} style={{ boxShadow: 'inset 0 1px 0 var(--ln2)' }}>
      <div
        onClick={onToggle}
        role="button"
        aria-expanded={open}
        style={{ height: 36, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', cursor: 'pointer', fontSize: 13 }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ flexShrink: 0, color: open ? 'var(--tx)' : 'var(--mu)' }}>{title}</div>
          <div className="ellipsis" style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 11, color: 'var(--ac)' }} title={summary}>
            {summary}
          </div>
        </div>
        <div style={{ flexShrink: 0, fontSize: 12, lineHeight: 1, color: 'var(--dm)', width: 12, textAlign: 'right' }}>{open ? '▴' : '▾'}</div>
      </div>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 12px 14px' }}>{children}</div>}
    </div>
  );
}

/** A small square check box with its label (the design's "incl. ext. hours"). */
export function Check({ on, label, onToggle, disabled, title }: { on: boolean; label: ReactNode; onToggle: () => void; disabled?: boolean; title?: string }) {
  return (
    <div
      onClick={disabled ? undefined : onToggle}
      title={title}
      role="checkbox"
      aria-checked={on}
      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 11, color: 'var(--dm)', flexShrink: 0, ...(disabled ? { opacity: 0.5 } : undefined) }}
    >
      <div style={{ width: 12, height: 12, flexShrink: 0, boxShadow: `inset 0 0 0 ${on ? 4 : 1}px var(--ac)` }} />
      <div>{label}</div>
    </div>
  );
}

export interface Choice<K> {
  key: K;
  label: ReactNode;
  /** Why the choice is not available (shown as its tooltip); it stays visible but inert. */
  why?: string | null;
  title?: string;
}

/** Segmented choice on the panel's p track (the condition operator, the stop-loss type, …). */
export function Seg<K extends string | number>({ options, value, onChange, style, itemStyle }: { options: Choice<K>[]; value: K; onChange: (k: K) => void; style?: CSSProperties; itemStyle?: CSSProperties }) {
  return (
    <div role="radiogroup" style={{ display: 'flex', background: 'var(--p)', padding: 2, gap: 2, boxShadow: 'inset 0 0 0 1px var(--ln)', ...style }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <div
            key={String(o.key)}
            role="radio"
            aria-checked={on}
            aria-disabled={!!o.why}
            title={o.why ?? o.title}
            onClick={o.why || on ? undefined : () => onChange(o.key)}
            className="ellipsis"
            style={{
              flex: 1,
              minWidth: 0,
              height: 26,
              lineHeight: '26px',
              textAlign: 'center',
              padding: '0 4px',
              fontSize: 12,
              cursor: o.why ? 'not-allowed' : 'pointer',
              background: on ? 'var(--p2)' : 'transparent',
              color: on ? 'var(--tx)' : 'var(--dm)',
              opacity: o.why ? 0.4 : 1,
              ...itemStyle,
            }}
          >
            {o.label}
          </div>
        );
      })}
    </div>
  );
}

const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

/**
 * A menu under (or above, when there is no room) an anchor, drawn over everything in a portal so
 * the ticket's scrolling body does not clip it. Clicking outside or Escape closes it.
 *
 * While it is open it owns the keyboard: ↑ / ↓ / Home / End move through the available items,
 * Enter picks the highlighted one, and no key reaches the ticket's shortcuts (Enter there would
 * submit the order behind the menu). A text field the menu belongs to (a symbol search) keeps its
 * typing; Enter there picks the highlighted item, if any.
 */
export function Dropdown({ anchor, onClose, width, children }: { anchor: HTMLElement | null; onClose: () => void; width?: number; children: ReactNode }) {
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
          // Nothing else reaches the ticket's shortcuts (B / S switch the side) behind the menu.
          if (!typing && e.key !== 'Tab') handled();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="no-drag" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 19 }}>
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

/** A heading line inside a drop-down menu. */
export function MenuHeading({ children }: { children: ReactNode }) {
  return <div style={{ padding: '8px 12px 4px', fontSize: 11, color: 'var(--dm)' }}>{children}</div>;
}

/** A drop-down menu item with an optional hint line; inert with a reason when unavailable. */
export function MenuChoice({ label, hint, active, why, onPick }: { label: ReactNode; hint?: string; active?: boolean; why?: string | null; onPick: () => void }) {
  return (
    <div
      onClick={why ? undefined : onPick}
      title={why ?? hint}
      className={why ? undefined : 'hover-p2'}
      role="menuitemradio"
      aria-checked={!!active}
      aria-disabled={!!why}
      style={{
        padding: hint ? '6px 12px' : '0 12px',
        minHeight: hint ? undefined : 30,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        cursor: why ? 'not-allowed' : 'pointer',
        boxShadow: active ? 'inset 2px 0 0 var(--ac)' : undefined,
        opacity: why ? 0.45 : 1,
      }}
    >
      <div style={{ fontSize: 13, color: active ? 'var(--tx)' : 'var(--tx)' }}>{label}</div>
      {hint && (
        <div className="ellipsis" style={{ fontSize: 11, lineHeight: 1.35, color: 'var(--dm)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** A 34px box showing the chosen option with ▾ that opens a menu of the options. */
export function Select<K extends string | number>({
  options,
  value,
  onChange,
  disabled,
  title,
  width,
  style,
}: {
  options: Array<Choice<K> & { hint?: string }>;
  value: K;
  onChange: (k: K) => void;
  disabled?: boolean;
  title?: string;
  /** Menu width (default: the box's). */
  width?: number;
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
        <Dropdown anchor={anchor} width={width} onClose={() => setAnchor(null)}>
          {options.map((o) => (
            <MenuChoice
              key={String(o.key)}
              label={o.label}
              hint={o.hint}
              active={o.key === value}
              why={o.why}
              onPick={() => {
                setAnchor(null);
                onChange(o.key);
              }}
            />
          ))}
        </Dropdown>
      )}
    </>
  );
}

/** A small label over a control, in a grid cell. */
export function Field({ label, children, style }: { label: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, ...style }}>
      <div className="ellipsis" style={label11}>
        {label}
      </div>
      {children}
    </div>
  );
}

/** Why a choice is unavailable with the rest of the ticket (texts, null when it is available). */
export interface Choices {
  timing: <F extends TimingField>(field: F, value: TimingInput[F]) => string | null;
  rule: (patch: Partial<TicketState>, field: OrderField) => string | null;
}

/**
 * A New York wall time typed in either format ("9:35 AM", "上午 9:35", "09:35", "21:35"), shown in
 * the user's format once the field is left, and kept as 24-hour "HH:MM" (good-after time, algo
 * start and end). Text an IME is still composing (pinyin on its way to 上午 / 下午) is left alone
 * until it ends.
 */
export function WallTimeField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const clock = useClock();
  /** The text being typed; null while the field shows the stored time. */
  const [draft, setDraft] = useState<string | null>(null);
  const composing = useRef(false);
  const type = (v: string) => {
    const next = goodAfterTyping(v, composing.current);
    setDraft(next);
    onChange(next);
  };
  return (
    <TextField
      value={draft ?? goodAfterDisplay(value, clock)}
      placeholder={placeholder ?? clock.wall('09:35')}
      numeric={false}
      onChange={type}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(v) => {
        composing.current = false;
        type(v);
      }}
      onBlur={() => {
        composing.current = false;
        if (draft != null) onChange(goodAfterCommit(goodAfterInput(draft), clock.format));
        setDraft(null);
      }}
    />
  );
}

