// Option chain: column preset / strike range toolbar, CALLS | Strike | PUTS grid.
// Clicking Bid adds a SELL leg, clicking Ask a BUY leg.

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { f2 } from '@shared/format';
import type { OptionRight, OrderAction } from '@shared/types';
import { Segmented } from '../../ui/primitives';
import { cellColor, COLUMN_PRESETS, formatCell, type ColumnKey, type OptionData } from './chain';
import { useDesk, type StrikeRange } from './deskStore';
import { useM } from './messages';
import { MAX_CHAIN_ROWS, type ChainRow, type DeskModel } from './model';

const ROW_H = 30;
/** Extra rows subscribed above and below the viewport when only the rows in view are quoted. */
const OVERSCAN = 4;
/** Advance of one glyph of the 12.5px monospaced chain font (SF Mono 0.600em, Menlo 0.602em). */
const CHAR_W = 7.55;
/** Cell padding (10px) plus rounding. */
const CELL_PAD = 11;
/** Narrowest data column; the longest titles ("Intrinsic", "内在价值") may use the cell padding. */
const MIN_COL = 48;
const STRIKE_COL = 92;
/** Horizontal padding of the rows. */
const ROW_PAD = 40;

/**
 * Minimum width per column so that its longest value fits; columns share the rest equally. The
 * table scrolls horizontally when the minimums do not fit, so numbers are never clipped.
 */
function columnWidths(keys: ColumnKey[], rows: ChainRow[]): number[] {
  return keys.map((k) => {
    let chars = 0;
    for (const r of rows) chars = Math.max(chars, formatCell(k, r.call).length, formatCell(k, r.put).length);
    return Math.max(MIN_COL, Math.ceil(chars * CHAR_W) + CELL_PAD);
  });
}

function cols(widths: number[]): string {
  const side = (ws: number[]) => ws.map((w) => `minmax(${w}px,1fr)`).join(' ');
  return `${side([...widths].reverse())} ${STRIKE_COL}px ${side(widths)}`;
}

const RANGES: StrikeRange[] = [5, 12, 25, 'all'];

export function ChainPanel({ model, onVisible, state }: { model: DeskModel; onVisible: (r: { from: number; to: number }) => void; state: ReactNode }) {
  const m = useM();
  const preset = useDesk((s) => s.preset);
  const range = useDesk((s) => s.range);
  const patch = useDesk((s) => s.patch);
  const keys = COLUMN_PRESETS[preset];
  const hint = model.spot == null && model.rows.length ? m.noSpot : m.hint;

  return (
    <div style={{ background: 'var(--p)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', flexShrink: 0 }}>
        <Segmented
          options={(['key', 'quotes', 'greeks', 'value'] as const).map((k) => ({ key: k, label: m.presets[k] }))}
          value={preset}
          onChange={(k) => patch({ preset: k })}
          style={{ flexShrink: 0 }}
          itemStyle={{ fontSize: 13 }}
        />
        <Segmented<StrikeRange>
          options={RANGES.map((k) => ({ key: k, label: k === 'all' ? m.allStrikes : `±${k}` }))}
          value={range}
          onChange={(k) => patch({ range: k })}
          style={{ flexShrink: 0 }}
          itemStyle={{ fontSize: 13, padding: '6px 10px' }}
        />
        <div style={{ flex: 1 }} />
        <div title={hint} style={{ fontSize: 12, color: 'var(--dm)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hint}
        </div>
      </div>
      {state ? (
        <>
          <ChainHeaders keys={keys} widths={columnWidths(keys, [])} />
          {state}
        </>
      ) : (
        <ChainRows model={model} keys={keys} onVisible={onVisible} />
      )}
    </div>
  );
}

/** CALLS / PUTS caption and column titles. */
function ChainHeaders({ keys, widths }: { keys: ColumnKey[]; widths: number[] }) {
  const m = useM();
  const n = keys.length;
  return (
    <div style={{ fontFamily: 'var(--sans)', fontSize: 11, lineHeight: 'normal', color: 'var(--dm)', background: 'var(--p)', flexShrink: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols(widths), padding: '0 20px' }}>
        <div style={{ gridColumn: `1 / ${n + 1}`, textAlign: 'right', padding: '4px 10px', fontWeight: 600, color: 'var(--mu)' }}>{m.calls}</div>
        <div />
        <div style={{ gridColumn: `${n + 2} / ${2 * n + 2}`, padding: '4px 10px', fontWeight: 600, color: 'var(--mu)' }}>{m.puts}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: cols(widths), padding: '6px 20px', boxShadow: 'inset 0 -1px 0 var(--ln)' }}>
        {[...keys].reverse().map((k) => (
          <div key={'c' + k} style={{ textAlign: 'right', paddingRight: 10, whiteSpace: 'nowrap' }}>
            {m.columns[k]}
          </div>
        ))}
        <div style={{ textAlign: 'center' }}>{m.strike}</div>
        {keys.map((k) => (
          <div key={'p' + k} style={{ paddingLeft: 10, whiteSpace: 'nowrap' }}>
            {m.columns[k]}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChainRows({ model, keys, onVisible }: { model: DeskModel; keys: ColumnKey[]; onVisible: (r: { from: number; to: number }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { range, preset, addLeg } = useDesk();
  const exp = model.exp!;

  const head = useRef<HTMLDivElement>(null);
  const headH = () => head.current?.offsetHeight ?? 0;

  // Center the ATM row whenever the instrument, expiry, range or columns change (design centerAtm).
  const centerKey = [model.symbol, exp.expiry, range, preset, model.spot != null, model.rows.length > 0].join('|');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = Math.max(0, model.centerRow * ROW_H + ROW_H / 2 - (el.clientHeight - headH()) / 2);
    report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerKey]);

  // Windows over the line budget (±25, "all"): report the rows in view so only those are subscribed.
  const frame = useRef(0);
  const report = () => {
    const el = ref.current;
    if (!el || model.rows.length <= MAX_CHAIN_ROWS) return;
    const from = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
    const to = Math.ceil((el.scrollTop + el.clientHeight - headH()) / ROW_H) + OVERSCAN;
    onVisible({ from, to });
  };
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(report);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const add = (side: OrderAction, right: OptionRight, strike: number) =>
    addLeg({ side, right, strike, expiry: exp.expiry, qty: 1, tradingClass: exp.tradingClass, multiplier: exp.multiplier });

  const widths = columnWidths(keys, model.rows);
  const template = cols(widths);
  const minWidth = 2 * widths.reduce((a, w) => a + w, 0) + STRIKE_COL + ROW_PAD;
  return (
    <div ref={ref} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ minWidth }}>
        <div ref={head} style={{ position: 'sticky', top: 0, zIndex: 1 }}>
          <ChainHeaders keys={keys} widths={widths} />
        </div>
        <div style={{ font: '12.5px/1 var(--num)', fontVariantNumeric: 'tabular-nums' }}>
          {model.rows.map((r) => (
            <div
              key={r.strike}
              style={{
                display: 'grid',
                gridTemplateColumns: template,
                height: ROW_H,
                padding: '0 20px',
                boxShadow: r.atm ? 'inset 0 -1px 0 var(--ac)' : 'inset 0 -1px 0 var(--ln2)',
              }}
            >
              {[...keys].reverse().map((k) => (
                <Cell key={'c' + k} k={k} d={r.call} itm={r.callItm} side="C" onAdd={(s) => add(s, 'C', r.strike)} />
              ))}
              <StrikeCell row={r} />
              {keys.map((k) => (
                <Cell key={'p' + k} k={k} d={r.put} itm={r.putItm} side="P" onAdd={(s) => add(s, 'P', r.strike)} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StrikeCell({ row }: { row: ChainRow }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontWeight: 600, color: row.atm ? 'var(--ac)' : 'var(--tx)' }}>
      <div>{f2(row.strike)}</div>
      {row.em && <div style={{ font: '600 9px/1 var(--mono)', color: 'var(--ac)' }}>{row.em}</div>}
    </div>
  );
}

function Cell({ k, d, itm, side, onAdd }: { k: ColumnKey; d: OptionData; itm: boolean; side: OptionRight; onAdd: (s: OrderAction) => void }) {
  const click = k === 'bid' || k === 'ask';
  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    background: itm ? 'var(--sel)' : 'transparent',
    color: cellColor(k, d),
    cursor: click ? 'pointer' : 'default',
    whiteSpace: 'nowrap',
    ...(side === 'C' ? { justifyContent: 'flex-end', paddingRight: 10 } : { paddingLeft: 10 }),
  };
  return (
    <div onClick={click ? () => onAdd(k === 'ask' ? 'BUY' : 'SELL') : undefined} style={style}>
      {formatCell(k, d)}
    </div>
  );
}
