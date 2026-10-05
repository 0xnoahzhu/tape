// The layer of the floating panels over the content area (App mounts it under the top bar): the
// order ticket where the docked ticket would be (Trade › Chart, Depth), the strategy builder in
// Trade › Options. The layer passes clicks through; z-index 1 puts it above the page content and
// below menus (4+), the top bar's dropdowns, dialogs, toasts and the lock screen.

import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { panelShown } from './actions';
import { FloatingPanel } from './FloatingPanel';
import type { Size } from './model';
import { isCollapsed, isFloating, usePanels } from './panelStore';
import { useBarKeys, usePanelEscape } from './shortcuts';
import { StrategyBar, StrategyFloatContent } from './StrategyFloat';
import { TicketBar, TicketFloatContent } from './TicketFloat';

function useArea(ref: React.RefObject<HTMLElement | null>): Size | null {
  const [area, setArea] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setArea((a) => (a && a.width === el.clientWidth && a.height === el.clientHeight ? a : { width: el.clientWidth, height: el.clientHeight }));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref]);
  return area;
}

export function FloatingPanels() {
  const ref = useRef<HTMLDivElement>(null);
  const area = useArea(ref);
  const ticketFloating = usePanels(isFloating('ticket'));
  const strategyFloating = usePanels(isFloating('strategy'));
  const ticket = useStore((s) => panelShown('ticket', s)) && ticketFloating;
  const strategy = useStore((s) => panelShown('strategy', s)) && strategyFloating;
  const ticketCollapsed = usePanels(isCollapsed('ticket'));
  useBarKeys(ticket && ticketCollapsed);
  usePanelEscape(ticket || strategy);
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', overflow: 'hidden' }}>
      {area && ticket && <FloatingPanel id="ticket" area={area} content={(width) => <TicketFloatContent width={width} />} bar={() => <TicketBar />} />}
      {area && strategy && <FloatingPanel id="strategy" area={area} content={(width) => <StrategyFloatContent width={width} />} bar={() => <StrategyBar />} />}
    </div>
  );
}
