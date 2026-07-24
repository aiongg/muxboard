// Render PWA icons from the SVG mark. Run: pnpm icons
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = new URL('../public/icons/', import.meta.url).pathname;
const svg = await readFile(join(dir, 'icon.svg'));

// Regular icons: full-bleed render of the mark — used where nothing masks.
for (const size of [192, 512]) {
  await sharp(svg).resize(size, size).png().toFile(join(dir, `icon-${size}.png`));
}

// Maskable: Android reveals only the safe zone — a circle of 80% of the
// canvas diameter (radius 205 at 512) — over a full-bleed opaque background.
// The whole mark square, corners included, must fit inside that circle:
// side <= 409 / sqrt(2) ~= 289. At 280 it clears the crop with margin.
const mark = await sharp(svg).resize(280, 280).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#131009' } })
  .composite([{ input: mark, top: 116, left: 116 }])
  .png().toFile(join(dir, 'maskable-512.png'));

// Apple touch icon: iOS rounds its own corners but never circle-crops.
await sharp({ create: { width: 180, height: 180, channels: 4, background: '#131009' } })
  .composite([{ input: await sharp(svg).resize(180, 180).png().toBuffer() }])
  .png().toFile(join(dir, 'apple-touch-icon.png'));

// Favicon.
await writeFile(join(dir, '../favicon.ico'), await sharp(svg).resize(32, 32).png().toBuffer());
console.log('icons rendered');
