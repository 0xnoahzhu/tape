import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, defaultSettings } from './defaults';
import {
  CATEGORY_KINDS,
  KNOWN_SOUNDS,
  MAC_SOUNDS,
  NO_SOUND,
  PLATFORM_SOUNDS,
  SOUND_CATEGORIES,
  WINDOWS_SOUNDS,
  defaultSounds,
  macSoundFile,
  resolveSound,
  soundCategory,
  soundPlatform,
} from './notificationSounds';

describe('soundCategory', () => {
  it('maps orders, fills and everything else', () => {
    expect(soundCategory('order')).toBe('order');
    expect(soundCategory('fill')).toBe('fill');
    for (const kind of ['price', 'opt', 'conn', 'sys'] as const) expect(soundCategory(kind)).toBe('other');
  });

  it('CATEGORY_KINDS lists every kind once, in the category soundCategory gives it', () => {
    const listed = SOUND_CATEGORIES.flatMap((c) => CATEGORY_KINDS[c].map((kind) => [kind, c] as const));
    expect(listed.map(([kind]) => kind).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const [kind, c] of listed) expect(soundCategory(kind)).toBe(c);
  });
});

describe('platform sounds', () => {
  it('treats unknown platforms like Linux', () => {
    expect(soundPlatform('darwin')).toBe('darwin');
    expect(soundPlatform('win32')).toBe('win32');
    expect(soundPlatform('linux')).toBe('linux');
    expect(soundPlatform('freebsd')).toBe('linux');
  });

  it('offers the macOS system sounds and the Windows toast sound events', () => {
    expect(PLATFORM_SOUNDS.darwin).toContain('Glass');
    expect(PLATFORM_SOUNDS.darwin).toHaveLength(14);
    // No Notification.SMS: the default Windows scheme plays the IM file for it.
    expect(PLATFORM_SOUNDS.win32).toEqual(['Notification.Default', 'Notification.IM', 'Notification.Mail', 'Notification.Reminder']);
    expect(PLATFORM_SOUNDS.linux).toEqual(['default']);
    expect(KNOWN_SOUNDS).toEqual(expect.arrayContaining([NO_SOUND, ...MAC_SOUNDS, ...WINDOWS_SOUNDS, 'default', 'Notification.SMS']));
  });

  it('has distinct defaults per category on macOS and Windows, all from the platform list', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const d = defaultSounds(platform);
      expect(new Set(Object.values(d)).size).toBe(3);
      for (const id of Object.values(d)) expect(PLATFORM_SOUNDS[platform]).toContain(id);
    }
    expect(defaultSounds('darwin')).toEqual({ order: 'Tink', fill: 'Glass', other: 'Purr' });
    expect(defaultSounds('linux')).toEqual({ order: 'default', fill: 'default', other: 'default' });
  });

  it('macSoundFile is the system alert sound file', () => {
    expect(macSoundFile('Purr')).toBe('/System/Library/Sounds/Purr.aiff');
  });

  it('defaultSettings takes the platform defaults', () => {
    expect(defaultSettings('en').notifications.sounds).toEqual(defaultSounds('darwin'));
    expect(defaultSettings('zh', 'win32').notifications.sounds).toEqual(defaultSounds('win32'));
  });

  it('resolveSound keeps the platform own ids and None, and falls back to the category default', () => {
    expect(resolveSound('darwin', 'fill', 'Hero')).toBe('Hero');
    expect(resolveSound('darwin', 'fill', NO_SOUND)).toBe(NO_SOUND);
    expect(resolveSound('win32', 'order', 'Notification.Mail')).toBe('Notification.Mail');
    // A profile copied from another platform.
    expect(resolveSound('win32', 'fill', 'Glass')).toBe('Notification.Reminder');
    expect(resolveSound('darwin', 'order', 'Notification.IM')).toBe('Tink');
    expect(resolveSound('linux', 'other', 'Pop')).toBe('default');
    expect(resolveSound('darwin', 'other', 'nope')).toBe('Purr');
    // Offered by an earlier build: still loads, plays the category default.
    expect(resolveSound('win32', 'fill', 'Notification.SMS')).toBe('Notification.Reminder');
  });
});
