// Pure helpers for the Settings page: input validation, connection labels,
// market data observation, API log filtering/formatting and shortcut labels.

import { DEFAULT_PORTS } from '@shared/defaults';
import { depthPermissions, isFullBook } from '@shared/depthPermissions';
import { DASH, hmsMs } from '@shared/format';
import { CATEGORY_KINDS, NO_SOUND, PLATFORM_SOUNDS, soundPlatform, type SoundCategory } from '@shared/notificationSounds';
import type {
  ApiLogEntry,
  ConnectionState,
  DepthBook,
  MarketCheckItem,
  MarketCheckProbe,
  MarketDataCheck,
  MarketDataCheckState,
  MarketDataType,
  Quote,
  Settings,
} from '@shared/types';

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
/** Most rows the list shows (odd, so the current sound can sit in the middle). */
export const SOUND_LIST_MAX_ROWS = 9;
/** Fewest rows it shows, even with less room (the window has a minimum size). */
export const SOUND_LIST_MIN_ROWS = 5;
/** Space kept between the list and the edge of the visible area (includes the 4 px gap to the button). */
export const SOUND_LIST_MARGIN = 12;

/** Whole rows that fit in `height` px of list. */
const soundRowsIn = (height: number) => Math.floor((height - SOUND_LIST_PAD) / SOUND_ROW_H);

/**
 * Where the sound list opens: below the button when it fits in the visible area (`bounds`, the
 * scrolling pane within the window), else on the side with more room, with its height capped
 * to that room, so opening it never scrolls or overflows the pane. The height is whole rows,
 * so with the scroll on a row boundary (soundListScroll, soundListReveal) no name shows cut at
 * the list's edges.
 */
export function soundListPlace(button: { top: number; bottom: number }, bounds: { top: number; bottom: number }, count: number): { up: boolean; maxH: number } {
  const want = Math.min(SOUND_LIST_MAX_ROWS, count);
  const least = Math.min(SOUND_LIST_MIN_ROWS, want);
  const below = soundRowsIn(bounds.bottom - button.bottom - SOUND_LIST_MARGIN);
  const above = soundRowsIn(button.top - bounds.top - SOUND_LIST_MARGIN);
  const rows = below >= want ? want : above > below ? Math.max(least, Math.min(want, above)) : Math.max(least, below);
  return { up: below < want && above > below, maxH: rows * SOUND_ROW_H + SOUND_LIST_PAD };
}

/**
 * The list's scrollTop on open: row `index` (of `count`) in the middle of the rows that fit in
 * `height`, on a row boundary.
 */
export function soundListScroll(index: number, count: number, height: number): number {
  const rows = Math.max(1, soundRowsIn(height));
  return Math.max(0, Math.min(count - rows, index - Math.floor((rows - 1) / 2))) * SOUND_ROW_H;
}

/**
 * The list's scrollTop that brings row `index` into view from `scrollTop` with the least scroll,
 * the list's padding kept around the row, so a list on a row boundary stays on one.
 */
export function soundListReveal(index: number, scrollTop: number, height: number): number {
  const top = index * SOUND_ROW_H;
  return Math.min(top, Math.max(top + SOUND_ROW_H + SOUND_LIST_PAD - height, scrollTop));
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
// Active market data check (main/market/marketCheck.ts)

/** Settings › Market data checks again when it opens and the last result is older than this. */
export const STALE_CHECK_MS = 5 * 60_000;

/** True when Settings › Market data should start a (quiet) check: connected, none running, and none recent for this account. */
export function checkNeeded(state: MarketDataCheckState, connection: Pick<ConnectionState, 'status' | 'account'>, now: number): boolean {
  if (connection.status !== 'connected' || state.running) return false;
  const r = state.result;
  if (!r) return true;
  if (connection.account && r.account && r.account !== connection.account) return true;
  return now - r.checkedAt >= STALE_CHECK_MS;
}

/** The check's item per row, when the result belongs to the connected account (or no account is known). */
export function checkItems(result: MarketDataCheck | null, account: string | undefined): Partial<Record<MarketRow, MarketCheckItem>> {
  const out: Partial<Record<MarketRow, MarketCheckItem>> = {};
  if (!result || (account && result.account && result.account !== account)) return out;
  for (const item of result.items) out[item.market] = item;
  return out;
}

/** The tag of a checked market: its status (a primary-exchange-only market reads live). */
export function checkTag(item: MarketCheckItem): ObservedTag {
  return item.status;
}

/** A stock served by its primary exchange: "AAPL via NASDAQ". */
export interface ExchangePair {
  symbol: string;
  exchange: string;
}

/** Why a market has no live data, and what to do about it (one note per reason). */
export type CheckReason =
  | { kind: 'competing' }
  /**
   * Delayed / not subscribed: the markets concerned, IB's codes, and whether another market of the
   * same check is live (then a paper account already shares the live account's data).
   */
  | { kind: 'notSubscribed'; codes: number[]; markets: Array<{ market: MarketRow; instrument: string }>; othersLive: boolean }
  /**
   * SMART delayed but the exchange live: the check's own stock (`smartDelayed`: SMART was delayed
   * for it, so likely for the account's stocks in general) and the quotes now served by their
   * exchange. `liveOnSmart`: the check's stock when it was live on SMART (only some stocks fall back).
   */
  | { kind: 'fallback'; smartDelayed: boolean; pairs: ExchangePair[]; liveOnSmart?: string }
  | { kind: 'depthPerm' }
  | { kind: 'depthPartial'; depth: string[]; missing: string[] }
  | { kind: 'depthLimit' }
  | { kind: 'noAnswer' }
  | { kind: 'lines' }
  | { kind: 'noOption' };

/** IB's answers that mean the account has no live entitlement for the API. */
const NOT_SUBSCRIBED = new Set([354, 10089, 10090, 10091, 10167, 10168, 10186]);
const COMPETING = 10197;

function probesOf(item: MarketCheckItem): MarketCheckProbe[] {
  return item.primary ? [item.probe, item.primary] : [item.probe];
}

/**
 * The reasons behind the delayed / no-data markets of a check, in the order they should be read:
 * a competing session first (it hides everything else), then subscriptions, then the fallback and
 * Level 2 specifics, then Tape's own outcomes (no answer, no free line, no option to test).
 */
export function checkReasons(result: MarketDataCheck | null): CheckReason[] {
  if (!result) return [];
  const has = new Set<CheckReason['kind']>();
  const codes = new Set<number>();
  const pairs = new Map<string, ExchangePair>();
  const notLive: Array<{ market: MarketRow; instrument: string }> = [];
  let smartDelayed = false;
  let liveOnSmart: string | undefined;
  let anyLive = false;
  let partial: { depth: string[]; missing: string[] } | null = null;
  for (const item of result.items) {
    if (item.market !== 'depth' && (item.status === 'live' || item.status === 'frozen')) anyLive = true;
    if (item.via && item.market !== 'depth') {
      smartDelayed = true;
      pairs.set(item.instrument, { symbol: item.instrument, exchange: item.via });
    } else if (item.market === 'stk' && (item.probe.status === 'live' || item.probe.status === 'frozen')) {
      liveOnSmart = item.instrument;
    }
    for (const f of item.fallback ?? []) if (!pairs.has(f.symbol)) pairs.set(f.symbol, { symbol: f.symbol, exchange: f.exchange });
    for (const p of probesOf(item)) {
      if (p.code === COMPETING) has.add('competing');
      if (p.own === 'timeout') has.add('noAnswer');
      if (p.own === 'lines') has.add('lines');
      if (p.own === 'contract' && item.market === 'opt') has.add('noOption');
    }
    const p = item.probe;
    if (item.market === 'depth') {
      if (item.via) partial = depthPermissions(p.message);
      if (p.code === 309) has.add('depthLimit');
      else if (item.status === 'nodata' && p.code !== undefined && p.code !== COMPETING && !p.own) has.add('depthPerm');
      continue;
    }
    // SMART delayed with the primary exchange live is the fallback's note, not a subscription problem;
    // a delayed primary-exchange line next to a live SMART one needs nothing either.
    if (item.via || p.status === 'live' || p.status === 'frozen') continue;
    if (p.code !== undefined && NOT_SUBSCRIBED.has(p.code)) {
      has.add('notSubscribed');
      codes.add(p.code);
      notLive.push({ market: item.market, instrument: item.instrument });
    } else if (p.status === 'delayed' && p.code !== COMPETING) {
      has.add('notSubscribed');
      notLive.push({ market: item.market, instrument: item.instrument });
    }
  }
  const out: CheckReason[] = [];
  if (has.has('competing')) out.push({ kind: 'competing' });
  if (has.has('notSubscribed')) out.push({ kind: 'notSubscribed', codes: [...codes].sort((a, b) => a - b), markets: notLive, othersLive: anyLive });
  if (pairs.size) out.push({ kind: 'fallback', smartDelayed, pairs: [...pairs.values()], ...(!smartDelayed && liveOnSmart ? { liveOnSmart } : {}) });
  if (has.has('depthPerm')) out.push({ kind: 'depthPerm' });
  if (partial?.missing.length) out.push({ kind: 'depthPartial', ...partial });
  if (has.has('depthLimit')) out.push({ kind: 'depthLimit' });
  if (has.has('noAnswer')) out.push({ kind: 'noAnswer' });
  if (has.has('lines')) out.push({ kind: 'lines' });
  if (has.has('noOption')) out.push({ kind: 'noOption' });
  return out;
}

/**
 * The line under the Level 2 switch: IB sends the book of some exchanges only (2152); the switch is
 * on without the user having set it (a check found a full book, main/market/marketCheck.ts); a full
 * book; else (not checked, no data) what Level 2 needs.
 */
export type DepthNote = { kind: 'partial'; via: string } | { kind: 'auto' } | { kind: 'full' } | { kind: 'needs' };

export function depthNote(item: MarketCheckItem | undefined, features: Settings['features']): DepthNote {
  if (item?.via) return { kind: 'partial', via: item.via };
  if (features.depth && !features.depthSetByUser) return { kind: 'auto' };
  return item && isFullBook(item.probe) ? { kind: 'full' } : { kind: 'needs' };
}

/** How long ago a check ran, for "checked 2 min ago" (null: show the date and time instead). */
export function checkAge(checkedAt: number, now: number): { unit: 'now' | 'min' | 'h'; n: number } | null {
  const ms = Math.max(0, now - checkedAt);
  if (ms < 60_000) return { unit: 'now', n: 0 };
  if (ms < 3_600_000) return { unit: 'min', n: Math.floor(ms / 60_000) };
  if (ms < 86_400_000) return { unit: 'h', n: Math.floor(ms / 3_600_000) };
  return null;
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
