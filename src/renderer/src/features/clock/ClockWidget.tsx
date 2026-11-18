// The clock widget (Settings › General › Clock widget): a small card floating over the content
// area, in Settings › General › Time zone, the chart's zone ("Exchange" follows the instrument on
// the chart, New York when unknown, so the two always agree), in Settings › General › Time format.
// Locked, it stays where it is; unlocked, it is dragged anywhere in the content area. The lock
// button shows only on hover (and while dragged). Where it was left is kept per device by the nearest
// corner (model.ts), so it stays there when the window is resized.
//
// Its layer (App mounts it over the content area, under the top bar, after the page) passes clicks
// through. z-index 3 puts it above the floating panels (1) and the page's own raised parts: the
// Portfolio header (3, a tie the later layer wins) and the table toolbar (2); below menus (4+),
// dialogs, toasts and the lock screen.

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { clockReading, localZone, zoneShortName } from '@shared/timeFormat';
import { useCommon } from '../../i18n/common';
import { useLang } from '../../i18n';
import { useStore } from '../../state/store';
import { LockIcon, UnlockIcon } from '../../ui/icons';
import { shownTimeZone } from '../chart/chartMath';
import { useContractInfo } from '../chart/contractInfo';
import { saveSettings } from '../settings/parts';
import { clampPoint, parsePlace, placePoint, pointPlace, type ClockPlace, type Point, type Size } from './model';

const STORAGE_KEY = 'tape.clockWidget';

function loadPlace(): ClockPlace {
  try {
    return parsePlace(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return parsePlace(null);
  }
}

function savePlace(p: ClockPlace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Not kept: it comes back at its default place.
  }
}

/** Now, refreshed at each turn of the second (or minute). */
function useTick(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, stepMs - (Date.now() % stepMs) + 5);
    };
    setNow(Date.now());
    schedule();
    return () => clearTimeout(timer);
  }, [stepMs]);
  return now;
}

/** The size of an element, kept current. */
function useSize(ref: React.RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s && s.width === el.offsetWidth && s.height === el.offsetHeight ? s : { width: el.offsetWidth, height: el.offsetHeight }));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** The widget's layer over the content area; nothing while the widget is off. */
export function ClockLayer() {
  const show = useStore((s) => s.settings.appearance.clock.show);
  const ref = useRef<HTMLDivElement>(null);
  const area = useSize(ref);
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none', overflow: 'hidden' }}>
      {show && area && <ClockWidget area={area} />}
    </div>
  );
}

function ClockWidget({ area }: { area: Size }) {
  const m = useCommon();
  const lang = useLang();
  const format = useStore((s) => s.settings.appearance.timeFormat);
  const chartZone = useStore((s) => s.settings.appearance.chartZone);
  const clock = useStore((s) => s.settings.appearance.clock);
  const symbol = useStore((s) => s.symbol);
  const info = useContractInfo(symbol);
  const zone = shownTimeZone(chartZone, info?.timeZoneId, localZone());
  const now = useTick(clock.seconds ? 1000 : 60_000);
  const reading = clockReading(now, zone, clock, format, lang);

  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const [place, setPlace] = useState(loadPlace);
  /** While dragged: where the drag started (pointer and widget) and where it is now. */
  const [drag, setDrag] = useState<{ start: Point; from: Point; at: Point } | null>(null);
  const [hover, setHover] = useState(false);

  const base = size ? placePoint(place, size, area) : null;
  const at = drag?.at ?? base;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (clock.locked || e.button !== 0 || !base || (e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ start: { x: e.clientX, y: e.clientY }, from: base, at: base });
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || !size) return;
    const p = { x: drag.from.x + e.clientX - drag.start.x, y: drag.from.y + e.clientY - drag.start.y };
    setDrag({ ...drag, at: clampPoint(p, size, area) });
  };
  const up = () => {
    if (!drag || !size) return;
    const next = pointPlace(drag.at, size, area);
    setPlace(next);
    savePlace(next);
    setDrag(null);
  };

  const full = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { timeZone: zone, dateStyle: 'full' }).format(now);
  const city = (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
  const tip = `${full} · ${city} (${zoneShortName(zone, now)})${clock.locked ? '' : ` · ${m.clockDrag}`}`;
  const showLock = hover || drag != null;

  return (
    <div
      ref={ref}
      data-testid="clock-widget"
      title={drag ? undefined : tip}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        left: at?.x ?? 0,
        top: at?.y ?? 0,
        visibility: at ? 'visible' : 'hidden',
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px 8px 14px',
        background: 'var(--p)',
        boxShadow: `0 0 0 1px ${clock.locked ? 'var(--ln)' : 'var(--ac)'}, 0 8px 24px rgba(0,0,0,.18)`,
        cursor: clock.locked ? 'default' : drag ? 'grabbing' : 'grab',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ font: '600 18px/1 var(--num)', fontVariantNumeric: 'tabular-nums' }}>{reading.time}</div>
        {reading.detail && <div style={{ font: '11px/1 var(--num)', color: 'var(--mu)' }}>{reading.detail}</div>}
      </div>
      <button
        type="button"
        title={clock.locked ? m.clockUnlock : m.clockLock}
        aria-pressed={clock.locked}
        onClick={() => saveSettings({ appearance: { clock: { locked: !clock.locked } } })}
        style={{
          width: 22,
          height: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: clock.locked ? 'var(--mu)' : 'var(--ac)',
          cursor: 'pointer',
          opacity: showLock ? 1 : 0,
          transition: 'opacity .12s',
        }}
      >
        {clock.locked ? <LockIcon size={14} /> : <UnlockIcon size={14} />}
      </button>
    </div>
  );
}
