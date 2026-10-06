// The Dashboard tab (design v6): a 3-column grid of widgets. In edit mode each widget carries a
// toolbar (drag grip, S / M / L span, remove) and can be dragged into the place of another one;
// the "Add widget" tile and the catalog add or remove widgets. The layout is per device
// (layoutStore.ts).

import { useEffect, type DragEvent, type ReactNode } from 'react';
import type { AccountSummary, NavPoint } from '@shared/types';
import { GripIcon } from '../../../ui/icons';
import type { AccountTotals, PositionRow } from '../calc';
import { AllocationCard } from '../AllocationCard';
import { EquityCard } from '../EquityCard';
import { ConcentrationWidget, GreeksWidget, MarginWidget } from './AccountWidgets';
import { BenchWidget, EventsWidget, FillsWidget } from './ActivityWidgets';
import { useOptionQuotes } from './data';
import { CATALOG, SPANS, dropSide, hasWidget, type DropTarget, type LayoutItem, type WidgetId } from './layout';
import { useDashboardLayout, useLayout } from './layoutStore';
import { useDashboardMessages } from './messages';
import { ContribWidget, ExpiryWidget } from './PositionWidgets';

export interface DashboardProps {
  rows: PositionRow[];
  account: AccountSummary | null;
  totals: AccountTotals;
  series: NavPoint[];
  /** Currency symbol of the account ('$' or ''). */
  symbol: string;
}

/** Text button of the edit controls and the catalog (h30, 12px). */
const buttonBase = {
  height: 30,
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  fontSize: 12,
  border: 'none',
  whiteSpace: 'nowrap',
  flexShrink: 0,
} as const;

/** Tab-row controls on the Dashboard tab: Reset and "+ Add widget" while editing, and the Edit layout / Done toggle. */
export function DashboardControls() {
  const m = useDashboardMessages();
  const edit = useDashboardLayout((s) => s.edit);
  const { setEdit, setPickerOpen, reset } = useDashboardLayout.getState();
  return (
    <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {edit && (
        <>
          <button type="button" onClick={reset} className="hover-tx" style={{ ...buttonBase, background: 'transparent', color: 'var(--mu)' }}>
            {m.reset}
          </button>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="hover-p2"
            style={{ ...buttonBase, background: 'transparent', color: 'var(--tx)', boxShadow: 'inset 0 0 0 1px var(--ln)' }}
          >
            + {m.addWidget}
          </button>
        </>
      )}
      <button
        type="button"
        aria-pressed={edit}
        onClick={() => setEdit(!edit)}
        style={{
          ...buttonBase,
          background: edit ? 'var(--tx)' : 'transparent',
          color: edit ? 'var(--p)' : 'var(--tx)',
          boxShadow: `inset 0 0 0 1px ${edit ? 'var(--tx)' : 'var(--ln)'}`,
        }}
      >
        {edit ? m.done : m.editLayout}
      </button>
    </div>
  );
}

function Widget({ id, props, quotes }: { id: WidgetId; props: DashboardProps; quotes: ReturnType<typeof useOptionQuotes> }) {
  const { rows, account, totals, series, symbol } = props;
  switch (id) {
    case 'eq':
      return <EquityCard series={series} symbol={symbol} />;
    case 'alloc':
      return <AllocationCard rows={rows} cash={account?.totalCashValue} netLiq={account?.netLiquidation} symbol={symbol} />;
    case 'margin':
      return <MarginWidget account={account} totals={totals} />;
    case 'greeks':
      return <GreeksWidget rows={rows} quotes={quotes} known={account != null} />;
    case 'conc':
      return <ConcentrationWidget rows={rows} netLiq={account?.netLiquidation} />;
    case 'contrib':
      return <ContribWidget rows={rows} />;
    case 'expiry':
      return <ExpiryWidget rows={rows} quotes={quotes} />;
    case 'fills':
      return <FillsWidget />;
    case 'events':
      return <EventsWidget rows={rows} />;
    case 'bench':
      return <BenchWidget />;
  }
}

/** Edit toolbar in the widget's top-right corner: grip, S / M / L and remove. */
function EditToolbar({ item }: { item: LayoutItem }) {
  const m = useDashboardMessages();
  const { setSpan, remove } = useDashboardLayout.getState();
  const cell = { height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', padding: 0 } as const;
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        background: 'var(--p)',
        boxShadow: '0 0 0 1px var(--ln)',
        padding: 3,
      }}
    >
      <div title={m.dragToReorder} style={{ ...cell, width: 26, color: 'var(--dm)', cursor: 'grab' }}>
        <GripIcon />
      </div>
      {SPANS.map((span, i) => {
        const [label, title] = m.sizes[i];
        const on = item.span === span;
        return (
          <button
            key={span}
            type="button"
            title={title}
            aria-pressed={on}
            onClick={() => setSpan(item.id, span)}
            style={{ ...cell, padding: '0 9px', fontSize: 12, background: on ? 'var(--p2)' : 'transparent', color: on ? 'var(--tx)' : 'var(--dm)' }}
          >
            {label}
          </button>
        );
      })}
      <button
        type="button"
        title={m.remove}
        aria-label={m.remove}
        onClick={() => remove(item.id)}
        className="hover-tx hover-p2"
        style={{ ...cell, width: 26, fontSize: 15, background: 'transparent', color: 'var(--mu)' }}
      >
        ×
      </button>
    </div>
  );
}

/** The insertion mark of a drop: a 4px accent bar on the side of the target the widget lands on. */
function DropMark({ side }: { side: 'before' | 'after' }) {
  return <div style={{ position: 'absolute', top: 0, bottom: 0, [side === 'before' ? 'left' : 'right']: 0, width: 4, background: 'var(--ac)', zIndex: 3, pointerEvents: 'none' }} />;
}

/** Drag handlers of a drop target (a widget or the Add tile); only a widget drag of this dashboard is accepted. */
function useDropTarget(target: DropTarget) {
  const { setOver, move } = useDashboardLayout.getState();
  return {
    onDragOver: (e: DragEvent) => {
      const { edit, drag } = useDashboardLayout.getState();
      if (!edit || !drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(target);
    },
    onDrop: (e: DragEvent) => {
      const { drag } = useDashboardLayout.getState();
      if (!drag) return;
      e.preventDefault();
      move(drag, target);
    },
  };
}

function WidgetFrame({ item, children }: { item: LayoutItem; children: ReactNode }) {
  const layout = useLayout();
  const edit = useDashboardLayout((s) => s.edit);
  const drag = useDashboardLayout((s) => s.drag);
  const over = useDashboardLayout((s) => s.over);
  const { setDrag, endDrag } = useDashboardLayout.getState();
  const drop = useDropTarget(item.id);
  const target = edit && over === item.id && drag !== item.id;
  const side = target ? dropSide(layout, drag, item.id) : null;

  return (
    <div
      draggable={edit}
      onDragStart={(e) => {
        if (!edit) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
        setDrag(item.id);
      }}
      onDragEnd={endDrag}
      {...drop}
      style={{
        gridColumn: `span ${item.span}`,
        position: 'relative',
        display: 'flex',
        minWidth: 0,
        opacity: drag === item.id ? 0.45 : 1,
        outline: edit ? (target ? '2px solid var(--ac)' : '1px dashed var(--ln)') : 'none',
        outlineOffset: -1,
        cursor: edit ? 'grab' : undefined,
      }}
    >
      {/* While editing, the widget is a drag handle: its rows and controls do not take clicks. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', pointerEvents: edit ? 'none' : undefined }}>{children}</div>
      {side && <DropMark side={side} />}
      {edit && <EditToolbar item={item} />}
    </div>
  );
}

/** "+ Add widget" tile after the last widget (editing, or an empty layout); also the drop target for "move to the end". */
function AddTile() {
  const m = useDashboardMessages();
  const layout = useLayout();
  const edit = useDashboardLayout((s) => s.edit);
  const drag = useDashboardLayout((s) => s.drag);
  const over = useDashboardLayout((s) => s.over);
  const drop = useDropTarget('end');
  const target = edit && over === 'end' && dropSide(layout, drag, 'end') != null;
  return (
    <div
      onClick={() => useDashboardLayout.getState().setPickerOpen(true)}
      {...drop}
      className="dash-add"
      style={{
        position: 'relative',
        minHeight: 180,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        cursor: 'pointer',
        color: 'var(--mu)',
        boxShadow: 'inset 0 0 0 1px var(--ln)',
        outline: target ? '2px solid var(--ac)' : 'none',
        outlineOffset: -1,
      }}
    >
      <div style={{ fontSize: 22, lineHeight: 1 }}>+</div>
      <div style={{ fontSize: 13 }}>{m.addWidget}</div>
      {target && <DropMark side="before" />}
    </div>
  );
}

/** The widget catalog: every widget with its description and an Add / Remove button. */
function CatalogModal() {
  const m = useDashboardMessages();
  const layout = useLayout();
  const { setPickerOpen, toggle } = useDashboardLayout.getState();
  const close = () => setPickerOpen(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPickerOpen]);

  return (
    <div
      onClick={close}
      className="no-drag"
      style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'var(--ov)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        role="dialog"
        aria-label={m.addWidget}
        onClick={(e) => e.stopPropagation()}
        // Only the rows scroll: the title and Done stay in view in a short window.
        style={{
          width: 520,
          maxHeight: '80vh',
          overflow: 'hidden',
          background: 'var(--p)',
          boxShadow: '0 0 0 1px var(--ln), 0 20px 60px rgba(0,0,0,.25)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'tape-fade-in .12s ease-out',
        }}
      >
        <div style={{ padding: '22px 24px 14px', display: 'flex', alignItems: 'baseline', gap: 12, flexShrink: 0 }}>
          <div style={{ font: '600 18px/1.2 var(--sans)' }}>{m.addWidget}</div>
          <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.addWidgetHint}</div>
        </div>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
          {CATALOG.map((c) => {
            const on = hasWidget(layout, c.id);
            const text = m.catalog[c.id];
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 24px', boxShadow: 'inset 0 1px 0 var(--ln2)', flexShrink: 0 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 14 }}>{text.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--dm)', lineHeight: 1.5 }}>{text.desc}</div>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(c.id)}
                  className="hover-p2"
                  style={{
                    ...buttonBase,
                    background: 'transparent',
                    color: on ? 'var(--mu)' : 'var(--tx)',
                    boxShadow: `inset 0 0 0 1px ${on ? 'var(--ln2)' : 'var(--ln)'}`,
                  }}
                >
                  {on ? m.remove : m.add}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ padding: '14px 24px 20px', display: 'flex', justifyContent: 'flex-end', boxShadow: 'inset 0 1px 0 var(--ln2)', flexShrink: 0 }}>
          <button
            type="button"
            onClick={close}
            style={{ ...buttonBase, height: 36, padding: '0 18px', fontSize: 13, background: 'var(--tx)', color: 'var(--p)' }}
          >
            {m.done}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Dashboard(props: DashboardProps) {
  const layout = useLayout();
  const edit = useDashboardLayout((s) => s.edit);
  const pickerOpen = useDashboardLayout((s) => s.pickerOpen);
  // Greeks and expirations read the option quotes and their underlyings' (one owner for both).
  const quotes = useOptionQuotes(props.rows, hasWidget(layout, 'greeks') || hasWidget(layout, 'expiry'));

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3,minmax(0,1fr))',
          gap: 'var(--gap)',
          padding: 'var(--pad)',
          marginTop: 'var(--gap)',
          flex: '1 0 auto',
        }}
      >
        {layout.map((item) => (
          <WidgetFrame key={item.id} item={item}>
            <Widget id={item.id} props={props} quotes={quotes} />
          </WidgetFrame>
        ))}
        {(edit || !layout.length) && <AddTile />}
      </div>
      {pickerOpen && <CatalogModal />}
    </>
  );
}
