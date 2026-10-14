// Validation and merging for the persisted JSON files.
//
// Pure (no Electron, no fs) so it can be unit tested. Every loader takes `unknown` (whatever
// JSON.parse produced, or whatever the renderer sent over IPC) and returns well-typed data:
// unknown keys are dropped, types are coerced where the intent is clear, numbers are clamped,
// and entries that cannot be repaired are skipped.

import { ALERT_FREQUENCIES, ALERT_SESSIONS, ALERT_TIMEFRAMES, clipNote, DEFAULT_ALERT_SESSIONS, MAX_INDICATOR_PERIOD } from '@shared/alerts';
import { defaultUpColor, NOTIFICATION_KINDS } from '@shared/defaults';
import { DND_MAX_MS } from '@shared/dnd';
import { KNOWN_SOUNDS } from '@shared/notificationSounds';
import { TIME_FORMATS } from '@shared/timeFormat';
import type {
  AlertCross,
  AlertFrequency,
  AlertRule,
  AlertSession,
  AlertTimeframe,
  AppNotification,
  ComboLeg,
  ContractRef,
  DeepPartial,
  IndicatorSignal,
  LocalizedName,
  LocalizedText,
  NotificationKind,
  PriceAlert,
  SecType,
  Settings,
  WatchGroup,
  WatchItem,
  Watchlist,
} from '@shared/types';

export const MAX_NOTIFICATIONS = 200;
export const KEEP_DAYS = [1, 3, 7, 30, 90] as const;
const MAX_TEXT = 2000;

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

type Raw = Record<string, unknown>;

export const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

// ---------------------------------------------------------------------------
// Settings: a spec mirrors the Settings shape; each leaf coerces one value.

/** Coerces `raw` to a valid value, or returns `fallback` when it cannot. */
type Leaf<T> = (raw: unknown, fallback: T) => T;
type Spec<T> = { [K in keyof T]-?: T[K] extends object ? Spec<T[K]> : Leaf<T[K]> };

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

const bool: Leaf<boolean> = (v, d) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return d;
};

const int =
  (min: number, max: number): Leaf<number> =>
  (v, d) => {
    const n = toNumber(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
  };

const oneOf =
  <T extends string>(values: readonly T[]): Leaf<T> =>
  (v, d) =>
    (values as readonly unknown[]).includes(v) ? (v as T) : d;

/** Snaps a number to the closest allowed value. */
const nearest =
  (values: readonly number[]): Leaf<number> =>
  (v, d) => {
    const n = toNumber(v);
    if (!Number.isFinite(n)) return d;
    return values.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best));
  };

const hostName: Leaf<string> = (v, d) => {
  if (typeof v !== 'string') return d;
  const s = v.trim();
  return s.length > 0 && s.length <= 253 && !/\s/.test(s) ? s : d;
};

/**
 * Do-not-disturb's end: null (off) or a time within DND_MAX_MS from now. An end already past loads
 * as off; a later one (a hand-edited file) is cut to the longest Tape offers, so it still ends.
 */
const dndUntil: Leaf<number | null> = (v, d) => {
  if (v === null) return null;
  const t = toNumber(v);
  if (!Number.isFinite(t)) return d;
  const now = Date.now();
  return t <= now ? null : Math.min(Math.round(t), now + DND_MAX_MS);
};

const notificationRules = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, bool])) as Spec<Record<NotificationKind, boolean>>;

const SETTINGS_SPEC: Spec<Settings> = {
  connection: {
    mode: oneOf(['tws', 'gateway']),
    host: hostName,
    port: int(1, 65535),
    clientId: int(0, 999_999_999),
    autoConnect: bool,
    autoReconnect: bool,
  },
  trading: { defaultQty: int(1, 10_000_000), outsideRthDefault: bool },
  appearance: {
    theme: oneOf(['system', 'dark', 'light']),
    language: oneOf(['en', 'zh']),
    timeFormat: oneOf(TIME_FORMATS),
    upColor: oneOf(['cn', 'us']),
    showAccountId: bool,
  },
  features: { depth: bool, depthSetByUser: bool },
  notifications: {
    system: notificationRules,
    sound: bool,
    // Any platform's id loads (a profile may move between machines); unknown ids keep the fallback.
    sounds: { order: oneOf(KNOWN_SOUNDS), fill: oneOf(KNOWN_SOUNDS), other: oneOf(KNOWN_SOUNDS) },
    dndUntil,
  },
  apiLog: { writeFile: bool, keepDays: nearest(KEEP_DAYS) },
  lock: {
    autoLock: oneOf(['15', '30', '60', 'custom', 'never']),
    customMinutes: int(1, 1440),
    unlockWith: oneOf(['biometric', 'pin']),
    sound: bool,
  },
};

/** Walks the spec: keys missing from `raw` take the fallback, keys not in the spec are dropped. */
function sanitize<T>(spec: Spec<T>, raw: unknown, fallback: T): T {
  const src = isObject(raw) ? raw : {};
  const out = {} as T;
  for (const key of Object.keys(spec) as Array<keyof T & string>) {
    const rule = spec[key] as unknown;
    const value = src[key];
    out[key] =
      typeof rule === 'function'
        ? value === undefined
          ? fallback[key]
          : (rule as Leaf<T[typeof key]>)(value, fallback[key])
        : sanitize(rule as Spec<T[typeof key]>, value, fallback[key]);
  }
  return out;
}

/**
 * Saved settings deep-merged over the defaults. Files from before depthSetByUser (which also had
 * the removed features.options / .flow) count Level 2 on as the user's choice: it was off by default.
 * A file without up / down colours (the one a Forgot-PIN reset writes keeps only the language and
 * the theme) takes the convention of its language, not of the defaults' language.
 */
export function loadSettings(raw: unknown, defaults: Settings): Settings {
  const s = sanitize(SETTINGS_SPEC, raw, defaults);
  const saved = isObject(raw) && isObject(raw.features) ? raw.features : null;
  if (saved && saved.depthSetByUser === undefined && s.features.depth) s.features.depthSetByUser = true;
  const appearance = isObject(raw) && isObject(raw.appearance) ? raw.appearance : null;
  if (appearance && appearance.upColor === undefined) s.appearance.upColor = defaultUpColor(s.appearance.language);
  return s;
}

/**
 * Whether saved settings have Tape's former read-only switch (`connection.readOnly`) on. The
 * switch was removed (TWS / IB Gateway's own "Read-Only API" blocks orders); loadSettings drops
 * the key, and the store tells a user who had it on, once.
 */
export function hadReadOnlyMode(raw: unknown): boolean {
  return isObject(raw) && isObject(raw.connection) && bool(raw.connection.readOnly, false);
}

/**
 * Whether saved settings have the former do-not-disturb switch (`notifications.dnd`) on. It had no
 * end, so loadSettings drops it (do-not-disturb now ends by itself, `dndUntil`) and the store says
 * once that it was turned off.
 */
export function hadOpenEndedDnd(raw: unknown): boolean {
  return isObject(raw) && isObject(raw.notifications) && bool(raw.notifications.dnd, false);
}

/** Applies a (possibly untrusted) partial update; invalid values keep the current value. */
export function applySettingsPatch(current: Settings, patch: DeepPartial<Settings> | unknown): Settings {
  return sanitize(SETTINGS_SPEC, patch, current);
}

/** Structural equality for sanitized data (key order is fixed by the spec). */
export function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 'zh-CN', 'zh-Hant-TW' → 'zh'; everything else → 'en'. */
export function languageFromLocale(locale: string | undefined): 'en' | 'zh' {
  return locale && locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

// ---------------------------------------------------------------------------
// Shared pieces

const SEC_TYPES: readonly SecType[] = ['STK', 'OPT', 'IND', 'FUT', 'FOP', 'CASH', 'BAG', 'CFD', 'BOND', 'WAR', 'CRYPTO'];

const clip = (s: string, max = MAX_TEXT) => (s.length > max ? s.slice(0, max) : s);

export function sanitizeLocalizedText(raw: unknown): LocalizedText | null {
  if (!isObject(raw) || typeof raw.en !== 'string' || typeof raw.zh !== 'string') return null;
  return { en: clip(raw.en), zh: clip(raw.zh) };
}

function sanitizeLocalizedName(raw: unknown): LocalizedName | null {
  if (typeof raw === 'string') return clip(raw, 200);
  return sanitizeLocalizedText(raw);
}

function sanitizeComboLeg(raw: unknown): ComboLeg | null {
  if (!isObject(raw)) return null;
  const { conId, ratio, action, exchange } = raw;
  if (!Number.isInteger(conId) || !Number.isInteger(ratio) || (ratio as number) <= 0) return null;
  if (action !== 'BUY' && action !== 'SELL') return null;
  return { conId: conId as number, ratio: ratio as number, action, exchange: typeof exchange === 'string' ? exchange : 'SMART' };
}

export function sanitizeContract(raw: unknown): ContractRef | null {
  if (!isObject(raw)) return null;
  const { symbol, secType, exchange, currency } = raw;
  if (!nonEmpty(symbol) || !SEC_TYPES.includes(secType as SecType)) return null;
  if (typeof exchange !== 'string' || typeof currency !== 'string') return null;
  const c: ContractRef = { symbol: clip(symbol, 64), secType: secType as SecType, exchange, currency };
  for (const key of ['primaryExchange', 'lastTradeDate', 'localSymbol', 'tradingClass'] as const) {
    if (typeof raw[key] === 'string') c[key] = clip(raw[key] as string, 64);
  }
  if (Number.isInteger(raw.conId) && (raw.conId as number) > 0) c.conId = raw.conId as number;
  if (isFiniteNumber(raw.strike)) c.strike = raw.strike;
  if (raw.right === 'C' || raw.right === 'P') c.right = raw.right;
  if (isFiniteNumber(raw.multiplier) && raw.multiplier > 0) c.multiplier = raw.multiplier;
  if (Array.isArray(raw.comboLegs)) {
    const legs = raw.comboLegs.map(sanitizeComboLeg).filter((l): l is ComboLeg => l !== null);
    if (legs.length) c.comboLegs = legs;
  }
  return c;
}

/** Maps an array, dropping entries the sanitizer rejects. Returns null when `raw` is not an array. */
function sanitizeList<T>(raw: unknown, item: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const v of raw) {
    const s = item(v);
    if (s !== null) out.push(s);
  }
  return out;
}

/** Drops later entries whose id was already seen. */
function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Watchlists

function sanitizeWatchItem(raw: unknown): WatchItem | null {
  if (!isObject(raw)) return null;
  const contract = sanitizeContract(raw.contract);
  if (!contract) return null;
  const name = raw.name === undefined ? null : sanitizeLocalizedName(raw.name);
  return name === null ? { contract } : { contract, name };
}

function sanitizeWatchGroup(raw: unknown): WatchGroup | null {
  if (!isObject(raw) || !nonEmpty(raw.id)) return null;
  const name = sanitizeLocalizedName(raw.name);
  if (name === null) return null;
  return { id: raw.id, name, items: sanitizeList(raw.items, sanitizeWatchItem) ?? [] };
}

function sanitizeWatchlist(raw: unknown): Watchlist | null {
  if (!isObject(raw) || !nonEmpty(raw.id)) return null;
  const name = sanitizeLocalizedName(raw.name);
  if (name === null) return null;
  const groups = uniqueById(sanitizeList(raw.groups, sanitizeWatchGroup) ?? []);
  return { id: raw.id, name, groups };
}

/**
 * Validates watchlists and keeps the built-in lists intact: they cannot be deleted or renamed,
 * so missing ones are restored from `defaults` and their name and flag come from there too.
 * Returns null when `raw` is not an array.
 */
export function sanitizeWatchlists(raw: unknown, defaults: Watchlist[]): Watchlist[] | null {
  const lists = sanitizeList(raw, sanitizeWatchlist);
  if (!lists) return null;
  const builtins = new Map(defaults.filter((l) => l.builtin).map((l) => [l.id, l]));
  const out = uniqueById(lists).map((l) => {
    const b = builtins.get(l.id);
    return b ? { ...l, name: b.name, builtin: true } : l;
  });
  defaults.forEach((b, i) => {
    if (b.builtin && !out.some((l) => l.id === b.id)) out.splice(Math.min(i, out.length), 0, b);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Price alerts
//
// Two shapes are read and the current one is written:
// - v1 (Tape 0.12 and older): { condition: 'above' | 'below', price, repeat }, migrated to a
//   priceAbove / priceBelow rule; repeat → frequency 'always' (re-arms after crossing back, as
//   before), otherwise 'once'. Only loading migrates: the file is rewritten with the next change.
// - v2: { rule, frequency, sessions?, note?, updatedAt?, lastValue? }. A rule or frequency this
//   version does not know (a newer Tape's, or parameters it cannot read) is kept as written,
//   including on / off, and marked `unsupported`, so a downgrade neither deletes nor turns off an
//   alert (main writes the whole list back with any change); it is never evaluated here.
// Price rules also get the v1 fields (condition, price, repeat) on write, so Tape 0.12 keeps them
// after a downgrade (its loader requires those fields and drops the rest).

const isPositive = (v: unknown): v is number => isFiniteNumber(v) && v > 0;
const isPeriod = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_INDICATOR_PERIOD;
const isLevel = (v: unknown, lo = 0, hi = 100): v is number => isFiniteNumber(v) && v >= lo && v <= hi;
const isCross = (v: unknown): v is AlertCross => v === 'up' || v === 'down';

function sanitizeSignal(raw: unknown): IndicatorSignal | null {
  if (!isObject(raw) || !isCross(raw.cross)) return null;
  const cross = raw.cross;
  const lines = (fast: unknown, slow: unknown) => isPeriod(fast) && isPeriod(slow) && fast < slow;
  switch (raw.ind) {
    case 'ma':
    case 'ema':
      if (raw.kind === 'price' && isPeriod(raw.period)) return { ind: raw.ind, kind: 'price', period: raw.period, cross };
      if (raw.kind === 'lines' && lines(raw.fast, raw.slow)) return { ind: raw.ind, kind: 'lines', fast: raw.fast as number, slow: raw.slow as number, cross };
      return null;
    case 'macd':
      if ((raw.kind !== 'signal' && raw.kind !== 'zero') || !lines(raw.fast, raw.slow) || !isPeriod(raw.signal)) return null;
      return { ind: 'macd', kind: raw.kind, fast: raw.fast as number, slow: raw.slow as number, signal: raw.signal, cross };
    case 'kdj': {
      if (!isPeriod(raw.n) || !isPeriod(raw.m1) || !isPeriod(raw.m2)) return null;
      const { n, m1, m2 } = raw;
      if (raw.kind === 'cross') return { ind: 'kdj', kind: 'cross', n, m1, m2, cross };
      if (raw.kind !== 'level' || (raw.line !== 'k' && raw.line !== 'd' && raw.line !== 'j')) return null;
      // J = 3K − 2D runs beyond 0–100.
      if (!(raw.line === 'j' ? isLevel(raw.level, -50, 150) : isLevel(raw.level))) return null;
      return { ind: 'kdj', kind: 'level', n, m1, m2, line: raw.line, level: raw.level as number, cross };
    }
    case 'rsi':
      if (raw.kind === 'level' && isPeriod(raw.period) && isLevel(raw.level)) return { ind: 'rsi', kind: 'level', period: raw.period, level: raw.level, cross };
      if (raw.kind === 'lines' && lines(raw.fast, raw.slow)) return { ind: 'rsi', kind: 'lines', fast: raw.fast as number, slow: raw.slow as number, cross };
      return null;
    case 'boll':
      if (raw.kind !== 'band' || !isPeriod(raw.period) || raw.period < 2 || !isFiniteNumber(raw.k) || raw.k <= 0 || raw.k > 5) return null;
      if (raw.band !== 'upper' && raw.band !== 'middle' && raw.band !== 'lower') return null;
      return { ind: 'boll', kind: 'band', period: raw.period, k: raw.k, band: raw.band, cross };
    default:
      return null;
  }
}

/** A valid rule of a known type, else null (unknown type or invalid parameters). */
export function sanitizeRule(raw: unknown): AlertRule | null {
  if (!isObject(raw)) return null;
  const pct = (v: unknown): v is number => isPositive(v) && v <= 1000;
  switch (raw.type) {
    case 'priceAbove':
    case 'priceBelow':
    case 'bidAbove':
    case 'askBelow':
      return isPositive(raw.value) ? { type: raw.type, value: raw.value } : null;
    case 'dayRise':
    case 'dayFall':
      return pct(raw.pct) ? { type: raw.type, pct: raw.pct } : null;
    case 'windowRise':
    case 'windowFall':
      return pct(raw.pct) && (raw.minutes === 3 || raw.minutes === 5) ? { type: raw.type, minutes: raw.minutes, pct: raw.pct } : null;
    case 'volumeAbove':
    case 'bidSizeAbove':
    case 'askSizeAbove':
      return isPositive(raw.shares) ? { type: raw.type, shares: raw.shares } : null;
    case 'turnoverAbove':
      return isPositive(raw.amount) ? { type: 'turnoverAbove', amount: raw.amount } : null;
    case 'indicator': {
      if (!ALERT_TIMEFRAMES.includes(raw.timeframe as AlertTimeframe) || (raw.on !== 'close' && raw.on !== 'live')) return null;
      const signal = sanitizeSignal(raw.signal);
      return signal ? { type: 'indicator', timeframe: raw.timeframe as AlertTimeframe, on: raw.on, signal } : null;
    }
    case 'halt':
      return raw.dir === 'halted' || raw.dir === 'resumed' ? { type: 'halt', dir: raw.dir } : null;
    default:
      return null;
  }
}

/** A non-empty subset of the sessions in canonical order; undefined for the default (or nothing valid). */
function sanitizeSessions(raw: unknown): AlertSession[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const picked = ALERT_SESSIONS.filter((s) => raw.includes(s));
  if (!picked.length || (picked.length === DEFAULT_ALERT_SESSIONS.length && DEFAULT_ALERT_SESSIONS.every((s) => picked.includes(s)))) return undefined;
  return picked;
}

/** Adds the v1 fields (condition, price, repeat) to price rules, read by Tape 0.12 and older. */
function withLegacyMirror(a: PriceAlert): PriceAlert {
  if (a.unsupported || (a.rule.type !== 'priceAbove' && a.rule.type !== 'priceBelow')) return a;
  return { ...a, condition: a.rule.type === 'priceAbove' ? 'above' : 'below', price: a.rule.value, repeat: a.frequency === 'always' };
}

function sanitizeAlert(raw: unknown): PriceAlert | null {
  if (!isObject(raw) || !nonEmpty(raw.id) || !isFiniteNumber(raw.createdAt)) return null;
  const contract = sanitizeContract(raw.contract);
  if (!contract) return null;
  const optional: Partial<PriceAlert> = {};
  if (isFiniteNumber(raw.updatedAt)) optional.updatedAt = raw.updatedAt;
  if (isFiniteNumber(raw.lastTriggeredAt)) optional.lastTriggeredAt = raw.lastTriggeredAt;
  if (isFiniteNumber(raw.lastValue)) optional.lastValue = raw.lastValue;
  const note = clipNote(raw.note);
  if (note) optional.note = note;

  if (raw.rule === undefined) {
    // v1
    if (raw.condition !== 'above' && raw.condition !== 'below') return null;
    if (!isPositive(raw.price)) return null;
    return withLegacyMirror({
      id: raw.id,
      contract,
      rule: { type: raw.condition === 'above' ? 'priceAbove' : 'priceBelow', value: raw.price },
      frequency: raw.repeat === true ? 'always' : 'once',
      active: raw.active !== false,
      createdAt: raw.createdAt,
      ...optional,
    });
  }

  const frequency = raw.frequency === undefined ? 'once' : ALERT_FREQUENCIES.includes(raw.frequency as AlertFrequency) ? (raw.frequency as AlertFrequency) : null;
  const rule = sanitizeRule(raw.rule);
  if (!rule || !frequency) {
    // A newer Tape's rule or frequency (or one this version cannot read): kept as written,
    // including on / off (the newer Tape runs it again), never evaluated here.
    if (!isObject(raw.rule) || !nonEmpty(raw.rule.type)) return null;
    const kept: PriceAlert = {
      id: raw.id,
      contract,
      rule: raw.rule as unknown as AlertRule,
      frequency: (nonEmpty(raw.frequency) ? raw.frequency : 'once') as AlertFrequency,
      active: raw.active !== false,
      createdAt: raw.createdAt,
      ...optional,
      unsupported: true,
    };
    if (Array.isArray(raw.sessions) && raw.sessions.length && raw.sessions.every(nonEmpty)) kept.sessions = raw.sessions as AlertSession[];
    return kept;
  }
  const sessions = sanitizeSessions(raw.sessions);
  if (sessions) optional.sessions = sessions;
  return withLegacyMirror({ id: raw.id, contract, rule, frequency, active: raw.active !== false, createdAt: raw.createdAt, ...optional });
}

/**
 * Validates the alerts file (or main's list before it is written). Entries without an id, an
 * instrument or a creation time are dropped, and so are v1 entries that are not a valid price alert.
 */
export function sanitizeAlerts(raw: unknown): PriceAlert[] | null {
  const list = sanitizeList(raw, sanitizeAlert);
  return list && uniqueById(list);
}

/**
 * An alert the renderer sends to be created or edited (upsertPriceAlert): a valid v2 alert of a
 * known type, or null. Unlike a file, nothing unknown is accepted.
 */
export function sanitizeAlertInput(raw: unknown): PriceAlert | null {
  if (!isObject(raw) || raw.rule === undefined) return null;
  const alert = sanitizeAlert(raw);
  return alert && !alert.unsupported ? alert : null;
}

// ---------------------------------------------------------------------------
// Notifications

/** Kinds a notification can be critical in (AppNotification.critical): orders, connection, option risk. */
export const CRITICAL_KINDS: readonly NotificationKind[] = ['order', 'conn', 'opt'];

/** Kinds a notification names an account in (AppNotification.account): orders, fills, option risk. */
export const ACCOUNT_KINDS: readonly NotificationKind[] = ['order', 'fill', 'opt'];

/** The account of a notice of `kind` (AppNotification.account): an IB account id, else undefined. */
export function sanitizeNoticeAccount(raw: unknown, kind: NotificationKind): string | undefined {
  return ACCOUNT_KINDS.includes(kind) && typeof raw === 'string' && raw.length > 0 && raw.length < 32 ? raw : undefined;
}

function sanitizeNotification(raw: unknown): AppNotification | null {
  if (!isObject(raw) || !nonEmpty(raw.id) || !isFiniteNumber(raw.t)) return null;
  if (!NOTIFICATION_KINDS.includes(raw.kind as NotificationKind)) return null;
  const title = sanitizeLocalizedText(raw.title);
  const body = sanitizeLocalizedText(raw.body);
  if (!title || !body) return null;
  const n: AppNotification = { id: raw.id, t: raw.t, kind: raw.kind as NotificationKind, title, body, read: raw.read === true };
  const contract = raw.contract === undefined ? null : sanitizeContract(raw.contract);
  if (contract) n.contract = contract;
  if (raw.orderDone === true && n.kind === 'order') n.orderDone = true;
  if (raw.critical === true && CRITICAL_KINDS.includes(n.kind)) n.critical = true;
  const account = sanitizeNoticeAccount(raw.account, n.kind);
  if (account) n.account = account;
  return n;
}

/** Newest first, capped at MAX_NOTIFICATIONS. */
export function sanitizeNotifications(raw: unknown): AppNotification[] | null {
  const list = sanitizeList(raw, sanitizeNotification);
  return list && capNotifications(uniqueById(list).sort((a, b) => b.t - a.t));
}

export function capNotifications(list: AppNotification[]): AppNotification[] {
  return list.length > MAX_NOTIFICATIONS ? list.slice(0, MAX_NOTIFICATIONS) : list;
}

// ---------------------------------------------------------------------------
// Window bounds

export function sanitizeWindowBounds(raw: unknown): WindowBounds | null {
  if (!isObject(raw) || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) return null;
  const size = (n: number) => Math.min(20_000, Math.max(200, Math.round(n)));
  const b: WindowBounds = { width: size(raw.width), height: size(raw.height) };
  if (isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
    b.x = Math.round(raw.x);
    b.y = Math.round(raw.y);
  }
  if (typeof raw.maximized === 'boolean') b.maximized = raw.maximized;
  return b;
}
