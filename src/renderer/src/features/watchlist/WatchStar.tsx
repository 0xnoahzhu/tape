// The chart header's add-to-watchlist star. A click opens a picker of every list that accepts the
// charted instrument (Indices: indices only) or holds it, each list's groups under its name and
// checked where it is. Clicking an unchecked group puts the instrument there (adds it to that list,
// or moves it there within that list). Clicking a checked group takes it out of that list. The
// picker stays open for more picks, with the lists it opened with (one click puts it back). The
// star is filled while any list has the instrument.
// Watchlists are local data, so this works while disconnected (only fillMissingName fails).

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, LocalizedName, WatchItem } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { MenuDivider, Popover } from '../../ui/primitives';
import { fillMissingName, updateWatchlists } from './actions';
import { DEFAULT_GROUP_NAME, useWatchlistMessages } from './messages';
import { starSections, toggleInGroup } from './model';
import { emptyItem, sectionLabel } from './RowMenu';
import { useWatchlistView } from './viewState';

const STAR_MENU_W = 220;
/** Keeps the menu this far inside the window's edges (px). */
const MENU_MARGIN = 16;

export function WatchStar({ contract, name, size }: { contract: ContractRef; name: LocalizedName | undefined; size: number }) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const lists = useStore((s) => s.watchlists);
  const setTarget = useWatchlistView((s) => s.setTarget);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ right: 0, maxH: 400 });
  // The lists shown when the picker opened stay while it is open: a stock unchecked in Indices
  // would otherwise take that section away, moving the next section under the pointer.
  const [shown, setShown] = useState<readonly string[]>([]);
  const sections = useMemo(() => starSections(lists, contract, open ? shown : undefined), [lists, contract, open, shown]);
  const key = contractKey(contract);
  const label = contractLabel(contract);
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

  // Every group holding it, "Watchlist · Tech", for the tooltip; the star is filled when there is one.
  const places = sections.flatMap((s) => s.rows.flatMap((r) => (r.checked && r.group ? [m.place(nameOf(s.list.name, lang), nameOf(r.group.name, lang))] : [])));
  const inAny = places.length > 0;

  const openMenu = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-aligned under the star, kept inside the window; a long menu scrolls.
    setPlace({ right: Math.min(0, r.right - STAR_MENU_W - MENU_MARGIN), maxH: Math.max(160, window.innerHeight - r.bottom - 4 - MENU_MARGIN) });
    setShown(sections.map((s) => s.list.id));
    setOpen(true);
  };

  /** Checks or unchecks one group (model.ts → toggleInGroup); the picker stays open and its checks update in place. */
  const toggle = (listId: string, groupId: string | undefined) => {
    // From the latest lists: one may have changed or gone while the picker was open.
    const latest = useStore.getState().watchlists.find((l) => l.id === listId);
    if (!latest) return;
    const r = toggleInGroup(latest, groupId, item, DEFAULT_GROUP_NAME);
    if (!r.change) return;
    updateWatchlists((ls) => ls.map((l) => (l === latest ? r.list : l)));
    // A picked group becomes the list's "Add symbol" group (the panel's chips follow).
    if (r.groupId) setTarget(listId, r.groupId);
    if (r.change === 'added' && !itemName) fillMissingName(listId, contract);
  };

  const onClick = (e: React.MouseEvent) => {
    // The second click of a double-click is no new press: it would close the picker it just opened.
    if (e.detail > 1) return;
    if (open) setOpen(false);
    else openMenu();
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <div
        onClick={onClick}
        title={inAny ? m.starIn(places) : m.starPick}
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
        <Popover style={{ top: 'calc(100% + 4px)', right: place.right, width: STAR_MENU_W, display: 'block', maxHeight: place.maxH, overflowY: 'auto' }}>
          <div style={{ padding: '6px 12px 8px', font: '600 12px/1 var(--mono)', color: 'var(--mu)' }}>{label}</div>
          {sections.map((s, i) => {
            const listName = nameOf(s.list.name, lang);
            return (
              <Fragment key={s.list.id}>
                {i > 0 && <MenuDivider />}
                <div className="ellipsis" title={listName} style={sectionLabel}>
                  {listName}
                </div>
                {s.rows.map((row) => {
                  const groupName = nameOf(row.group?.name ?? DEFAULT_GROUP_NAME, lang);
                  return (
                    <div
                      key={row.group?.id ?? ''}
                      role="menuitemcheckbox"
                      aria-checked={row.checked}
                      // A double-click is one pick, not an add and a remove.
                      onClick={(e) => {
                        if (e.detail <= 1) toggle(s.list.id, row.group?.id);
                      }}
                      title={m.place(listName, groupName)}
                      className="hover-p2"
                      style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', cursor: 'pointer', color: 'var(--tx)' }}
                    >
                      <div style={{ width: 14, flexShrink: 0, color: 'var(--ac)', fontSize: 12 }}>{row.checked ? '✓' : ''}</div>
                      <div className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: row.checked ? 600 : 400 }}>
                        {groupName}
                      </div>
                    </div>
                  );
                })}
              </Fragment>
            );
          })}
          {sections.length === 0 && <div style={emptyItem}>{m.noLists}</div>}
        </Popover>
      )}
    </div>
  );
}
