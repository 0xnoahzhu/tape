// Shared pieces of the dashboard widgets (design v6): the card with its title / subtitle header,
// the big figure with its label, and the empty-state line.

import type { CSSProperties, ReactNode } from 'react';
import { DASH, f2 } from '@shared/format';

/** "94.3%" with one decimal and a true minus; "—" when unknown. */
export function pct1(v: number | undefined): string {
  return v != null && Number.isFinite(v) ? `${f2(v, 1)}%` : DASH;
}

/** Card of the new widgets: padding 22 28 20, column, gap 14; title (600) and a 12px subtitle on one baseline. */
export function WidgetCard({ title, sub, aside, children }: { title: string; sub?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: 'var(--p)', padding: '22px 28px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 }}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{title}</div>
        {sub != null && sub !== '' && (
          <div className="ellipsis" style={{ fontSize: 12, color: 'var(--dm)', minWidth: 0 }}>
            {sub}
          </div>
        )}
        {aside && (
          <>
            <div style={{ flex: 1 }} />
            {aside}
          </>
        )}
      </div>
      {children}
    </div>
  );
}

/** The big figure (500 28px) with its 12px label. */
export function BigFigure({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
      <div className="selectable" style={{ font: '500 28px/1 var(--num)', color, whiteSpace: 'nowrap' }}>
        {value}
      </div>
      <div className="ellipsis" style={{ fontSize: 12, color: 'var(--mu)', minWidth: 0 }}>
        {label}
      </div>
    </div>
  );
}

/** Placeholder line of a list without rows (design: "No option positions"). */
export function EmptyLine({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 13, color: 'var(--dm)', padding: '12px 0', lineHeight: 1.5, ...style }}>{children}</div>;
}

/** List container with tabular figures. */
export function List({ children, gap }: { children: ReactNode; gap?: number }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, fontVariantNumeric: 'tabular-nums' }}>{children}</div>;
}

/** Small note under a list (11px, --dm). */
export function Note({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11, color: 'var(--dm)', lineHeight: 1.5 }}>{children}</div>;
}
