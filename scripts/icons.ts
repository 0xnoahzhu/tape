// Renders the app icons from resources/icons/icon-{dark,light}.svg (design: "Tape App Icon" 4a).
//
//   pnpm icons
//
// resources/icons/ (shipped as extraResources, used at runtime by src/main/appearance.ts)
//   icon-<theme>.png        1024 px macOS dock icon: Apple icon grid (824 px artwork, 100 px
//                           margin) with a soft drop shadow, like Big Sur style app icons
//   icon-<theme>-256.png    full-bleed window / taskbar / notification icon (Windows, Linux)
//   icon-<theme>-512.png    full-bleed, larger
// build/ (electron-builder)
//   icon.png                1024 px, light, macOS style
//   icon.icns               macOS bundle icon via iconutil (macOS only)
//   icon.ico                Windows icon, full-bleed light, 16–256 px PNG entries
// The bundle icons (Finder, Launchpad, the DMG, the taskbar before the app runs) are the light ones,
// like the Light theme that Settings lists first; at run time the icon follows the resolved theme.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

type Theme = 'dark' | 'light';

/** Theme of the icons electron-builder puts into the app bundle and installers. */
const BUNDLE_THEME: Theme = 'light';

const root = fileURLToPath(new URL('..', import.meta.url));
const iconsDir = join(root, 'resources', 'icons');
const buildDir = join(root, 'build');

const CANVAS = 1024;
const ARTWORK = 824;
const MARGIN = (CANVAS - ARTWORK) / 2;
// CSS "0 10px 20px rgba(0,0,0,.25)": a 20 px blur radius is a Gaussian with σ = 10.
const SHADOW = { dy: 10, stdDeviation: 10, opacity: 0.25 };

function source(theme: Theme): string {
  return readFileSync(join(iconsDir, `icon-${theme}.svg`), 'utf8');
}

/** The markup inside the root <svg> element of a 100×100 icon. */
function artwork(theme: Theme): string {
  const match = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source(theme));
  if (!match) throw new Error(`icon-${theme}.svg has no <svg> root`);
  return match[1];
}

/** The 100-unit artwork centred on a 1024 canvas with the macOS margin and shadow. */
function macSvg(theme: Theme): string {
  const scale = ARTWORK / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${SHADOW.dy}" stdDeviation="${SHADOW.stdDeviation}" flood-color="#000" flood-opacity="${SHADOW.opacity}"/>
    </filter>
  </defs>
  <g filter="url(#shadow)">
    <g transform="translate(${MARGIN} ${MARGIN}) scale(${scale})">${artwork(theme)}</g>
  </g>
</svg>`;
}

function render(svg: string, size: number): Buffer {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } });
  return resvg.render().asPng();
}

const written: string[] = [];
function write(path: string, data: Buffer): void {
  writeFileSync(path, data);
  written.push(relative(root, path));
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function ico(images: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, e); // width, 0 means 256
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
    entries.writeUInt8(0, e + 2); // palette size
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

function icns(theme: Theme, out: string): void {
  if (process.platform !== 'darwin') {
    console.warn('icons: skipping icon.icns (iconutil is only available on macOS)');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'tape-icons-'));
  const iconset = join(tmp, 'icon.iconset');
  mkdirSync(iconset);
  const svg = macSvg(theme);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      writeFileSync(join(iconset, `icon_${size}x${size}.png`), render(svg, size));
      writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), render(svg, size * 2));
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out]);
    written.push(relative(root, out));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

mkdirSync(buildDir, { recursive: true });

for (const theme of ['dark', 'light'] as const) {
  write(join(iconsDir, `icon-${theme}.png`), render(macSvg(theme), CANVAS));
  for (const size of [256, 512]) write(join(iconsDir, `icon-${theme}-${size}.png`), render(source(theme), size));
}

write(join(buildDir, 'icon.png'), render(macSvg(BUNDLE_THEME), CANVAS));
icns(BUNDLE_THEME, join(buildDir, 'icon.icns'));
write(
  join(buildDir, 'icon.ico'),
  ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: render(source(BUNDLE_THEME), size) }))),
);

console.log(`icons: wrote\n  ${written.join('\n  ')}`);
