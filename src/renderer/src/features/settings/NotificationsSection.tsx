// Settings › Notifications: which kinds are pushed to the OS, sound (one per category, not on
// Linux), do-not-disturb, test.
//
// Sound picker: a listbox under (or, near the bottom of the pane, over) the button, sized to the
// visible part of the settings pane so opening it never scrolls the page, in whole rows so no
// name shows cut at its edges. ↑ ↓ Home End move, Enter / Space pick, Escape / Tab close; the
// focus then returns to the button.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NOTIFICATION_KINDS } from '@shared/defaults';
import { NO_SOUND, SOUND_CATEGORIES, resolveSound, type SoundCategory } from '@shared/notificationSounds';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import { hasSoundChoice, SOUND_ROW_H, soundCategoryOff, soundChoices, soundLabel, soundListKey, soundListPlace, soundListReveal, soundListScroll } from './logic';
import { useSettingsMessages } from './messages';
import { LabelBlock, SectionHeader, SettingToggle, saveSettings } from './parts';

export function NotificationsSection() {
  const m = useSettingsMessages();
  const n = useStore((s) => s.settings.notifications);
  const showToast = useStore((s) => s.showToast);
  const platform = useStore((s) => s.platform);

  const test = () => window.tape.testNotification().catch((err: unknown) => showToast(errorText(err), 'error'));

  return (
    <>
      <SectionHeader title={m.nav.notif} desc={m.notifDesc} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {NOTIFICATION_KINDS.map((kind) => (
          <div
            key={kind}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) 34px',
              gap: 12,
              height: 56,
              alignItems: 'center',
              boxShadow: 'inset 0 -1px 0 var(--ln2)',
            }}
          >
            <LabelBlock label={m.rules[kind].l} desc={m.rules[kind].d} />
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Toggle on={n.system[kind]} onClick={() => saveSettings({ notifications: { system: { [kind]: !n.system[kind] } } })} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <SettingToggle height={56} label={m.sound} desc={m.soundD} on={n.sound} onToggle={() => saveSettings({ notifications: { sound: !n.sound } })} />
        {n.sound && hasSoundChoice(platform) && SOUND_CATEGORIES.map((category) => <SoundRow key={category} category={category} />)}
        <SettingToggle height={56} label={m.dnd} desc={m.dndD} on={n.dnd} onToggle={() => saveSettings({ notifications: { dnd: !n.dnd } })} />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div
          onClick={() => void test()}
          className="hover-p2"
          style={{
            height: 36,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            fontSize: 13,
            cursor: 'pointer',
            boxShadow: 'inset 0 0 0 1px var(--ln)',
            color: 'var(--tx)',
          }}
        >
          {m.test}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.testD}</div>
      </div>
    </>
  );
}

const PICKER_WIDTH = 168;
const CONTROL_HEIGHT = 30;

/** The nearest scrolling ancestor's visible box, within the window. */
function visibleBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      const r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
      break;
    }
  }
  return { top, bottom };
}

/** One sound category under the Sound switch: label, sound picker, ▶ sample. */
function SoundRow({ category }: { category: SoundCategory }) {
  const m = useSettingsMessages();
  const platform = useStore((s) => s.platform);
  const n = useStore((s) => s.settings.notifications);
  const showToast = useStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const [place, setPlace] = useState({ up: false, maxH: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const choices = soundChoices(platform);
  const value = resolveSound(platform, category, n.sounds[category]);
  const valueLabel = soundLabel(value, m.soundNames);
  const off = soundCategoryOff(n.system, category);
  const previewBlocked = value === NO_SOUND ? m.soundPreviewNone : n.dnd ? m.soundPreviewDnd : null;
  const idBase = `sound-${category}`;

  const openList = () => {
    const button = buttonRef.current;
    if (!button) return;
    setPlace(soundListPlace(button.getBoundingClientRect(), visibleBounds(button), choices.length));
    setFocus(Math.max(0, choices.indexOf(value)));
    setOpen(true);
  };
  /** `refocus`: the focus goes back to the button (not for a press elsewhere, which takes it). */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  };
  const pick = (id: string) => {
    close(true);
    if (id !== n.sounds[category]) void saveSettings({ notifications: { sounds: { [category]: id } } });
  };
  const preview = () => {
    if (previewBlocked) return;
    window.tape.testNotification(category).catch((err: unknown) => showToast(errorText(err), 'error'));
  };

  // On open: focus the list without scrolling the page, the current sound in its middle.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    list.focus({ preventScroll: true });
    list.scrollTop = soundListScroll(focus, choices.length, list.clientHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // A press outside the list and the button closes it (the press itself goes on).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent) => {
    const action = soundListKey(e.key, focus, choices.length);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === 'select') pick(choices[focus]);
    else if (action.kind === 'close') close(true);
    else {
      setFocus(action.index);
      // Keep the row in view, scrolling the list only. Not for a row the pointer enters: that one
      // shows already, and scrolling to it would move the list off whole rows.
      const list = listRef.current;
      if (list) list.scrollTop = soundListReveal(action.index, list.scrollTop, list.clientHeight);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `minmax(0,1fr) ${PICKER_WIDTH}px ${CONTROL_HEIGHT}px`,
        gap: 8,
        height: 56,
        alignItems: 'center',
        paddingLeft: 16,
        boxShadow: 'inset 0 -1px 0 var(--ln2)',
      }}
    >
      <LabelBlock label={m.soundCats[category].l} desc={off ? m.soundCatOff : m.soundCats[category].d} />
      <div style={{ position: 'relative' }}>
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${m.soundCats[category].l}: ${valueLabel}`}
          title={m.soundPick}
          onClick={() => (open ? close(true) : openList())}
          className="hover-p2"
          style={{
            width: '100%',
            height: CONTROL_HEIGHT,
            padding: '0 10px',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            background: 'transparent',
            boxShadow: `inset 0 0 0 1px ${open ? 'var(--ac)' : 'var(--ln)'}`,
            color: value === NO_SOUND ? 'var(--mu)' : 'var(--tx)',
            font: '13px/1 var(--sans)',
            cursor: 'pointer',
          }}
        >
          <span className="ellipsis">{valueLabel}</span>
          <span style={{ color: 'var(--dm)', fontSize: 11 }}>▾</span>
        </button>
        {open && (
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-label={m.soundCats[category].l}
            aria-activedescendant={`${idBase}-${focus}`}
            onKeyDown={onListKey}
            style={{
              position: 'absolute',
              ...(place.up ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
              right: 0,
              zIndex: 8,
              width: PICKER_WIDTH,
              maxHeight: place.maxH,
              overflowY: 'auto',
              background: 'var(--p)',
              boxShadow: '0 0 0 1px var(--ln), 0 12px 32px rgba(0,0,0,.2)',
              outline: 'none',
              padding: '6px 0',
            }}
          >
            {choices.map((id, i) => {
              const on = id === value;
              return (
                <div
                  key={id}
                  id={`${idBase}-${i}`}
                  data-row={i}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setFocus(i)}
                  onClick={() => pick(id)}
                  style={{
                    height: SOUND_ROW_H,
                    padding: '0 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    background: i === focus ? 'var(--sel)' : 'transparent',
                    color: id === NO_SOUND && !on ? 'var(--mu)' : 'var(--tx)',
                    font: '13px/1 var(--sans)',
                    cursor: 'pointer',
                  }}
                >
                  <span className="ellipsis">{soundLabel(id, m.soundNames)}</span>
                  {on && <span style={{ color: 'var(--ac)', fontSize: 12 }}>✓</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <button
        type="button"
        title={previewBlocked ?? m.soundPreview}
        aria-label={`${m.soundCats[category].l}: ${m.soundPreview}`}
        aria-disabled={previewBlocked ? true : undefined}
        onClick={preview}
        className={previewBlocked ? undefined : 'hover-p2 hover-tx'}
        style={{
          width: CONTROL_HEIGHT,
          height: CONTROL_HEIGHT,
          padding: 0,
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          boxShadow: 'inset 0 0 0 1px var(--ln)',
          color: 'var(--mu)',
          fontSize: 10,
          opacity: previewBlocked ? 0.4 : 1,
          cursor: previewBlocked ? 'default' : 'pointer',
        }}
      >
        ▶
      </button>
    </div>
  );
}
