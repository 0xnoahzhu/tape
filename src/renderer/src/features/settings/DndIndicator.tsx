// Do-not-disturb in the top bar: a small "DND" tag left of the bell while it is on, so it is never
// on unnoticed (it holds back fills and order updates from the notification center). Its tooltip
// says when it ends; a click opens Settings › Notifications.

import { useEffect, useState } from 'react';
import { dndActive } from '@shared/dnd';
import { useClock } from '../../i18n';
import { useStore } from '../../state/store';
import { dndEndText } from './logic';
import { useSettingsMessages } from './messages';

/** setTimeout's longest delay; do-not-disturb never lasts that long (DND_MAX_MS). */
const MAX_DELAY = 2_147_000_000;

/**
 * Do-not-disturb's end while it is on, else null. Re-renders when it ends by itself (main keeps
 * the past time in the settings; it simply no longer counts).
 */
export function useDndUntil(): number | null {
  const until = useStore((s) => s.settings.notifications.dndUntil);
  const [, setTick] = useState(0);
  const active = dndActive({ dndUntil: until });
  useEffect(() => {
    if (!active || until == null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(MAX_DELAY, until - Date.now() + 50));
    return () => clearTimeout(timer);
  }, [active, until]);
  return active ? until : null;
}

export function DndIndicator() {
  const m = useSettingsMessages();
  const clock = useClock();
  const until = useDndUntil();
  const openSettings = useStore((s) => s.openSettings);
  if (until == null) return null;
  return (
    <div
      role="button"
      title={m.dndChipTip(dndEndText(until, Date.now(), clock))}
      onClick={() => openSettings('notif')}
      className="no-drag"
      // The account badge's metrics (AccountTag), in the text colour: on, not a warning.
      style={{
        height: 22,
        display: 'flex',
        alignItems: 'center',
        marginRight: 4,
        padding: '0 7px',
        flexShrink: 0,
        font: '600 11px/1 var(--mono)',
        color: 'var(--tx)',
        boxShadow: 'inset 0 0 0 1px var(--mu)',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      {m.dndChip}
    </div>
  );
}
