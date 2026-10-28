// Grid rows shared by the working orders and trades tables (design: 12px header, 48px rows); a
// click on a row opens its instrument's chart (navigation.ts → openRowChart).

import type { MouseEvent, ReactNode } from 'react';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';

/**
 * The header over a scrolling body: only the rows scroll, so the scrollbar runs beside them and
 * never beside the header. Both keep the same room for the scrollbar whether it shows or not (the
 * header's never does), and give it back from their right padding (scrollGutter.ts): the header's
 * columns stay over the rows', and new rows never narrow them.
 */
export function TableBody({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', fontVariantNumeric: 'tabular-nums' }}>
      {/* Its rule runs on over the scrollbar's room, so the scrollbar starts right under it. */}
      <div style={{ flexShrink: 0, overflow: 'hidden', ...stableGutter, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>{header}</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', ...stableGutter }}>{children}</div>
    </div>
  );
}

export function HeaderRow({ columns, children }: { columns: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        gap: 12,
        padding: `12px ${lessGutter(32)} 12px 32px`,
        fontSize: 12,
        color: 'var(--dm)',
        background: 'var(--p)',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * A click that is not meant for the row: on a control inside it (Modify, Cancel, Why?), or the end
 * of selecting text (the contract and order id cells are selectable).
 */
export function clickForControl(e: MouseEvent<HTMLElement>): boolean {
  if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')) return true;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode);
}

/** A table row; with `onOpen` a click on it (not on its controls) opens it (its instrument's chart). */
export function Row({ columns, title, onOpen, children }: { columns: string; title?: string; onOpen?: () => void; children: ReactNode }) {
  return (
    <div
      title={title}
      onClick={onOpen ? (e) => !clickForControl(e) && onOpen() : undefined}
      className={onOpen ? 'hover-p2' : undefined}
      style={{
        cursor: onOpen ? 'pointer' : undefined,
        display: 'grid',
        gridTemplateColumns: columns,
        gap: 12,
        padding: `0 ${lessGutter(32)} 0 32px`,
        height: 48,
        alignItems: 'center',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <div style={{ padding: `32px ${lessGutter(32)} 32px 32px`, textAlign: 'center', fontSize: 13, color: 'var(--dm)' }}>{children}</div>;
}
