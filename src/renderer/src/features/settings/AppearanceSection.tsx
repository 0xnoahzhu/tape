// Settings › General: language, time format, theme, up/down color convention and color-blind mode
// (red–green set further apart, or blue and orange, for up / down: tokens.css, data-cb).

import type { TimeFormat } from '@shared/timeFormat';
import type { ColorBlind, Lang, ThemeSetting, UpColor } from '@shared/types';
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
  const hollow = a.colorBlind !== 'off';
  const colorLabel = (k: UpColor, text: string) => (
    <>
      <CandleIcon up={k === 'cn' ? red : green} down={k === 'cn' ? green : red} hollow={hollow} />
      <div>{text}</div>
    </>
  );
  // Each color-blind option previews its own colors in the current convention ("green" first).
  const palettes: Record<ColorBlind, [string, string]> = {
    off: ['var(--g)', 'var(--r)'],
    redGreen: ['var(--rgGreen)', 'var(--rgRed)'],
    blueOrange: ['var(--cbBlue)', 'var(--cbOrange)'],
  };
  const modeLabel = (k: ColorBlind, text: string) => {
    const [g, r] = palettes[k];
    return (
      <>
        <CandleIcon up={a.upColor === 'cn' ? r : g} down={a.upColor === 'cn' ? g : r} hollow={k !== 'off'} />
        <div>{text}</div>
      </>
    );
  };

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
          // In blue–orange the conventions are named by the colors they show.
          { key: 'cn', label: colorLabel('cn', a.colorBlind === 'blueOrange' ? m.cnColorBlind : m.cn) },
          { key: 'us', label: colorLabel('us', a.colorBlind === 'blueOrange' ? m.usColorBlind : m.us) },
        ]}
        value={a.upColor}
        onChange={(upColor) => saveSettings({ appearance: { upColor } })}
      />
      <OptionRow<ColorBlind>
        label={m.colorBlind}
        desc={m.colorBlindDesc}
        options={[
          { key: 'off', label: modeLabel('off', m.off) },
          { key: 'redGreen', label: modeLabel('redGreen', m.redGreen) },
          { key: 'blueOrange', label: modeLabel('blueOrange', m.blueOrange) },
        ]}
        value={a.colorBlind}
        onChange={(colorBlind) => saveSettings({ appearance: { colorBlind } })}
      />
    </>
  );
}

/** Four little bars and ▲▼ in the convention's up / down colors; up bars outlined when `hollow` (color-blind modes). */
function CandleIcon({ up, down, hollow }: { up: string; down: string; hollow?: boolean }) {
  const bar = (color: string, h: number, isUp: boolean) => (
    <div style={{ width: 4, height: h, boxSizing: 'border-box', ...(isUp && hollow ? { boxShadow: `inset 0 0 0 1px ${color}` } : { background: color }) }} />
  );
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 }}>
        {bar(up, 9, true)}
        {bar(up, 14, true)}
        {bar(down, 6, false)}
        {bar(up, 11, true)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, font: '600 9px/1 var(--num)' }}>
        <div style={{ color: up }}>▲</div>
        <div style={{ color: down }}>▼</div>
      </div>
    </>
  );
}
