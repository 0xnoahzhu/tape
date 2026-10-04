// Validation and merging for the persisted JSON files.
//
// Pure (no Electron, no fs) so it can be unit tested. Every loader takes `unknown` (whatever
// JSON.parse produced, or whatever the renderer sent over IPC) and returns well-typed data:
// unknown keys are dropped, types are coerced where the intent is clear, numbers are clamped,
// and entries that cannot be repaired are skipped.

import { NOTIFICATION_KINDS } from '@shared/defaults';
import type {
  AppNotification,
  ComboLeg,
  ContractRef,
  DeepPartial,
  LocalizedName,
  LocalizedText,
  NavPoint,
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
  trading: { confirmOrders: bool, defaultQty: int(1, 10_000_000), outsideRthDefault: bool },
  appearance: {
    theme: oneOf(['system', 'dark', 'light']),
    language: oneOf(['en', 'zh']),
    upColor: oneOf(['cn', 'us']),
    showAccountId: bool,
  },
  features: { depth: bool, options: bool, flow: bool },
  notifications: { system: notificationRules, sound: bool, dnd: bool },
  apiLog: { writeFile: bool, keepDays: nearest(KEEP_DAYS) },
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

/** Saved settings deep-merged over the defaults. */
export function loadSettings(raw: unknown, defaults: Settings): Settings {
  return sanitize(SETTINGS_SPEC, raw, defaults);
}

/**
 * Whether saved settings have Tape's former read-only switch (`connection.readOnly`) on. The
 * switch was removed (TWS / IB Gateway's own "Read-Only API" blocks orders); loadSettings drops
 * the key, and the store tells a user who had it on, once.
 */
export function hadReadOnlyMode(raw: unknown): boolean {
  return isObject(raw) && isObject(raw.connection) && bool(raw.connection.readOnly, false);
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

function sanitizeAlert(raw: unknown): PriceAlert | null {
  if (!isObject(raw) || !nonEmpty(raw.id)) return null;
  const contract = sanitizeContract(raw.contract);
  if (!contract) return null;
  if (raw.condition !== 'above' && raw.condition !== 'below') return null;
  if (!isFiniteNumber(raw.price) || !isFiniteNumber(raw.createdAt)) return null;
  const alert: PriceAlert = {
    id: raw.id,
    contract,
    condition: raw.condition,
    price: raw.price,
    repeat: raw.repeat === true,
    createdAt: raw.createdAt,
    active: raw.active !== false,
  };
  if (isFiniteNumber(raw.lastTriggeredAt)) alert.lastTriggeredAt = raw.lastTriggeredAt;
  return alert;
}

export function sanitizeAlerts(raw: unknown): PriceAlert[] | null {
  const list = sanitizeList(raw, sanitizeAlert);
  return list && uniqueById(list);
}

// ---------------------------------------------------------------------------
// Notifications

function sanitizeNotification(raw: unknown): AppNotification | null {
  if (!isObject(raw) || !nonEmpty(raw.id) || !isFiniteNumber(raw.t)) return null;
  if (!NOTIFICATION_KINDS.includes(raw.kind as NotificationKind)) return null;
  const title = sanitizeLocalizedText(raw.title);
  const body = sanitizeLocalizedText(raw.body);
  if (!title || !body) return null;
  const n: AppNotification = { id: raw.id, t: raw.t, kind: raw.kind as NotificationKind, title, body, read: raw.read === true };
  const contract = raw.contract === undefined ? null : sanitizeContract(raw.contract);
  if (contract) n.contract = contract;
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
// NAV history and window bounds

function sanitizeNavPoint(raw: unknown): NavPoint | null {
  if (!isObject(raw) || !isFiniteNumber(raw.t) || !isFiniteNumber(raw.netLiq)) return null;
  return { t: raw.t, netLiq: raw.netLiq };
}

/** Oldest first. */
export function sanitizeNav(raw: unknown): NavPoint[] | null {
  const list = sanitizeList(raw, sanitizeNavPoint);
  return list && list.sort((a, b) => a.t - b.t);
}

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
