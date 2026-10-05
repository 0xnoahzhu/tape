// The sound part of an OS notification (pure, no Electron; used by notifications.ts).
//
// Whether a notification shows at all (per-kind switch, do-not-disturb) is decided before this
// (notificationModel.ts → shouldShowSystem): a notification that is not shown makes no sound.
//
//   macOS    { silent: true } + Tape plays /System/Library/Sounds/<name>.aiff once the
//            notification is posted (its 'show' event; soundPlayer.ts). Electron 44 hands
//            `sound` to UNNotificationSound soundNamed:, which only finds files in the app's
//            Library/Sounds or main bundle, and on current macOS the notification daemon also
//            rejects any name that is not a ToneLibrary tone ("Glass", "Glass.aiff" and bundled
//            files alike), so every category would play the same default sound. Trade-off: the
//            OS Focus modes and the per-app "Play sound for notifications" switch do not mute
//            Tape's sound; Tape's own Sound switch and do-not-disturb do.
//   Windows  { toastXml }: Electron's generated toast has no sound choice, so Tape writes the
//            same toast itself (title, body, the theme's icon) plus <audio>. Electron still
//            creates the toast (id → Tag, groupId → Group) and wires its events: a click on the
//            toast body (no `arguments`) raises `click` as before.
//   Linux    { silent }: Electron's libnotify backend ignores both `silent` and `sound`, so the
//            notification server decides; there is nothing to choose.

import { NO_SOUND, macSoundFile, resolveSound, soundCategory, soundPlatform } from '@shared/notificationSounds';
import type { NotificationKind, Settings } from '@shared/types';

/** The sound id a notification of `kind` plays on `platform`, or null when it is silent. */
export function notificationSound(settings: Settings, kind: NotificationKind, platform: string): string | null {
  const { sound, sounds } = settings.notifications;
  if (!sound) return null;
  const category = soundCategory(kind);
  const id = resolveSound(platform, category, sounds[category]);
  return id === NO_SOUND ? null : id;
}

export interface SoundOptions {
  silent: boolean;
  sound?: string;
  toastXml?: string;
}

export interface ToastContent {
  title: string;
  body: string;
  /** Absolute path of the icon image (Windows), or null for none. */
  iconPath: string | null;
}

/**
 * Electron Notification options for `sound` (null = silent) on `platform`. On macOS the
 * notification is always silent: Tape plays the sound itself (soundFile).
 */
export function soundOptions(platform: string, sound: string | null, content: ToastContent): SoundOptions {
  switch (soundPlatform(platform)) {
    case 'darwin':
      return { silent: true };
    case 'win32':
      return { silent: sound === null, toastXml: toastXml(content, sound) };
    default:
      return { silent: sound === null };
  }
}

/** The file Tape plays itself when the notification has been posted (macOS), or null. */
export function soundFile(platform: string, sound: string | null): string | null {
  return sound && soundPlatform(platform) === 'darwin' ? macSoundFile(sound) : null;
}

/** Escapes text for XML element content and attribute values. */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Characters XML 1.0 does not allow at all (control characters other than tab, LF and CR). */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const text = (s: string) => escapeXml(s.replace(INVALID_XML, ''));

/**
 * The toast Electron would generate for title + body + icon (ToastGeneric, the icon as app logo),
 * with the category's sound event or silent audio.
 */
export function toastXml({ title, body, iconPath }: ToastContent, sound: string | null): string {
  const lines = title && body ? [title, body] : [title || body || '[no message]'];
  const image = iconPath ? `<image id="1" placement="appLogoOverride" hint-crop="none" src="${text(iconPath)}"/>` : '';
  const audio = sound ? `<audio src="ms-winsoundevent:${text(sound)}"/>` : '<audio silent="true"/>';
  return (
    '<toast><visual><binding template="ToastGeneric">' +
    lines.map((l) => `<text>${text(l)}</text>`).join('') +
    image +
    '</binding></visual>' +
    audio +
    '</toast>'
  );
}
