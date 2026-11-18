// The top bar's clock (Settings › General › Top bar clock): the time in Settings › General › Time
// zone, the same zone as the chart's time axis. "Exchange" follows the instrument on the chart (New
// York when it is unknown), so the clock and the chart always agree. Its 12 / 24-hour format is
// Settings › General › Time format; the date, seconds and zone label are the clock's own settings.
// It ticks on the second (or the minute without seconds); a click opens Settings › General.

import { useEffect, useState } from 'react';
import { localZone, topBarClockText, zoneShortName } from '@shared/timeFormat';
import { shownTimeZone } from '../features/chart/chartMath';
import { useContractInfo } from '../features/chart/contractInfo';
import { useCommon } from '../i18n/common';
import { useLang } from '../i18n';
import { useStore } from '../state/store';

/** Now, refreshed at each turn of the second (or minute). */
function useTick(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const t = Date.now();
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, stepMs - (t % stepMs) + 5);
    };
    setNow(Date.now());
    schedule();
    return () => clearTimeout(timer);
  }, [stepMs]);
  return now;
}

export function TopBarClock() {
  const settings = useStore((s) => s.settings.appearance.clock);
  if (!settings.show) return null;
  return <ClockText />;
}

function ClockText() {
  const m = useCommon();
  const lang = useLang();
  const format = useStore((s) => s.settings.appearance.timeFormat);
  const chartZone = useStore((s) => s.settings.appearance.chartZone);
  const clock = useStore((s) => s.settings.appearance.clock);
  const symbol = useStore((s) => s.symbol);
  const info = useContractInfo(symbol);
  const zone = shownTimeZone(chartZone, info?.timeZoneId, localZone());
  const now = useTick(clock.seconds ? 1000 : 60_000);

  const full = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { timeZone: zone, dateStyle: 'full' }).format(now);
  const city = (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
  const tip = `${full} · ${city} (${zoneShortName(zone, now)}) · ${m.clockTip}`;

  return (
    <div
      className="no-drag"
      data-testid="topbar-clock"
      title={tip}
      onClick={() => useStore.getState().openSettings('view')}
      style={{
        flexShrink: 0,
        whiteSpace: 'nowrap',
        font: '14px/1 var(--num)',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--mu)',
        cursor: 'pointer',
        // Clear of the index ticker on the left and the account badge on the right (the group's gap is 8).
        margin: '0 12px 0 16px',
      }}
    >
      {topBarClockText(now, zone, clock, format, lang)}
    </div>
  );
}
