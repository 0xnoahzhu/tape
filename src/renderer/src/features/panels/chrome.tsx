// The panels' own chrome: the docked panel's pop-out button, and on a floating panel its header
// (the drag handle, with the title) and its two controls, collapse and dock back.

import { createContext, useContext, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { HEADER_H, type PanelId } from './model';
import { dockBack, popOut, setCollapsed } from './actions';
import { ChevronIcon, DockIcon, PopOutIcon } from './icons';
import { usePanelMessages } from './messages';

/** What a floating panel gives its content: the panel and the start of a header drag (FloatingPanel). */
export interface FloatFrame {
  id: PanelId;
  startDrag(e: PointerEvent<HTMLElement>): void;
}

export const FloatContext = createContext<FloatFrame | null>(null);

export const useFloatFrame = (): FloatFrame | null => useContext(FloatContext);

export function HeaderButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      data-no-drag
      className="hover-tx"
      style={{
        width: 26,
        height: 26,
        flexShrink: 0,
        padding: 0,
        border: 'none',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dm)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/** The docked panel's pop-out button (top-right of its header). */
export function PopOutButton({ id }: { id: PanelId }) {
  const m = usePanelMessages();
  return (
    <HeaderButton title={m.popOut} onClick={() => popOut(id)}>
      <PopOutIcon />
    </HeaderButton>
  );
}

/** Collapse and dock back: a floating panel's only controls (`collapsed`: expand instead). */
export function PanelControls({ id, collapsed = false }: { id: PanelId; collapsed?: boolean }) {
  const m = usePanelMessages();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
      <HeaderButton title={collapsed ? m.expand : m.collapse} onClick={() => setCollapsed(id, !collapsed)}>
        <ChevronIcon up={collapsed} />
      </HeaderButton>
      <HeaderButton title={m.dockBack} onClick={() => dockBack(id)}>
        <DockIcon />
      </HeaderButton>
    </div>
  );
}

/**
 * A floating panel's header: the drag handle with `children` (title, quote …) and the controls at
 * the right.
 */
export function PanelTitleBar({ id, children, style, collapsed }: { id: PanelId; children: ReactNode; style?: CSSProperties; collapsed?: boolean }) {
  const frame = useFloatFrame();
  return (
    <div
      onPointerDown={frame?.startDrag}
      style={{
        height: HEADER_H,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 8px 0 16px',
        background: 'var(--p)',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
        cursor: 'grab',
        userSelect: 'none',
        ...style,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>{children}</div>
      <PanelControls id={id} collapsed={collapsed} />
    </div>
  );
}
