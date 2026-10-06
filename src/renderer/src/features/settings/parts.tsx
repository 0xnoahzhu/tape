// Building blocks shared by the Settings sections (styles copied from the design).

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import type { DeepPartial, Settings } from '@shared/types';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Segmented, Toggle, type Option } from '../../ui/primitives';
import { TAG_LABEL, tagColors, type ObservedTag } from './logic';
import { useSettingsMessages } from './messages';

/**
 * Persists a settings change. The main process merges, saves and broadcasts the new
 * settings back, so the store (and this page) update from that event. Resolves once main
 * has answered; a failure is shown as a toast.
 */
export function saveSettings(patch: DeepPartial<Settings>): Promise<void> {
  return window.tape.updateSettings(patch).then(
    () => undefined,
    (err: unknown) => useStore.getState().showToast(errorText(err), 'error'),
  );
}

/** Section title (600 20px) with an optional description. */
export function SectionHeader({ title, desc, descStyle }: { title: ReactNode; desc?: ReactNode; descStyle?: CSSProperties }) {
  if (desc == null) return <div style={{ font: '600 20px/1.2 var(--sans)' }}>{title}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ font: '600 20px/1.2 var(--sans)' }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--mu)', textWrap: 'pretty', ...descStyle }}>{desc}</div>
    </div>
  );
}

/** Smaller heading inside a section ("Features", "Quote field sources"). */
export function SubHeader({ title, desc }: { title: ReactNode; desc?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {desc != null && <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.6 }}>{desc}</div>}
    </div>
  );
}

/** Label + description on the left, switch on the right; the whole row toggles. */
export function SettingToggle({
  label,
  desc,
  on,
  onToggle,
  height = 52,
}: {
  label: ReactNode;
  desc?: ReactNode;
  on: boolean;
  onToggle: () => void;
  height?: number;
}) {
  return (
    <div
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      style={{
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
        cursor: 'pointer',
      }}
    >
      <LabelBlock label={label} desc={desc} />
      <Toggle on={on} />
    </div>
  );
}

export function LabelBlock({ label, desc }: { label: ReactNode; desc?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div>{label}</div>
      {desc != null && <div style={{ fontSize: 12, color: 'var(--dm)' }}>{desc}</div>}
    </div>
  );
}

/**
 * Outlined mono tag showing what was observed (LIVE / DELAYED / FROZEN / NO DATA / —). `via`: live
 * only on that exchange ("LIVE · NASDAQ"), drawn with the plain ring; `muted`: a past answer;
 * `alert`: red, for what the user has to act on (a competing session). Muted wins over alert.
 */
export function ObservedTagBox({ tag, title, via, muted, alert }: { tag: ObservedTag; title?: string; via?: string; muted?: boolean; alert?: boolean }) {
  // Muted: a past answer (not connected now), in the colours of "—".
  const { fg, bd } = muted ? tagColors('none') : alert ? { fg: 'var(--r)', bd: 'var(--r)' } : tagColors(tag);
  return (
    <div
      title={title}
      style={{ padding: '3px 7px', font: '600 11px/1 var(--mono)', color: fg, boxShadow: `inset 0 0 0 1px ${via && !alert ? 'var(--ln)' : bd}`, whiteSpace: 'nowrap' }}
    >
      {via ? `${TAG_LABEL[tag]} · ${via}` : TAG_LABEL[tag]}
    </div>
  );
}

/**
 * Collapsible block (the design's expander: `label` on the left, Expand ▾ / Collapse ▴ on the right,
 * content on a --p2 panel). Closed at first unless `forceOpen`; turning `forceOpen` on later opens it
 * too, and the user can still collapse it. The open state is not remembered.
 */
export function Disclosure({ label, forceOpen = false, children }: { label: ReactNode; forceOpen?: boolean; children: ReactNode }) {
  const m = useSettingsMessages();
  const [open, setOpen] = useState(forceOpen);
  const panelId = useId();
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* A real button, so Tab reaches it and Enter / Space toggle it. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="hover-tx"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          width: '100%',
          padding: '4px 0',
          border: 'none',
          background: 'none',
          textAlign: 'left',
          fontSize: 13,
          color: 'var(--mu)',
        }}
      >
        <span>{label}</span>
        <span style={{ flexShrink: 0 }}>{open ? m.collapse : m.expand}</span>
      </button>
      {open && (
        <div id={panelId} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px', background: 'var(--p2)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** 60px row: label (and description) on the left, a segmented control on the right. */
export function OptionRow<K extends string>({
  label,
  desc,
  options,
  value,
  onChange,
  disabled,
}: {
  label: ReactNode;
  desc?: ReactNode;
  options: Option<K>[];
  value: K;
  onChange: (k: K) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)', ...disabledRow(disabled) }}>
      <LabelBlock label={label} desc={desc} />
      <Segmented options={options} value={value} onChange={(k) => k !== value && onChange(k)} itemStyle={{ padding: '7px 14px', fontSize: 13, gap: 10 }} />
    </div>
  );
}

/** A row that cannot be used yet: dimmed and inert to the pointer. */
export function disabledRow(disabled: boolean | undefined): CSSProperties {
  return disabled ? { opacity: 0.45, pointerEvents: 'none' } : {};
}

/** Rows container: stacked rows with their own bottom dividers. */
export function Rows({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: 'flex', flexDirection: 'column', ...style }}>{children}</div>;
}
