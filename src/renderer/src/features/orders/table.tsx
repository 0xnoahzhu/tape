// Grid rows shared by the working orders and trades tables (design: 12px header, 48px rows).

import type { ReactNode } from 'react';

/**
 * Scrolling table body. The header is its sticky first row rather than a sibling, so the
 * header and the rows share one width and their columns stay aligned when the scrollbar shows.
 */
export function TableBody({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', fontVariantNumeric: 'tabular-nums' }}>
      {header}
      {children}
    </div>
  );
}

export function HeaderRow({ columns, children }: { columns: string; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1,
        display: 'grid',
        gridTemplateColumns: columns,
        gap: 12,
        padding: '12px 32px',
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

export function Row({ columns, title, children }: { columns: string; title?: string; children: ReactNode }) {
  return (
    <div
      title={title}
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        gap: 12,
        padding: '0 32px',
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
  return <div style={{ padding: '32px', textAlign: 'center', fontSize: 13, color: 'var(--dm)' }}>{children}</div>;
}
