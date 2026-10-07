// List switcher under the panel header: built-in lists, "My lists" (rename / delete) and "New list".

import { useEffect, useRef, useState } from 'react';
import type { Watchlist } from '@shared/types';
import { nameOf, useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { useRefocus } from '../../ui/focus';
import { GlyphButton, TextInput } from '../../ui/primitives';
import { updateWatchlists } from './actions';
import { DEFAULT_GROUP_NAME, useWatchlistMessages } from './messages';
import { createList, deleteList, listItemCount, newId, renameList } from './model';

export function ListMenu({
  lists,
  currentId,
  onPick,
  onCreated,
  onDeleted,
  onClose,
}: {
  lists: Watchlist[];
  currentId: string;
  onPick: (id: string) => void;
  onCreated: (id: string) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const m = useWatchlistMessages();
  const lang = useLang();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');
  // Enter / Escape unmount the rename input, which can fire a trailing blur; ignore it.
  const renameDone = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const newListRef = useRef<HTMLButtonElement>(null);
  const refocus = useRefocus();
  // Enter / Escape in an editor remove the focused input: focus goes to the list's ✎, or to
  // "New list" (no id).
  const focusRow = (listId?: string) =>
    refocus(() => (listId ? menuRef.current?.querySelector<HTMLElement>(`[data-list="${CSS.escape(listId)}"] button`) : newListRef.current));

  const builtIn = lists.filter((l) => l.builtin);
  const custom = lists.filter((l) => !l.builtin);

  const commitRename = () => {
    if (renameDone.current || !renaming) return;
    renameDone.current = true;
    const { id, name } = renaming;
    setRenaming(null);
    updateWatchlists((ls) => renameList(ls, id, name));
  };

  // The menu can close without the input losing focus first (outside click, Escape, list
  // switched): a typed name is kept then too, as when leaving the input.
  const commitOnClose = useRef(commitRename);
  useEffect(() => {
    commitOnClose.current = commitRename;
  });
  useEffect(() => () => commitOnClose.current(), []);

  const startRename = (l: Watchlist) => {
    renameDone.current = false;
    setRenaming({ id: l.id, name: nameOf(l.name, lang) });
  };

  const confirmDelete = (l: Watchlist) => {
    useStore.getState().ask({
      title: m.deleteList,
      rows: [
        { label: m.list, value: nameOf(l.name, lang) },
        { label: m.symbols, value: String(listItemCount(l)) },
      ],
      note: m.deleteNote,
      label: m.delete,
      danger: true,
      run: () => {
        updateWatchlists((ls) => deleteList(ls, l.id));
        onDeleted(l.id);
      },
    });
  };

  const createNamedList = () => {
    const name = newName.trim();
    if (!name) {
      setNaming(false);
      focusRow();
      return;
    }
    const id = newId('w');
    updateWatchlists((ls) => createList(ls, name, DEFAULT_GROUP_NAME, id));
    onCreated(id);
  };

  const listRow = (l: Watchlist) => {
    const current = l.id === currentId;
    return {
      check: <div style={{ width: 14, color: 'var(--ac)', fontSize: 12 }}>{current ? '✓' : ''}</div>,
      count: <div style={{ font: '11px/1 var(--num)', color: 'var(--dm)' }}>{listItemCount(l)}</div>,
      weight: current ? 600 : 400,
    };
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 4 }} />
      <div
        ref={menuRef}
        style={{
          position: 'absolute',
          top: 48,
          left: 10,
          right: 10,
          zIndex: 5,
          background: 'var(--p)',
          boxShadow: '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.18)',
          padding: '6px 0',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100% - 56px)',
          overflowY: 'auto',
        }}
      >
        {builtIn.map((l) => {
          const r = listRow(l);
          return (
            <div key={l.id} onClick={() => onPick(l.id)} className="hover-p2" style={{ height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', cursor: 'pointer' }}>
              {r.check}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <div className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: r.weight }}>
                  {nameOf(l.name, lang)}
                </div>
                {r.count}
              </div>
            </div>
          );
        })}
        {custom.length > 0 && <div style={{ padding: '10px 12px 4px 34px', fontSize: 11, color: 'var(--dm)' }}>{m.myLists}</div>}
        {custom.map((l) => {
          if (renaming?.id === l.id) {
            return (
              <div key={l.id} style={{ padding: '4px 10px 4px 32px', flexShrink: 0 }}>
                <TextInput
                  autoFocus
                  accent
                  value={renaming.name}
                  onChange={(name) => setRenaming({ id: l.id, name })}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') {
                      // No keypress follows: it would activate the ✎ focus moves to.
                      e.preventDefault();
                      commitRename();
                      focusRow(l.id);
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      renameDone.current = true;
                      setRenaming(null);
                      focusRow(l.id);
                    }
                  }}
                  onBlur={commitRename}
                />
              </div>
            );
          }
          const r = listRow(l);
          return (
            <div
              key={l.id}
              data-list={l.id}
              onClick={() => onPick(l.id)}
              className="hover-p2"
              style={{ height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px 0 12px', cursor: 'pointer' }}
            >
              {r.check}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <div className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: r.weight }}>
                  {nameOf(l.name, lang)}
                </div>
                {r.count}
              </div>
              <GlyphButton title={m.rename} fontSize={12} onClick={() => startRename(l)}>
                ✎
              </GlyphButton>
              <GlyphButton title={m.deleteList} fontSize={13} danger onClick={() => confirmDelete(l)}>
                ×
              </GlyphButton>
            </div>
          );
        })}
        <div style={{ height: 1, flexShrink: 0, background: 'var(--ln2)', margin: '6px 0' }} />
        {naming ? (
          <div style={{ padding: '4px 10px', flexShrink: 0 }}>
            <TextInput
              autoFocus
              accent
              value={newName}
              placeholder={m.newListPh}
              onChange={setNewName}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  // No keypress follows: it would activate "New list" when focus moves there.
                  e.preventDefault();
                  createNamedList();
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setNaming(false);
                  focusRow();
                }
              }}
            />
          </div>
        ) : (
          <button
            ref={newListRef}
            type="button"
            onClick={() => setNaming(true)}
            className="hover-p2"
            style={{
              height: 36,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 12px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--ac)',
            }}
          >
            <div style={{ width: 14 }}>+</div>
            <div>{m.newList}</div>
          </button>
        )}
      </div>
    </>
  );
}
