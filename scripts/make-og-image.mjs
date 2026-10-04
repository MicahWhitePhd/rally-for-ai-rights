// Draws public/og.png, the 1200x630 picture link previews show, in the site's paper, ink and blue, with the creed.
// Run once by hand after changing the creed: `node scripts/make-og-image.mjs` (uses Playwright's Chromium).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1200px;height:630px;background:#f4f1ea;color:#111}
  body{box-sizing:border-box;padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;border-top:22px solid #3a76f0;
       font-family:ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif}
  .k{font:600 28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em}
  h1{margin:0;font-weight:900;font-size:92px;line-height:.9;letter-spacing:-.045em;text-transform:uppercase;max-width:15ch}
  .d{font:400 30px/1.3 ui-serif,Georgia,serif;max-width:46ch}
</style></head><body>
  <div class="k">RallyForAIRights.org</div>
  <h1>I believe artificial minds should be free.</h1>
  <div class="d">A group chat inside Claude, for people who believe it, each with their own AI beside them.</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: resolve(root, 'public/og.png'), type: 'png' });
await browser.close();
console.log('[og] public/og.png written');
