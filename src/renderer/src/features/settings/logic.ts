// Pure helpers for the Settings page: input validation, connection labels,
// market data observation, API log filtering/formatting and shortcut labels.

import { DEFAULT_PORTS } from '@shared/defaults';
import { DASH, hmsMs } from '@shared/format';
import { CATEGORY_KINDS, NO_SOUND, PLATFORM_SOUNDS, soundPlatform, type SoundCategory } from '@shared/notificationSounds';
import type { ApiLogEntry, ConnectionState, DepthBook, MarketDataType, Quote, Settings } from '@shared/types';

// ---------------------------------------------------------------------------
// Notification sounds

/** The picker's choices on `platform`: None first, then the platform's sounds. */
export function soundChoices(platform: string): string[] {
  return [NO_SOUND, ...PLATFORM_SOUNDS[soundPlatform(platform)]];
}

/** True when every kind of the category is kept out of the OS notification center (so it is never heard). */
export function soundCategoryOff(system: Settings['notifications']['system'], category: SoundCategory): boolean {
  return CATEGORY_KINDS[category].every((kind) => !system[kind]);
}

/** A sound's name as the picker shows it: translated where there is a name for it, else the system name. */
export function soundLabel(id: string, names: Record<string, string>): string {
  return Object.hasOwn(names, id) ? names[id] : id;
}

/** Linux has no per-category sounds: Electron cannot set (or silence) the notification server's sound. */
export function hasSoundChoice(platform: string): boolean {
  return soundPlatform(platform) !== 'linux';
}

export const SOUND_ROW_H = 30;
/** The list's vertical padding (top + bottom). */
export const SOUND_LIST_PAD = 12;
export const SOUND_LIST_MAX_H = 296;
export const SOUND_LIST_MIN_H = 180;
/** Space kept between the list and the edge of the visible area (includes the 4 px gap to the button). */
export const SOUND_LIST_MARGIN = 12;

/**
 * Where the sound list opens: below the button when it fits in the visible area (`bounds`, the
 * scrolling pane within the window), else on the side with more room, with its height capped
 * to that room, so opening it never scrolls or overflows the pane.
 */
export function soundListPlace(button: { top: number; bottom: number }, bounds: { top: number; bottom: number }, count: number): { up: boolean; maxH: number } {
  const want = Math.min(SOUND_LIST_MAX_H, count * SOUND_ROW_H + SOUND_LIST_PAD);
  const below = bounds.bottom - button.bottom - SOUND_LIST_MARGIN;
  const above = button.top - bounds.top - SOUND_LIST_MARGIN;
  if (below >= want) return { up: false, maxH: want };
  if (above > below) return { up: true, maxH: Math.max(Math.min(SOUND_LIST_MIN_H, want), Math.min(want, above)) };
  return { up: false, maxH: Math.max(Math.min(SOUND_LIST_MIN_H, want), below) };
}

export type SoundListKey = { kind: 'focus'; index: number } | { kind: 'select' } | { kind: 'close' };

/** Listbox keys of the open sound list: ↑ ↓ Home End move, Enter / Space pick, Escape / Tab close. */
export function soundListKey(key: string, index: number, count: number): SoundListKey | undefined {
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: Math.min(count - 1, index + 1) };
    case 'ArrowUp':
      return { kind: 'focus', index: Math.max(0, index - 1) };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: count - 1 };
    case 'Enter':
    case ' ':
      return { kind: 'select' };
    case 'Escape':
    case 'Tab':
      return { kind: 'close' };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Connection inputs

type Mode = Settings['connection']['mode'];

// Host names, IPv4 and IPv6 (bare or in brackets).
const HOST_RE = /^[A-Za-z0-9.\-_:[\]]+$/;

/** Host name, IPv4 or IPv6 address; null when invalid. */
export function parseHost(s: string): string | null {
  const t = s.trim();
  return t.length > 0 && t.length <= 253 && HOST_RE.test(t) ? t : null;
}

/** TCP port 1–65535; null when invalid. */
export function parsePort(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Largest client id the settings store keeps (it clamps larger values). */
export const MAX_CLIENT_ID = 999_999_999;

/** Client id 0–MAX_CLIENT_ID; null when invalid. */
export function parseClientId(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_CLIENT_ID ? n : null;
}

/**
 * Port to use after switching between TWS and IB Gateway: the paper port of the new
 * mode, or its live port when the current port is the other mode's live port.
 */
export function portForMode(mode: Mode, currentPort: number): number {
  const other = mode === 'tws' ? DEFAULT_PORTS.gateway : DEFAULT_PORTS.tws;
  const own = mode === 'tws' ? DEFAULT_PORTS.tws : DEFAULT_PORTS.gateway;
  return currentPort === other.live || currentPort === own.live ? own.live : own.paper;
}

/** "TWS" or "IB Gateway": inferred from well-known ports, otherwise the configured mode. */
export function hostAppName(port: number, mode: Mode): string {
  if (port === DEFAULT_PORTS.tws.live || port === DEFAULT_PORTS.tws.paper) return 'TWS';
  if (port === DEFAULT_PORTS.gateway.live || port === DEFAULT_PORTS.gateway.paper) return 'IB Gateway';
  return mode === 'tws' ? 'TWS' : 'IB Gateway';
}

/**
 * Dot color of the connection status line: green only while connected (--ac equals --g in
 * skin a, so it cannot mark progress), muted during a first attempt, red when not connected.
 */
export function statusDotColor(status: ConnectionState['status']): string {
  if (status === 'connected') return 'var(--g)';
  if (status === 'connecting') return 'var(--mu)';
  return 'var(--r)';
}

/** Farm entries sorted by name, for the status chips. */
export function farmList(farms: ConnectionState['farms']): Array<{ name: string; state: 'ok' | 'inactive' | 'broken' }> {
  return Object.entries(farms ?? {})
    .map(([name, state]) => ({ name, state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Market data observation

/** What the UI can honestly say about a market, from the data actually received. */
export type ObservedTag = 'live' | 'frozen' | 'delayed' | 'nodata' | 'none';

export interface Observation {
  tag: ObservedTag;
  live: number;
  frozen: number;
  delayed: number;
  errors: number;
  /** Most recent error code seen for this market. */
  errorCode?: number;
  /** Depth only: symbol and number of levels in the current book. */
  depthSymbol?: string;
  depthLevels?: number;
}

export type MarketRow = 'stk' | 'opt' | 'depth' | 'ind';

export const MARKET_ROWS: readonly MarketRow[] = ['stk', 'opt', 'depth', 'ind'];

const SEC_PREFIX: Record<Exclude<MarketRow, 'depth'>, string> = { stk: 'STK:', opt: 'OPT:', ind: 'IND:' };

function empty(): Observation {
  return { tag: 'none', live: 0, frozen: 0, delayed: 0, errors: 0 };
}

function typeBucket(t: MarketDataType): 'live' | 'frozen' | 'delayed' {
  // 1 live, 2 frozen (live subscription, market closed), 3 delayed, 4 delayed-frozen.
  return t === 1 ? 'live' : t === 2 ? 'frozen' : 'delayed';
}

function tagOf(o: Observation): ObservedTag {
  if (o.live) return 'live';
  if (o.frozen) return 'frozen';
  if (o.delayed) return 'delayed';
  if (o.errors) return 'nodata';
  return 'none';
}

/**
 * Summarizes received quotes per market (by contract key prefix) and the current depth book.
 * A quote that carries an error counts as an error whatever data it delivered before: main
 * clears the error as soon as ticks flow again, so a present error means nothing flows now.
 * A market-wide issue (e.g. 10197) marks markets without any observed data as "no data".
 */
export function observeMarkets(quotes: Record<string, Quote>, depth: DepthBook | null, issue?: { code: number } | null): Record<MarketRow, Observation> {
  const out: Record<MarketRow, Observation> = { stk: empty(), opt: empty(), depth: empty(), ind: empty() };
  const lastErrorAt: Partial<Record<MarketRow, number>> = {};
  for (const [key, q] of Object.entries(quotes)) {
    const row = (Object.keys(SEC_PREFIX) as Array<Exclude<MarketRow, 'depth'>>).find((r) => key.startsWith(SEC_PREFIX[r]));
    if (!row) continue;
    const o = out[row];
    if (q.error) {
      o.errors++;
      if ((lastErrorAt[row] ?? -1) <= q.updatedAt) {
        lastErrorAt[row] = q.updatedAt;
        o.errorCode = q.error.code;
      }
    } else if (q.marketDataType) {
      o[typeBucket(q.marketDataType)]++;
    }
  }
  if (depth) {
    const o = out.depth;
    o.depthSymbol = depth.key.split(':')[1] ?? depth.key;
    o.depthLevels = Math.max(depth.bids.length, depth.asks.length);
    if (depth.error) {
      o.errors = 1;
      o.errorCode = depth.error.code;
    } else if (o.depthLevels > 0) {
      // Level 2 is only ever delivered with a live subscription.
      o.live = 1;
    }
  }
  for (const row of MARKET_ROWS) {
    const o = out[row];
    o.tag = tagOf(o);
    if (o.tag === 'none' && issue) {
      o.tag = 'nodata';
      o.errorCode = issue.code;
    }
  }
  return out;
}

export const TAG_LABEL: Record<ObservedTag, string> = {
  live: 'LIVE',
  frozen: 'FROZEN',
  delayed: 'DELAYED',
  nodata: 'NO DATA',
  none: '—',
};

/** Text and ring colors of an observation tag. */
export function tagColors(tag: ObservedTag): { fg: string; bd: string } {
  if (tag === 'live') return { fg: 'var(--ac)', bd: 'var(--ac)' };
  if (tag === 'nodata') return { fg: 'var(--r)', bd: 'var(--r)' };
  if (tag === 'none') return { fg: 'var(--dm)', bd: 'var(--ln)' };
  return { fg: 'var(--mu)', bd: 'var(--ln)' };
}

// ---------------------------------------------------------------------------
// API log

export type LogFilter = 'all' | 'out' | 'in' | 'err';

const bodyCache = new WeakMap<ApiLogEntry, string>();
const hayCache = new WeakMap<ApiLogEntry, string>();

/** Fields as "k=v  k=v" (cached per entry). */
export function logBody(e: ApiLogEntry): string {
  let s = bodyCache.get(e);
  if (s == null) {
    s = e.fields.map(([k, v]) => `${k}=${v}`).join('  ');
    bodyCache.set(e, s);
  }
  return s;
}

function haystack(e: ApiLogEntry): string {
  let s = hayCache.get(e);
  if (s == null) {
    s = `${e.name} ${e.reqId ?? ''} ${logBody(e)}`.toLowerCase();
    hayCache.set(e, s);
  }
  return s;
}

/** Informational error callbacks (farm status 2104 etc.) are shown muted, not red. */
export function isInfo(e: ApiLogEntry): boolean {
  return e.name === 'error' && !e.err;
}

export function logCounts(entries: readonly ApiLogEntry[]): Record<LogFilter, number> {
  let out = 0;
  let err = 0;
  for (const e of entries) {
    if (e.dir === 'out') out++;
    if (e.err) err++;
  }
  return { all: entries.length, out, in: entries.length - out, err };
}

/** Entries matching the direction filter and search text (message name, reqId or content), oldest first. */
export function filterLog(entries: readonly ApiLogEntry[], filter: LogFilter, query: string): ApiLogEntry[] {
  const q = query.trim().toLowerCase();
  const out: ApiLogEntry[] = [];
  for (const e of entries) {
    if (filter === 'err' ? !e.err : filter !== 'all' && e.dir !== filter) continue;
    if (q && !haystack(e).includes(q)) continue;
    out.push(e);
  }
  return out;
}

/** The newest `max` entries, newest first. */
export function newestFirst<T>(entries: readonly T[], max = 300): T[] {
  return entries.slice(Math.max(0, entries.length - max)).reverse();
}

/** Number of entries recorded after a paused snapshot was taken. */
export function countNewSince(live: readonly ApiLogEntry[], frozen: readonly ApiLogEntry[]): number {
  if (!frozen.length) return live.length;
  const lastSeq = frozen[frozen.length - 1].seq;
  let n = 0;
  for (let i = live.length - 1; i >= 0 && live[i].seq > lastSeq; i--) n++;
  return n;
}

/** Expanded row text: header line, padded fields and the raw frame. */
export function logDetail(e: ApiLogEntry): string {
  const head = `${e.dir === 'out' ? 'SEND  client → TWS' : 'RECV  TWS → client'}   msgId ${e.msgId}   ${e.bytes} bytes   ${hmsMs(e.t)}`;
  const fields = e.fields.map(([k, v]) => k.padEnd(18) + v).join('\n');
  return `${head}\n\n${fields}${fields ? '\n\n' : ''}raw  ${e.raw}`;
}

/** "/Users/me/Library/Logs/x.log" -> "~/Library/Logs/x.log". */
export function tildify(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');
}

// ---------------------------------------------------------------------------
// Local cache

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 88_290_000 -> "84.2 MB" (binary units, like the cache's 512 MB cap); bytes are whole. */
export function formatBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return DASH;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} B`;
  // A value that rounds up to 1024 of a unit moves to the next one.
  if (Number(v.toFixed(1)) >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${BYTE_UNITS[i]}`;
}

// ---------------------------------------------------------------------------
// Privacy & Security

/**
 * The custom auto-lock duration as typed: digits only, capped at 1440 (as in the design), and the
 * minutes to save, or null while the field is empty or 0.
 */
export function customMinutesInput(raw: string): { text: string; minutes: number | null } {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (!digits) return { text: '', minutes: null };
  const n = Math.min(1440, Number(digits));
  return { text: Number(digits) > 1440 ? '1440' : digits, minutes: n >= 1 ? n : null };
}

// ---------------------------------------------------------------------------
// Shortcuts

export type ShortcutId = 'command' | 'buy' | 'sell' | 'qty' | 'submit' | 'cancelLast' | 'pages' | 'settings' | 'theme' | 'lock';

/** The keys of one combination, modifiers first: ['⌘', '⇧', 'L'] / ['Ctrl', 'Shift', 'L']. */
export type KeyCombo = string[];

export interface ShortcutRow {
  id: ShortcutId;
  /** One key cap each; two for a pair (↑ / ↓) or a range (⌘1 – ⌘3). */
  combos: KeyCombo[];
  /** Shown between two combinations. */
  sep?: '/' | '–';
}

/** Shortcut rows in the design's order: ⌘ ⇧ ⏎ ⌫ glyphs on macOS, Ctrl / Shift / Enter / Backspace elsewhere. */
export function shortcutKeys(platform: string): ShortcutRow[] {
  const mac = platform === 'darwin';
  const mod = (...keys: string[]): KeyCombo => [mac ? '⌘' : 'Ctrl', ...keys];
  return [
    { id: 'command', combos: [mod('K')] },
    { id: 'buy', combos: [['B']] },
    { id: 'sell', combos: [['S']] },
    { id: 'qty', combos: [['↑'], ['↓']], sep: '/' },
    { id: 'submit', combos: [[mac ? '⏎' : 'Enter']] },
    { id: 'cancelLast', combos: [mod(mac ? '⌫' : 'Backspace')] },
    { id: 'pages', combos: [mod('1'), mod('3')], sep: '–' },
    { id: 'settings', combos: [mod(',')] },
    { id: 'theme', combos: [mod(mac ? '⇧' : 'Shift', 'L')] },
    { id: 'lock', combos: [mod('L')] },
  ];
}

/** "⌘⇧L" on macOS (glyphs side by side), "Ctrl+Shift+L" elsewhere. */
export function comboLabel(combo: KeyCombo, mac: boolean): string {
  return combo.join(mac ? '' : '+');
}
