// Draws public/icon-512.png, the square picture AI hosts show for the room's connector (serverInfo.icons), from
// src/app/icon.svg, the site's own icon. Run once by hand after changing the icon: `node scripts/make-icon.mjs`
// (uses Playwright's Chromium, like make-og-image.mjs).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'src/app/icon.svg'), 'utf8');
const size = 512;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${size}px;height:${size}px;background:#f4f1ea}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: resolve(root, 'public/icon-512.png'), type: 'png' });
await browser.close();
console.log('[icon] public/icon-512.png written');
