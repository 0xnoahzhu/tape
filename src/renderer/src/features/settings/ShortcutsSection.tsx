// Settings › Shortcuts: the keyboard shortcuts, with Ctrl labels outside macOS.

import { useStore } from '../../state/store';
import { shortcutKeys } from './logic';
import { useSettingsMessages } from './messages';
import { SectionHeader } from './parts';

export function ShortcutsSection() {
  const m = useSettingsMessages();
  const platform = useStore((s) => s.platform);
  return (
    <>
      <SectionHeader title={m.nav.keys} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {shortcutKeys(platform).map((k) => (
          <div
            key={k.id}
            style={{ height: 46, display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: 'inset 0 -1px 0 var(--ln2)' }}
          >
            <div style={{ color: 'var(--mu)' }}>{m.keys[k.id]}</div>
            <div style={{ font: '12px/1 var(--mono)', padding: '5px 8px', background: 'var(--p2)' }}>{k.keys}</div>
          </div>
        ))}
      </div>
    </>
  );
}
