// Settings › Appearance: account id visibility, language, theme, up/down color convention.

import type { ReactNode } from 'react';
import type { Lang, ThemeSetting, UpColor } from '@shared/types';
import { useStore } from '../../state/store';
import { Segmented, type Option } from '../../ui/primitives';
import { useSettingsMessages } from './messages';
import { SectionHeader, saveSettings } from './parts';

export function AppearanceSection() {
  const m = useSettingsMessages();
  const a = useStore((s) => s.settings.appearance);

  // The icon shows each convention with the colors the user sees for "red" and "green"
  // under the current convention, expressed through var(--up) / var(--dn).
  const red = a.upColor === 'cn' ? 'var(--up)' : 'var(--dn)';
  const green = a.upColor === 'cn' ? 'var(--dn)' : 'var(--up)';
  const colorLabel = (k: UpColor, text: string) => (
    <>
      <CandleIcon up={k === 'cn' ? red : green} down={k === 'cn' ? green : red} />
      <div>{text}</div>
    </>
  );

  return (
    <>
      <SectionHeader title={m.nav.view} />
      {/* As in the design, the rows sit directly in the section column (28px apart). */}
      <OptionRow<'show' | 'hide'>
        label={m.accountId}
        options={[
          { key: 'show', label: m.show },
          { key: 'hide', label: m.hide },
        ]}
        value={a.showAccountId ? 'show' : 'hide'}
        onChange={(k) => saveSettings({ appearance: { showAccountId: k === 'show' } })}
      />
      <OptionRow<Lang>
        label={m.language}
        options={[
          { key: 'en', label: 'English' },
          { key: 'zh', label: '中文' },
        ]}
        value={a.language}
        onChange={(language) => saveSettings({ appearance: { language } })}
      />
      <OptionRow<ThemeSetting>
        label={m.theme}
        options={[
          { key: 'system', label: m.system },
          { key: 'light', label: m.light },
          { key: 'dark', label: m.dark },
        ]}
        value={a.theme}
        onChange={(theme) => saveSettings({ appearance: { theme } })}
      />
      <OptionRow<UpColor>
        label={m.upColors}
        options={[
          { key: 'cn', label: colorLabel('cn', m.cn) },
          { key: 'us', label: colorLabel('us', m.us) },
        ]}
        value={a.upColor}
        onChange={(upColor) => saveSettings({ appearance: { upColor } })}
      />
    </>
  );
}

function OptionRow<K extends string>({ label, options, value, onChange }: { label: ReactNode; options: Option<K>[]; value: K; onChange: (k: K) => void }) {
  return (
    <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
      <div>{label}</div>
      <Segmented options={options} value={value} onChange={(k) => k !== value && onChange(k)} itemStyle={{ padding: '7px 14px', fontSize: 13, gap: 10 }} />
    </div>
  );
}

/** Four little bars and ▲▼ in the convention's up / down colors. */
function CandleIcon({ up, down }: { up: string; down: string }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 }}>
        <div style={{ width: 4, height: 9, background: up }} />
        <div style={{ width: 4, height: 14, background: up }} />
        <div style={{ width: 4, height: 6, background: down }} />
        <div style={{ width: 4, height: 11, background: up }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, font: '600 9px/1 var(--num)' }}>
        <div style={{ color: up }}>▲</div>
        <div style={{ color: down }}>▼</div>
      </div>
    </>
  );
}
