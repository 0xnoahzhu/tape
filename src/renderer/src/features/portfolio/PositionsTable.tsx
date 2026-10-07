// Positions tab: the columns chosen in the column editor (ColumnEditor.tsx; by default the
// design's 8), grouped as the toolbar's Group by says (PositionsToolbar.tsx) and sortable by a
// header click. Rows open the underlying on the Trade page.
//
// Grouped by underlying (the default) or by sector, a group of two or more rows gets a group row
// over them: a caret that collapses it (for the session), its name and count, its underlying's next
// corporate event (a chip) and, in each column where a sum means something, the sum of its rows
// (groups.ts → aggregate; % NLV in the accent from 20 %; an amount over rows in more than one currency
// in the account currency, its code after it); its rows are indented under it. A group of
// one row draws only that row, which stands for its group (it carries the chip and the accent), as
// every row does without grouping. An option row's second line reads "Call · 12 DTE · 3.2% ITM" (the
// DTE in the accent within a week); other rows' read their type and sector. Under the rows a quiet
// line says why earnings dates are missing or still coming, while they are.
//
// The card is its own scroll container, so its header row stays on top and the Symbol column on
// the left when many columns scroll sideways; while they overflow, its scrollbars are always shown
// (global.css → .pos-scroll), the horizontal one at the card's bottom edge. A header dragged sideways
// moves its column (Symbol stays first), and the strip on a header's right edge sizes the column (a
// double-click gives it its default width back); the editor shares the order, and both are
// remembered (columnStore.ts). A sort orders the groups (by their sum, their label on Symbol, else
// by their best row) and the rows within each group (groups.ts → orderGroups). Sorting on a value
// that moves (a price, a P&L) re-sorts at most once a second, and not while the pointer is over the
// rows: a row or group never moves away under a click. The values still update in place.

import {
  Fragment,
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
  type ReactNode,
  type RefObject,
} from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import { f2 } from '@shared/format';
import type { Clock } from '@shared/timeFormat';
import type { ContractRef, CorporateEarnings, Quote } from '@shared/types';
import { useCommon } from '../../i18n/common';
import { useClock, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { useOverflowTip } from '../../ui/OverflowTip';
import { Empty } from '../../ui/primitives';
import { positionTarget, underlyingOf, type PositionRow } from './calc';
import { cellColor, cellText, formatValue, type CellWords } from './cells';
import { COLUMNS, applies, isColumnId, rowId, type CellCtx, type ColumnDef, type ColumnId } from './columns';
import {
  MAX_COLUMN_WIDTH,
  clampWidth,
  dropSlot,
  gridTemplate,
  heldGroups,
  liveWidths,
  sameGroups,
  slotTarget,
  tracksWidth,
  type ColumnWidths,
  type OrderGroup,
  type SortState,
} from './columnsState';
import { usePositionColumns, useShownColumns } from './columnStore';
import { dividendAmount, eventLabel, eventSig, type CorporateEvent } from './events';
import { optionLine, sameOptionLine, type OptionLine } from './exposure';
import { aggregate, chipTargets, groupRows, inAccountCurrency, isConcentrated, orderGroups, type RowGroup } from './groups';
import { columnTip, sectorLabel, usePortfolioMessages } from './messages';
import { usePositionColumnData } from './usePositionColumnData';

/** A re-sort on changing values waits this long after the previous one. */
const RESORT_MS = 1000;
const GAP = 12;
/** The rows' side padding; the sticky Symbol cell reaches over the left one. */
const PAD = 32;
/** How far a group's rows are indented under its group row (px, in the Symbol cell). */
const INDENT = 16;
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

/**
 * The order groups and rows are drawn in. A new sort or grouping, or the pointer leaving the rows,
 * takes the wanted order at once; while the pointer is over the rows (`hold`), and within RESORT_MS
 * of the last re-sort, the drawn groups and rows keep their places (new ones come last, closed ones
 * go: columnsState.ts → heldGroups), and a held-back re-sort runs when that second is over.
 */
function useDrawnGroups(wanted: readonly OrderGroup[], sortSig: string, hold: boolean): readonly OrderGroup[] {
  const drawn = useRef<readonly OrderGroup[]>(wanted);
  const sortedAt = useRef(0);
  const prev = useRef({ sortSig, hold });
  const [woken, wake] = useReducer((n: number) => n + 1, 0);

  const resort = prev.current.sortSig !== sortSig || (prev.current.hold && !hold);
  let next: readonly OrderGroup[] = resort || (!hold && Date.now() - sortedAt.current >= RESORT_MS) ? wanted : heldGroups(drawn.current, wanted);
  if (sameGroups(next, drawn.current)) next = drawn.current;

  useLayoutEffect(() => {
    // Only a re-sort starts the second; a row added or closed meanwhile keeps its deadline.
    if (next !== drawn.current && next === wanted) sortedAt.current = Date.now();
    drawn.current = next;
    prev.current = { sortSig, hold };
  });

  // A held-back re-sort runs when the second is over; a wake-up that came a little early sets
  // another timer (`woken`), so a pending re-sort is never left waiting for the next render.
  const pending = !hold && !sameGroups(next, wanted);
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

interface PositionsTableProps {
  rows: PositionRow[];
  /** The option positions' and their underlyings' quotes (data.ts → useUnderlyingQuotes), for the option lines. */
  optionQuotes: Readonly<Record<string, Quote>>;
  /** The holdings' next corporate event by underlying key (events.ts → nextEvents). */
  events: ReadonlyMap<string, CorporateEvent>;
  /** The holdings' earnings (data.ts → useEarnings), for the earnings columns. */
  earnings: CorporateEarnings | undefined;
  /** Why earnings dates are missing or still coming (the line under the rows); undefined when nothing is. */
  note?: string;
  /** Unix ms of the current minute (data.ts → useMinute). */
  now: number;
}

export function PositionsTable({ rows, optionQuotes, events, earnings: corporate, note, now }: PositionsTableProps) {
  const m = usePortfolioMessages();
  const common = useCommon();
  const lang = useLang();
  const clock = useClock();
  const connected = useStore((s) => s.connection.status === 'connected');
  const baseCurrency = useStore((s) => s.account?.currency);
  const openSymbol = useStore((s) => s.openSymbol);
  const shown = useShownColumns();
  const sort = usePositionColumns((s) => s.sort);
  const widths = usePositionColumns((s) => s.widths);
  const groupBy = usePositionColumns((s) => s.groupBy);
  const collapsed = usePositionColumns((s) => s.collapsed);
  const toggleGroup = usePositionColumns((s) => s.toggleGroup);
  const moveToSlot = usePositionColumns((s) => s.moveToSlot);
  const defs = useMemo(() => shown.map((id) => COLUMNS[id]), [shown]);
  const { quotes, infos, grossBase, earnings } = usePositionColumnData(rows, defs, corporate);
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
    for (const row of rows) {
      const k = row.position.contract;
      // An option shows its underlying's earnings.
      const e = earnings.size ? earnings.get(contractKey(underlyingOf(k))) : undefined;
      out.set(rowId(row), { row, q: quotes[contractKey(k)], info: infos.get(rowId(row)), grossBase, earnings: e, now });
    }
    return out;
  }, [rows, quotes, infos, grossBase, earnings, now]);

  // The rows come largest absolute value first (calc.ts → sortRows): the order within a group
  // without a sort.
  const groups = useMemo(() => groupRows([...ctxs.values()], groupBy), [ctxs, groupBy]);
  const byKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);
  const labelOf = useCallback((g: RowGroup) => (g.kind === 'sector' ? sectorLabel(m, g.label) : g.label), [m]);
  const wanted = useMemo(() => orderGroups(groups, sort, lang, labelOf), [groups, sort, lang, labelOf]);
  const order = useDrawnGroups(wanted, `${sort?.id ?? ''}:${sort?.dir ?? ''}:${lang}:${groupBy}`, hold);
  // What the group rows show in each column, and which sums are in the account currency (an amount
  // over rows in more than one currency); only groups of two or more rows draw one.
  const sums = useMemo(() => {
    const out = new Map<string, { values: Array<number | null | undefined>; base: boolean[] }>();
    if (groupBy !== 'none') {
      for (const g of groups) {
        if (g.ctxs.length > 1) out.set(g.key, { values: defs.map((d) => aggregate(d, g.ctxs)), base: defs.map((d) => inAccountCurrency(d, g.ctxs)) });
      }
    }
    return out;
  }, [groups, groupBy, defs]);
  const chips = useMemo(() => chipTargets(groups, groupBy, events), [groups, groupBy, events]);
  const lines = useMemo(() => {
    const out = new Map<string, OptionLine>();
    const at = new Date(now);
    for (const r of rows) {
      const line = optionLine(r, optionQuotes, rows, at);
      if (line) out.set(rowId(r), line);
    }
    return out;
  }, [rows, optionQuotes, now]);

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

  const body: ReactNode[] = [];
  for (const og of order) {
    const g = byKey.get(og.key);
    const sum = sums.get(og.key);
    if (!g) continue;
    const closed = !!sum && !!collapsed[g.key];
    if (sum) {
      body.push(
        <GroupRowView
          key={`g:${g.key}`}
          id={g.key}
          label={labelOf(g)}
          count={g.ctxs.length}
          values={sum.values}
          base={sum.base}
          currency={baseCurrency}
          collapsed={closed}
          chip={chips.groups.get(g.key)}
          defs={defs}
          scrolled={scrolled}
          words={words}
          clock={clock}
          now={now}
          onToggle={toggleGroup}
        />,
      );
    }
    if (closed) continue;
    for (const id of og.ids) {
      const c = ctxs.get(id);
      if (!c) continue;
      body.push(
        <RowView
          key={id}
          c={c}
          defs={defs}
          scrolled={scrolled}
          words={words}
          clock={clock}
          nested={!!sum}
          // A row inside a group leaves the accent to its group row; a row on its own stands for its group.
          flag={!sum && isConcentrated(c.row.weight)}
          chip={chips.rows.get(id)}
          line={lines.get(id)}
          onOpen={open}
        />,
      );
    }
  }

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
      style={{ background: 'var(--p)', flex: '1 1 0', minHeight: 200, overflow: 'auto', isolation: 'isolate' }}
    >
      <div ref={tableRef} role="table" aria-label={m.tabPos} style={{ minWidth, position: 'relative', '--pos-cols': template } as CSSProperties}>
        <div style={{ height: 8 }} />
        <HeaderRow rowRef={headerRef} defs={defs} sort={sort} scrolled={scrolled} dragging={dragging} onDrag={onDrag} onLive={setLive} />
        <div role="rowgroup" style={{ fontVariantNumeric: 'tabular-nums' }} onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)}>
          {body}
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
      {note && (
        // Stays in view while the table is scrolled sideways.
        <div data-pos="events-note" style={{ position: 'sticky', left: 0, padding: '10px 32px 14px', fontSize: 11, color: 'var(--dm)' }}>
          {note}
        </div>
      )}
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

interface GroupRowProps {
  /** The group's key (groups.ts → groupKey). */
  id: string;
  label: string;
  count: number;
  /** Per shown column: the sum (groups.ts → aggregate), undefined when unknown, null for an empty cell. */
  values: ReadonlyArray<number | null | undefined>;
  /** Per shown column: the sum is in the account currency (groups.ts → inAccountCurrency). */
  base: ReadonlyArray<boolean>;
  /** The account currency's code, once known. */
  currency?: string;
  collapsed: boolean;
  chip?: CorporateEvent;
  defs: readonly ColumnDef[];
  scrolled: boolean;
  words: CellWords;
  clock: Clock;
  now: number;
  onToggle: (key: string) => void;
}

/** The group rows are rebuilt with every price; one whose text did not change is not redrawn. */
const sameGroupProps = (a: GroupRowProps, b: GroupRowProps): boolean =>
  a.id === b.id &&
  a.label === b.label &&
  a.count === b.count &&
  a.collapsed === b.collapsed &&
  eventSig(a.chip) === eventSig(b.chip) &&
  a.defs === b.defs &&
  a.scrolled === b.scrolled &&
  a.words === b.words &&
  a.clock === b.clock &&
  a.now === b.now &&
  a.onToggle === b.onToggle &&
  a.currency === b.currency &&
  a.values.length === b.values.length &&
  a.values.every((v, i) => Object.is(v, b.values[i]) && a.base[i] === b.base[i]);

/** A group's row: a click collapses or expands it (it opens no chart). */
const GroupRowView = memo(function GroupRowView({ id, label, count, values, base, currency, collapsed, chip, defs, scrolled, words, clock, now, onToggle }: GroupRowProps) {
  const m = usePortfolioMessages();
  return (
    <div
      role="row"
      aria-expanded={!collapsed}
      data-pos-group={id}
      data-collapsed={collapsed || undefined}
      onClick={() => onToggle(id)}
      className="hover-p2 pos-row"
      style={{
        display: 'grid',
        gridTemplateColumns: 'var(--pos-cols)',
        gap: GAP,
        padding: `0 ${PAD}px`,
        height: 44,
        alignItems: 'center',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
        cursor: 'pointer',
        fontFamily: 'var(--num)',
        fontSize: 13,
      }}
    >
      {defs.map((d, i) => {
        if (i === 0) {
          return (
            <div key={d.id} role="cell" className="pos-sticky" style={{ ...stickyCell(scrolled, 1), display: 'flex', alignItems: 'center', minWidth: 0, fontFamily: 'var(--sans)' }}>
              {/* The keyboard's way to the same toggle: its click reaches the row. */}
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? m.expand : m.collapse} ${label}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  font: 'inherit',
                  color: 'var(--tx)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span aria-hidden style={{ width: 10, flexShrink: 0, fontSize: 8, color: 'var(--dm)' }}>
                  {collapsed ? '▶' : '▼'}
                </span>
                <span className="ellipsis" title={label} style={{ minWidth: 0, fontSize: 14, fontWeight: 600 }}>
                  {label}
                </span>
                <span style={{ flexShrink: 0, font: '11px/1 var(--num)', color: 'var(--dm)' }}>{count}</span>
                {chip && <EventChip e={chip} words={words} clock={clock} now={now} />}
              </button>
            </div>
          );
        }
        const v = values[i];
        if (v === null) return <div key={d.id} role="cell" />;
        const accent = d.id === 'weight' && isConcentrated(v);
        // An amount over rows in more than one currency is in the account currency: its code follows.
        const inBase = base[i];
        const title = accent ? m.concentrated : inBase ? m.inAccountCurrency(currency) : undefined;
        return (
          <div key={d.id} role="cell" title={title} style={{ textAlign: 'right', whiteSpace: 'nowrap', color: accent ? 'var(--ac)' : cellColor(d, v) }}>
            {formatValue(d.fmt, v, words, clock, now)}
            {inBase && currency && v !== undefined && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--dm)' }}>{currency}</span>}
          </div>
        );
      })}
    </div>
  );
}, sameGroupProps);

/**
 * An underlying's next corporate event: "Earnings 10/23 AMC · Est.", "Ex-div 10/15 $0.24". It takes
 * only the room the symbol beside it leaves (no flex basis, growing up to its own width), so short
 * of room it is cut with an ellipsis (in full in its tooltip) and the symbol stays readable. A
 * hairline ring, not a fill: a fill in --p2 would vanish into a hovered row.
 */
function EventChip({ e, words, clock, now }: { e: CorporateEvent; words: CellWords; clock: Clock; now: number }) {
  const m = usePortfolioMessages();
  const text = eventLabel(e, { earnings: m.earnings, exDiv: m.exDiv, estimated: m.estimated, times: words.earningsTimes, atEt: m.atEt }, clock.wall);
  const date = formatValue('date', e.date, words, clock, now);
  const detail =
    e.kind === 'earnings'
      ? [m.earningsOn(date), e.estimated ? m.estimatedHint : undefined].filter(Boolean).join('\n')
      : m.exDivOn(date, e.amount != null ? dividendAmount(e.amount, e.underlying.currency) : undefined);
  return (
    <span
      data-pos-chip={e.kind}
      data-estimated={e.estimated || undefined}
      title={`${text}\n${detail}`}
      className="ellipsis"
      style={{ flex: '1 1 0', maxWidth: 'max-content', padding: '2px 6px', font: '11px/1.3 var(--sans)', boxShadow: 'inset 0 0 0 1px var(--ln)', color: 'var(--mu)' }}
    >
      {text}
    </span>
  );
}

interface RowProps {
  c: CellCtx;
  defs: readonly ColumnDef[];
  scrolled: boolean;
  words: CellWords;
  clock: Clock;
  /** Under a group row: indented. */
  nested: boolean;
  /** % NLV in the accent (a row that stands for its group, at CONCENTRATION_FLAG or more). */
  flag: boolean;
  chip?: CorporateEvent;
  /** The second line of an option row. */
  line?: OptionLine;
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
  a.nested === b.nested &&
  a.flag === b.flag &&
  eventSig(a.chip) === eventSig(b.chip) &&
  sameOptionLine(a.line, b.line) &&
  a.words === b.words &&
  a.clock === b.clock &&
  a.c.q === b.c.q &&
  a.c.info === b.c.info &&
  a.c.grossBase === b.c.grossBase &&
  a.c.earnings === b.c.earnings &&
  a.c.now === b.c.now &&
  sameRow(a.c.row, b.c.row);

const RowView = memo(function RowView({ c, defs, scrolled, words, clock, nested, flag, chip, line, onOpen }: RowProps) {
  const m = usePortfolioMessages();
  const p = c.row.position;
  return (
    <div
      role="row"
      data-pos-row={rowId(c.row)}
      data-nested={nested || undefined}
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
      {defs.map((d, i) =>
        i === 0 ? (
          <SymbolCell key={d.id} c={c} scrolled={scrolled} nested={nested} chip={chip} line={line} words={words} clock={clock} />
        ) : (
          <Cell key={d.id} def={d} c={c} words={words} clock={clock} accent={flag && d.id === 'weight' ? m.concentrated : undefined} />
        ),
      )}
    </div>
  );
}, sameRowProps);

/**
 * Symbol (with its next-event chip) and, below it, the instrument type and sector (as since the
 * first design); an option's right, days to expiry and moneyness instead (exposure.ts → optionLine).
 */
function SymbolCell({
  c,
  scrolled,
  nested,
  chip,
  line,
  words,
  clock,
}: {
  c: CellCtx;
  scrolled: boolean;
  nested: boolean;
  chip?: CorporateEvent;
  line?: OptionLine;
  words: CellWords;
  clock: Clock;
}) {
  const m = usePortfolioMessages();
  const k = c.row.position.contract;
  const kind = m.kinds[k.secType] ?? k.secType;
  let sub: ReactNode = `${kind} · ${sectorLabel(m, c.row.sector)}`;
  if (line) {
    const pct = line.moneyness && `${f2(line.moneyness.pct, 1)}%`;
    const parts: ReactNode[] = [
      (line.right && words.rights[line.right]) ?? kind,
      line.dte !== undefined && <span style={line.soon ? { color: 'var(--ac)' } : undefined}>{m.dte(line.dte)}</span>,
      line.moneyness && pct && (line.moneyness.itm ? m.itm(pct) : m.otm(pct)),
    ].filter(Boolean);
    sub = parts.map((part, i) => (
      <Fragment key={i}>
        {i > 0 && ' · '}
        {part}
      </Fragment>
    ));
  }
  return (
    <div
      role="cell"
      className="pos-sticky"
      style={{
        ...stickyCell(scrolled, 1),
        ...(nested && { paddingLeft: PAD + INDENT }),
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 4,
        fontFamily: 'var(--sans)',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <div className="ellipsis" style={{ minWidth: 0, fontSize: 14 }}>
          {contractLabel(k)}
        </div>
        {chip && <EventChip e={chip} words={words} clock={clock} now={c.now} />}
      </div>
      <div className="ellipsis" data-pos-line={line ? 'option' : undefined} style={{ fontSize: 11, color: 'var(--dm)' }}>
        {sub}
      </div>
    </div>
  );
}

/** `accent`: % NLV highlighted (a lone row at CONCENTRATION_FLAG or more), with this tooltip. */
function Cell({ def, c, words, clock, accent }: { def: ColumnDef; c: CellCtx; words: CellWords; clock: Clock; accent?: string }) {
  if (!applies(def, c.row)) return <div role="cell" />;
  const text = cellText(def, c, words, clock);
  const color = accent ? 'var(--ac)' : cellColor(def, def.value(c));
  const title = accent ?? def.title?.(c, words);
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
