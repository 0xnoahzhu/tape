// Small controls of the order ticket's Advanced panel, in the design's dense square style: switch
// rows, collapsible sections, check boxes and segmented choices. Its drop-down menus (Select,
// Dropdown, MenuChoice) are ui/select.tsx's.

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { OrderField } from '@shared/orderRules';
import type { TimingField, TimingInput } from '@shared/orderTiming';
import { useClock } from '../../i18n';
import type { TicketState } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import type { Choice } from '../../ui/select';
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
    // The ticket reads its value while the field is still being typed in (errors, summary).
    onChange(goodAfterCommit(next, clock.format));
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

