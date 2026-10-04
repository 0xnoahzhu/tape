// Settings › Shortcuts: the keyboard shortcuts as key caps, with Ctrl / Shift / Enter / Backspace
// spelled out outside macOS.

import { Fragment } from 'react';
import { useStore } from '../../state/store';
import { comboLabel, shortcutKeys, type KeyCombo } from './logic';
import { useSettingsMessages } from './messages';
import { SectionHeader } from './parts';

export function ShortcutsSection() {
  const m = useSettingsMessages();
  const platform = useStore((s) => s.platform);
  const mac = platform === 'darwin';
  return (
    <>
      <SectionHeader title={m.nav.keys} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {shortcutKeys(platform).map((k) => (
          <div
            key={k.id}
            style={{ height: 46, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, boxShadow: 'inset 0 -1px 0 var(--ln2)' }}
          >
            <div style={{ color: 'var(--mu)' }}>{m.keys[k.id]}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {k.combos.map((combo, i) => (
                <Fragment key={i}>
                  {i > 0 && <div style={{ font: '13px/1 var(--sans)', color: 'var(--dm)' }}>{k.sep}</div>}
                  <KeyCap combo={combo} mac={mac} />
                </Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * One key combination on a --p2 cap. The system font (the top bar's ⌘K treatment, at 13px)
 * draws ⌘ ⇧ ⏎ ⌫ and the arrows at the size of the letters; macOS glyphs sit side by side.
 */
function KeyCap({ combo, mac }: { combo: KeyCombo; mac: boolean }) {
  return (
    <div
      style={{
        minWidth: 26,
        display: 'flex',
        justifyContent: 'center',
        gap: 2,
        padding: '6px 8px',
        background: 'var(--p2)',
        font: '500 13px/1 var(--sans)',
        whiteSpace: 'nowrap',
      }}
    >
      {mac ? combo.map((key, i) => <span key={i}>{key}</span>) : comboLabel(combo, false)}
    </div>
  );
}
