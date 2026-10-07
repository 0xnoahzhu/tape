// Positions tab: the columns chosen in the column editor (ColumnEditor.tsx; by default the
// design's 8), sortable by a header click. Rows open the underlying on the Trade page.
//
// The card is its own scroll container, so its header row stays on top and the Symbol column on
// the left when many columns scroll sideways. Sorting on a value that moves (a price, a P&L)
// re-sorts at most once a second, and not while the pointer is over the rows: a row never moves
// away under a click. The rows' values still update in place.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
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
import { COLUMNS, applies, rowId, type CellCtx, type ColumnDef } from './columns';
import { heldOrder, sameOrder, sortBy, type SortState } from './columnsState';
import { usePositionColumns, useShownColumns } from './columnStore';
import { columnTip, sectorLabel, usePortfolioMessages } from './messages';
import { usePositionColumnData } from './usePositionColumnData';

/** A re-sort on changing values waits this long after the previous one. */
const RESORT_MS = 1000;
const GAP = 12;
/** The rows' side padding; the sticky Symbol cell reaches over the left one. */
const PAD = 32;

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

/** Grid tracks: Symbol takes twice the spare width of the others; none gets narrower than its minimum. */
function gridTemplate(defs: readonly ColumnDef[]): string {
  return defs.map((d, i) => `minmax(${d.width}px,${i ? 1 : 2}fr)`).join(' ');
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
  const defs = useMemo(() => shown.map((id) => COLUMNS[id]), [shown]);
  const { quotes, infos, grossBase } = usePositionColumnData(rows, defs);
  const now = useMinute();
  const [hold, setHold] = useState(false);
  const [scrolled, setScrolled] = useState(false);
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

  const template = gridTemplate(defs);
  const minWidth = defs.reduce((w, d) => w + d.width, 0) + GAP * (defs.length - 1) + 2 * PAD;
  const open = (c: ContractRef) => {
    const t = positionTarget(c);
    openSymbol(t.contract, t.view);
  };

  return (
    <div
      onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
      // Its own stacking context: the sticky header and column stay under the page's popovers.
      style={{ background: 'var(--p)', margin: 'var(--gap) var(--pad) var(--pad)', flex: '1 1 0', minHeight: 240, overflow: 'auto', isolation: 'isolate' }}
    >
      <div role="table" aria-label={m.tabPos} style={{ minWidth }}>
        <div style={{ height: 8 }} />
        <HeaderRow defs={defs} sort={sort} template={template} scrolled={scrolled} />
        <div role="rowgroup" style={{ fontVariantNumeric: 'tabular-nums' }} onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)}>
          {order.map((id) => {
            const c = ctxs.get(id);
            return c && <RowView key={id} c={c} defs={defs} template={template} scrolled={scrolled} words={words} clock={clock} onOpen={open} />;
          })}
        </div>
      </div>
      {!rows.length && <Empty style={{ padding: '18px 32px 22px' }}>{connected ? m.noPositions : common.notConnected}</Empty>}
    </div>
  );
}

// Re-rendered only when the columns, the sort or the side scroll change (not with every price).
const HeaderRow = memo(function HeaderRow({ defs, sort, template, scrolled }: { defs: readonly ColumnDef[]; sort: SortState | null; template: string; scrolled: boolean }) {
  return (
    <div
      role="row"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        display: 'grid',
        gridTemplateColumns: template,
        gap: GAP,
        padding: `0 ${PAD}px`,
        fontSize: 12,
        background: 'var(--p)',
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
      }}
    >
      {defs.map((d, i) => (
        <HeaderCell key={d.id} def={d} dir={sort?.id === d.id ? sort.dir : undefined} sticky={i === 0} scrolled={scrolled} />
      ))}
    </div>
  );
});

function HeaderCell({ def, dir, sticky, scrolled }: { def: ColumnDef; dir: 'asc' | 'desc' | undefined; sticky: boolean; scrolled: boolean }) {
  const m = usePortfolioMessages();
  const cycleSort = usePositionColumns((s) => s.cycleSort);
  const right = def.align === 'right';
  const arrow = dir && <span style={{ fontSize: 9, color: 'var(--tx)', flexShrink: 0 }}>{dir === 'asc' ? '▲' : '▼'}</span>;
  return (
    <div
      role="columnheader"
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
      style={{ display: 'flex', minWidth: 0, ...(sticky ? stickyCell(scrolled, 3) : {}) }}
    >
      <button
        type="button"
        title={columnTip(m, def.id)}
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
    </div>
  );
}

interface RowProps {
  c: CellCtx;
  defs: readonly ColumnDef[];
  template: string;
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
  a.template === b.template &&
  a.scrolled === b.scrolled &&
  a.words === b.words &&
  a.clock === b.clock &&
  a.c.q === b.c.q &&
  a.c.info === b.c.info &&
  a.c.grossBase === b.c.grossBase &&
  a.c.now === b.c.now &&
  sameRow(a.c.row, b.c.row);

const RowView = memo(function RowView({ c, defs, template, scrolled, words, clock, onOpen }: RowProps) {
  const p = c.row.position;
  return (
    <div
      role="row"
      onClick={() => onOpen(p.contract)}
      className="hover-p2 pos-row"
      style={{
        display: 'grid',
        gridTemplateColumns: template,
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
