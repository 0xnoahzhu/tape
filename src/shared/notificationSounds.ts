// Notification sounds: three categories (orders, fills, everything else), each with its own
// native sound, so an order acknowledgement, a fill and an alert can be told apart by ear.
//
// The sounds are the OS's own, tied to the OS notification (main/notificationSound.ts):
//   macOS    a system alert sound (/System/Library/Sounds/<name>.aiff), played by Tape when the
//            notification has been posted; the notification itself is silent. macOS cannot play
//            these by name with a notification (see main/notificationSound.ts).
//   Windows  toast <audio src="ms-winsoundevent:…">, played by the toast itself
//   Linux    no choice: the notification server decides (Electron cannot set or suppress it), so
//            Settings shows no per-category rows there
//
// A setting holds a sound id. Every id of every platform is valid in the settings file (so a
// profile copied between machines loads); an id the running platform does not have resolves to
// that platform's default for the category.

import type { NotificationKind } from './types';

export type SoundCategory = 'order' | 'fill' | 'other';
export const SOUND_CATEGORIES: readonly SoundCategory[] = ['order', 'fill', 'other'];

/** The notification kinds whose sound each category sets. */
export const CATEGORY_KINDS: Record<SoundCategory, readonly NotificationKind[]> = {
  order: ['order'],
  fill: ['fill'],
  other: ['price', 'opt', 'conn', 'sys'],
};

/** Orders (submitted, modified, cancelled, rejected), fills (also partial), everything else. */
export function soundCategory(kind: NotificationKind): SoundCategory {
  return kind === 'order' ? 'order' : kind === 'fill' ? 'fill' : 'other';
}

export type SoundPlatform = 'darwin' | 'win32' | 'linux';

/** Platforms without a sound list of their own behave like Linux. */
export function soundPlatform(platform: string): SoundPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

/** No sound for the category (its notifications still show, silently). */
export const NO_SOUND = 'none';

/** macOS system alert sounds (/System/Library/Sounds/<name>.aiff). */
export const MAC_SOUNDS = [
  'Basso',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Glass',
  'Hero',
  'Morse',
  'Ping',
  'Pop',
  'Purr',
  'Sosumi',
  'Submarine',
  'Tink',
] as const;

/** Absolute path of a macOS system alert sound. */
export function macSoundFile(name: string): string {
  return `/System/Library/Sounds/${name}.aiff`;
}

/**
 * Windows toast sound events (`ms-winsoundevent:<id>`); the user's sound scheme decides the file.
 * Notification.SMS is left out: the default scheme plays the same file for it as for IM.
 */
export const WINDOWS_SOUNDS = ['Notification.Default', 'Notification.IM', 'Notification.Mail', 'Notification.Reminder'] as const;

/** Ids an earlier build offered; they still load and resolve to the category's default. */
const RETIRED_SOUNDS = ['Notification.SMS'] as const;

/** Linux: the notification server's default sound. */
export const LINUX_SOUNDS = ['default'] as const;

/** The sounds each platform offers, without NO_SOUND. */
export const PLATFORM_SOUNDS: Record<SoundPlatform, readonly string[]> = {
  darwin: MAC_SOUNDS,
  win32: WINDOWS_SOUNDS,
  linux: LINUX_SOUNDS,
};

/** Every id the settings file may hold. */
export const KNOWN_SOUNDS: readonly string[] = [NO_SOUND, ...MAC_SOUNDS, ...WINDOWS_SOUNDS, ...LINUX_SOUNDS, ...RETIRED_SOUNDS];

/**
 * Defaults, distinct per category: a short neutral tick for orders, a bright chime for fills,
 * a softer, lower tone for the rest (Purr: Pop is a second click like Tink and among the
 * quietest). Windows: Messaging, Calendar and the generic notify sound of the default scheme.
 */
const DEFAULTS: Record<SoundPlatform, Record<SoundCategory, string>> = {
  darwin: { order: 'Tink', fill: 'Glass', other: 'Purr' },
  win32: { order: 'Notification.IM', fill: 'Notification.Reminder', other: 'Notification.Default' },
  linux: { order: 'default', fill: 'default', other: 'default' },
};

export function defaultSounds(platform: string): Record<SoundCategory, string> {
  return { ...DEFAULTS[soundPlatform(platform)] };
}

/** The sound to use on `platform`: the saved id when the platform has it, else the category's default. */
export function resolveSound(platform: string, category: SoundCategory, id: string): string {
  const p = soundPlatform(platform);
  return id === NO_SOUND || PLATFORM_SOUNDS[p].includes(id) ? id : DEFAULTS[p][category];
}
