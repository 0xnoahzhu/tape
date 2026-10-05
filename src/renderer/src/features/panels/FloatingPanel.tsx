// A panel floating inside the main window: non-modal, above the page content (below menus,
// dialogs, toasts and the lock screen; FloatingPanels sets the layer). Expanded, it is moved by its
// header and resized from every edge and corner; collapsed, it is a slim bar moved by its handle.
// Both remember where they were left (panelStore.ts) and stay inside the content area (model.ts).
//
// Keys (shortcuts.ts → panelKeyAction): Esc in a field leaves the field and the next Esc collapses
// the panel (dialogs and menus take their Esc first); on the bar Enter expands it. A press in the
// panel also gives it Esc while nothing is focused (usePanelEscape).

import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useStore } from '../../state/store';
import { ErrorBoundary, ErrorFallback } from '../../ui/ErrorBoundary';
import { claimPanelKeys, setCollapsed } from './actions';
import { FloatContext, PanelTitleBar, type FloatFrame } from './chrome';
import { barRect, EDGE_CURSOR, EDGES, MIN_SIZE, moveRect, panelRect, resizeRect, type Edge, type PanelId, type Rect, type Size } from './model';
import { usePanels } from './panelStore';
import { panelKeyAction, shortcutKey } from './shortcuts';

/** The panels' elevation: the popovers' ring and shadow. */
export const PANEL_SHADOW = '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.2)';

/** Thickness of the resize handles along the edges, and their size at the corners. */
const EDGE = 6;
const CORNER = 14;

/** Pointer travel (px) below which a press on a handle is a click, not a drag. */
const TAP_SLOP = 3;

/** Elements a press on the header must leave alone (they are not a drag). */
const INTERACTIVE = 'button, input, select, textarea, a[href], [role="button"], [data-no-drag]';

function handleStyle(edge: Edge): CSSProperties {
  const s: CSSProperties = { position: 'absolute', zIndex: 2, cursor: EDGE_CURSOR[edge], touchAction: 'none' };
  const corner = edge.length === 2;
  if (edge.includes('n')) s.top = -EDGE / 2;
  if (edge.includes('s')) s.bottom = -EDGE / 2;
  if (edge.includes('w')) s.left = -EDGE / 2;
  if (edge.includes('e')) s.right = -EDGE / 2;
  if (corner) return { ...s, width: CORNER, height: CORNER, zIndex: 3 };
  return edge === 'n' || edge === 's' ? { ...s, left: CORNER / 2, right: CORNER / 2, height: EDGE } : { ...s, top: CORNER / 2, bottom: CORNER / 2, width: EDGE };
}

type Gesture = 'move' | Edge;

/**
 * Pointer drags of the panel or its bar: the box follows the pointer (kept in the area) and is
 * remembered when the pointer is released.
 */
function useGesture(area: Size, min: Size, commit: (rect: Rect) => void) {
  const [live, setLive] = useState<Rect | null>(null);
  /** `onTap`: the pointer was released without moving (a click on the bar's handle expands it). */
  const begin = (e: PointerEvent<HTMLElement>, gesture: Gesture, start: Rect, onTap?: () => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (released before this ran): the drag simply ends at once.
    }
    const sx = e.clientX;
    const sy = e.clientY;
    let last: Rect | null = null;
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      // A few pixels of jitter are still a click.
      if (!last && Math.abs(dx) + Math.abs(dy) < TAP_SLOP) return;
      last = gesture === 'move' ? moveRect(start, dx, dy, area) : resizeRect(start, gesture, dx, dy, min, area);
      setLive(last);
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (last) commit(last);
      else onTap?.();
      setLive(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  return { live, begin };
}

/** The ticket and strategy panels' content gets the panel's width to lay itself out for. */
export function FloatingPanel({ id, area, content, bar }: { id: PanelId; area: Size; content: (width: number) => ReactNode; bar: () => ReactNode }) {
  const prefs = usePanels((s) => s.panels[id]);
  const min = MIN_SIZE[id];
  const collapsed = prefs.collapsed;
  const shown = collapsed ? barRect(prefs.bar, area) : panelRect(prefs.rect, area, min);
  const { live, begin } = useGesture(area, min, (r) => {
    const store = usePanels.getState();
    if (collapsed) store.setBar(id, { x: r.x, y: r.y });
    else store.setRect(id, r);
  });
  const rect = live ?? shown;
  const root = useRef<HTMLDivElement>(null);

  const frame: FloatFrame = {
    id,
    startDrag: (e) => {
      if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
      // The press does not focus anything itself (it is a drag): the panel takes the keys.
      root.current?.focus({ preventScroll: true });
      begin(e, 'move', rect, collapsed ? () => setCollapsed(id, false) : undefined);
    },
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const key = shortcutKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, defaultPrevented: e.defaultPrevented, target: e.target });
    const action = panelKeyAction(key, collapsed, useStore.getState());
    if (!action) return;
    if (action === 'leaveField') {
      // The fields leave themselves on Esc (blurOnKeys): the panel then takes the focus, so the
      // next Esc collapses it.
      if (!e.defaultPrevented) (e.target as HTMLElement).blur();
      root.current?.focus({ preventScroll: true });
    } else setCollapsed(id, action === 'collapse');
    e.preventDefault();
  };

  return (
    <FloatContext value={frame}>
      <div
        ref={root}
        // Focusable, so a click anywhere in the panel gives it the keys (Esc, and the ticket's Enter).
        tabIndex={-1}
        data-panel-root={id}
        data-testid={`floating-${id}`}
        onKeyDown={onKeyDown}
        // Esc with nothing focused then collapses this panel (shortcuts.ts → usePanelEscape).
        onPointerDownCapture={() => claimPanelKeys(id)}
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          pointerEvents: 'auto',
          background: 'var(--p)',
          boxShadow: PANEL_SHADOW,
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
          animation: 'tape-fade-in .12s ease-out',
        }}
      >
        <ErrorBoundary
          name={id}
          // A failure keeps the panel's header: it can still be moved, collapsed and docked back.
          fallback={(error, retry) => (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <PanelTitleBar id={id} collapsed={collapsed}>
                {null}
              </PanelTitleBar>
              <ErrorFallback error={error} onRetry={retry} style={{ flex: 1, minHeight: 0 }} />
            </div>
          )}
        >
          {collapsed ? bar() : content(rect.width)}
        </ErrorBoundary>
        {!collapsed && EDGES.map((edge) => <div key={edge} aria-hidden onPointerDown={(e) => begin(e, edge, rect)} style={handleStyle(edge)} />)}
      </div>
    </FloatContext>
  );
}
