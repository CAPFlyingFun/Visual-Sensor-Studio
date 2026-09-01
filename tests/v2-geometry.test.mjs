import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * V2 Milestone A, measured in a real browser: routing, the single sticky
 * viewfinder, and — with Chromium's fake camera — the actual camera lifecycle,
 * negotiated source size and measured delivered FPS flowing through the V2
 * state into the HUD. Skips loudly where no browser is available.
 *
 * Real-iPhone acceptance still applies on top of this; Chromium's fake device
 * cannot verify WebKit behaviour, PWA lifecycle or MP4 output.
 */

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.map': 'application/json'
};

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }
const runnable = chromium !== null && existsSync(CHROME);

async function withBrowser(body, extraArgs = []) {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const file = join(ROOT, url === '/' ? 'index.html' : url);
    if (!existsSync(file) || !file.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", ...extraArgs] });
  try {
    return await body(browser, `http://127.0.0.1:${port}`);
  } finally {
    await browser.close();
    server.close();
  }
}

test('?scene=v2 routes to V2 and its absence leaves legacy untouched',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

      await page.goto(`${base}/index.html?scene=v2`);
      await page.waitForTimeout(400);
      assert.ok(page.url().includes('/v2.html'), `should land on v2.html, got ${page.url()}`);
      assert.ok(page.url().includes('scene=v2'), 'the query survives the redirect');
      assert.equal(await page.textContent('#v2Badge'), 'V2 · Experimental');

      await page.goto(`${base}/index.html`);
      await page.waitForTimeout(400);
      assert.ok(!page.url().includes('v2.html'), 'without the parameter the legacy app stays');
      assert.ok(await page.$('.tabbar'), 'the legacy tab bar is present');
      assert.equal(await page.$('#v2Badge'), null, 'no V2 chrome leaks into legacy');
      await page.close();
    });
  });

for (const [label, width, height] of [['430x932', 430, 932], ['320x568', 320, 568]]) {
  test(`V2 keeps the viewfinder pinned and the page honest at ${label}`,
    { skip: runnable ? false : 'no browser available' }, async () => {
      await withBrowser(async (browser, base) => {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(`${base}/v2.html?scene=v2`);
        await page.waitForTimeout(400);

        const seen = await page.evaluate(() => {
          const sticky = [...document.querySelectorAll('*')]
            .filter((el) => getComputedStyle(el).position === 'sticky')
            .map((el) => el.className || el.tagName);
          const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
          return {
            sticky,
            docWidth: document.documentElement.scrollWidth,
            duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
            dockButtons: [...document.querySelectorAll('#v2Dock [data-route]')]
              .map((b) => b.dataset.route)
          };
        });
        assert.deepEqual(seen.sticky, ['viewfinder-wrap'],
          `only the viewfinder may be sticky, found: ${seen.sticky.join(', ')}`);
        assert.equal(seen.docWidth, width, 'no horizontal overflow');
        assert.deepEqual(seen.duplicateIds, []);
        assert.deepEqual(seen.dockButtons, ['camera', 'sensors', 'world', 'data', 'more'],
          'the dock is generated from NAV_ROUTES, in order');

        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(150);
        const after = await page.evaluate(() => {
          const vf = document.getElementById('v2Viewfinder').getBoundingClientRect();
          const dock = document.getElementById('v2Dock').getBoundingClientRect();
          return { top: Math.round(vf.top), visible: vf.bottom > 0 && vf.top < innerHeight,
            dockTop: Math.round(dock.top), overlap: vf.bottom > dock.top + 1 };
        });
        assert.ok(after.visible, 'the viewfinder left the screen');
        assert.ok(after.top <= 0 || after.top < 40, 'the viewfinder should be pinned near the top');

        // The unimplemented routes are honest placeholders, not fake features.
        await page.click('[data-route="world"]');
        await page.waitForTimeout(100);
        assert.equal(await page.isHidden('#v2CameraRoute'), true);
        assert.match(await page.textContent('#v2PlaceholderPlan'), /legacy app/);
        await page.close();
      });
    });
}

test('the camera goes live and the HUD carries measured truth (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);

      await page.click('#v2EnableCamera');
      // The fake device negotiates quickly; a real one can take seconds.
      await page.waitForFunction(() =>
        document.getElementById('v2HudState')?.textContent === 'LIVE', null, { timeout: 8000 });

      // Let the frame-rate meter accumulate presented frames.
      await page.waitForTimeout(2500);
      const hud = await page.evaluate(() => ({
        state: document.getElementById('v2HudState').textContent,
        source: document.getElementById('v2HudSource').textContent,
        fps: document.getElementById('v2HudFps').textContent,
        diag: document.getElementById('v2DiagSource').textContent,
        enableHidden: document.getElementById('v2EnableCamera').hidden,
        switchEnabled: !document.getElementById('v2SwitchCamera').disabled
      }));
      assert.equal(hud.state, 'LIVE');
      assert.match(hud.source, /^\d+×\d+$/, `the negotiated size should be numbers, got "${hud.source}"`);
      assert.match(hud.fps, /^\d+(\.\d+)? fps$/, `delivered fps should be measured, got "${hud.fps}"`);
      assert.match(hud.diag, /^\d+×\d+ · \d+(\.\d+)? delivered fps$/,
        'the SOURCE row carries size and measured rate together');
      assert.equal(hud.enableHidden, true, 'the enable overlay hides once live');
      assert.equal(hud.switchEnabled, true);
      await page.close();
      await context.close();
    });
  }, );
