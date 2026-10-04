// Ticket inputs. They look exactly like the design's static boxes and become editable on click.

import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { parseNum } from '@shared/format';

/** Enter commits, Escape leaves the field; both just blur (the store already has the value). */
function blurOnKeys(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

const ring = (focused: boolean) => `inset 0 0 0 1px ${focused ? 'var(--ac)' : 'var(--ln)'}`;

/** Base style of the bare input inside a bordered box. */
export const bareInput: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--tx)',
  width: '100%',
  minWidth: 0,
  height: '100%',
  padding: 0,
  fontVariantNumeric: 'tabular-nums',
};

/**
 * Number input that shows a formatted value and edits a plain draft while focused.
 * `onInput` receives every valid positive number as it is typed (null when cleared or invalid).
 */
export function NumberField({
  display,
  edit,
  onInput,
  onCommit,
  onFocusChange,
  readOnly,
  integer,
  placeholder,
  style,
  title,
}: {
  display: string;
  edit: string;
  onInput: (n: number | null) => void;
  onCommit?: (n: number | null) => void;
  onFocusChange?: (focused: boolean) => void;
  readOnly?: boolean;
  integer?: boolean;
  placeholder?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Leaving the field without typing must not freeze a price that follows the market.
  const initial = useRef('');
  const parse = (s: string): number | null => {
    const n = parseNum(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (
    <input
      value={draft ?? display}
      readOnly={readOnly}
      tabIndex={readOnly ? -1 : undefined}
      placeholder={placeholder}
      title={title}
      spellCheck={false}
      inputMode={integer ? 'numeric' : 'decimal'}
      onFocus={(e) => {
        if (readOnly) return;
        setDraft(edit);
        initial.current = edit;
        onFocusChange?.(true);
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onChange={(e) => {
        const v = e.target.value;
        if (!(integer ? /^[\d,]*$/ : /^[\d,]*\.?\d*$/).test(v)) return;
        setDraft(v);
        onInput(parse(v));
      }}
      onBlur={() => {
        if (draft != null && draft !== initial.current) onCommit?.(parse(draft));
        setDraft(null);
        onFocusChange?.(false);
      }}
      onKeyDown={blurOnKeys}
      style={{ ...bareInput, cursor: readOnly ? 'default' : 'text', ...style }}
    />
  );
}

/**
 * Bordered 34px text input of the advanced section (take-profit, condition price, …).
 * A value that follows the market is frozen while focused, so quote ticks do not rewrite it under
 * the caret; the first edit hands the field back to `value`, which then holds the typed text.
 */
export function TextField({
  value,
  onChange,
  onBlur,
  placeholder,
  style,
  numeric = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  style?: CSSProperties;
  numeric?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [frozen, setFrozen] = useState<string | null>(null);
  return (
    <input
      value={frozen ?? value}
      placeholder={placeholder}
      spellCheck={false}
      inputMode={numeric ? 'decimal' : undefined}
      onChange={(e) => {
        setFrozen(null);
        onChange(e.target.value);
      }}
      onFocus={(e) => {
        setFocused(true);
        setFrozen(value);
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onBlur={() => {
        setFocused(false);
        setFrozen(null);
        onBlur?.();
      }}
      onKeyDown={blurOnKeys}
      style={{
        height: 34,
        padding: '0 10px',
        border: 'none',
        boxShadow: ring(focused),
        background: 'var(--p)',
        color: 'var(--tx)',
        font: '500 13px/1 var(--num)',
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        width: '100%',
        ...style,
      }}
    />
  );
}

/**
 * Date and time input (the browser's datetime-local, "2026-10-09T16:00") in the bare style of the
 * ticket's boxes. `onChange` receives "" while a part is cleared.
 */
export function DateTimeField({
  value,
  min,
  onChange,
  onFocusChange,
  title,
  style,
}: {
  value: string;
  min?: string;
  onChange: (v: string) => void;
  onFocusChange?: (focused: boolean) => void;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <input
      type="datetime-local"
      value={value}
      min={min}
      title={title}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      onKeyDown={blurOnKeys}
      style={{ ...bareInput, flex: 1, font: '500 12px/1 var(--num)', textAlign: 'right', ...style }}
    />
  );
}

/** A 40px bordered box whose ring turns accent while its input has focus. */
export function FieldBox({ focused, children, style }: { focused: boolean; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ height: 40, display: 'flex', alignItems: 'center', boxShadow: ring(focused), ...style }}>{children}</div>;
}
