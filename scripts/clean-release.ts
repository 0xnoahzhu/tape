// Leaves only the installers in release/: macOS .dmg and Windows setup .exe. electron-builder
// also writes unpacked apps (mac-arm64/, win-unpacked/), block maps and debug files.

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'release';
const keep = (name: string) => name.endsWith('.dmg') || name.endsWith('-setup.exe');

let entries: string[] = [];
try {
  entries = readdirSync(dir);
} catch {
  process.exit(0);
}
for (const name of entries) {
  if (!keep(name)) rmSync(join(dir, name), { recursive: true, force: true });
}
console.log(`release/: ${readdirSync(dir).join(', ') || '(empty)'}`);
