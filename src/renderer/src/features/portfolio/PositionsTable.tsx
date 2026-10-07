// Positions tab: the columns chosen in the column editor (ColumnEditor.tsx; by default the
// design's 8), sortable by a header click. Rows open the underlying on the Trade page.
//
// The card is its own scroll container, so its header row stays on top and the Symbol column on
// the left when many columns scroll sideways; while they overflow, its scrollbars are always shown
// (global.css → .pos-scroll), the horizontal one at the card's bottom edge. A header dragged sideways
// moves its column (Symbol stays first), and the strip on a header's right edge sizes the column (a
// double-click gives it its default width back); the editor shares the order, and both are
// remembered (columnStore.ts). Sorting on a value that moves (a price, a P&L) re-sorts at most once
// a second, and not while the pointer is over the rows: a row never moves away under a click. The
// rows' values still update in place.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import type { Clock } from '@shared/timeFormat';
import type { ContractRef } from '@shared/types';
import { useCommon } from '../../i18n/common';
import { useClock, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { useOverflowTip } from '../../ui/OverflowTip';
import { Empty } from '../../ui/primitives';
import { positionTarget, type PositionRow } from './calc';
import { cellColor, cellText, type CellWords } from './cells';
import { COLUMNS, applies, isColumnId, rowId, type CellCtx, type ColumnDef, type ColumnId } from './columns';
import {
  MAX_COLUMN_WIDTH,
  clampWidth,
  dropSlot,
  gridTemplate,
  heldOrder,
  liveWidths,
  sameOrder,
  slotTarget,
  sortBy,
  tracksWidth,
  type ColumnWidths,
  type SortState,
} from './columnsState';
import { usePositionColumns, useShownColumns } from './columnStore';
import { columnTip, sectorLabel, usePortfolioMessages } from './messages';
import { usePositionColumnData } from './usePositionColumnData';

/** A re-sort on changing values waits this long after the previous one. */
const RESORT_MS = 1000;
const GAP = 12;
/** The rows' side padding; the sticky Symbol cell reaches over the left one. */
const PAD = 32;
/** Width of the strip that sizes a column, centred in the gap right of its header. */
const GRIP = 10;
/** A press on that strip that moves less than this (px) is a click, not a resize. */
const SLOP = 2;
/** Data type of a dragged header (not text, so it never drops into a text field). */
const DRAG_TYPE = 'application/x-tape-column';

/**
 * The column being sized and its width while the pointer is down (stored when it is released), with
 * the widths the columns left of it were drawn at when it was pressed (columnsState.ts → liveWidths).
 */
interface LiveWidth {
  id: ColumnId;
  w: number;
  left: ColumnWidths;
}

/** Where a dragged header would land: the slot (columnsState.ts → dropSlot) and that boundary's x in the table. */
interface DropMark {
  slot: number;
  x: number;
}

/** Unix ms of the current minute, so days to expiry and today's hours follow the clock. */
function useMinute(): number {
  const [t, setT] = useState(() => Date.now() - (Date.now() % 60_000));
  useEffect(() => {
    const id = setInterval(() => setT(Date.now() - (Date.now() % 60_000)), 15_000);
    return () => clearInterval(id);
  }, []);
  return t;
}

/**
 * The order rows are drawn in. A new sort or the pointer leaving the rows takes the wanted order
 * at once; while the pointer is over the rows (`hold`), and within RESORT_MS of the last re-sort,
 * the drawn rows keep their places (new rows come last, closed ones go), and a held-back re-sort
 * runs when that second is over.
 */
function useDrawnOrder(wanted: readonly string[], sortSig: string, hold: boolean): readonly string[] {
  const drawn = useRef<readonly string[]>(wanted);
  const sortedAt = useRef(0);
  const prev = useRef({ sortSig, hold });
  const [woken, wake] = useReducer((n: number) => n + 1, 0);

  const resort = prev.current.sortSig !== sortSig || (prev.current.hold && !hold);
  let next: readonly string[] = resort || (!hold && Date.now() - sortedAt.current >= RESORT_MS) ? wanted : heldOrder(drawn.current, wanted);
  if (sameOrder(next, drawn.current)) next = drawn.current;

  useLayoutEffect(() => {
    // Only a re-sort starts the second; a row added or closed meanwhile keeps its deadline.
    if (next !== drawn.current && next === wanted) sortedAt.current = Date.now();
    drawn.current = next;
    prev.current = { sortSig, hold };
  });

  // A held-back re-sort runs when the second is over; a wake-up that came a little early sets
  // another timer (`woken`), so a pending re-sort is never left waiting for the next render.
  const pending = !hold && !sameOrder(next, wanted);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(wake, Math.max(0, sortedAt.current + RESORT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [pending, woken]);
  return next;
}

/** An element's outer width (px), which no scrollbar changes; 0 until it is measured. */
function useOuterWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el, { box: 'border-box' });
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Ties keep IB's contract order (conId), so equal values never swap places. */
function byConId(a: CellCtx, b: CellCtx): number {
  return (a.row.position.contract.conId ?? 0) - (b.row.position.contract.conId ?? 0) || a.row.key.localeCompare(b.row.key);
}

/** The sticky Symbol cell: over the row's left padding, with a rule on its right while the table is scrolled sideways. */
function stickyCell(scrolled: boolean, zIndex: number): CSSProperties {
  return {
    position: 'sticky',
    left: 0,
    zIndex,
    alignSelf: 'stretch',
    marginLeft: -PAD,
    paddingLeft: PAD,
    background: 'var(--p)',
    boxShadow: `inset 0 -1px 0 var(--ln2)${scrolled ? ', inset -1px 0 0 var(--ln2)' : ''}`,
  };
}

export function PositionsTable({ rows }: { rows: PositionRow[] }) {
  const m = usePortfolioMessages();
  const common = useCommon();
  const lang = useLang();
  const clock = useClock();
  const connected = useStore((s) => s.connection.status === 'connected');
  const openSymbol = useStore((s) => s.openSymbol);
  const shown = useShownColumns();
  const sort = usePositionColumns((s) => s.sort);
  const widths = usePositionColumns((s) => s.widths);
  const moveToSlot = usePositionColumns((s) => s.moveToSlot);
  const defs = useMemo(() => shown.map((id) => COLUMNS[id]), [shown]);
  const { quotes, infos, grossBase } = usePositionColumnData(rows, defs);
  const now = useMinute();
  const [hold, setHold] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [live, setLive] = useState<LiveWidth | null>(null);
  const [dragging, setDragging] = useState<ColumnId | null>(null);
  const [drop, setDrop] = useState<DropMark | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const boxW = useOuterWidth(boxRef);
  const words = useMemo<CellWords>(() => ({ ...m.words, kinds: m.kinds }), [m]);

  const ctxs = useMemo(() => {
    const out = new Map<string, CellCtx>();
    for (const row of rows) out.set(rowId(row), { row, q: quotes[contractKey(row.position.contract)], info: infos.get(rowId(row)), grossBase, now });
    return out;
  }, [rows, quotes, infos, grossBase, now]);

  // The default order is the rows' own (largest absolute value first, calc.ts → sortRows).
  const sortDef = sort ? COLUMNS[sort.id] : null;
  const wanted = useMemo(() => {
    const list = [...ctxs.values()];
    if (!sort || !sortDef) return list.map((c) => rowId(c.row));
    const valueOf = (c: CellCtx) => (applies(sortDef, c.row) ? (sortDef.sortValue ?? sortDef.value)(c) : undefined);
    return sortBy(list, valueOf, sortDef.sort, sort.dir, lang, byConId).map((c) => rowId(c.row));
  }, [ctxs, sort, sortDef, lang]);
  const order = useDrawnOrder(wanted, `${sort?.id ?? ''}:${sort?.dir ?? ''}:${lang}`, hold);

  // The tracks go to the rows through the table's --pos-cols, so sizing a column redraws no row.
  const sized = useMemo(() => (live ? liveWidths(widths, live.id, live.w, live.left) : widths), [widths, live]);
  const template = gridTemplate(defs, sized);
  const minOf = (ws: ColumnWidths) => tracksWidth(defs, ws) + GAP * (defs.length - 1) + 2 * PAD;
  // While a column is sized the table stays at least as wide as at the press: narrower, a card
  // scrolled to its right end would scroll back by as much and the edge would leave the pointer. The
  // scroll settles once, on release.
  const minWidth = live ? Math.max(minOf(sized), minOf(widths)) : minOf(widths);
  // Compared with the card's outer width: the classic scrollbars this switches on take room inside it.
  const overflowX = boxW > 0 && minWidth > boxW;
  const open = (c: ContractRef) => {
    const t = positionTarget(c);
    openSymbol(t.contract, t.view);
  };

  const onDrag = useCallback((id: ColumnId | null) => {
    setDragging(id);
    if (!id) setDrop(null);
  }, []);
  // A dragged header can be dropped anywhere over the card: the slot follows the pointer's x.
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cells = Array.from(headerRef.current?.children ?? [], (el) => el.getBoundingClientRect());
    const table = tableRef.current?.getBoundingClientRect();
    if (!cells.length || !table) return;
    // Over the sticky Symbol the pointer counts as at its right edge, so a header never lands among
    // the columns scrolled under it.
    const floor = cells[0].right;
    const slot = dropSlot(cells.map((r) => (r.left + r.right) / 2), e.clientX, floor);
    // No mark where the column already is.
    if (slotTarget(shown, dragging, slot) == null) {
      setDrop(null);
      return;
    }
    const edge = slot < cells.length ? cells[slot].left - GAP / 2 : cells[cells.length - 1].right + GAP / 2;
    // Never drawn over Symbol: a column scrolled partly under it is marked at Symbol's edge.
    const x = Math.round(Math.max(edge, floor + 1) - table.left);
    setDrop((d) => (d?.slot === slot && d.x === x ? d : { slot, x }));
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.preventDefault();
    if (drop) moveToSlot(dragging, drop.slot);
    onDrag(null);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (dragging && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
  };

  return (
    <div
      ref={boxRef}
      className="pos-scroll"
      data-pos="scroll"
      data-overflow-x={overflowX || undefined}
      onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      // Its own stacking context: the sticky header and column stay under the page's popovers.
      style={{ background: 'var(--p)', margin: 'var(--gap) var(--pad) var(--pad)', flex: '1 1 0', minHeight: 240, overflow: 'auto', isolation: 'isolate' }}
    >
      <div ref={tableRef} role="table" aria-label={m.tabPos} style={{ minWidth, position: 'relative', '--pos-cols': template } as CSSProperties}>
        <div style={{ height: 8 }} />
        <HeaderRow rowRef={headerRef} defs={defs} sort={sort} scrolled={scrolled} dragging={dragging} onDrag={onDrag} onLive={setLive} />
        <div role="rowgroup" style={{ fontVariantNumeric: 'tabular-nums' }} onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)}>
          {order.map((id) => {
            const c = ctxs.get(id);
            return c && <RowView key={id} c={c} defs={defs} scrolled={scrolled} words={words} clock={clock} onOpen={open} />;
          })}
        </div>
        {drop && (
          <div
            aria-hidden
            data-pos="drop"
            data-slot={drop.slot}
            style={{ position: 'absolute', top: 8, bottom: 0, left: drop.x - 1, width: 2, zIndex: 4, background: 'var(--ac)', pointerEvents: 'none' }}
          />
        )}
      </div>
      {!rows.length && <Empty style={{ padding: '18px 32px 22px' }}>{connected ? m.noPositions : common.notConnected}</Empty>}
    </div>
  );
}

interface HeaderProps {
  rowRef: RefObject<HTMLDivElement | null>;
  defs: readonly ColumnDef[];
  sort: SortState | null;
  scrolled: boolean;
  /** The column whose header is being dragged. */
  dragging: ColumnId | null;
  onDrag: (id: ColumnId | null) => void;
  onLive: (live: LiveWidth | null) => void;
}

// Re-rendered only when the columns, the sort, the side scroll or a header drag change (not with
// every price, nor while a column is sized).
const HeaderRow = memo(function HeaderRow({ rowRef, defs, sort, scrolled, dragging, onDrag, onLive }: HeaderProps) {
  return (
    <div
      ref={rowRef}
      role="row"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        display: 'grid',
        gridTemplateColumns: 'var(--pos-cols)',
        gap: GAP,
        padding: `0 ${PAD}px`,
        fontSize: 12,
        background: 'var(--p)',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
      }}
    >
      {defs.map((d, i) => (
        <HeaderCell
          key={d.id}
          def={d}
          dir={sort?.id === d.id ? sort.dir : undefined}
          sticky={i === 0}
          scrolled={scrolled}
          dragged={dragging === d.id}
          onDrag={onDrag}
          onLive={onLive}
        />
      ))}
    </div>
  );
});

interface HeaderCellProps {
  def: ColumnDef;
  dir: 'asc' | 'desc' | undefined;
  sticky: boolean;
  scrolled: boolean;
  dragged: boolean;
  onDrag: (id: ColumnId | null) => void;
  onLive: (live: LiveWidth | null) => void;
}

/** A header: click to sort, drag to move the column (not Symbol), its right edge to size it. */
function HeaderCell({ def, dir, sticky, scrolled, dragged, onDrag, onLive }: HeaderCellProps) {
  const m = usePortfolioMessages();
  const cycleSort = usePositionColumns((s) => s.cycleSort);
  const right = def.align === 'right';
  const arrow = dir && <span style={{ fontSize: 9, color: 'var(--tx)', flexShrink: 0 }}>{dir === 'asc' ? '▲' : '▼'}</span>;
  return (
    <div
      role="columnheader"
      data-pos-col={def.id}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
      style={{ position: 'relative', display: 'flex', minWidth: 0, ...(dragged && { opacity: 0.45 }), ...(sticky ? stickyCell(scrolled, 3) : {}) }}
    >
      <button
        type="button"
        title={`${columnTip(m, def.id)}\n${sticky ? m.headerSort : m.headerSortMove}`}
        // Symbol stays first: the other headers are dragged to reorder.
        draggable={!sticky}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(DRAG_TYPE, def.id);
          onDrag(def.id);
        }}
        onDragEnd={() => onDrag(null)}
        onClick={() => cycleSort(def.id)}
        className="hover-tx"
        style={{
          flex: 1,
          minWidth: 0,
          padding: '8px 0',
          border: 'none',
          background: 'transparent',
          font: 'inherit',
          color: dir ? 'var(--tx)' : 'var(--dm)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: right ? 'flex-end' : 'flex-start',
          gap: 4,
          cursor: 'pointer',
        }}
      >
        {right && arrow}
        <span className="ellipsis">{m.columns[def.id][0]}</span>
        {def.kind === 'calc' && (
          <span aria-hidden style={{ color: 'var(--dm)', fontStyle: 'italic', flexShrink: 0 }}>
            ƒ
          </span>
        )}
        {!right && arrow}
      </button>
      <ResizeHandle def={def} onLive={onLive} />
    </div>
  );
}

/**
 * The strip on a header's right edge (in the gap to the next column): dragging it sizes the column
 * (live while the pointer is down, stored when it is released), a double-click gives the column its
 * default width back. It lies outside the header's button, so it never sorts or starts a header drag.
 */
function ResizeHandle({ def, onLive }: { def: ColumnDef; onLive: (live: LiveWidth | null) => void }) {
  const m = usePortfolioMessages();
  /** The press: its x, the column's drawn width, the drawn widths left of it; `live` once it is sized. */
  const drag = useRef<{ x: number; w: number; left: ColumnWidths; moved: boolean; live: boolean } | null>(null);
  const [active, setActive] = useState(false);

  // The pointer keeps the resize cursor wherever it goes while the column is sized.
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add('pos-resizing');
    return () => root.classList.remove('pos-resizing');
  }, [active]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    const cell = e.currentTarget.parentElement;
    const row = cell?.parentElement;
    if (e.button !== 0 || !cell || !row) return;
    // Not prevented: the press's mousedown still closes the column editor and other popovers.
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone: the strip still follows it until it is released.
    }
    // The tracks' widths as drawn (the sticky Symbol cell reaches over the row's left padding).
    const track = (el: Element) => el.getBoundingClientRect().width - (el === row.firstElementChild ? PAD : 0);
    const left: Partial<Record<ColumnId, number>> = {};
    for (const el of row.children) {
      if (el === cell) break;
      const id = (el as HTMLElement).dataset.posCol;
      if (isColumnId(id)) left[id] = track(el);
    }
    drag.current = { x: e.clientX, w: track(cell), left, moved: false, live: false };
    setActive(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || (!d.moved && Math.abs(e.clientX - d.x) < SLOP)) return;
    d.moved = true;
    const w = d.w + e.clientX - d.x;
    // A column drawn wider than the maximum (its share of a very wide card) is sized only once the
    // pointer brings it within it: a nudge never snaps it down to the maximum.
    d.live = d.w <= MAX_COLUMN_WIDTH || w <= MAX_COLUMN_WIDTH;
    onLive(d.live ? { id: def.id, w: clampWidth(def.id, w), left: d.left } : null);
  };
  const end = (e: PointerEvent<HTMLDivElement>, keep: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActive(false);
    // A press without a move (a click, half of a double-click) leaves the width as it is.
    if (keep && d.moved && d.live) usePositionColumns.getState().setWidth(def.id, d.w + e.clientX - d.x, d.left);
    onLive(null);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={m.resizeColumnOf(m.columns[def.id][0])}
      title={m.resizeColumn}
      data-pos-resize={def.id}
      data-active={active || undefined}
      className="pos-resize"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => usePositionColumns.getState().resetWidth(def.id)}
      style={{ position: 'absolute', top: 0, bottom: 0, right: -(GAP + GRIP) / 2, width: GRIP, zIndex: 1, cursor: 'col-resize', touchAction: 'none' }}
    />
  );
}

interface RowProps {
  c: CellCtx;
  defs: readonly ColumnDef[];
  scrolled: boolean;
  words: CellWords;
  clock: Clock;
  onOpen: (c: ContractRef) => void;
}

/** Own fields equal by identity, leaving out `skip`. */
function shallowSame<T extends object>(a: T, b: T, skip: ReadonlyArray<keyof T> = []): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as Array<keyof T>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => skip.includes(k) || a[k] === b[k]);
}

/** Every row is rebuilt when any price changes (usePositionRows); a row whose values did not change is not redrawn. */
function sameRow(a: PositionRow, b: PositionRow): boolean {
  return (
    shallowSame(a, b, ['position']) &&
    shallowSame(a.position, b.position, ['contract', 'updatedAt']) &&
    shallowSame(a.position.contract, b.position.contract)
  );
}

const sameRowProps = (a: RowProps, b: RowProps): boolean =>
  a.defs === b.defs &&
  a.scrolled === b.scrolled &&
  a.words === b.words &&
  a.clock === b.clock &&
  a.c.q === b.c.q &&
  a.c.info === b.c.info &&
  a.c.grossBase === b.c.grossBase &&
  a.c.now === b.c.now &&
  sameRow(a.c.row, b.c.row);

const RowView = memo(function RowView({ c, defs, scrolled, words, clock, onOpen }: RowProps) {
  const p = c.row.position;
  return (
    <div
      role="row"
      onClick={() => onOpen(p.contract)}
      className="hover-p2 pos-row"
      style={{
        display: 'grid',
        gridTemplateColumns: 'var(--pos-cols)',
        gap: GAP,
        padding: `0 ${PAD}px`,
        height: 50,
        alignItems: 'center',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
        cursor: 'pointer',
        fontFamily: 'var(--num)',
        fontSize: 13,
      }}
    >
      {defs.map((d, i) => (i === 0 ? <SymbolCell key={d.id} c={c} scrolled={scrolled} /> : <Cell key={d.id} def={d} c={c} words={words} clock={clock} />))}
    </div>
  );
}, sameRowProps);

/** Symbol and, below it, the instrument type and sector (as since the first design). */
function SymbolCell({ c, scrolled }: { c: CellCtx; scrolled: boolean }) {
  const m = usePortfolioMessages();
  const k = c.row.position.contract;
  return (
    <div role="cell" className="pos-sticky" style={{ ...stickyCell(scrolled, 1), display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, fontFamily: 'var(--sans)', minWidth: 0 }}>
      <div className="ellipsis" style={{ fontSize: 14 }}>
        {contractLabel(k)}
      </div>
      <div className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)' }}>
        {m.kinds[k.secType] ?? k.secType} · {sectorLabel(m, c.row.sector)}
      </div>
    </div>
  );
}

function Cell({ def, c, words, clock }: { def: ColumnDef; c: CellCtx; words: CellWords; clock: Clock }) {
  if (!applies(def, c.row)) return <div role="cell" />;
  const text = cellText(def, c, words, clock);
  const color = cellColor(def, def.value(c));
  const title = def.title?.(c);
  if (def.sub) {
    return (
      <div role="cell" title={title} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', color, whiteSpace: 'nowrap' }}>
        <div>{text}</div>
        <div style={{ fontSize: 11 }}>{cellText({ ...def, fmt: def.sub.fmt, value: def.sub.value }, c, words, clock)}</div>
      </div>
    );
  }
  if (def.align === 'left') return <TextCell text={text} title={title} color={color} />;
  return (
    <div role="cell" title={title} style={{ textAlign: 'right', color, whiteSpace: 'nowrap' }}>
      {text}
    </div>
  );
}

/** A left-aligned (text) cell: cut with an ellipsis, shown in full on hover when cut. */
function TextCell({ text, title, color }: { text: string; title?: string; color?: string }) {
  const { textRef, hoverProps, tip } = useOverflowTip(text);
  return (
    <div {...hoverProps} role="cell" title={title} style={{ minWidth: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center', color }}>
      <div ref={textRef} className="ellipsis" style={{ minWidth: 0 }}>
        {text}
      </div>
      {tip}
    </div>
  );
}
