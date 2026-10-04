// Building blocks shared by the Settings sections (styles copied from the design).

import type { CSSProperties, ReactNode } from 'react';
import type { DeepPartial, Settings } from '@shared/types';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Segmented, Toggle, type Option } from '../../ui/primitives';
import { TAG_LABEL, tagColors, type ObservedTag } from './logic';

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

/** Outlined mono tag showing what was observed (LIVE / DELAYED / FROZEN / NO DATA / —). */
export function ObservedTagBox({ tag, title }: { tag: ObservedTag; title?: string }) {
  const { fg, bd } = tagColors(tag);
  return (
    <div title={title} style={{ padding: '3px 7px', font: '600 11px/1 var(--mono)', color: fg, boxShadow: `inset 0 0 0 1px ${bd}`, whiteSpace: 'nowrap' }}>
      {TAG_LABEL[tag]}
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
