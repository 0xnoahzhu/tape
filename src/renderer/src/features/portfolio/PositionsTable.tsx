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
// moves its column (Symbol stays first; useHeaderDrag), and the strip on a header's right edge sizes
// the column (ResizeHandle; a double-click gives it its default width back). Both follow the pointer
// on the window from press to release (followPointer), not HTML drag and drop or an element's pointer
// capture. The editor shares the order, and both are remembered (columnStore.ts). A sort orders the
// groups (by their sum, their label on Symbol, else by their best row) and the rows within each group
// (groups.ts → orderGroups). Sorting on a value that moves (a price, a P&L) re-sorts at most once a
// second, and not while the pointer is over the rows: a row or group never moves away under a click.
// The values still update in place.

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
  type PointerEvent as ReactPointerEvent,
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
  dragWidth,
  dropMark,
  edgeScroll,
  gridTemplate,
  heldGroups,
  liveWidths,
  sameGroups,
  startsReorder,
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
/** A dragged header scrolls the card sideways within this far (px) of its sides (Symbol's right edge on the left)... */
const EDGE = 32;
/** ...by up to this much a frame (px), at the side itself or past it. */
const EDGE_SPEED = 16;
/** The dragged header's ghost reaches this far (px) past the header on either side. */
const GHOST_PAD = 8;

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
 * Swallows the click the release of a drag would cause (a sort on the header under it, or a row
 * opened). The browser sends it in the same task as the release, so a later click is left alone.
 */
function swallowClick(): void {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/**
 * Follows a pressed pointer on the window until it is released, wherever it goes: neither the
 * pressed element staying under the pointer nor its pointer capture is relied on (a capture that does
 * not hold would leave the gesture behind at the element's edge, and its release unseen). `move` gets
 * each move; `end` gets the release, or null when the gesture is undone: by Escape, the window losing
 * the focus or a context menu opening (the release is still waited for, and its click swallowed: it
 * goes to the window the press was in, and would sort the header under it), or by a pointercancel
 * (no release follows). A release that never comes (it went to another window) is given up at the
 * pointer's next press. The moves' `buttons` are not read: input that reports none while the button
 * is down must not end the gesture. Returns what stops following (unmount).
 */
function followPointer(pointerId: number, move: (e: globalThis.PointerEvent) => void, end: (e: globalThis.PointerEvent | null) => void): () => void {
  let cancelled = false;
  const onMove = (e: globalThis.PointerEvent) => {
    if (e.pointerId === pointerId) move(e);
  };
  const onUp = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    if (cancelled) swallowClick();
    else end(e);
  };
  const onCancel = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    if (!cancelled) end(null);
  };
  // A new press of the pointer while an undone gesture waits for its release: that release was missed.
  const onDown = (e: globalThis.PointerEvent) => {
    if (e.pointerId === pointerId) stop();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // The Escape is the gesture's: it closes nothing else.
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  /** Undoes the gesture now; its release is still waited for (onUp swallows its click). */
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('contextmenu', cancel, true);
    window.removeEventListener('blur', cancel);
    window.addEventListener('pointerdown', onDown, true);
    end(null);
  }
  function stop() {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('contextmenu', cancel, true);
    window.removeEventListener('blur', cancel);
  }
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('contextmenu', cancel, true);
  window.addEventListener('blur', cancel);
  return stop;
}

/** A pressed header: armed until the pointer goes REORDER_SLOP px sideways (columnsState.ts → startsReorder), then dragged. */
interface HeaderPress {
  id: ColumnId;
  /** The pointer at the press and now (viewport px). */
  x0: number;
  x: number;
  y: number;
  /** Where in its header the pointer took it (px from the header's left edge), for the ghost. */
  dx: number;
  dragged: boolean;
}

/** The dragged header: its column and its size, for the ghost. */
interface Dragged {
  id: ColumnId;
  w: number;
  h: number;
}

/**
 * Moving a column by dragging its header with the pointer (not HTML drag and drop, which needs the
 * system's drag session). A press arms it; a move of more than REORDER_SLOP px sideways starts it:
 * the header fades, a ghost of it follows the pointer along the header row, an accent line marks the
 * slot while the pointer is level with the card (columnsState.ts → dropMark), and the card scrolls
 * sideways near its sides (edgeScroll). The release drops the column in that slot and swallows its
 * click, so no header sorts. A press released without that move is a click (a sort); Escape cancels.
 */
function useHeaderDrag(shown: readonly ColumnId[], boxRef: RefObject<HTMLDivElement | null>, tableRef: RefObject<HTMLDivElement | null>, headerRef: RefObject<HTMLDivElement | null>) {
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [drop, setDrop] = useState<DropMark | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const press = useRef<HeaderPress | null>(null);
  /** The slot a release now drops in (what `drop` draws). */
  const mark = useRef<DropMark | null>(null);
  /** Stops following the press (unmount). */
  const stop = useRef<(() => void) | null>(null);
  const frame = useRef(0);
  const cols = useRef(shown);
  useLayoutEffect(() => {
    cols.current = shown;
  });

  /**
   * The ghost under the pointer: its x follows the pointer, its y the header row. It stays within the
   * table: past its right edge it would widen what the card scrolls over (and the side scroll would
   * chase it).
   */
  const place = useCallback(() => {
    const p = press.current;
    const el = ghostRef.current;
    const table = tableRef.current?.getBoundingClientRect();
    const head = headerRef.current?.getBoundingClientRect();
    if (!p || !el || !table || !head) return;
    const x = Math.max(0, Math.min(table.width - el.offsetWidth, p.x - p.dx - GHOST_PAD - table.left));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(head.top - table.top)}px)`;
  }, [tableRef, headerRef]);
  // Placed before it is first painted.
  useLayoutEffect(() => {
    if (dragging) place();
  }, [dragging, place]);

  // The pointer keeps the grabbing hand wherever it goes while a header is dragged.
  const active = !!dragging;
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add('pos-reordering');
    return () => root.classList.remove('pos-reordering');
  }, [active]);

  useEffect(() => () => stop.current?.(), []);

  const onPress = useCallback(
    (id: ColumnId, e: ReactPointerEvent<HTMLElement>) => {
      // Not prevented: the press's mousedown still closes the column editor and other popovers.
      if (e.button !== 0 || stop.current) return;
      const el = e.currentTarget;
      const cell = (el.parentElement ?? el).getBoundingClientRect();
      const p: HeaderPress = { id, x0: e.clientX, x: e.clientX, y: e.clientY, dx: e.clientX - cell.left, dragged: false };
      /** The slot under the pointer (none while it is above or below the card), and the ghost. */
      const follow = () => {
        const box = boxRef.current?.getBoundingClientRect();
        const table = tableRef.current?.getBoundingClientRect();
        let next: DropMark | null = null;
        if (box && table && p.y >= box.top && p.y <= box.bottom) {
          const cells = Array.from(headerRef.current?.children ?? [], (c) => c.getBoundingClientRect());
          const at = dropMark(cells, p.x, cols.current, id, GAP);
          if (at) next = { slot: at.slot, x: Math.round(at.x - table.left) };
        }
        const cur = mark.current;
        if (cur?.slot !== next?.slot || cur?.x !== next?.x) {
          mark.current = next;
          setDrop(next);
        }
        place();
      };
      /** Each frame of the drag: near a side of the card, scroll it (and follow the columns that moved). */
      const scroll = () => {
        frame.current = requestAnimationFrame(scroll);
        const box = boxRef.current;
        const symbol = headerRef.current?.firstElementChild;
        if (!box || !symbol || box.scrollWidth <= box.clientWidth) return;
        const r = box.getBoundingClientRect();
        if (p.y < r.top || p.y > r.bottom) return;
        const step = edgeScroll(p.x, p.x0, symbol.getBoundingClientRect().right, r.left + box.clientLeft + box.clientWidth, EDGE, EDGE_SPEED);
        if (!step) return;
        const before = box.scrollLeft;
        box.scrollLeft = before + step;
        if (box.scrollLeft !== before) follow();
      };
      const done = () => {
        cancelAnimationFrame(frame.current);
        stop.current = null;
        press.current = null;
        mark.current = null;
        setDrop(null);
        setDragging(null);
      };
      const unfollow = followPointer(
        e.pointerId,
        (ev) => {
          p.x = ev.clientX;
          p.y = ev.clientY;
          if (!p.dragged) {
            if (!startsReorder(p.x0, p.x)) return;
            p.dragged = true;
            try {
              el.setPointerCapture(ev.pointerId);
            } catch {
              // Not held: the window follows the pointer all the same.
            }
            setDragging({ id, w: cell.width, h: cell.height });
            frame.current = requestAnimationFrame(scroll);
          }
          follow();
        },
        (ev) => {
          if (ev && p.dragged) {
            p.x = ev.clientX;
            p.y = ev.clientY;
            follow();
            if (mark.current) usePositionColumns.getState().moveToSlot(id, mark.current.slot);
            swallowClick();
          }
          done();
        },
      );
      press.current = p;
      stop.current = () => {
        unfollow();
        done();
      };
    },
    [boxRef, tableRef, headerRef, place],
  );

  return { dragging, drop, ghostRef, onPress };
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
  const defs = useMemo(() => shown.map((id) => COLUMNS[id]), [shown]);
  const { quotes, infos, grossBase, earnings } = usePositionColumnData(rows, defs, corporate);
  const [hold, setHold] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [live, setLive] = useState<LiveWidth | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const boxW = useOuterWidth(boxRef);
  const { dragging, drop, ghostRef, onPress } = useHeaderDrag(shown, boxRef, tableRef, headerRef);
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
      data-dragging={dragging?.id}
      onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
      // Its own stacking context: the sticky header and column stay under the page's popovers.
      style={{ background: 'var(--p)', flex: '1 1 0', minHeight: 200, overflow: 'auto', isolation: 'isolate' }}
    >
      <div ref={tableRef} role="table" aria-label={m.tabPos} style={{ minWidth, position: 'relative', '--pos-cols': template } as CSSProperties}>
        <div style={{ height: 8 }} />
        <HeaderRow rowRef={headerRef} defs={defs} sort={sort} scrolled={scrolled} dragging={dragging?.id ?? null} onPress={onPress} onLive={setLive} />
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
        {dragging && (
          // The dragged header, under the pointer along the header row (useHeaderDrag places it).
          <div
            ref={ghostRef}
            aria-hidden
            data-pos="ghost"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              zIndex: 5,
              width: dragging.w + 2 * GHOST_PAD,
              height: dragging.h,
              padding: `0 ${GHOST_PAD}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: COLUMNS[dragging.id].align === 'right' ? 'flex-end' : 'flex-start',
              fontSize: 12,
              color: 'var(--tx)',
              background: 'var(--p2)',
              boxShadow: 'inset 0 0 0 1px var(--ln), 0 2px 8px var(--ov)',
              opacity: 0.95,
              pointerEvents: 'none',
              willChange: 'transform',
            }}
          >
            <span className="ellipsis">{m.columns[dragging.id][0]}</span>
          </div>
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
  /** A press on a header's button (useHeaderDrag: a drag once it moves sideways). */
  onPress: (id: ColumnId, e: ReactPointerEvent<HTMLElement>) => void;
  onLive: (live: LiveWidth | null) => void;
}

// Re-rendered only when the columns, the sort, the side scroll or a header drag change (not with
// every price, nor while a column is sized).
const HeaderRow = memo(function HeaderRow({ rowRef, defs, sort, scrolled, dragging, onPress, onLive }: HeaderProps) {
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
          onPress={onPress}
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
  onPress: (id: ColumnId, e: ReactPointerEvent<HTMLElement>) => void;
  onLive: (live: LiveWidth | null) => void;
}

/** A header: click to sort, drag to move the column (not Symbol), its right edge to size it. */
function HeaderCell({ def, dir, sticky, scrolled, dragged, onPress, onLive }: HeaderCellProps) {
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
        // Symbol stays first: the other headers are dragged to reorder (a drag's release does not
        // reach onClick: useHeaderDrag swallows its click).
        onPointerDown={sticky ? undefined : (e) => onPress(def.id, e)}
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
 * The strip on a header's right edge (in the gap to the next column, a faint rule at rest: global.css
 * → .pos-resize): dragging it sizes the column (live while the pointer is down, stored when it is
 * released; Escape gives back the width it had), a double-click gives the column its default width
 * back (not one whose press sized it). The pointer is followed on the window from the press to the
 * release (followPointer), so the column keeps following it once it leaves the strip. The strip lies
 * outside the header's button, so it never sorts or starts a header drag.
 */
function ResizeHandle({ def, onLive }: { def: ColumnDef; onLive: (live: LiveWidth | null) => void }) {
  const m = usePortfolioMessages();
  const [active, setActive] = useState(false);
  /** Stops sizing (unmount while the pointer is down). */
  const stop = useRef<(() => void) | null>(null);
  /**
   * Whether the last two presses on the strip moved it. A press that sizes the column soon after a
   * click is the second of a double-click to the system, and its release a dblclick: only one whose
   * presses both stayed put resets the width.
   */
  const moves = useRef<[boolean, boolean]>([false, false]);

  // The pointer keeps the resize cursor wherever it goes while the column is sized.
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add('pos-resizing');
    return () => root.classList.remove('pos-resizing');
  }, [active]);

  useEffect(() => () => stop.current?.(), []);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const cell = e.currentTarget.parentElement;
    const row = cell?.parentElement;
    if (e.button !== 0 || !cell || !row || stop.current) return;
    // Not prevented: the press's mousedown still closes the column editor and other popovers.
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not held: the window follows the pointer all the same.
    }
    // The tracks' widths as drawn (the sticky Symbol cell reaches over the row's left padding).
    const track = (el: Element) => el.getBoundingClientRect().width - (el === row.firstElementChild ? PAD : 0);
    const left: Partial<Record<ColumnId, number>> = {};
    for (const el of row.children) {
      if (el === cell) break;
      const id = (el as HTMLElement).dataset.posCol;
      if (isColumnId(id)) left[id] = track(el);
    }
    const x0 = e.clientX;
    const w0 = track(cell);
    let moved = false;
    const done = () => {
      stop.current = null;
      setActive(false);
      onLive(null);
    };
    const unfollow = followPointer(
      e.pointerId,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < SLOP) return;
        moved = true;
        const w = dragWidth(def.id, w0, x0, ev.clientX);
        onLive(w == null ? null : { id: def.id, w, left });
      },
      (ev) => {
        moves.current = [moves.current[1], moved];
        // A press without a move (a click, half of a double-click) leaves the width as it is, as do
        // Escape and a cancel (the stored width is drawn again).
        const w = ev && moved ? dragWidth(def.id, w0, x0, ev.clientX) : null;
        if (w != null) {
          usePositionColumns.getState().setWidth(def.id, w, left);
          swallowClick();
        }
        done();
      },
    );
    stop.current = () => {
      unfollow();
      done();
    };
    setActive(true);
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
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => {
        if (!moves.current.some(Boolean)) usePositionColumns.getState().resetWidth(def.id);
      }}
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
                {/* Name and count on one baseline (14px sans, 11px mono); the caret and the chip stay centred. */}
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <span className="ellipsis" title={label} style={{ minWidth: 0, fontSize: 14, fontWeight: 600 }}>
                    {label}
                  </span>
                  <span style={{ flexShrink: 0, font: '11px/1 var(--num)', color: 'var(--dm)' }}>{count}</span>
                </span>
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
