// The chart header's add-to-watchlist star. A click opens a picker: for a stock (anything but an
// index), the watchlist's tabs, checked where it is; clicking an unchecked tab adds it there, a
// checked one takes it out of that tab (the other tabs keep it). For an index, which cannot be
// traded and so has no tab, one row puts it on the top bar's ticker or takes it off. The picker
// stays open for more picks. The star is filled while the instrument is in a tab (or on the ticker).
// Watchlists are local data, so this works while disconnected (only fillMissingName fails).

import { useEffect, useRef, useState } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, LocalizedName, WatchItem } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { MenuDivider, Popover } from '../../ui/primitives';
import { stableGutter } from '../../ui/scrollGutter';
import { fillMissingName, updateList } from './actions';
import { DEFAULT_GROUP_NAME, useWatchlistMessages } from './messages';
import { listHas, starRows, tabsListOf, tickerListOf, toggleInTab, toggleInTicker } from './model';
import { emptyItem, sectionLabel } from './RowMenu';
import { useWatchlistView } from './viewState';

const STAR_MENU_W = 220;
/** Keeps the menu this far inside the window's edges (px). */
const MENU_MARGIN = 16;

export function WatchStar({ contract, name, size }: { contract: ContractRef; name: LocalizedName | undefined; size: number }) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const tabs = useStore((s) => tabsListOf(s.watchlists));
  const ticker = useStore((s) => tickerListOf(s.watchlists));
  const setTarget = useWatchlistView((s) => s.setTarget);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ right: 0, maxH: 400 });
  const key = contractKey(contract);
  const label = contractLabel(contract);
  const isIndex = contract.secType === 'IND';
  const rows = tabs && !isIndex ? starRows(tabs, contract) : [];
  const onTicker = !!ticker && listHas(ticker, key);
  // The chart's own contract is stored, so a click on the panel's row selects the same one.
  const itemName = (typeof name === 'string' ? name.trim() : name) || undefined;
  const item: WatchItem = { contract, ...(itemName ? { name: itemName } : {}) };

  // Another symbol on the chart closes the menu.
  useEffect(() => setOpen(false), [key]);

  // A press outside the star and its menu closes it (on lock too: closeTransientUi presses the
  // body), and so does Escape unless a confirmation is showing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useStore.getState().confirm == null) setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Every tab holding it, for the tooltip; the star is filled when there is one (an index: on the ticker).
  const places = rows.filter((r) => r.checked).map((r) => nameOf(r.group.name, lang));
  const inAny = isIndex ? onTicker : places.length > 0;

  const openMenu = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-aligned under the star, kept inside the window; a long menu scrolls.
    setPlace({ right: Math.min(0, r.right - STAR_MENU_W - MENU_MARGIN), maxH: Math.max(160, window.innerHeight - r.bottom - 4 - MENU_MARGIN) });
    setOpen(true);
  };

  /** Checks or unchecks one tab (model.ts → toggleInTab); the picker stays open and its checks update in place. */
  const toggle = (groupId: string) => {
    // From the latest list: it may have changed while the picker was open.
    const latest = tabsListOf(useStore.getState().watchlists);
    if (!latest) return;
    const r = toggleInTab(latest, groupId, item);
    if (!r.change) return;
    updateList(latest.id, () => r.list);
    // A picked tab becomes where "Add symbol" adds on All.
    if (r.change === 'added') {
      setTarget(groupId);
      if (!itemName) fillMissingName(latest.id, contract);
    }
  };

  const toggleTicker = () => {
    const latest = tickerListOf(useStore.getState().watchlists);
    if (!latest) return;
    const r = toggleInTicker(latest, item, DEFAULT_GROUP_NAME);
    updateList(latest.id, () => r.list);
    useStore.getState().showToast(r.change === 'added' ? m.tickerAdded(label) : m.tickerRemoved(label));
  };

  const onClick = (e: React.MouseEvent) => {
    // The second click of a double-click is no new press: it would close the picker it just opened.
    if (e.detail > 1) return;
    if (open) setOpen(false);
    else openMenu();
  };

  const checkRow = (id: string, text: string, checked: boolean, run: () => void) => (
    <div
      key={id}
      role="menuitemcheckbox"
      aria-checked={checked}
      // A double-click is one pick, not an add and a remove.
      onClick={(e) => {
        if (e.detail <= 1) run();
      }}
      title={text}
      className="hover-p2"
      style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', cursor: 'pointer', color: 'var(--tx)' }}
    >
      <div style={{ width: 14, flexShrink: 0, color: 'var(--ac)', fontSize: 12 }}>{checked ? '✓' : ''}</div>
      <div className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: checked ? 600 : 400 }}>
        {text}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <div
        onClick={onClick}
        title={isIndex ? (onTicker ? m.onTicker : m.showOnTicker) : inAny ? m.starIn(places) : m.starPick}
        aria-haspopup="menu"
        aria-expanded={open}
        className="hover-tx hover-p2"
        style={{
          height: size,
          width: size,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: 'var(--mu)',
          boxShadow: 'inset 0 0 0 1px var(--ln)',
          background: open ? 'var(--p2)' : undefined,
        }}
      >
        {/* Filled in the accent itself (not currentColor), so the hover color leaves it alone. */}
        <svg viewBox="0 0 16 16" width={14} height={14} style={{ display: 'block' }} aria-hidden>
          <path
            d="M8 1.6l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3l-3.9 2.3 1-4.4-3.4-3 4.5-.5z"
            fill={inAny ? 'var(--ac)' : 'none'}
            stroke={inAny ? 'var(--ac)' : 'currentColor'}
            strokeWidth={1.3}
            strokeLinejoin="miter"
          />
        </svg>
      </div>
      {/* Block layout keeps every row at its fixed height when the menu has to scroll. */}
      {open && (
        <Popover style={{ top: 'calc(100% + 4px)', right: place.right, width: STAR_MENU_W, display: 'block', maxHeight: place.maxH, overflowY: 'auto', ...stableGutter }}>
          <div style={{ padding: '6px 12px 8px', font: '600 12px/1 var(--mono)', color: 'var(--mu)' }}>{label}</div>
          {isIndex ? (
            <>
              <div style={sectionLabel}>{m.ticker}</div>
              {checkRow('ticker', m.showOnTicker, onTicker, toggleTicker)}
              <MenuDivider />
              <div style={{ padding: '4px 12px 6px', fontSize: 11, lineHeight: 1.45, color: 'var(--dm)' }}>{m.tickerHint}</div>
            </>
          ) : (
            <>
              <div style={sectionLabel}>{m.title}</div>
              {rows.map((r) => checkRow(r.group.id, nameOf(r.group.name, lang), r.checked, () => toggle(r.group.id)))}
              {rows.length === 0 && <div style={emptyItem}>{m.noOtherGroups}</div>}
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
