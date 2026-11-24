// Settings page (design 3a, "pgSet"): 220px section nav | scrolling content.
// Every change goes through window.tape.updateSettings; main persists and broadcasts back.

import { useEffect, useRef } from 'react';
import { useStore, type SettingsTab } from '../../state/store';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { lessGutter, stableGutter } from '../../ui/scrollGutter';
import { AboutSection } from './AboutSection';
import { ApiLogSection } from './ApiLogSection';
import { AppearanceSection } from './AppearanceSection';
import { ConnectionSection } from './ConnectionSection';
import { MarketDataSection } from './MarketDataSection';
import { updatePending } from '../update/actions';
import { useSettingsMessages } from './messages';
import { NotificationsSection } from './NotificationsSection';
import { PrivacySection } from './PrivacySection';
import { ShortcutsSection } from './ShortcutsSection';
import { TradeSection } from './TradeSection';

/** Nav order (design setNav, with Trade after Market data, and About last). Settings opens on General. */
export const TABS: readonly SettingsTab[] = ['view', 'conn', 'data', 'trade', 'notif', 'sec', 'keys', 'log', 'about'];

const SECTIONS: Record<SettingsTab, () => React.JSX.Element> = {
  view: AppearanceSection,
  conn: ConnectionSection,
  data: MarketDataSection,
  trade: TradeSection,
  notif: NotificationsSection,
  sec: PrivacySection,
  keys: ShortcutsSection,
  log: ApiLogSection,
  about: AboutSection,
};

export function SettingsPage() {
  const m = useSettingsMessages();
  const tab = useStore((s) => s.settingsTab);
  const openSettings = useStore((s) => s.openSettings);
  const scroller = useRef<HTMLDivElement>(null);
  const hasUpdate = useStore((s) => updatePending(s.update) != null);
  const Section = SECTIONS[tab] ?? AppearanceSection;

  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
  }, [tab]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: '220px minmax(0,1fr)',
        gap: 'var(--gap)',
        padding: 'var(--pad)',
        background: 'var(--gbg)',
      }}
    >
      <div style={{ background: 'var(--p)', padding: '20px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {TABS.map((k) => {
          const active = k === tab;
          const dot = k === 'about' && hasUpdate;
          return (
            <div
              key={k}
              onClick={() => openSettings(k)}
              className={active ? undefined : 'hover-tx'}
              style={{
                height: 40,
                display: 'flex',
                alignItems: 'center',
                padding: '0 14px',
                cursor: 'pointer',
                background: active ? 'var(--sel)' : 'transparent',
                color: active ? 'var(--tx)' : 'var(--dm)',
                gap: 8,
              }}
            >
              {m.nav[k]}
              {/* A new version of Tape is available or downloaded (the Settings button has the same dot). */}
              {dot && <div data-testid="about-dot" style={{ width: 6, height: 6, background: 'var(--ac)', flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>
      {/* Opening Connection's Advanced or turning Sound on makes the pane scroll; its content keeps its width (scrollGutter.ts). */}
      <div ref={scroller} style={{ background: 'var(--p)', overflow: 'auto', ...stableGutter, padding: `32px ${lessGutter(40)} 32px 40px`, minHeight: 0 }}>
        {/* The API log fills the panel height (its list takes the rest); other sections keep their own height. */}
        <div style={{ maxWidth: tab === 'log' ? 'none' : 720, minHeight: tab === 'log' ? '100%' : undefined, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <ErrorBoundary name={m.nav[tab] ?? tab} key={tab}>
            <Section />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
