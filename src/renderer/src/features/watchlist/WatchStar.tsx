// The chart header's add-to-watchlist star. A click adds the charted instrument to the current
// list's target group (the panel's "Add symbol" group, else the first one); when the current list
// has it already, cannot take it (Indices: indices only) or there is no list yet, the click opens
// a menu of every list · group instead: add or move it there, or remove it from the current list.
// Watchlists are local data, so this works while disconnected (only fillMissingName fails).

import { useEffect, useMemo, useRef, useState } from 'react';
import { contractKey, contractLabel } from '@shared/contract';
import type { ContractRef, LocalizedName, WatchGroup, WatchItem, Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { MenuDivider, MenuItem, Popover } from '../../ui/primitives';
import { askRemoveItem, fillMissingName, updateWatchlists } from './actions';
import { DEFAULT_GROUP_NAME, useWatchlistMessages } from './messages';
import { placeItem, quickAdd, targetGroupOf, type QuickAddRow } from './model';
import { emptyItem, sectionLabel } from './RowMenu';
import { useWatchlistView } from './viewState';

const STAR_MENU_W = 220;
/** Keeps the menu this far inside the window's edges (px). */
const MENU_MARGIN = 16;

export function WatchStar({ contract, name, size }: { contract: ContractRef; name: LocalizedName | undefined; size: number }) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const lists = useStore((s) => s.watchlists);
  const currentId = useWatchlistView((s) => s.currentId);
  const targets = useWatchlistView((s) => s.targets);
  const setTarget = useWatchlistView((s) => s.setTarget);
  const plan = useMemo(() => quickAdd(lists, currentId, targets, contract), [lists, currentId, targets, contract]);
  const key = contractKey(contract);
  const label = contractLabel(contract);
  // The chart's own contract is stored, so a click on the panel's row selects the same one.
  const itemName = (typeof name === 'string' ? name.trim() : name) || undefined;
  const item: WatchItem = { contract, ...(itemName ? { name: itemName } : {}) };

  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ right: 0, maxH: 400 });

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

  /** "Watchlist · Tech"; a list without groups gets its default group. */
  const where = (list: Watchlist, group: WatchGroup | undefined) => m.place(nameOf(list.name, lang), nameOf(group?.name ?? DEFAULT_GROUP_NAME, lang));

  const openMenu = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-aligned under the star, kept inside the window; a long menu scrolls.
    setPlace({ right: Math.min(0, r.right - STAR_MENU_W - MENU_MARGIN), maxH: Math.max(160, window.innerHeight - r.bottom - 4 - MENU_MARGIN) });
    setOpen(true);
  };

  /** Adds the instrument to a group of a list, or moves it there within that list; `remember` makes it the list's target. */
  const put = (listId: string, groupId: string | undefined, remember: boolean) => {
    // From the latest lists: one may have changed or gone while the menu was open.
    const latest = useStore.getState().watchlists.find((l) => l.id === listId);
    if (!latest) return;
    const r = placeItem(latest, groupId, item, DEFAULT_GROUP_NAME);
    if (!r.change) return;
    const group = targetGroupOf(latest, groupId);
    updateWatchlists((ls) => ls.map((l) => (l === latest ? r.list : l)));
    useStore.getState().showToast(r.change === 'moved' ? m.movedTo(label, where(latest, group)) : m.addedTo(label, where(latest, group)));
    if (r.change !== 'added') return;
    if (remember && group) setTarget(listId, group.id);
    if (!itemName) fillMissingName(listId, contract);
  };

  const onClick = (e: React.MouseEvent) => {
    // The rest of a double-click is no new press: after a one-click add it would open the menu.
    if (e.detail > 1 && !open) return;
    if (open) setOpen(false);
    else if (plan.click.kind === 'add') put(plan.click.listId, plan.click.groupId, false);
    else openMenu();
  };

  const pick = (row: QuickAddRow) => {
    setOpen(false);
    put(row.list.id, row.group?.id, true);
  };

  const remove = () => {
    setOpen(false);
    if (plan.list) askRemoveItem(plan.list.id, contract);
  };

  const current = plan.list;
  const title =
    current && plan.inList
      ? m.starIn(nameOf(current.name, lang))
      : current && plan.click.kind === 'add'
        ? m.starAdd(where(current, targetGroupOf(current, targets[current.id])))
        : m.starPick;

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <div
        onClick={onClick}
        title={title}
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
            fill={plan.inList ? 'var(--ac)' : 'none'}
            stroke={plan.inList ? 'var(--ac)' : 'currentColor'}
            strokeWidth={1.3}
            strokeLinejoin="miter"
          />
        </svg>
      </div>
      {/* Block layout keeps every row at its fixed height when the menu has to scroll. */}
      {open && (
        <Popover style={{ top: 'calc(100% + 4px)', right: place.right, width: STAR_MENU_W, display: 'block', maxHeight: place.maxH, overflowY: 'auto' }}>
          <div style={{ padding: '6px 12px 8px', font: '600 12px/1 var(--mono)', color: 'var(--mu)' }}>{label}</div>
          <div style={sectionLabel}>{m.addTo}</div>
          {plan.rows.map((row) => {
            const text = where(row.list, row.group);
            return (
              <div
                key={`${row.list.id}:${row.group?.id ?? ''}`}
                onClick={row.checked ? undefined : () => pick(row)}
                title={text}
                className={row.checked ? undefined : 'hover-p2'}
                style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', cursor: row.checked ? 'default' : 'pointer', color: 'var(--tx)' }}
              >
                <div style={{ width: 14, color: 'var(--ac)', fontSize: 12 }}>{row.checked ? '✓' : ''}</div>
                <div className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: row.checked ? 600 : 400 }}>
                  {text}
                </div>
              </div>
            );
          })}
          {plan.rows.length === 0 && <div style={emptyItem}>{m.noLists}</div>}
          {plan.inList && current && (
            <>
              <MenuDivider />
              <MenuItem danger onClick={remove} title={m.removeFrom(nameOf(current.name, lang))}>
                <div className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
                  {m.removeFrom(nameOf(current.name, lang))}
                </div>
              </MenuItem>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
