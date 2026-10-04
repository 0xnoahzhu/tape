// Settings page (design 3a, "pgSet"): 220px section nav | scrolling content.
// Every change goes through window.tape.updateSettings; main persists and broadcasts back.

import { useEffect, useRef } from 'react';
import { useStore, type SettingsTab } from '../../state/store';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { ApiLogSection } from './ApiLogSection';
import { AppearanceSection } from './AppearanceSection';
import { ConnectionSection } from './ConnectionSection';
import { MarketDataSection } from './MarketDataSection';
import { useSettingsMessages } from './messages';
import { NotificationsSection } from './NotificationsSection';
import { ShortcutsSection } from './ShortcutsSection';
import { TradeSection } from './TradeSection';

const TABS: readonly SettingsTab[] = ['conn', 'data', 'trade', 'notif', 'view', 'log', 'keys'];

const SECTIONS: Record<SettingsTab, () => React.JSX.Element> = {
  conn: ConnectionSection,
  data: MarketDataSection,
  trade: TradeSection,
  notif: NotificationsSection,
  view: AppearanceSection,
  log: ApiLogSection,
  keys: ShortcutsSection,
};

export function SettingsPage() {
  const m = useSettingsMessages();
  const tab = useStore((s) => s.settingsTab);
  const openSettings = useStore((s) => s.openSettings);
  const scroller = useRef<HTMLDivElement>(null);
  const Section = SECTIONS[tab] ?? ConnectionSection;

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
              }}
            >
              {m.nav[k]}
            </div>
          );
        })}
      </div>
      <div ref={scroller} style={{ background: 'var(--p)', overflow: 'auto', padding: '32px 40px', minHeight: 0 }}>
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
