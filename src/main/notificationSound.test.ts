import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { Settings } from '@shared/types';
import { escapeXml, notificationSound, soundFile, soundOptions, toastXml } from './notificationSound';

function settings(patch: Partial<Settings['notifications']> = {}, platform = 'darwin'): Settings {
  const s = defaultSettings('en', platform);
  return { ...s, notifications: { ...s.notifications, ...patch } };
}

describe('notificationSound', () => {
  it('picks the sound of the kind category', () => {
    const s = settings({ sounds: { order: 'Tink', fill: 'Glass', other: 'Purr' } });
    expect(notificationSound(s, 'order', 'darwin')).toBe('Tink');
    expect(notificationSound(s, 'fill', 'darwin')).toBe('Glass');
    for (const kind of ['price', 'opt', 'conn', 'sys'] as const) expect(notificationSound(s, kind, 'darwin')).toBe('Purr');
  });

  it('is silent with the Sound switch off or None', () => {
    expect(notificationSound(settings({ sound: false }), 'fill', 'darwin')).toBeNull();
    const none = settings({ sounds: { order: 'none', fill: 'Glass', other: 'Purr' } });
    expect(notificationSound(none, 'order', 'darwin')).toBeNull();
    expect(notificationSound(none, 'fill', 'darwin')).toBe('Glass');
  });

  it('falls back to the platform default for another platform id', () => {
    const s = settings({ sounds: { order: 'Tink', fill: 'Glass', other: 'Pop' } });
    expect(notificationSound(s, 'fill', 'win32')).toBe('Notification.Reminder');
    expect(notificationSound(s, 'order', 'linux')).toBe('default');
  });
});

describe('soundOptions', () => {
  const content = { title: 'Filled', body: 'BUY 100 AAPL', iconPath: null };

  it('macOS: always a silent notification (Tape plays the sound file itself), never a sound name', () => {
    expect(soundOptions('darwin', 'Glass', content)).toEqual({ silent: true });
    expect(soundOptions('darwin', null, content)).toEqual({ silent: true });
  });

  it('Windows: a toast with the sound event, or silent audio', () => {
    const loud = soundOptions('win32', 'Notification.Reminder', content);
    expect(loud.silent).toBe(false);
    expect(loud.sound).toBeUndefined();
    expect(loud.toastXml).toBe(
      '<toast><visual><binding template="ToastGeneric"><text>Filled</text><text>BUY 100 AAPL</text></binding></visual>' +
        '<audio src="ms-winsoundevent:Notification.Reminder"/></toast>',
    );
    const quiet = soundOptions('win32', null, content);
    expect(quiet.silent).toBe(true);
    expect(quiet.toastXml).toContain('<audio silent="true"/>');
    expect(quiet.toastXml).not.toContain('ms-winsoundevent');
  });

  it('Linux: only silent or not (which libnotify ignores)', () => {
    expect(soundOptions('linux', 'default', content)).toEqual({ silent: false });
    expect(soundOptions('linux', null, content)).toEqual({ silent: true });
  });
});

describe('soundFile', () => {
  it('macOS: the system alert sound file; elsewhere and when silent: none', () => {
    expect(soundFile('darwin', 'Glass')).toBe('/System/Library/Sounds/Glass.aiff');
    expect(soundFile('darwin', null)).toBeNull();
    expect(soundFile('win32', 'Notification.IM')).toBeNull();
    expect(soundFile('linux', 'default')).toBeNull();
  });

  it('only ever names a file of the macOS list (saved ids are resolved first)', () => {
    const s = settings({ sounds: { order: '../../../tmp/x', fill: 'Notification.Mail', other: 'Purr' } });
    expect(soundFile('darwin', notificationSound(s, 'order', 'darwin'))).toBe('/System/Library/Sounds/Tink.aiff');
    expect(soundFile('darwin', notificationSound(s, 'fill', 'darwin'))).toBe('/System/Library/Sounds/Glass.aiff');
  });
});

describe('toastXml', () => {
  it('escapes the title, body and icon path', () => {
    const xml = toastXml({ title: 'P&L <alert>', body: `"AT&T" isn't 'x'`, iconPath: 'C:\\Tape & Co\\icon"1".png' }, 'Notification.IM');
    expect(xml).toContain('<text>P&amp;L &lt;alert&gt;</text>');
    expect(xml).toContain('<text>&quot;AT&amp;T&quot; isn&apos;t &apos;x&apos;</text>');
    expect(xml).toContain('<image id="1" placement="appLogoOverride" hint-crop="none" src="C:\\Tape &amp; Co\\icon&quot;1&quot;.png"/>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('drops characters XML cannot hold and keeps a single line when one text is empty', () => {
    expect(toastXml({ title: 'a\u0000b\u001Fc', body: '', iconPath: null }, null)).toBe(
      '<toast><visual><binding template="ToastGeneric"><text>abc</text></binding></visual><audio silent="true"/></toast>',
    );
    expect(toastXml({ title: '', body: '', iconPath: null }, null)).toContain('<text>[no message]</text>');
  });

  it('escapeXml', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  });
});
