// The Positions tab's column editor: a "Columns" button on the toolbar line opens a popover with a
// search box, the shown columns in order (drag, ↑ / ↓ or Alt+↑ / Alt+↓ to reorder, × to hide;
// Symbol stays first) and every column by group with a check to show or hide it. Calculated
// columns carry a "Calc." chip; a column's note names the instruments it applies to ("No holdings of
// this type" when none is held), whether it asks IB for extra market data while shown and whether
// its values are not verified yet. It is not modal: the table updates behind it, and a header dragged
// in the table moves the same list. "Reset to default" also gives every column its default width and
// groups by underlying again, every group expanded. A press outside, Escape, leaving the page and
// locking Tape close it (state/lockActions.ts).

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { useStore } from '../../state/store';
import { GripIcon, SlidersIcon } from '../../ui/icons';
import { GlyphButton, Popover, TextInput } from '../../ui/primitives';
import type { PositionRow } from './calc';
import { COLUMN_GROUPS, COLUMN_IDS, COLUMNS, PINNED, applies, type ColumnDef, type ColumnId } from './columns';
import { usePositionColumns, useShownColumns } from './columnStore';
import { columnTip, usePortfolioMessages, type PortfolioMessages } from './messages';

const EDITOR_W = 380;
/** Keeps the popover this far inside the window's bottom edge (px). */
const MENU_MARGIN = 16;

/** Text button of the Positions toolbar (h30, 12px). */
const buttonBase: CSSProperties = {
  height: 30,
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  border: 'none',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const sectionLabel: CSSProperties = { padding: '10px 12px 6px', fontSize: 11, color: 'var(--dm)' };
const rowBase: CSSProperties = { height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 12px', flexShrink: 0 };

/** Whether a column's English or Chinese header or full name contains the query. */
function matches(id: ColumnId, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [usePortfolioMessages.for('en'), usePortfolioMessages.for('zh')].some((m) => m.columns[id].some((s) => s.toLowerCase().includes(q)));
}

/**
 * A column's note: its instrument types, "Extra market data" and "Unverified" (" · " between them).
 * Extra data: a column with a profile (generic ticks on the positions' lines) or one of the earnings
 * columns (Wall Street Horizon requests, else the market scanner, for every stock held).
 */
function columnNote(def: ColumnDef, m: PortfolioMessages): string {
  const extra = !!def.profile || def.needs === 'earnings';
  return [def.note ? m.notes[def.note] : '', extra ? m.extraData : '', def.unverified ? m.unverifiedLabel : ''].filter(Boolean).join(' · ');
}

function CalcChip({ id, m }: { id: ColumnId; m: PortfolioMessages }) {
  if (COLUMNS[id].kind !== 'calc') return null;
  return (
    <span
      title={`${m.calculatedBy} ${m.formulas[id] ?? ''}`}
      style={{ flexShrink: 0, padding: '2px 5px', font: '10px/1 var(--sans)', color: 'var(--mu)', boxShadow: 'inset 0 0 0 1px var(--ln)' }}
    >
      {m.calcChip}
    </span>
  );
}

/** The Positions toolbar's Columns button and its popover. */
export function PositionsControls({ rows }: { rows: readonly PositionRow[] }) {
  const m = usePortfolioMessages();
  const open = usePositionColumns((s) => s.editorOpen);
  const setOpen = usePositionColumns((s) => s.setEditorOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState(600);

  // A press outside the button and its popover closes it (on lock too: closeTransientUi presses
  // the body), and so does Escape unless a confirmation is showing or it dismisses an input
  // method's candidates in the search box (pinyin).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && useStore.getState().confirm == null) setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  // Leaving the page (a shortcut, the command palette) closes it, so it never reopens by itself on
  // the way back with a height measured for another window size.
  useEffect(() => () => setOpen(false), [setOpen]);

  const toggle = () => {
    if (open) return setOpen(false);
    const r = rootRef.current?.getBoundingClientRect();
    if (r) setMaxH(Math.max(240, Math.min(600, window.innerHeight * 0.7, window.innerHeight - r.bottom - 4 - MENU_MARGIN)));
    setOpen(true);
  };

  return (
    <div ref={rootRef} className="no-drag" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className="hover-p2"
        style={{ ...buttonBase, background: open ? 'var(--p2)' : 'transparent', color: 'var(--tx)', boxShadow: 'inset 0 0 0 1px var(--ln)' }}
      >
        <SlidersIcon size={14} />
        {m.columnsButton}
      </button>
      {open && <ColumnEditor rows={rows} maxH={maxH} onDone={() => setOpen(false)} />}
    </div>
  );
}

function ColumnEditor({ rows, maxH, onDone }: { rows: readonly PositionRow[]; maxH: number; onDone: () => void }) {
  const m = usePortfolioMessages();
  const shown = useShownColumns();
  const { toggle, reset } = usePositionColumns.getState();
  const [query, setQuery] = useState('');
  const q = query.trim();
  const visible = shown.filter((id) => matches(id, q));
  // Columns of instrument types not held (no row it applies to), for the "No holdings" note.
  const unheld = useMemo(() => new Set(rows.length ? COLUMN_IDS.filter((id) => !rows.some((r) => applies(COLUMNS[id], r))) : []), [rows]);

  return (
    <Popover
      style={{
        top: 'calc(100% + 4px)',
        right: 0,
        width: EDITOR_W,
        maxHeight: maxH,
        padding: 0,
        overflow: 'hidden',
        animation: 'tape-fade-in .12s ease-out',
      }}
    >
      <div role="dialog" aria-label={m.columnsButton} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: maxH }}>
        <div style={{ padding: 12, flexShrink: 0, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
          <TextInput value={query} onChange={setQuery} placeholder={m.searchColumns} autoFocus height={30} />
        </div>
        {/* Block layout keeps every row at its fixed height when the list scrolls. */}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingBottom: 6 }}>
          <div style={sectionLabel}>{m.shownColumns(shown.length)}</div>
          <ShownList ids={visible} all={shown} />
          <div style={{ ...sectionLabel, paddingTop: 14 }}>{m.allColumns}</div>
          {COLUMN_GROUPS.map((group) => {
            const ids = COLUMN_IDS.filter((id) => COLUMNS[id].group === group && matches(id, q));
            if (!ids.length) return null;
            return (
              <Fragment key={group}>
                <div style={{ ...sectionLabel, padding: '8px 12px 4px', color: 'var(--mu)' }}>{m.groups[group]}</div>
                {ids.map((id) => {
                  const on = shown.includes(id);
                  const def = COLUMNS[id];
                  const note = unheld.has(id) ? m.noHoldings : columnNote(def, m);
                  return (
                    <div
                      key={id}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      aria-disabled={id === PINNED || undefined}
                      tabIndex={0}
                      title={note ? `${columnTip(m, id)}\n${note}` : columnTip(m, id)}
                      onClick={() => toggle(id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle(id);
                        }
                      }}
                      className={id === PINNED ? undefined : 'hover-p2'}
                      style={{ ...rowBase, cursor: id === PINNED ? 'default' : 'pointer', color: 'var(--tx)' }}
                    >
                      <div style={{ width: 14, flexShrink: 0, color: 'var(--ac)', fontSize: 12 }}>{on ? '✓' : ''}</div>
                      <div className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: on ? 600 : 400 }}>
                        {m.columns[id][0]}
                      </div>
                      <CalcChip id={id} m={m} />
                      {note && (
                        // Shrinks before the column's name does (the full note is in the row's tooltip).
                        <div className="ellipsis" style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '58%', fontSize: 11, color: 'var(--dm)', paddingRight: 4 }}>
                          {note}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            );
          })}
          {!COLUMN_IDS.some((id) => matches(id, q)) && <div style={{ ...rowBase, color: 'var(--dm)' }}>{m.noMatch}</div>}
        </div>
        <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: 'inset 0 1px 0 var(--ln2)', flexShrink: 0 }}>
          <button type="button" onClick={reset} className="hover-tx" style={{ ...buttonBase, padding: 0, background: 'transparent', color: 'var(--mu)' }}>
            {m.resetDefault}
          </button>
          <button type="button" onClick={onDone} style={{ ...buttonBase, background: 'var(--tx)', color: 'var(--p)' }}>
            {m.done}
          </button>
        </div>
      </div>
    </Popover>
  );
}

/** Where a dragged column lands: before or after the row under the pointer. */
interface Drop {
  id: ColumnId;
  side: 'before' | 'after';
}

/** The shown columns in order (`ids`: those matching the search; `all`: every shown one). */
function ShownList({ ids, all }: { ids: readonly ColumnId[]; all: readonly ColumnId[] }) {
  const m = usePortfolioMessages();
  const { remove, move, moveBy } = usePositionColumns.getState();
  const [drag, setDrag] = useState<ColumnId | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const rowRefs = useRef(new Map<ColumnId, HTMLDivElement>());
  const end = () => {
    setDrag(null);
    setDrop(null);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, id: ColumnId) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    // Nothing goes before Symbol.
    const side = id === PINNED || e.clientY > r.top + r.height / 2 ? 'after' : 'before';
    setDrop((d) => (d?.id === id && d.side === side ? d : { id, side }));
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (drag && drop && drag !== drop.id) {
      const rest = all.filter((c) => c !== drag);
      const at = rest.indexOf(drop.id);
      move(drag, drop.side === 'before' ? at : at + 1);
    }
    end();
  };

  return (
    <>
      {ids.map((id) => {
        const pinned = id === PINNED;
        const i = all.indexOf(id);
        const mark = drop?.id === id && drag !== id ? drop.side : null;
        return (
          <div
            key={id}
            ref={(el) => {
              if (el) rowRefs.current.set(id, el);
              else rowRefs.current.delete(id);
            }}
            tabIndex={0}
            draggable={!pinned}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', id);
              setDrag(id);
            }}
            onDragEnd={end}
            onDragOver={(e) => onDragOver(e, id)}
            onDrop={onDrop}
            onKeyDown={(e: KeyboardEvent) => {
              if (pinned || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
              e.preventDefault();
              moveBy(id, e.key === 'ArrowUp' ? -1 : 1);
              // The moved row's element is put in its new place, which takes the focus away from it.
              requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
            }}
            title={pinned ? undefined : m.dragToReorder}
            className="hover-p2"
            style={{ ...rowBase, position: 'relative', opacity: drag === id ? 0.45 : 1, cursor: pinned ? 'default' : 'grab', color: 'var(--tx)' }}
          >
            <div style={{ width: 14, flexShrink: 0, color: 'var(--dm)' }}>{!pinned && <GripIcon size={14} />}</div>
            <div className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
              {m.columns[id][0]}
            </div>
            <CalcChip id={id} m={m} />
            {pinned ? (
              <div style={{ flexShrink: 0, fontSize: 11, color: 'var(--dm)', paddingRight: 4 }}>{m.alwaysShown}</div>
            ) : (
              <div style={{ display: 'flex', flexShrink: 0 }}>
                <GlyphButton title={m.moveUp} fontSize={12} disabled={i <= 1} onClick={() => moveBy(id, -1)}>
                  ↑
                </GlyphButton>
                <GlyphButton title={m.moveDown} fontSize={12} disabled={i >= all.length - 1} onClick={() => moveBy(id, 1)}>
                  ↓
                </GlyphButton>
                <GlyphButton title={m.hideColumn} fontSize={14} danger onClick={() => remove(id)}>
                  ×
                </GlyphButton>
              </div>
            )}
            {mark && <div style={{ position: 'absolute', left: 0, right: 0, [mark === 'before' ? 'top' : 'bottom']: 0, height: 2, background: 'var(--ac)', pointerEvents: 'none' }} />}
          </div>
        );
      })}
    </>
  );
}
