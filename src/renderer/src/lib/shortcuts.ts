// Keyboard shortcut labels: ⌘ glyphs on macOS, "Ctrl+" elsewhere.

/** "⌘K" / "⌘⇧L" on macOS, "Ctrl+K" / "Ctrl+Shift+L" on Windows and Linux. */
export function modKey(mac: boolean, key: string, shift = false): string {
  return mac ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
