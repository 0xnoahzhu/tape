// Inline tab name editor of the tab bar (GroupTabs): a new tab ("+") and renaming one. Enter saves,
// Escape cancels. A name another tab has is refused, with a hint under the input. `byKey` tells
// Enter / Escape, which unmount the focused input, from leaving it.

import { useEffect, useRef, useState } from 'react';
import type { Watchlist } from '@shared/types';
import { useStore } from '../../state/store';
import { TextInput } from '../../ui/primitives';
import { useWatchlistMessages } from './messages';
import { groupNameTaken } from './model';

export function GroupNameInput({
  list,
  groupId,
  initial = '',
  placeholder,
  onSave,
  onCancel,
}: {
  list: Watchlist;
  /** The tab being renamed; none for a new tab. */
  groupId?: string;
  initial?: string;
  placeholder?: string;
  onSave: (name: string, byKey: boolean) => void;
  onCancel: (byKey: boolean) => void;
}) {
  const m = useWatchlistMessages();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter / Escape unmount the input, which can fire a trailing blur; ignore it.
  const done = useRef(false);
  const taken = groupNameTaken(list, value, groupId);
  const hint = taken ? m.groupExists(value.trim()) : null;

  // A rename starts with the current name selected, so typing replaces it; the input is scrolled into the bar's view.
  useEffect(() => {
    inputRef.current?.select();
    inputRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  const onBlur = () => {
    if (done.current) return;
    done.current = true;
    // Leaving saves a name that can be saved; an empty or taken one is dropped (a taken one says why).
    if (taken) {
      useStore.getState().showToast(m.groupExists(value.trim()), 'error');
      onCancel(false);
    } else if (!value.trim()) onCancel(false);
    else onSave(value, false);
  };

  return (
    <div style={{ flexShrink: 0, alignSelf: 'center', position: 'relative' }}>
      <TextInput
        inputRef={inputRef}
        autoFocus
        accent
        value={value}
        placeholder={placeholder}
        height={24}
        style={{ width: Math.max(96, Math.min(180, 24 + value.length * 7.5)), padding: '0 6px', font: '600 12px/1 var(--sans)' }}
        onChange={setValue}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && !taken) {
            // No keypress follows: it would activate the button focus moves to (useRefocus).
            e.preventDefault();
            done.current = true;
            if (value.trim()) onSave(value, true);
            else onCancel(true);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            done.current = true;
            onCancel(true);
          }
        }}
        onBlur={onBlur}
      />
      {hint && (
        // Fixed at its place under the input (no offsets), so the bar's scroller does not clip it; over the rows, the bar keeps its height.
        <div
          style={{
            position: 'fixed',
            marginTop: 4,
            zIndex: 8,
            maxWidth: 220,
            padding: '6px 8px',
            background: 'var(--p)',
            boxShadow: '0 0 0 1px var(--ln), 0 8px 24px rgba(0,0,0,.18)',
            fontSize: 11,
            lineHeight: 1.4,
            color: 'var(--r)',
            pointerEvents: 'none',
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
