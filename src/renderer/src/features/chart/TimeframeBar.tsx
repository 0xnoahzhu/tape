// The chart toolbar's intervals and ranges: the favorites as chips (intervals, then ranges after
// a thin divider) and a "▾" button opening the full picker, a dropdown with sections (seconds,
// minutes, hours, days, ranges) of 40 px rows, each with a star that adds the row to the toolbar
// or removes it (chips keep the picker's order). The active interval is highlighted like the
// chips, and so is the active range while the view is fitted to it.
//
// Width: the chips are measured (a hidden copy of every label) and only the favorites that fit
// `maxWidth` are shown, in picker order (toolbarChips); the "▾" button always shows and carries
// the labels of an active interval or range left without a chip.
//
// Focus: the button takes no focus from a click, so after a pick with the mouse (or a click on a
// chip or outside) the focus stays where it was, and the order ticket's shortcuts (arrows, Enter)
// work as before. Opened from the keyboard (Enter / Space on the focused button), ↑ / ↓ move,
// Enter picks, Space stars and Escape closes, and the focus returns to the button, so a later
// Enter cannot reach the order ticket. A press outside, or on a chip, closes the picker.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useChartPrefs } from './chartPrefs';
import { useChartMessages } from './messages';
import {
  activeIndex,
  hiddenActive,
  isFavorite,
  itemKey,
  PICKER_ITEMS,
  PICKER_SECTIONS,
  pickerKey,
  sameItem,
  toolbarChips,
  type PickerItem,
  type ToolbarMetrics,
} from './timeframePicker';

const ROW_H = 40;
const PICKER_W = 208;
/** Keeps the dropdown this far inside the window's edges (px). */
const PICKER_MARGIN = 16;
const PICKER_MIN_H = 180;
const PICKER_MAX_H = 640;
const CHIP_PAD_X = 10;
const GAP = 2;
/** The divider between interval and range chips: 1 px with 4 px margins. */
const DIVIDER_W = 9;
/** Gap between the "▾" button's labels and its arrow; the arrow's width. */
const BUTTON_GAP = 6;
const ARROW_W = 9;

const measureStyle: CSSProperties = { position: 'absolute', top: 0, left: 0, whiteSpace: 'pre' };

const chipStyle = (active: boolean): CSSProperties => ({
  padding: `7px ${CHIP_PAD_X}px`,
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  background: active ? 'var(--p2)' : 'transparent',
  color: active ? 'var(--tx)' : 'var(--dm)',
});

function Chip({ active, title, onClick, children }: { active: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <div role="button" aria-pressed={active} title={title} onClick={onClick} className={active ? undefined : 'hover-tx'} style={chipStyle(active)}>
      {children}
    </div>
  );
}

/** Star of a picker row: filled in the accent color for a favorite, an outline otherwise. */
function Star({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden style={{ display: 'block' }}>
      <path
        d="M8 1.6l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3l-3.9 2.3 1-4.4-3.4-3 4.5-.5z"
        fill={on ? 'var(--ac)' : 'none'}
        stroke={on ? 'var(--ac)' : 'var(--dm)'}
        strokeWidth={1.2}
        strokeLinejoin="miter"
      />
    </svg>
  );
}

/** Keeps `row` (a child of the scrolling `list`, which is its offsetParent) in view by scrolling the list only. */
function scrollRowIntoList(list: HTMLElement, row: HTMLElement): void {
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
}

/**
 * `maxWidth`: the width the toolbar may take (px; 0: not known yet, all favorites show).
 * `plotWidth`: the chart's plot width, for the interval a range picks (ranges.ts).
 */
export function TimeframeBar({ maxWidth = 0, plotWidth }: { maxWidth?: number; plotWidth?: number }) {
  const m = useChartMessages();
  const { timeframe, range, favorites, setTimeframe, setRange, toggleFavorite } = useChartPrefs();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const [place, setPlace] = useState({ maxH: PICKER_MAX_H, right: 0 });
  const [focusRing, setFocusRing] = useState(false);
  /** Label widths (px) by item key, and of the " · " between the button's labels. */
  const [widths, setWidths] = useState<{ labels: Record<string, number>; sep: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  /** How the open picker was opened, and what had the focus then. */
  const openedRef = useRef<{ keyboard: boolean; focused: Element | null }>({ keyboard: false, focused: null });

  const label = (item: PickerItem) => (item.kind === 'interval' ? m.timeframes[item.tf] : m.ranges[item.range]);
  const isActive = (item: PickerItem) => (item.kind === 'interval' ? item.tf === timeframe : item.range === range);
  const pick = (item: PickerItem) => (item.kind === 'interval' ? setTimeframe(item.tf) : setRange(item.range, Date.now(), plotWidth));

  // Label widths of every item (a hidden copy), again once web fonts have loaded.
  useLayoutEffect(() => {
    const measure = () => {
      const el = measureRef.current;
      if (!el) return;
      const labels: Record<string, number> = {};
      let sep = 0;
      for (const child of el.children) {
        const k = (child as HTMLElement).dataset.measure;
        const w = child.getBoundingClientRect().width;
        if (k === 'sep') sep = w;
        else if (k) labels[k] = w;
      }
      setWidths({ labels, sep });
    };
    measure();
    let live = true;
    void document.fonts?.ready.then(() => live && measure());
    return () => {
      live = false;
    };
  }, [m]);

  /**
   * Closes the picker. `toButton`: it was opened from the keyboard and closed with Enter or
   * Escape, so the focus goes to the button; otherwise it goes back where it was before.
   */
  const close = (toButton: boolean) => {
    setOpen(false);
    const { keyboard, focused } = openedRef.current;
    if (toButton && keyboard) {
      buttonRef.current?.focus();
      return;
    }
    if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected) focused.focus({ preventScroll: true });
    else listRef.current?.blur();
  };
  const openPicker = (keyboard: boolean) => {
    openedRef.current = { keyboard, focused: document.activeElement };
    const r = rootRef.current?.getBoundingClientRect();
    if (r) {
      // Right-aligned under the toolbar, kept inside the window.
      const right = Math.min(Math.max(0, r.right - (window.innerWidth - PICKER_MARGIN)), Math.max(0, r.right - PICKER_W - PICKER_MARGIN));
      setPlace({ maxH: Math.max(PICKER_MIN_H, Math.min(PICKER_MAX_H, window.innerHeight - r.bottom - PICKER_MARGIN)), right });
    }
    setFocus(activeIndex(timeframe, range));
    setOpen(true);
  };

  // Focus the list on open with the current row in its middle (the rows around it in view), then
  // keep the focused row in view (scrolling the list only).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    list.focus({ preventScroll: true });
    const row = list.querySelector<HTMLElement>(`[data-row="${focus}"]`);
    if (row) list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const row = list.querySelector<HTMLElement>(`[data-row="${focus}"]`);
    if (row) scrollRowIntoList(list, row);
  }, [open, focus]);

  // A press outside the list and the button closes the picker (the press itself goes on).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent) => {
    const action = pickerKey(e.key, focus);
    if (!action) return;
    // Handled here: the order ticket's shortcuts (arrows, Enter) and the chart's must not see it.
    e.preventDefault();
    e.stopPropagation();
    switch (action.kind) {
      case 'focus':
        setFocus(action.index);
        break;
      case 'select':
        pick(PICKER_ITEMS[focus]);
        close(true);
        break;
      case 'star':
        toggleFavorite(PICKER_ITEMS[focus]);
        break;
      case 'close':
        close(true);
        break;
    }
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (open) close(true);
    else openPicker(true);
  };

  // The chips that fit, and the active items left for the button.
  const metrics: ToolbarMetrics | null = widths && {
    chip: (item) => (widths.labels[itemKey(item)] ?? 0) + 2 * CHIP_PAD_X,
    button: (labels) =>
      2 * CHIP_PAD_X + ARROW_W + (labels.length ? BUTTON_GAP + labels.reduce((w, i) => w + (widths.labels[itemKey(i)] ?? 0), 0) + (labels.length - 1) * widths.sep : 0),
    divider: DIVIDER_W,
    gap: GAP,
  };
  const all = PICKER_ITEMS.filter((i) => isFavorite(favorites, i));
  const active: PickerItem[] = [...(range ? [{ kind: 'range', range } as PickerItem] : []), { kind: 'interval', tf: timeframe }];
  const shown = metrics && maxWidth > 0 ? toolbarChips(favorites, active, metrics, maxWidth) : all;
  const chipIntervals = shown.filter((i) => i.kind === 'interval');
  const chipRanges = shown.filter((i) => i.kind === 'range');
  const hiddenLabels = hiddenActive(timeframe, range, shown).map(label);
  const hidden = hiddenLabels.length > 0;
  const pickChip = (item: PickerItem) => {
    pick(item);
    if (open) close(false);
  };

  return (
    <div ref={rootRef} data-chart="timeframes" style={{ position: 'relative', display: 'flex', alignItems: 'stretch', gap: GAP, minWidth: 0 }}>
      {/* Hidden copy of every label, for the widths (in a box of no size, so nothing overflows). */}
      <div ref={measureRef} aria-hidden style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0, overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none', fontSize: 13 }}>
        {PICKER_ITEMS.map((item) => (
          <span key={itemKey(item)} data-measure={itemKey(item)} style={measureStyle}>
            {label(item)}
          </span>
        ))}
        <span data-measure="sep" style={measureStyle}>
          {' · '}
        </span>
      </div>
      {chipIntervals.map((item) => (
        <Chip key={itemKey(item)} active={isActive(item)} onClick={() => pickChip(item)}>
          {label(item)}
        </Chip>
      ))}
      {chipRanges.length > 0 && chipIntervals.length > 0 && <div aria-hidden style={{ width: 1, margin: '7px 4px', background: 'var(--ln)' }} />}
      {chipRanges.map((item) => (
        <Chip key={itemKey(item)} active={isActive(item)} title={m.rangeHint(label(item))} onClick={() => pickChip(item)}>
          {label(item)}
        </Chip>
      ))}
      <div
        ref={buttonRef}
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${m.pickerMore} (${m.pickerHint})`}
        data-chart="timeframe-more"
        // A click does not take the focus (it stays where it was, see the header).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? close(false) : openPicker(false))}
        onKeyDown={onButtonKey}
        onFocus={(e) => setFocusRing(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => setFocusRing(false)}
        className={hidden || open ? undefined : 'hover-tx'}
        style={{
          ...chipStyle(hidden || open),
          display: 'flex',
          alignItems: 'center',
          gap: BUTTON_GAP,
          outline: 'none',
          flexShrink: 0,
          boxShadow: focusRing ? 'inset 0 0 0 1px var(--ac)' : undefined,
        }}
      >
        {hidden && <span>{hiddenLabels.join(' · ')}</span>}
        <svg viewBox="0 0 10 10" width={ARROW_W} height={ARROW_W} aria-hidden style={{ display: 'block' }}>
          <path d="M1.5 3.5L5 7l3.5-3.5" stroke="currentColor" strokeWidth={1.3} fill="none" />
        </svg>
      </div>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={m.pickerMore}
          aria-activedescendant={`tf-row-${focus}`}
          data-chart="timeframe-picker"
          onKeyDown={onListKey}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: place.right,
            width: PICKER_W,
            maxHeight: place.maxH,
            overflowY: 'auto',
            zIndex: 7,
            background: 'var(--p)',
            boxShadow: '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.25)',
            outline: 'none',
            padding: '4px 0',
          }}
        >
          {PICKER_SECTIONS.map((section, si) => (
            <div key={section.id} role="group" aria-label={m.pickerSections[section.id]} style={si ? { borderTop: '1px solid var(--ln2)', marginTop: 4, paddingTop: 4 } : undefined}>
              <div style={{ padding: '10px 14px 6px', font: '600 11px/1 var(--sans)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dm)' }}>
                {m.pickerSections[section.id]}
              </div>
              {section.items.map((item) => {
                const index = PICKER_ITEMS.findIndex((i) => sameItem(i, item));
                const active = isActive(item);
                const fav = isFavorite(favorites, item);
                return (
                  <div
                    key={itemKey(item)}
                    id={`tf-row-${index}`}
                    data-row={index}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setFocus(index)}
                    onClick={() => {
                      pick(item);
                      close(false);
                    }}
                    style={{
                      height: ROW_H,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0 6px 0 14px',
                      cursor: 'pointer',
                      fontSize: 13,
                      color: active ? 'var(--tx)' : 'var(--mu)',
                      background: index === focus ? 'var(--sel)' : active ? 'var(--p2)' : 'transparent',
                      boxShadow: active ? 'inset 2px 0 0 var(--ac)' : undefined,
                    }}
                  >
                    <span>{label(item)}</span>
                    <div
                      role="switch"
                      aria-checked={fav}
                      title={fav ? m.unstar : m.star}
                      data-star={itemKey(item)}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(item);
                      }}
                      style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Star on={fav} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
