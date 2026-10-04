// Settings › General: language, time format, theme, up/down color convention.

import type { TimeFormat } from '@shared/timeFormat';
import type { Lang, ThemeSetting, UpColor } from '@shared/types';
import { useStore } from '../../state/store';
import { useSettingsMessages } from './messages';
import { OptionRow, SectionHeader, saveSettings } from './parts';

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
      <OptionRow<Lang>
        label={m.language}
        options={[
          { key: 'en', label: 'English' },
          { key: 'zh', label: '中文' },
        ]}
        value={a.language}
        onChange={(language) => saveSettings({ appearance: { language } })}
      />
      <OptionRow<TimeFormat>
        label={m.timeFormat}
        options={[
          { key: '12h', label: m.hour12 },
          { key: '24h', label: m.hour24 },
        ]}
        value={a.timeFormat}
        onChange={(timeFormat) => saveSettings({ appearance: { timeFormat } })}
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
