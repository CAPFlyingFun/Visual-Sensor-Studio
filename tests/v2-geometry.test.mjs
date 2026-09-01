import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * V2 Milestones A–B, measured in a real browser: routing, the single sticky
 * viewfinder, and — with Chromium's fake camera — the actual camera lifecycle,
 * negotiated source size and measured delivered FPS flowing through the V2
 * state into the HUD; then the GPU pipeline itself, on SwiftShader: shaders
 * compile and draw, the canvas carries exactly the PREVIEW geometry, filters
 * change the pixels in the way each shader promises, and a photo comes out at
 * exactly the SOURCE size. Skips loudly where no browser is available.
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

test('Milestone B: the GPU pipeline renders truthfully (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    const { ironbowColor } = await import('../.test-build/vision/motion-ironbow.js');
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      page.on('download', () => { /* the photo triggers a real download; discard it */ });
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);

      // The strip exists before the camera does — it is built from FILTERS at
      // boot, and the photo control is honestly disabled until frames exist.
      const boot = await page.evaluate(() => ({
        filters: [...document.querySelectorAll('#v2FilterStrip [data-filter]')]
          .map((b) => b.dataset.filter),
        active: [...document.querySelectorAll('#v2FilterStrip .active')]
          .map((b) => b.dataset.filter),
        photoDisabled: document.getElementById('v2PhotoButton').disabled,
        canvasHidden: document.getElementById('v2PreviewCanvas').hidden,
        stage: document.getElementById('v2Stage').textContent
      }));
      assert.deepEqual(boot.filters, ['rgb', 'ironbow', 'edges'],
        'the strip mirrors the FILTERS registry, in order');
      assert.deepEqual(boot.active, ['rgb'], 'RGB is the default filter');
      assert.equal(boot.photoDisabled, true, 'no photo before the camera is live');
      assert.equal(boot.canvasHidden, true, 'no canvas over the video until a real render');
      assert.ok(!/WebGL is unavailable/.test(boot.stage),
        `WebGL must initialise in this browser, stage says: "${boot.stage}"`);

      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        document.getElementById('v2HudState')?.textContent === 'LIVE', null, { timeout: 8000 });
      // A rendered-fps number in the PREVIEW row is the proof frames are drawing.
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      const sampleCanvas = () => page.evaluate(() => {
        const canvas = document.getElementById('v2PreviewCanvas');
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = [];
        let maxChroma = 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const d = ctx.getImageData(
              Math.floor((x + 0.5) * copy.width / 8),
              Math.floor((y + 0.5) * copy.height / 8), 1, 1).data;
            pixels.push([d[0], d[1], d[2]]);
            maxChroma = Math.max(maxChroma,
              Math.abs(d[0] - d[1]), Math.abs(d[1] - d[2]), Math.abs(d[0] - d[2]));
          }
        }
        return { pixels, maxChroma, hidden: canvas.hidden, width: canvas.width, height: canvas.height };
      });

      // RGB: the canvas is visible and carries the fake device's colours.
      const rgb = await sampleCanvas();
      assert.equal(rgb.hidden, false, 'the canvas unhides once frames render');
      assert.ok(rgb.maxChroma > 20,
        `RGB preserves colour — the fake pattern is not grey (chroma ${rgb.maxChroma})`);

      // One owner, observable end to end: the canvas draws at EXACTLY the
      // PREVIEW row's size, PREVIEW never exceeds SOURCE, PHOTO equals SOURCE.
      const rows = await page.evaluate(() => ({
        source: document.getElementById('v2DiagSource').textContent,
        preview: document.getElementById('v2DiagPreview').textContent,
        photo: document.getElementById('v2DiagPhoto').textContent
      }));
      const dims = (text) => text.match(/^(\d+)×(\d+)/).slice(1, 3).map(Number);
      const [sw, sh] = dims(rows.source);
      const [pw, ph] = dims(rows.preview);
      const [photoW, photoH] = dims(rows.photo);
      assert.equal(rgb.width, pw, 'the canvas width is the PREVIEW geometry, no private size');
      assert.equal(rgb.height, ph);
      assert.ok(pw <= sw && ph <= sh, `preview ${pw}×${ph} never exceeds the stream ${sw}×${sh}`);
      assert.equal(photoW, sw, 'the PHOTO row promises the negotiated stream');
      assert.equal(photoH, sh);

      // Edges: the Sobel shader writes vec3(g) — every pixel exactly grey.
      await page.click('[data-filter="edges"]');
      await page.waitForTimeout(600);
      const edges = await sampleCanvas();
      assert.ok(edges.maxChroma <= 2,
        `Sobel output is grey by construction, worst chroma ${edges.maxChroma}`);

      // Ironbow: every pixel must lie ON the legacy ramp — the LUT uploaded to
      // the GPU is ironbowColor itself, and no arbitrary colour (the fake
      // device's green, say) is anywhere near that ramp.
      await page.click('[data-filter="ironbow"]');
      await page.waitForTimeout(600);
      const ironbow = await sampleCanvas();
      assert.ok(ironbow.maxChroma > 20, 'the ramp is colour, not grey');
      const ramp = [];
      for (let i = 0; i < 256; i++) ramp.push(ironbowColor(i / 255));
      const offRamp = ironbow.pixels.filter(([r, g, b]) => {
        let best = Infinity;
        for (const [rr, rg, rb] of ramp) {
          best = Math.min(best, Math.hypot(r - rr, g - rg, b - rb));
        }
        return best > 20;
      });
      assert.equal(offRamp.length, 0,
        `every ironbow pixel sits on the legacy ramp, off-ramp: ${JSON.stringify(offRamp.slice(0, 3))}`);

      // Photo: the same shader at the PHOTO geometry — the report must carry
      // EXACTLY the source dimensions, the whole point of Milestone B.
      await page.click('#v2PhotoButton');
      await page.waitForFunction(() =>
        (document.getElementById('v2PhotoResult')?.textContent ?? '').startsWith('Saved'),
        null, { timeout: 8000 });
      const line = await page.textContent('#v2PhotoResult');
      assert.match(line,
        new RegExp(`^Saved ${sw}×${sh} · \\d+\\.\\d{2} MB JPEG · the negotiated stream`),
        `the photo reports the exact SOURCE size, got "${line}"`);

      // And the very next preview frame takes the canvas back — photo size
      // never leaks into the preview product.
      await page.waitForTimeout(600);
      const after = await sampleCanvas();
      assert.equal(after.width, pw, 'the preview reclaims its own geometry after a photo');
      assert.equal(after.height, ph);

      await page.close();
      await context.close();
    });
  });
