// Shared building blocks that reproduce the design's controls exactly.
// The design is square (no border radius), uses inset box-shadows as borders,
// and expresses state through color tokens only.

import type { CSSProperties, ReactNode, KeyboardEvent, ChangeEvent, MouseEvent } from 'react';

/** 34×18 switch: accent when on, line color when off. */
export function Toggle({ on, onClick, disabled, title }: { on: boolean; onClick?: (e: MouseEvent) => void; disabled?: boolean; title?: string }) {
  return (
    <div
      role="switch"
      aria-checked={on}
      title={title}
      onClick={disabled ? undefined : onClick}
      style={{
        width: 34,
        height: 18,
        flexShrink: 0,
        background: on ? 'var(--ac)' : 'var(--ln)',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : onClick ? 'pointer' : undefined,
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <div style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14, background: 'var(--p)' }} />
    </div>
  );
}

/** A labelled row with a description and a toggle on the right (settings, advanced ticket). */
export function ToggleRow({
  label,
  desc,
  on,
  onToggle,
  height,
  divider,
  disabled,
}: {
  label: ReactNode;
  desc?: ReactNode;
  on: boolean;
  onToggle: () => void;
  height?: number;
  divider?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      onClick={disabled ? undefined : onToggle}
      style={{
        minHeight: height,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: divider ? 'inset 0 -1px 0 var(--ln2)' : undefined,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {desc != null && <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.5 }}>{desc}</div>}
      </div>
      <Toggle on={on} disabled={disabled} />
    </div>
  );
}

export interface Option<K extends string | number> {
  key: K;
  label: ReactNode;
  title?: string;
  /** Shown dimmed and not selectable (the title can say why). */
  disabled?: boolean;
}

/** Segmented control: p2 track, selected item on p. */
export function Segmented<K extends string | number>({
  options,
  value,
  onChange,
  itemStyle,
  style,
  trackBg = 'var(--p2)',
  activeBg = 'var(--p)',
}: {
  options: Option<K>[];
  value: K;
  onChange: (k: K) => void;
  itemStyle?: CSSProperties;
  style?: CSSProperties;
  trackBg?: string;
  activeBg?: string;
}) {
  return (
    <div style={{ display: 'flex', background: trackBg, padding: 3, ...style }}>
      {options.map((o) => (
        <div
          key={String(o.key)}
          title={o.title}
          onClick={o.disabled ? undefined : () => onChange(o.key)}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            cursor: o.disabled ? 'not-allowed' : 'pointer',
            opacity: o.disabled ? 0.45 : undefined,
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: value === o.key ? activeBg : 'transparent',
            color: value === o.key ? 'var(--tx)' : 'var(--dm)',
            ...itemStyle,
          }}
        >
          {o.label}
        </div>
      ))}
    </div>
  );
}

/** Outlined chip: accent ring when active. */
export function Chip({
  active,
  onClick,
  children,
  style,
  title,
}: {
  active: boolean;
  onClick?: () => void;
  children: ReactNode;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <div
      title={title}
      onClick={onClick}
      style={{
        padding: '6px 10px',
        fontSize: 12,
        cursor: onClick ? 'pointer' : undefined,
        whiteSpace: 'nowrap',
        boxShadow: `inset 0 0 0 1px ${active ? 'var(--ac)' : 'var(--ln)'}`,
        color: active ? 'var(--tx)' : 'var(--mu)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Underlined tabs (top nav, view tabs, panel tabs). Rendered as a fragment of items. */
export function TabItems<K extends string>({
  tabs,
  value,
  onChange,
  itemStyle,
}: {
  tabs: Array<{ key: K; label: ReactNode; count?: ReactNode }>;
  value: K;
  onChange: (k: K) => void;
  itemStyle?: CSSProperties;
}) {
  return (
    <>
      {tabs.map((t) => (
        <div
          key={t.key}
          onClick={() => onChange(t.key)}
          className="no-drag"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            color: value === t.key ? 'var(--tx)' : 'var(--dm)',
            boxShadow: value === t.key ? 'inset 0 -2px 0 var(--ac)' : 'none',
            ...itemStyle,
          }}
        >
          <div>{t.label}</div>
          {t.count != null && t.count !== '' && <div style={{ font: '11px/1 var(--num)', color: 'var(--dm)' }}>{t.count}</div>}
        </div>
      ))}
    </>
  );
}

/** Text input styled as in the design: inset ring, no border. */
export function TextInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
  placeholder,
  autoFocus,
  align = 'left',
  mono,
  height = 34,
  accent,
  style,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  height?: number;
  /** Accent ring (focused editors in the design). */
  accent?: boolean;
  style?: CSSProperties;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={inputRef}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      style={{
        height,
        padding: '0 10px',
        border: 'none',
        boxShadow: `inset 0 0 0 1px ${accent ? 'var(--ac)' : 'var(--ln)'}`,
        background: accent ? 'var(--bg)' : 'var(--p)',
        color: 'var(--tx)',
        font: mono ? '500 13px/1 var(--num)' : '13px/1 var(--sans)',
        textAlign: align,
        width: '100%',
        ...style,
      }}
    />
  );
}

/** Square icon button used in headers (28/34 px). */
export function IconButton({
  onClick,
  title,
  children,
  size = 28,
  active,
  style,
}: {
  onClick?: (e: MouseEvent) => void;
  title?: string;
  children: ReactNode;
  size?: number;
  active?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      onClick={onClick}
      title={title}
      className="hover-tx hover-p2 no-drag"
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        color: active ? 'var(--ac)' : 'var(--dm)',
        background: active ? 'var(--sel)' : 'transparent',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 24px glyph button inside a row (✎ / × of watchlist group headers and the list menu). Clicks do
 * not reach the row. A disabled one stays focusable so its title can say why.
 */
export function GlyphButton({
  title,
  fontSize,
  danger,
  disabled,
  onClick,
  children,
}: {
  title: string;
  fontSize: number;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      className={disabled ? undefined : danger ? 'hover-r' : 'hover-tx'}
      style={{
        width: 24,
        height: 24,
        flexShrink: 0,
        padding: 0,
        border: 'none',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize,
        lineHeight: 1,
        color: 'var(--dm)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/** Primary / secondary buttons used in dialogs and forms. */
export function Button({
  children,
  onClick,
  kind = 'primary',
  bg,
  height = 44,
  disabled,
  autoFocus,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary';
  /** Background override for primary buttons (e.g. var(--up) / var(--dn) / var(--r)). */
  bg?: string;
  height?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  style?: CSSProperties;
}) {
  const primary = kind === 'primary';
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      style={{
        height,
        padding: '0 20px',
        border: 'none',
        background: primary ? (bg ?? 'var(--ac)') : 'var(--p2)',
        color: primary ? (bg ? 'var(--btnTx)' : 'var(--acI)') : 'var(--tx)',
        boxShadow: primary ? undefined : 'inset 0 0 0 1px var(--ln)',
        font: `${primary ? 600 : 500} 14px/1 var(--sans)`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Modal overlay with the 400px panel used by every dialog in the design. */
export function Modal({
  onClose,
  children,
  width = 400,
  zIndex = 20,
}: {
  onClose?: () => void;
  children: ReactNode;
  width?: number;
  zIndex?: number;
}) {
  return (
    <div
      onClick={onClose}
      className="no-drag"
      style={{ position: 'absolute', inset: 0, zIndex, background: 'var(--ov)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          background: 'var(--p)',
          boxShadow: '0 0 0 1px var(--ln), 0 20px 60px rgba(0,0,0,.25)',
          padding: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          animation: 'tape-fade-in .12s ease-out',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Key/value rows inside dialogs. */
export function KeyValueRows({ rows }: { rows: Array<{ label: ReactNode; value: ReactNode; color?: string }> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{ minHeight: 36, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)', fontSize: 13 }}
        >
          <div style={{ color: 'var(--mu)' }}>{r.label}</div>
          <div className="num selectable" style={{ color: r.color ?? 'var(--tx)', textAlign: 'right' }}>
            {r.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Popover menu container (absolute; the caller positions it). */
export function Popover({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        position: 'absolute',
        zIndex: 7,
        background: 'var(--p)',
        boxShadow: '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.2)',
        padding: '6px 0',
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  danger,
  disabled,
  title,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      title={title}
      className={disabled ? undefined : 'hover-p2'}
      style={{
        height: 32,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        cursor: disabled ? 'default' : 'pointer',
        color: danger ? 'var(--r)' : disabled ? 'var(--dm)' : 'var(--tx)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function MenuDivider() {
  return <div style={{ height: 1, background: 'var(--ln2)', margin: '6px 0' }} />;
}

/** Empty / placeholder text block. */
export function Empty({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ padding: '10px 24px', fontSize: 13, color: 'var(--dm)', ...style }}>{children}</div>;
}
